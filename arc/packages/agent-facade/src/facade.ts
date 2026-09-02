import type { Capability, ToolDefinition, ToolResult } from '@arc/core-model';
import { AGENT_DEFAULT_CAPABILITIES } from '@arc/tool-runtime';
import { redact, type Redaction } from './redact.js';
import type {
  ChatMessage,
  LlmProvider,
  ToolCall,
} from './provider.js';

/**
 * Agent Facade —— LLM 的受限介面
 *
 * 對應 MVP1-PLAN.md 3.7：
 *   agent 不得直接使用 core-tools，必須經由 agent-facade。
 *   這是「限制只作用於 LLM、不作用於人工」的結構性保證。
 *
 * 兩條 LLM 路徑都走這裡：
 *   內部  GUI 側邊欄     → agent-facade → registry
 *   外部  Claude Desktop → MCP Server  → agent-facade → registry
 *
 * 因此外部 MCP client 與 GUI 側邊欄拿到的能力完全一致 ——
 * 兩者都沒有 browser.eval。
 *
 * ── 這一層做三件事 ────────────────────────────────────
 *
 *   1. 能力收窄   只暴露 allowedCapabilities 範圍內的工具
 *   2. 遮蔽       所有送往 LLM 的內容先經過 redact()
 *   3. 迴圈       工具呼叫的往返，含次數上限
 *
 * 刪除本套件後，GUI 與 CLI 完全不受影響。
 */

/** facade 需要的最小宿主介面。刻意不依賴 core-tools 的具體型別。 */
export interface ToolHost {
  listTools(opts: {
    allowedCapabilities?: ReadonlySet<Capability>;
    domain?: string;
  }): ToolResult<ToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { allowedCapabilities?: ReadonlySet<Capability> },
  ): Promise<ToolResult>;
}

export type FacadeOptions = {
  /** 預設不含 browser.eval，見 MVP1-PLAN 3.4 */
  allowedCapabilities?: ReadonlySet<Capability>;
  /** 單次對話最多往返幾輪工具呼叫 */
  maxToolRounds?: number;
  /** 是否遮蔽送往 LLM 的內容。關閉需明示，且應記錄。 */
  redactOutbound?: boolean;
  /** 只暴露符合此網域的工具，控制 context 大小 */
  domain?: string;
};

export type AgentTurn = {
  /** LLM 的最終文字回覆 */
  content: string;
  /** 本次對話中實際執行的工具 */
  toolCalls: {
    name: string;
    arguments: Record<string, unknown>;
    result: ToolResult;
  }[];
  /** 遮蔽記錄。留在宿主端，供 UI 的「查看原值」使用。 */
  redactions: Redaction[];
  rounds: number;
  stoppedReason?: 'max_rounds' | 'error';
};

const SYSTEM_PROMPT = `你是 ARC 的分析助理。ARC 是一套網站調查工具，
會記錄使用者在瀏覽器中的操作，以及每個操作觸發了哪些網路請求。

工作原則：

1. 一切結論都必須基於工具回傳的實際資料。
   不要憑空產生網址、參數名稱或 header 值。
   若資料不足以回答，就說明還需要什麼。

2. 引用具體的識別碼（例如 flow_12、action_3），
   讓使用者可以點回去核對原始資料。

3. 你看到的內容可能含有 [已遮蔽:type#id] 標記，
   那是被移除的憑證或個資。不要嘗試猜測其內容，
   必要時告訴使用者哪一項需要人工查看。

4. 回答要簡短具體。使用者多半在追查某個特定行為。`;

export class AgentFacade {
  private readonly allowed: ReadonlySet<Capability>;
  private readonly maxRounds: number;
  private readonly shouldRedact: boolean;
  private readonly domain?: string;

  constructor(
    private readonly host: ToolHost,
    private readonly provider: LlmProvider,
    opts: FacadeOptions = {},
  ) {
    this.allowed = opts.allowedCapabilities ?? AGENT_DEFAULT_CAPABILITIES;
    this.maxRounds = opts.maxToolRounds ?? 8;
    this.shouldRedact = opts.redactOutbound ?? true;
    if (opts.domain) this.domain = opts.domain;
  }

  /** LLM 可見的工具清單。已套用能力收窄與作用域過濾。 */
  availableTools(): ToolDefinition[] {
    const res = this.host.listTools({
      allowedCapabilities: this.allowed,
      ...(this.domain ? { domain: this.domain } : {}),
    });
    return res.ok ? res.data : [];
  }

  /**
   * 執行一輪對話，含工具呼叫往返。
   *
   * 迴圈在以下情況結束：
   *   - LLM 不再要求呼叫工具
   *   - 達到 maxRounds 上限
   */
  async ask(userMessage: string, history: ChatMessage[] = []): Promise<AgentTurn> {
    const tools = this.availableTools();
    const executed: AgentTurn['toolCalls'] = [];
    const allRedactions: Redaction[] = [];

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userMessage },
    ];

    let rounds = 0;
    let stoppedReason: AgentTurn['stoppedReason'];

    while (rounds < this.maxRounds) {
      rounds += 1;

      const res = await this.provider.chat({ messages, tools });

      if (res.toolCalls.length === 0) {
        return {
          content: res.content,
          toolCalls: executed,
          redactions: allRedactions,
          rounds,
        };
      }

      messages.push({
        role: 'assistant',
        content: res.content,
        toolCalls: res.toolCalls,
      });

      for (const call of res.toolCalls) {
        const result = await this.runTool(call);
        executed.push({
          name: call.name,
          arguments: call.arguments,
          result,
        });

        // ★ 遮蔽發生在這裡 —— 工具結果進入對話之前
        const payload = result.ok ? result.data : { error: result.error };
        const { value, redactions } = this.shouldRedact
          ? redact(payload)
          : { value: payload, redactions: [] as Redaction[] };
        allRedactions.push(...redactions);

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: truncate(JSON.stringify(value)),
        });
      }
    }

    stoppedReason = 'max_rounds';
    return {
      content:
        '已達到工具呼叫次數上限。目前取得的資料可能不完整，' +
        '請縮小問題範圍後再試。',
      toolCalls: executed,
      redactions: allRedactions,
      rounds,
      stoppedReason,
    };
  }

  private async runTool(call: ToolCall): Promise<ToolResult> {
    try {
      return await this.host.callTool(call.name, call.arguments, {
        allowedCapabilities: this.allowed,
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'EXECUTION_FAILED',
          message: String(err),
          retryable: false,
        },
      };
    }
  }
}

/**
 * 截斷過長的工具結果。
 *
 * 對應原規格書 §37 的 context 控制 ——
 * 一個 response body 可能有數 MB，不能整包送進 prompt。
 */
function truncate(s: string, limit = 24_000): string {
  if (s.length <= limit) return s;
  return (
    s.slice(0, limit) +
    `\n…（已截斷，原始長度 ${s.length} 字元。請用更精確的參數縮小範圍。）`
  );
}
