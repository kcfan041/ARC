import {
  newQuickJSAsyncWASMModule,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import type { ToolResult } from '@arc/core-model';
import { fail, ok } from '@arc/core-model';

/**
 * Tier 2：沙箱執行
 *
 * 用途：AI 寫的工具、匯入的工具，凡是宣告式（Tier 1）表達不了
 * 條件判斷、迴圈、複雜狀態機的情境。
 *
 * ── 為何選 QuickJS 而非 node:vm 或 isolated-vm ──────────
 *
 *   node:vm       Node 官方明言「不是安全邊界」，可被逃逸
 *   isolated-vm   隔離最強，但需要 node-gyp 編譯。
 *                 實測發現本專案環境本身就在擋 install scripts
 *                 （esbuild、fsevents 皆被擋），編譯型套件
 *                 在使用者機器上失敗率不低。
 *   QuickJS       WASM 隔離，純下載無編譯。工具主要做編排
 *                 不做重運算，效能差距無感。
 *
 * isolated-vm 保留為日後的升級選項，因此本模組只對外暴露
 * SandboxRunner 介面，實作可抽換。
 *
 * ── 安全性質 ──────────────────────────────────────────
 *
 * 沙箱的全域環境是空的。沒有 fetch、require、process、
 * 沒有檔案系統、沒有網路。工具唯一能做的事，
 * 就是呼叫「它宣告過的能力」所對應的注入函式。
 *
 * 這與 MVP1-PLAN 3A.2 一致：
 *   未宣告的能力不是被禁止，而是不存在於作用域。
 */

export type SandboxLimits = {
  /** 記憶體上限（位元組） */
  memoryBytes: number;
  /** 掛鐘執行時間上限（毫秒） */
  timeMs: number;
  /** 堆疊上限（位元組） */
  stackBytes: number;
  /** 允許呼叫注入函式的總次數。防止工具在迴圈中無限呼叫能力。 */
  maxHostCalls: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  timeMs: 5_000,
  stackBytes: 512 * 1024,
  maxHostCalls: 1_000,
};

export type SandboxOutcome = {
  value: unknown;
  /** 工具透過 log() 輸出的訊息，供除錯與人工審查 */
  logs: string[];
  hostCalls: number;
  elapsedMs: number;
};

/** 注入沙箱的能力函式。回傳值必須可 JSON 序列化。 */
export type HostFunctions = Record<
  string,
  (...args: unknown[]) => unknown | Promise<unknown>
>;

/**
 * WASM module 只載入一次，之後每次執行建立新的 runtime。
 *
 * runtime 是隔離邊界 —— 兩個工具不共用 runtime，
 * 因此無法透過全域變數互相影響。
 */
let modulePromise: ReturnType<typeof newQuickJSAsyncWASMModule> | undefined;

function getModule() {
  if (!modulePromise) modulePromise = newQuickJSAsyncWASMModule();
  return modulePromise;
}

/** 預先載入 WASM，避免第一次執行時的延遲被計入 timeMs */
export async function warmupSandbox(): Promise<void> {
  await getModule();
}

/**
 * 在沙箱中執行程式碼。
 *
 * 生命週期管理是這裡最容易出錯的地方 ——
 * QuickJS 的 handle 必須在 context 之前釋放，
 * context 必須在 runtime 之前釋放，
 * 且注入的 host function handle 在 setProp 後要立刻 dispose
 * （setProp 會自行保留一份參照）。
 * 順序錯誤會導致 WASM 層的 "HostRef not found" 崩潰。
 */
export async function runInSandbox(
  code: string,
  host: HostFunctions,
  limits: Partial<SandboxLimits> = {},
): Promise<ToolResult<SandboxOutcome>> {
  const lim = { ...DEFAULT_SANDBOX_LIMITS, ...limits };
  const QJS = await getModule();

  let runtime: QuickJSAsyncRuntime | undefined;
  let context: QuickJSAsyncContext | undefined;

  const logs: string[] = [];
  let hostCalls = 0;
  let hostCallDenied = false;
  const startedAt = Date.now();

  try {
    runtime = QJS.newRuntime();
    runtime.setMemoryLimit(lim.memoryBytes);
    runtime.setMaxStackSize(lim.stackBytes);

    // 中斷處理器：QuickJS 在執行位元組碼期間會週期性呼叫此函式，
    // 回傳 true 即中止。這是終止無窮迴圈的唯一手段 ——
    // WASM 內沒有執行緒可以外部強制停止。
    const deadline = startedAt + lim.timeMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);

    context = runtime.newContext();
    const ctx = context;

    // ── 注入：log ──────────────────────────────────────
    {
      const fn = ctx.newFunction('log', (...args) => {
        logs.push(args.map((a) => ctx.dump(a)).map(String).join(' '));
        return ctx.undefined;
      });
      ctx.setProp(ctx.global, 'log', fn);
      fn.dispose();
    }

    // ── 注入：宣告過的能力 ──────────────────────────────
    //
    // 用 asyncify 版本，使非同步的 host 函式在沙箱內
    // 表現為同步呼叫。工具作者（尤其 AI）因此不需要
    // 處理 async/await，可顯著降低生成錯誤率。
    for (const [name, impl] of Object.entries(host)) {
      const fn = ctx.newAsyncifiedFunction(name, async (...argHandles) => {
        if (hostCalls >= lim.maxHostCalls) {
          hostCallDenied = true;
          throw new Error(
            `host call limit exceeded (${lim.maxHostCalls})`,
          );
        }
        hostCalls += 1;

        const args = argHandles.map((h) => ctx.dump(h));
        const result = await impl(...args);
        // 一律經由 JSON 傳遞，避免把宿主物件洩漏進沙箱
        return ctx.newString(JSON.stringify(result ?? null));
      });
      ctx.setProp(ctx.global, name, fn);
      fn.dispose();
    }

    // 包一層 __call，讓沙箱內的呼叫直接拿到解析後的物件
    const bridge = Object.keys(host)
      .map(
        (n) =>
          `var ${n}__raw = ${n}; ${n} = function(){ ` +
          `var r = ${n}__raw.apply(null, arguments); ` +
          `return r === undefined ? undefined : JSON.parse(r); };`,
      )
      .join('\n');

    const wrapped = `${bridge}
(function(){
${code}
})()`;

    const result = await ctx.evalCodeAsync(wrapped);

    if (result.error) {
      const err = ctx.dump(result.error) as { name?: string; message?: string };
      result.error.dispose();

      // 判別順序有意義：資源超限的訊號要優先於一般錯誤，
      // 否則呼叫端無法分辨「工具寫錯」與「資源不足」。
      if (hostCallDenied) {
        return fail(
          'RESOURCE_EXCEEDED',
          `tool exceeded host call limit of ${lim.maxHostCalls}`,
        );
      }
      if (Date.now() > deadline) {
        return fail('TIMEOUT', `sandbox exceeded ${lim.timeMs}ms`, true);
      }

      const msg = err.message ?? String(err);
      // QuickJS 以 InternalError: out of memory 回報記憶體耗盡，
      // 而非拋出宿主例外
      if (/out of memory/i.test(msg)) {
        return fail(
          'RESOURCE_EXCEEDED',
          `sandbox exceeded memory limit of ${lim.memoryBytes} bytes`,
        );
      }
      if (/stack overflow/i.test(msg)) {
        return fail(
          'RESOURCE_EXCEEDED',
          `sandbox exceeded stack limit of ${lim.stackBytes} bytes`,
        );
      }

      return fail('EXECUTION_FAILED', `${err.name ?? 'Error'}: ${msg}`);
    }

    const value = ctx.dump(result.value);
    result.value.dispose();

    return ok({
      value,
      logs,
      hostCalls,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    // 少數情況下記憶體耗盡會以宿主例外拋出，而非 result.error
    const msg = String(err);
    if (/out of memory|allocation/i.test(msg)) {
      return fail(
        'RESOURCE_EXCEEDED',
        `sandbox exceeded memory limit of ${lim.memoryBytes} bytes`,
      );
    }
    return fail('EXECUTION_FAILED', msg);
  } finally {
    // 順序不可顛倒：context 先於 runtime
    try {
      context?.dispose();
    } catch {
      /* 已釋放或處於錯誤狀態 */
    }
    try {
      runtime?.dispose();
    } catch {
      /* 同上 */
    }
  }
}

/** 供測試觀察沙箱內可見的全域名稱 */
export async function probeSandboxGlobals(
  host: HostFunctions = {},
): Promise<ToolResult<SandboxOutcome>> {
  return runInSandbox(
    `var names = ['fetch','require','process','globalThis','XMLHttpRequest',
                  'WebSocket','eval','Function','setTimeout'];
     var out = {};
     for (var i = 0; i < names.length; i++) {
       try { out[names[i]] = typeof this[names[i]]; }
       catch (e) { out[names[i]] = 'error'; }
     }
     return out;`,
    host,
  );
}

export type { QuickJSHandle };
