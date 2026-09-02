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
