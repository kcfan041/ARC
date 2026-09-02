import type {
  Capability,
  ToolDefinition,
  ToolResult,
} from '@arc/core-model';
import { fail, ok, TOOL_LIMITS } from '@arc/core-model';
import { buildScope, checkAllowed, type CapabilityMap } from './capability.js';

/**
 * Tool Registry
 *
 * 職責切分（見 MVP1-PLAN 工具框架章）：
 *   Session    資源生命週期（瀏覽器、訂閱、計時器）+ 事件串流
 *   Registry   工具的宣告、發現、呼叫、capability 注入
 *
 * 兩者長期並存。Session 不是過渡層 ——
 * MCP 是請求/回應模型，沒有對應「事件串流」，
 * 而串流正是 ARC 的核心價值。
 */

/** 工具的實際執行函式。scope 只含該工具宣告過的能力。 */
export type ToolHandler = (
  args: Record<string, unknown>,
  scope: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

export type RegisteredTool = {
  def: ToolDefinition;
  handler: ToolHandler;
};

export type ListOptions = {
  /** 只回傳作用域相符的工具。用於控制 LLM 的 context 大小。 */
  domain?: string;
  tags?: string[];
  /** 只回傳這些能力範圍內的工具 */
  allowedCapabilities?: ReadonlySet<Capability>;
  cursor?: string;
  limit?: number;
};

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private caps: CapabilityMap = {};

  /** 註冊能力提供者。工具執行時從這裡取得實作。 */
  provide(caps: CapabilityMap): void {
    this.caps = { ...this.caps, ...caps };
  }

  register(def: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, { def, handler });
  }

  /** 覆寫既有工具。用於使用者修改內建工具或匯入同名工具。 */
  upsert(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * 列出工具。
   *
   * 支援作用域過濾與分頁，因為「幾百個工具」全部塞進 prompt
   * 會直接違反原規格書 §37 的 context 控制原則：
   *   300 工具 × 200 tokens = 60,000 tokens
   */
  list(opts: ListOptions = {}): ToolResult<ToolDefinition[]> {
    const limit = opts.limit ?? TOOL_LIMITS.defaultPageSize;
    let all = [...this.tools.values()].map((t) => t.def);

    if (opts.allowedCapabilities) {
      const allowed = opts.allowedCapabilities;
      all = all.filter((d) => checkAllowed(d, allowed).allowed);
    }

    if (opts.domain) {
      const domain = opts.domain;
      all = all.filter(
        (d) => !d.scope?.domain || matchDomain(domain, d.scope.domain),
      );
    }

    if (opts.tags?.length) {
      const want = new Set(opts.tags);
      all = all.filter((d) => d.scope?.tags?.some((t) => want.has(t)) ?? false);
    }

    all.sort((a, b) => a.name.localeCompare(b.name));

    const start = opts.cursor ? Math.max(0, Number(opts.cursor) || 0) : 0;
    const page = all.slice(start, start + limit);
    const nextIndex = start + page.length;

    if (nextIndex < all.length) {
      return ok(page, {
        reason: 'count_limit',
        returned: page.length,
        total: all.length,
        cursor: String(nextIndex),
      });
    }
    return ok(page);
  }

  /**
   * 呼叫工具。
   *
   * 執行順序刻意如此：
   *   1. 工具是否存在
   *   2. 呼叫端是否允許這些能力（agent-facade 可能比人工更窄）
   *   3. 建立受限作用域 —— 只注入宣告過的能力
   *   4. 逾時保護
   *
   * 第 3 步是安全性的關鍵：未宣告的能力不在 scope 內，
   * 工具無法取得，而非「取得後被拒絕」。
   */
  async call(
    name: string,
    args: Record<string, unknown> = {},
    opts: { allowedCapabilities?: ReadonlySet<Capability>; timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return fail('NOT_FOUND', `unknown tool: ${name}`);

    if (opts.allowedCapabilities) {
      const check = checkAllowed(entry.def, opts.allowedCapabilities);
      if (!check.allowed) {
        return fail(
          'CAPABILITY_DENIED',
          `tool "${name}" requires capabilities not available to this caller: ${check.denied.join(', ')}`,
        );
      }
    }

    const { scope, missing } = buildScope(entry.def, this.caps);
    if (missing.length > 0) {
      return fail(
        'CAPABILITY_DENIED',
        `capability provider not available: ${missing.join(', ')}`,
      );
    }

    const timeoutMs = opts.timeoutMs ?? TOOL_LIMITS.timeoutMs;
    try {
      return await withTimeout(
        Promise.resolve(entry.handler(args, scope)),
        timeoutMs,
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        return fail('TIMEOUT', `tool "${name}" exceeded ${timeoutMs}ms`, true);
      }
      return fail('EXECUTION_FAILED', String(err));
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 支援 *.example.com 形式的網域比對 */
export function matchDomain(actual: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return actual === base || actual.endsWith('.' + base);
  }
  return actual === pattern;
}
