import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Capability, ToolDefinition, ToolResult } from '@arc/core-model';
import { fail, ok } from '@arc/core-model';

/**
 * MCP Client —— Tier 3 外部工具
 *
 * ── 與檔案匯入的根本差別 ──────────────────────────────
 *
 *   檔案匯入（Tier 1/2）  內容可完整審查，執行在我方沙箱內，
 *                          能力由我方注入且不可逾越
 *
 *   外部 MCP Server（Tier 3）
 *                          執行發生在對方的程序。
 *                          我方看不到實作，也無法限制它在自己
 *                          程序內做什麼 —— 它可以讀檔、連網、
 *                          執行任何程式碼。
 *
 * 因此 capability 注入這套機制對 Tier 3 **不適用**。
 * 我方能控制的只有「是否呼叫它」與「傳什麼參數給它」。
 *
 * 這一點必須誠實反映在 UI 上：外部工具的信任等級
 * 本質上等同於「執行一個第三方程式」，與 npm 套件同級。
 */

export type McpServerSpec = {
  /** 顯示名稱，也用於工具改名時的前綴 */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type RemoteTool = {
  /** 本機使用的名稱，可能因衝突而改名 */
  localName: string;
  /** 對方 server 上的原始名稱 */
  remoteName: string;
  serverName: string;
  def: ToolDefinition;
};

/**
 * 已連線的外部 MCP Server。
 *
 * 生命週期由呼叫端管理 —— connect 之後必須 close，
 * 否則子程序會殘留。
 */
export class McpServerConnection {
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools: RemoteTool[] = [];

  constructor(readonly spec: McpServerSpec) {}

  get connected(): boolean {
    return !!this.client;
  }

  get availableTools(): RemoteTool[] {
    return this.tools;
  }

  async connect(opts: { timeoutMs?: number } = {}): Promise<ToolResult<RemoteTool[]>> {
    if (this.client) return ok(this.tools);

    try {
      this.transport = new StdioClientTransport({
        command: this.spec.command,
        args: this.spec.args ?? [],
        env: {
          ...(process.env as Record<string, string>),
          ...(this.spec.env ?? {}),
        },
      });

      this.client = new Client(
        { name: 'arc', version: '0.1.0' },
        { capabilities: {} },
      );

      await withTimeout(
        this.client.connect(this.transport),
        opts.timeoutMs ?? 30_000,
        `connecting to MCP server "${this.spec.name}"`,
      );

      const listed = await this.client.listTools();
      this.tools = listed.tools.map((t) => ({
        localName: t.name,
        remoteName: t.name,
        serverName: this.spec.name,
        def: this.toDefinition(t),
      }));

      return ok(this.tools);
    } catch (err) {
      await this.close();
      return fail('EXECUTION_FAILED', `無法連接 MCP server：${String(err)}`);
    }
  }

  /**
   * 把 MCP 的 Tool 轉為 ARC 的 ToolDefinition。
   *
   * capabilities 一律標為空陣列 —— 外部工具的能力
   * 不受我方控制，宣稱任何值都沒有意義。
   * tier 標為 external，讓 UI 能明確區分信任等級。
   */
  private toDefinition(t: {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: unknown;
  }): ToolDefinition {
    return {
      name: t.name,
      description: t.description ?? `外部工具（來自 ${this.spec.name}）`,
      inputSchema: (t.inputSchema as ToolDefinition['inputSchema']) ?? {
        type: 'object',
      },
      // 空陣列而非猜測 —— 見上方註解
      capabilities: [],
      tier: 'external',
      origin: { kind: 'imported', from: this.spec.name },
      ...(t.title ? { title: t.title } : {}),
      ...(t.outputSchema
        ? { outputSchema: t.outputSchema as ToolDefinition['outputSchema'] }
        : {}),
      ...(t.annotations
        ? { annotations: t.annotations as ToolDefinition['annotations'] }
        : {}),
    };
  }

  async call(
    remoteName: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    if (!this.client) return fail('BROWSER_NOT_READY', 'MCP server 未連線');

    try {
      const res = await withTimeout(
        this.client.callTool({ name: remoteName, arguments: args }),
        opts.timeoutMs ?? 60_000,
        `calling "${remoteName}"`,
      );

      const content = (res.content ?? []) as { type: string; text?: string }[];
      const text = content.map((c) => c.text ?? '').join('');

      if (res.isError) {
        return fail('EXECUTION_FAILED', text || '外部工具回報錯誤');
      }

      return ok(
        (res as { structuredContent?: unknown }).structuredContent ?? text,
      );
    } catch (err) {
      return fail('EXECUTION_FAILED', String(err));
    }
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* 已關閉或連線失敗 */
    }
    this.client = undefined;
    this.transport = undefined;
    this.tools = [];
  }
}

/** 外部工具在本機的能力宣告。永遠為空 —— 我方無法限制對方程序。 */
export const EXTERNAL_TOOL_CAPABILITIES: readonly Capability[] = [];

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms while ${what}`)),
      ms,
    );
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
