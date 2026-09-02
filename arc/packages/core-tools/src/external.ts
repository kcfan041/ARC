import type { ToolDefinition } from '@arc/core-model';
import {
  McpServerConnection,
  type McpServerSpec,
  type RemoteTool,
} from '@arc/mcp-client';
import { resolveName } from '@arc/tool-runtime';
import type { ToolRegistry } from '@arc/tool-runtime';

/**
 * 外部 MCP Server 的管理
 *
 * Tier 3 工具會出現在同一個 registry 中，因此對 LLM 而言
 * 介面與內建工具完全相同 —— 這是 MVP1-PLAN 3A.4 的
 * 「三層對 LLM 呈現相同介面」。
 *
 * 但信任等級不同，且必須誠實反映：
 *
 *   Tier 1/2  執行在我方沙箱，能力由我方注入且不可逾越
 *   Tier 3    執行在對方程序，我方無法限制它做什麼
 *
 * 因此外部工具的 capabilities 一律為空陣列 ——
 * 不是「不需要能力」，而是「宣稱任何能力都沒有意義」。
 * UI 應以 tier=external 明確標示這個差異。
 */
export class ExternalServers {
  private connections = new Map<string, McpServerConnection>();
  /** 本機名稱 → 遠端資訊 */
  private routing = new Map<string, RemoteTool>();

  constructor(private readonly registry: ToolRegistry) {}

  get servers(): { name: string; connected: boolean; toolCount: number }[] {
    return [...this.connections.entries()].map(([name, conn]) => ({
      name,
      connected: conn.connected,
      toolCount: conn.availableTools.length,
    }));
  }

  /**
   * 連接外部 server 並把它的工具註冊進來。
   *
   * 名稱衝突一律改名而非覆蓋 —— 覆蓋會讓使用者
   * 失去內建功能且難以察覺。
   */
  async connect(spec: McpServerSpec): Promise<
    | { ok: true; tools: RemoteTool[] }
    | { ok: false; error: string }
  > {
    if (this.connections.has(spec.name)) {
      return { ok: false, error: `已連接名為 "${spec.name}" 的 server` };
    }

    const conn = new McpServerConnection(spec);
    const res = await conn.connect();
    if (!res.ok) {
      return { ok: false, error: res.error.message };
    }

    this.connections.set(spec.name, conn);

    const listed = this.registry.list({ limit: 10_000 });
    const existing = new Set(listed.ok ? listed.data.map((d) => d.name) : []);

    const registered: RemoteTool[] = [];
    for (const t of res.data) {
      const localName = resolveName(t.remoteName, existing, spec.name);
      existing.add(localName);

      const def: ToolDefinition = { ...t.def, name: localName };
      const entry: RemoteTool = { ...t, localName, def };
      this.routing.set(localName, entry);
      registered.push(entry);

      this.registry.upsert(def, async (args) => {
        const conn2 = this.connections.get(spec.name);
        if (!conn2) {
          return {
            ok: false as const,
            error: {
              code: 'STALE_REFERENCE' as const,
              message: `MCP server "${spec.name}" 已中斷連線`,
              retryable: false,
            },
          };
        }
        return conn2.call(t.remoteName, args);
      });
    }

    return { ok: true, tools: registered };
  }

  async disconnect(serverName: string): Promise<boolean> {
    const conn = this.connections.get(serverName);
    if (!conn) return false;

    for (const [localName, entry] of [...this.routing.entries()]) {
      if (entry.serverName === serverName) {
        this.registry.unregister(localName);
        this.routing.delete(localName);
      }
    }

    await conn.close();
    this.connections.delete(serverName);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) {
      await this.disconnect(name);
    }
  }
}

export type { McpServerSpec, RemoteTool };
