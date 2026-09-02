import { ToolRegistry } from '@arc/tool-runtime';
import {
  runDeclarative,
  type DeclarativeSpec,
  type ExecutionMode,
} from '@arc/tool-runtime';
import type { ToolDefinition, ToolResult } from '@arc/core-model';
import { fail, ok } from '@arc/core-model';
import { InvestigationSession, type SessionOptions } from './session.js';
import { registerPrimitives } from './primitives.js';

/**
 * Workspace —— Session 與 Registry 的組合
 *
 * 職責切分（見 MVP1-PLAN 工具框架章）：
 *   Session    資源生命週期（瀏覽器、訂閱、計時器）+ 事件串流
 *   Registry   工具的宣告、發現、呼叫、capability 注入
 *
 * 兩者長期並存，不是過渡安排：
 *   MCP 是請求／回應模型，沒有對應「事件串流」，
 *   而串流正是 ARC 的核心價值（action 與 flow 即時推送到 GUI）。
 *   因此 Session 不會被 Registry 取代。
 *
 * 呼叫端的選擇：
 *   需要串流        → 直接用 session.on()
 *   需要呼叫工具    → 用 registry / callTool()
 */
export class Workspace {
  readonly session: InvestigationSession;
  readonly registry = new ToolRegistry();

  /** 已註冊的宣告式工具規格。Tier 1 工具是純資料，可儲存與傳輸。 */
  private declarativeSpecs = new Map<string, DeclarativeSpec>();

  constructor(opts: SessionOptions = {}) {
    this.session = new InvestigationSession(opts);
    registerPrimitives(this.registry, this.session);
  }

  /**
   * 註冊宣告式工具。
   *
   * 這是「AI 寫的工具」與「匯入的工具」在 Tier 1 的形式：
   * 純資料、不含程式碼，可儲存、可傳輸、可審查。
   */
  registerDeclarative(def: ToolDefinition, spec: DeclarativeSpec): void {
    this.declarativeSpecs.set(def.name, spec);
    this.registry.upsert(def, async (args, scope) => {
      const mode = (args.mode as ExecutionMode) ?? 'dry-run';
      return runDeclarative(spec, scope as never, mode);
    });
  }

  getDeclarativeSpec(name: string): DeclarativeSpec | undefined {
    return this.declarativeSpecs.get(name);
  }

  /** 呼叫工具。allowedCapabilities 由呼叫端決定（agent-facade 會更窄）。 */
  callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: Parameters<ToolRegistry['call']>[2] = {},
  ): Promise<ToolResult> {
    return this.registry.call(name, args, opts);
  }

  listTools(opts: Parameters<ToolRegistry['list']>[0] = {}) {
    return this.registry.list(opts);
  }

  /**
   * 匯出工具定義，供儲存或分享。
   *
   * 只有 Tier 1（宣告式）可以完整匯出 ——
   * 原語工具的行為在程式碼裡，不是資料。
   */
  exportTool(name: string): ToolResult<{
    def: ToolDefinition;
    spec: DeclarativeSpec;
  }> {
    const entry = this.registry.get(name);
    if (!entry) return fail('NOT_FOUND', `unknown tool: ${name}`);
    const spec = this.declarativeSpecs.get(name);
    if (!spec) {
      return fail(
        'INVALID_ARGUMENT',
        `tool "${name}" is not declarative and cannot be exported as data`,
      );
    }
    return ok({ def: entry.def, spec });
  }

  async close(): Promise<void> {
    await this.session.stop();
  }
}
