import type { ToolDefinition } from '@arc/core-model';
import {
  runInSandbox,
  type HostFunctions,
  type SandboxLimits,
} from '@arc/tool-runtime';

/**
 * Tier 2 工具的資料形式
 *
 * 與 Tier 1（宣告式）一樣是純資料，可儲存、傳輸、審查。
 * 差別在於 body 是程式碼字串，因此需要沙箱執行。
 */
export type SandboxedSpec = {
  /** 工具主體。可使用 return 回傳結果，args 為傳入參數。 */
  body: string;
  limits?: Partial<SandboxLimits>;
};

/**
 * 把 capability 注入產生的作用域，轉為沙箱可用的 host 函式。
 *
 * scope 來自 Registry 的 buildScope() —— 只含該工具宣告過的能力。
 * 因此沙箱內能看到什麼，完全由 capabilities 決定，
 * 與工具自述的 annotations 無關。
 */
export function scopeToHostFunctions(
  scope: Record<string, unknown>,
): HostFunctions {
  const host: HostFunctions = {};
  for (const [name, value] of Object.entries(scope)) {
    if (typeof value === 'function') {
      host[name] = value as HostFunctions[string];
    }
  }
  return host;
}

/**
 * 建立 Tier 2 工具的 handler。
 *
 * 傳入的 args 以 JSON 注入沙箱的 args 變數，
 * 而非字串拼接 —— 避免參數內容被當成程式碼執行。
 */
export function makeSandboxHandler(spec: SandboxedSpec) {
  return async (
    args: Record<string, unknown>,
    scope: Record<string, unknown>,
  ) => {
    const host = scopeToHostFunctions(scope);
    const preamble = `var args = ${JSON.stringify(args ?? {})};\n`;
    const result = await runInSandbox(
      preamble + spec.body,
      host,
      spec.limits ?? {},
    );

    if (!result.ok) return result;
    // 只把值與 log 交給呼叫端，資源統計留在內部
    return {
      ok: true as const,
      data: {
        value: result.data.value,
        logs: result.data.logs,
      },
    };
  };
}

/** Tier 2 工具定義的便利建構函式 */
export function defineSandboxedTool(
  meta: Omit<ToolDefinition, 'tier'>,
  spec: SandboxedSpec,
): { def: ToolDefinition; spec: SandboxedSpec } {
  return { def: { ...meta, tier: 'sandboxed' }, spec };
}
