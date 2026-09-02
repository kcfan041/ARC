import type { ToolDefinition } from '@arc/core-model';

/**
 * LLM Provider 抽象
 *
 * 對應 REVIEW.md M5（「沒有任何介面設計」）。
 *
 * 支援 Anthropic 與 OpenAI 兩種格式。兩者的 tool calling
 * 在結構上略有差異，抽象層把差異收在這裡：
 *
 *   OpenAI      tools[].function.{name,description,parameters}
 *               回應在 message.tool_calls[]
 *   Anthropic   tools[].{name,description,input_schema}
 *               回應在 content[] 中 type=tool_use 的項目
 *
 * API key 一律從環境變數取得，不寫進任何專案檔案 ——
 * 避免誤提交進版控。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** assistant 要求呼叫工具時填入 */
  toolCalls?: ToolCall[];
  /** role=tool 時，對應的呼叫 id */
  toolCallId?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
};

export type ChatResponse = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type ProviderConfig = {
  kind: 'openai' | 'anthropic';
  model: string;
  /** 自訂端點。本地 proxy 或相容服務用。 */
  baseUrl?: string;
  /** 明確指定金鑰。未給則從環境變數取得。 */
  apiKey?: string;
  timeoutMs?: number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 相容格式。本地 proxy 與多數第三方服務皆採此介面。 */
class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(readonly model: string, cfg: Omit<ProviderConfig, 'kind' | 'model'>) {
    this.baseUrl = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    if (!this.apiKey) {
      throw new Error(
        'OpenAI API key not found. Set OPENAI_API_KEY or pass apiKey.',
      );
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.toolCalls?.length) {
        return {
          role: m.role,
          content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.arguments) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      max_tokens: req.maxTokens ?? 2048,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const raw = (await postJson(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      body,
      this.timeoutMs,
    )) as {
      choices: {
        message: {
          content?: string | null;
          tool_calls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = raw.choices?.[0];
    const msg = choice?.message ?? {};

    return {
      content: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((t) => ({
        id: t.id,
        name: t.function.name,
        arguments: safeParse(t.function.arguments),
      })),
      finishReason: choice?.finish_reason ?? 'stop',
      ...(raw.usage
        ? {
            usage: {
              promptTokens: raw.usage.prompt_tokens,
              completionTokens: raw.usage.completion_tokens,
            },
          }
        : {}),
    };
  }
}

/** Anthropic Messages API */
class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(readonly model: string, cfg: Omit<ProviderConfig, 'kind' | 'model'>) {
    this.baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    if (!this.apiKey) {
      throw new Error(
        'Anthropic API key not found. Set ANTHROPIC_API_KEY or pass apiKey.',
      );
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Anthropic 把 system 抽成獨立欄位，不放在 messages 內
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId,
                content: m.content,
              },
            ],
          };
        }
        if (m.toolCalls?.length) {
          const blocks: unknown[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const t of m.toolCalls) {
            blocks.push({
              type: 'tool_use',
              id: t.id,
              name: t.name,
              input: t.arguments,
            });
          }
          return { role: 'assistant', content: blocks };
        }
        return { role: m.role, content: m.content };
      });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: req.maxTokens ?? 2048,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const raw = (await postJson(
      `${this.baseUrl}/messages`,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      this.timeoutMs,
    )) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const text = raw.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    const toolCalls = raw.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? '',
        name: b.name ?? '',
        arguments: (b.input ?? {}) as Record<string, unknown>,
      }));

    return {
      content: text,
      toolCalls,
      finishReason: raw.stop_reason ?? 'end_turn',
      ...(raw.usage
        ? {
            usage: {
              promptTokens: raw.usage.input_tokens,
              completionTokens: raw.usage.output_tokens,
            },
          }
        : {}),
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createProvider(cfg: ProviderConfig): LlmProvider {
  const { kind, model, ...rest } = cfg;
  return kind === 'anthropic'
    ? new AnthropicProvider(model, rest)
    : new OpenAiProvider(model, rest);
}

/**
 * 從環境變數建立 provider。
 *
 *   ARC_LLM_KIND      openai | anthropic（預設 openai）
 *   ARC_LLM_MODEL     模型名稱
 *   ARC_LLM_BASE_URL  自訂端點
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY
 */
export function providerFromEnv(): LlmProvider | undefined {
  const kind = (process.env.ARC_LLM_KIND ?? 'openai') as ProviderConfig['kind'];
  const key =
    kind === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;
  if (!key) return undefined;

  return createProvider({
    kind,
    model: process.env.ARC_LLM_MODEL ?? 'default',
    ...(process.env.ARC_LLM_BASE_URL
      ? { baseUrl: process.env.ARC_LLM_BASE_URL }
      : {}),
  });
}
