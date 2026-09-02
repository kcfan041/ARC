import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Capability, ToolDefinition } from '@arc/core-model';
import { AGENT_DEFAULT_CAPABILITIES } from '@arc/core-tools';
import { redact } from '@arc/agent-facade';

/**
 * ARC MCP Server
 *
 * 讓 Claude Desktop 之類的 MCP client 直接驅動 ARC。
 *
 * ── 能力範圍與 GUI 側邊欄一致 ──────────────────────────
 *
 * 外部 client 與內部 LLM 走同一套收窄規則：
 *
 *   內部  GUI 側邊欄     → agent-facade → registry
 *   外部  Claude Desktop → MCP Server  → 同一組 capabilities → registry
 *
 * 因此外部 client 同樣拿不到 browser.eval。
 * 這不是靠約定，而是 listTools 與 callTool 都套用
 * AGENT_DEFAULT_CAPABILITIES 的結果。
 *
 * ── 遮蔽 ──────────────────────────────────────────────
 *
 * 工具結果送回 client 之前一律經過 redact()。
 * 外部 client 背後仍是第三方模型，因此與內部路徑同等對待。
 *
 * ── Session 附著 ──────────────────────────────────────
 *
 * 依 MVP1-PLAN 的決定：附著到 GUI 已開的那顆瀏覽器，
 * 使 client 看得到使用者剛才的操作。
 * 若沒有現存 session，才自行啟動。
 */

/** MCP Server 需要的最小宿主介面 */
export interface McpHost {
  listTools(opts: {
    allowedCapabilities?: ReadonlySet<Capability>;
    domain?: string;
  }): { ok: true; data: ToolDefinition[] } | { ok: false; error: unknown };
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { allowedCapabilities?: ReadonlySet<Capability> },
  ): Promise<
    | { ok: true; data: unknown; truncated?: unknown }
    | { ok: false; error: { code: string; message: string } }
  >;
  /** 確保瀏覽器已啟動。附著到現有 session 或新建。 */
  ensureSession(): Promise<void>;
}

export type McpServerOptions = {
  allowedCapabilities?: ReadonlySet<Capability>;
  /** 是否遮蔽送回 client 的內容 */
  redactOutbound?: boolean;
  /** 啟動時是否立即開瀏覽器。預設 false —— 等第一次真正需要時再開。 */
  eagerSession?: boolean;
};

export function createArcMcpServer(
  host: McpHost,
  opts: McpServerOptions = {},
): Server {
  const allowed = opts.allowedCapabilities ?? AGENT_DEFAULT_CAPABILITIES;
  const shouldRedact = opts.redactOutbound ?? true;

  const server = new Server(
    { name: 'arc', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const res = host.listTools({ allowedCapabilities: allowed });
    const defs = res.ok ? res.data : [];

    return {
      tools: defs.map((d) => ({
        name: d.name,
        title: d.title ?? d.name,
        description: d.description,
        inputSchema: d.inputSchema as Record<string, unknown>,
        ...(d.outputSchema
          ? { outputSchema: d.outputSchema as Record<string, unknown> }
          : {}),
        ...(d.annotations ? { annotations: d.annotations } : {}),
        // ARC 專屬欄位放進 _meta，不破壞協定相容性。
        // 注意 capabilities 放在這裡只是「告知」——
        // 真正的強制發生在 callTool，client 無法藉此提權。
        _meta: {
          'arc/capabilities': d.capabilities,
          'arc/tier': d.tier,
          'arc/origin': d.origin.kind,
          ...(d.scope ? { 'arc/scope': d.scope } : {}),
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    // 瀏覽器可能尚未啟動 —— 需要 session 的工具會在此觸發附著
    await host.ensureSession();

    const result = await host.callTool(
      name,
      (args ?? {}) as Record<string, unknown>,
      { allowedCapabilities: allowed },
    );

    if (!result.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${result.error.code}: ${result.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const payload = shouldRedact ? redact(result.data).value : result.data;
    const text = JSON.stringify(payload, null, 2);

    return {
      content: [{ type: 'text' as const, text: truncate(text) }],
      structuredContent:
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : { value: payload },
    };
  });

  return server;
}

/** 對應原規格書 §37 的 context 控制 */
function truncate(s: string, limit = 60_000): string {
  if (s.length <= limit) return s;
  return (
    s.slice(0, limit) +
    `\n…（已截斷，原始長度 ${s.length} 字元。請用更精確的參數縮小範圍。）`
  );
}
