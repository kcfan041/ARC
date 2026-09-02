import type { Capability } from '@arc/core-model';
import { Workspace } from '@arc/core-tools';
import type { McpHost } from './server.js';

/**
 * 把 Workspace 接上 MCP Server 的 host 介面。
 *
 * Session 附著策略（MVP1-PLAN 的決定）：
 *   附著到 GUI 已開的那顆瀏覽器，使 client 看得到
 *   使用者剛才的操作。沒有現存 session 才自行啟動。
 *
 * 這裡的 ensureSession 是延遲啟動 —— 只在第一次真正
 * 呼叫工具時才開瀏覽器。純粹列出工具不會觸發。
 */
export class WorkspaceMcpHost implements McpHost {
  private starting?: Promise<void>;

  constructor(
    private readonly ws: Workspace,
    private readonly startUrl?: string,
  ) {}

  listTools(opts: {
    allowedCapabilities?: ReadonlySet<Capability>;
    domain?: string;
  }) {
    const res = this.ws.listTools(opts);
    return res.ok
      ? { ok: true as const, data: res.data }
      : { ok: false as const, error: res.error };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { allowedCapabilities?: ReadonlySet<Capability> },
  ) {
    const res = await this.ws.callTool(name, args, opts);
    return res.ok
      ? { ok: true as const, data: res.data }
      : {
          ok: false as const,
          error: { code: res.error.code, message: res.error.message },
        };
  }

  async ensureSession(): Promise<void> {
    if (this.ws.session.status().recording) return;
    // 併發呼叫時只啟動一次
    if (!this.starting) {
      this.starting = this.ws.session
        .start(this.startUrl)
        .finally(() => {
          this.starting = undefined;
        });
    }
    return this.starting;
  }
}
