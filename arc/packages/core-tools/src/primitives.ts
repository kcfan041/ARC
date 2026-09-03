import type { ToolDefinition } from '@arc/core-model';
import { fail, ok, READ_ONLY_CAPABILITIES, TOOL_LIMITS } from '@arc/core-model';
import {
  ToolRegistry,
  searchTools,
  summarise,
  type ToolHandler,
} from '@arc/tool-runtime';
import type { InvestigationSession } from './session.js';

/**
 * 內建原語工具
 *
 * 職責切分：
 *   Session   持有資源（瀏覽器、訂閱、計時器）與事件串流
 *   原語工具  向 Session 取資源，本身無狀態
 *
 * 每個原語都有完整簽章（inputSchema / outputSchema /
 * capabilities / annotations），這正是 REVIEW.md C3 要求的東西。
 *
 * 注意 annotations 與 capabilities 的分工：
 *   annotations   不可信自述，僅供 UI 與 LLM 參考
 *   capabilities  強制機制，決定執行時注入什麼
 */

type Def = Omit<ToolDefinition, 'tier' | 'origin'>;

function builtin(def: Def): ToolDefinition {
  return { ...def, tier: 'primitive', origin: { kind: 'builtin' } };
}

/** 依 TOOL_LIMITS 截斷列表，並回報截斷資訊 */
function paged<T>(items: T[], args: Record<string, unknown>) {
  const limit = Math.min(
    Number(args.limit) || TOOL_LIMITS.defaultPageSize,
    1000,
  );
  const offset = Number(args.offset) || 0;
  const page = items.slice(offset, offset + limit);
  const nextIndex = offset + page.length;
  return nextIndex < items.length
    ? ok(page, {
        reason: 'count_limit' as const,
        returned: page.length,
        total: items.length,
        cursor: String(nextIndex),
      })
    : ok(page);
}

const PAGE_ARGS = {
  limit: { type: 'number', description: '回傳筆數上限', default: 100 },
  offset: { type: 'number', description: '起始位置', default: 0 },
};

/** 未擷取到內容時的說明。這些都是正常結果，不是錯誤。 */
const BODY_STATUS_REASON: Record<string, string> = {
  'budget-exceeded': '已達本次工作階段的儲存上限，之後的回應內容未擷取',
  skipped: '此類型預設不擷取（例如串流影片的分段檔）',
  unavailable: '瀏覽器已無法提供此回應內容（可能來自快取或已被清除）',
};

/** 判斷 MIME 是否為文字類。二進位內容不直接回傳原始資料。 */
function isTextualMime(mime: string): boolean {
  if (!mime) return false;
  if (mime.startsWith('text/')) return true;
  return /(json|javascript|xml|x-www-form-urlencoded|graphql)/i.test(mime);
}

/**
 * 註冊所有內建原語，並提供 capability 實作。
 *
 * capability 提供者是 Registry 用來建立受限作用域的來源 ——
 * 工具宣告 'network.replay'，就只拿得到這裡 network.replay 底下的函式。
 */
export function registerPrimitives(
  registry: ToolRegistry,
  session: InvestigationSession,
): void {
  // ── capability 提供者 ────────────────────────────────
  registry.provide({
    'session.read': {
      listFlows: () => session.flows,
      listActions: () => session.actions,
      getFlow: (id: string) => session.flows.find((f) => f.id === id),
      getBindings: () => session.bindings(),
      getStatus: () => session.status(),
    },
    'browser.navigate': {
      goto: (url: string) => session.goto(url),
    },
    'network.replay': {
      replay: (flowId: string, changes: Record<string, unknown>) =>
        session.replay(flowId, changes),
    },
  });

  // ── 原語工具 ────────────────────────────────────────
  const tools: [ToolDefinition, ToolHandler][] = [
    [
      builtin({
        name: 'session_status',
        title: 'Session 狀態',
        description:
          '取得目前調查工作階段的狀態：是否錄製中、頁面網址、' +
          '已記錄的操作與請求數量，以及被綁定策略過濾掉的請求數。',
        inputSchema: { type: 'object', properties: {} },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true, idempotentHint: true },
      }),
      () => ok(session.status()),
    ],

    [
      builtin({
        name: 'action_list',
        title: '列出使用者操作',
        description:
          '列出已記錄的使用者操作（點擊、輸入、送出等），' +
          '依發生時間排序。這是 Timeline 的資料來源。',
        inputSchema: { type: 'object', properties: PAGE_ARGS },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true },
      }),
      (args) => paged(session.actions, args),
    ],

    [
      builtin({
        name: 'network_list',
        title: '列出網路請求',
        description:
          '列出已記錄的網路請求。可依網址片段、HTTP 方法、資源類型過濾。' +
          '預設只回傳有綁定到某個使用者操作的請求；' +
          'includeUnbound 設為 true 可一併取得輪詢與預載等背景請求。',
        inputSchema: {
          type: 'object',
          properties: {
            urlContains: { type: 'string', description: '網址須包含的字串' },
            method: { type: 'string', description: 'HTTP 方法' },
            resourceType: {
              type: 'string',
              description: '資源類型，例如 XHR、Fetch、Document',
            },
            includeUnbound: {
              type: 'boolean',
              description: '是否包含未綁定到操作的請求（輪詢、預載等）',
              default: false,
            },
            ...PAGE_ARGS,
          },
        },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true },
      }),
      (args) => {
        let flows = session.flows;
        if (!args.includeUnbound) {
          const bound = new Set(session.bindings().flatMap((b) => b.flowIds));
          flows = flows.filter((f) => bound.has(f.id));
        }
        if (args.urlContains) {
          const needle = String(args.urlContains);
          flows = flows.filter((f) => f.url.includes(needle));
        }
        if (args.method) {
          const m = String(args.method).toUpperCase();
          flows = flows.filter((f) => f.method.toUpperCase() === m);
        }
        if (args.resourceType) {
          flows = flows.filter((f) => f.resourceType === args.resourceType);
        }
        return paged(flows, args);
      },
    ],

    [
      builtin({
        name: 'network_get',
        title: '取得單一請求',
        description:
          '取得單一網路請求的完整資訊，包含 initiator call stack ——' +
          '也就是發出這個請求的 JavaScript 呼叫堆疊。',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: { type: 'string', description: '請求識別碼，例如 flow_12' },
          },
          required: ['flowId'],
        },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true, idempotentHint: true },
      }),
      (args) => {
        const f = session.flows.find((x) => x.id === args.flowId);
        return f ? ok(f) : fail('NOT_FOUND', `no such flow: ${args.flowId}`);
      },
    ],

    [
      builtin({
        name: 'network_get_body',
        title: '取得回應內容',
        description:
          '取得某個請求的回應內容。這是查看 API 實際回傳什麼資料的方式。' +
          '文字類內容（JSON、HTML、JavaScript）會直接回傳；' +
          '二進位內容（圖片、影片）只回報大小與類型，不回傳內容本身。' +
          '若回應未被擷取，會說明原因。',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: { type: 'string', description: '請求識別碼，例如 flow_12' },
            maxBytes: {
              type: 'number',
              description: '回傳的最大字元數，超過則截斷',
              default: 64 * 1024,
            },
          },
          required: ['flowId'],
        },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true, idempotentHint: true },
      }),
      (args) => {
        const flow = session.flows.find((x) => x.id === args.flowId);
        if (!flow) return fail('NOT_FOUND', `no such flow: ${args.flowId}`);

        const body = flow.body;
        if (!body) {
          return ok({
            flowId: flow.id,
            available: false,
            reason: '此請求尚未完成，或回應內容未被擷取',
          });
        }

        if (body.status !== 'captured' && body.status !== 'truncated') {
          return ok({
            flowId: flow.id,
            available: false,
            captureStatus: body.status,
            reason: BODY_STATUS_REASON[body.status],
            ...(body.size !== undefined ? { size: body.size } : {}),
          });
        }

        const raw = body.hash ? session.getBody(body.hash) : undefined;
        if (!raw) {
          return ok({
            flowId: flow.id,
            available: false,
            reason: '內容參照存在但檔案已不可讀取',
          });
        }

        const mime = flow.response?.mimeType ?? '';
        // 二進位內容不回傳原始位元組 —— 對 LLM 無意義，
        // 且 base64 會膨脹 33% 佔滿 context
        if (body.base64 && !isTextualMime(mime)) {
          return ok({
            flowId: flow.id,
            available: true,
            binary: true,
            mimeType: mime,
            size: body.size,
            hash: body.hash,
            note: '二進位內容，未回傳原始資料。可用 hash 從專案目錄取得。',
          });
        }

        const limit = Number(args.maxBytes) || 64 * 1024;
        const text = raw.toString('utf8');
        const clipped = text.length > limit;

        return ok({
          flowId: flow.id,
          available: true,
          mimeType: mime,
          size: body.size,
          captureStatus: body.status,
          truncated: clipped || body.status === 'truncated',
          content: clipped ? text.slice(0, limit) : text,
        });
      },
    ],

    [
      builtin({
        name: 'action_get_effects',
        title: '查詢操作造成的後果',
        description:
          '給定一個使用者操作，回傳它觸發了哪些網路請求。' +
          '這是 ARC 的核心能力 —— 瀏覽器開發者工具的 Recorder 面板' +
          '與 Network 面板彼此不互通，無法回答這個問題。',
        inputSchema: {
          type: 'object',
          properties: {
            actionId: { type: 'string', description: '操作識別碼，例如 action_3' },
          },
          required: ['actionId'],
        },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true, idempotentHint: true },
      }),
      (args) => {
        const action = session.actions.find((a) => a.id === args.actionId);
        if (!action) {
          return fail('NOT_FOUND', `no such action: ${args.actionId}`);
        }
        const binding = session
          .bindings()
          .find((b) => b.actionId === args.actionId);
        const flows = (binding?.flowIds ?? [])
          .map((id) => session.flows.find((f) => f.id === id))
          .filter((f): f is NonNullable<typeof f> => !!f);
        return ok({ action, flows, strategy: binding?.strategy });
      },
    ],

    [
      builtin({
        name: 'browser_goto',
        title: '前往網址',
        description: '讓錄製中的瀏覽器導航至指定網址。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '目標網址' } },
          required: ['url'],
        },
        capabilities: ['browser.navigate'],
        // 導航會改變頁面狀態，但不具破壞性
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      async (args) => {
        if (!session.status().recording) {
          return fail('BROWSER_NOT_READY', 'session not started');
        }
        await session.goto(String(args.url));
        return ok({ url: args.url });
      },
    ],

    [
      builtin({
        name: 'find_tools',
        title: '尋找工具',
        description:
          '依用途搜尋可用的工具。當你需要的操作不在目前可見的工具清單中時，' +
          '用自然語言描述你想做什麼，例如「抓取分頁資料」或「找出影片網址」。' +
          '回傳的是工具摘要；取得名稱後即可直接呼叫該工具。',
        inputSchema: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              description: '想完成的事，用自然語言描述',
            },
            limit: { type: 'number', description: '回傳筆數上限', default: 10 },
          },
          required: ['intent'],
        },
        capabilities: ['session.read'],
        annotations: { readOnlyHint: true, idempotentHint: true },
      }),
      (args) => {
        const listed = registry.list({ limit: 10_000 });
        if (!listed.ok) return listed;

        const hits = searchTools(listed.data, String(args.intent ?? ''), {
          limit: Number(args.limit) || 10,
        });

        return ok(
          hits.map((h) => ({
            ...summarise(h.def, READ_ONLY_CAPABILITIES),
            score: h.score,
          })),
        );
      },
    ],
  ];

  for (const [def, handler] of tools) registry.register(def, handler);
}
