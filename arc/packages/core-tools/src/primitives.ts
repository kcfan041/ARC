import type {
  StorageChange,
  StorageSnapshot,
  ToolDefinition,
} from '@arc/core-model';
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
 * storage_diff 的基準點。
 *
 * 以模組層級變數保存 —— 這是刻意的取捨：diff 的語意是
 * 「與上次觀察相比」，屬於工具的使用脈絡而非 session 狀態。
 * 若日後需要多個獨立的觀察序列，應改為由呼叫端傳入具名基準。
 */
let storageBaseline: StorageSnapshot | undefined;

/** 比較兩份儲存快照 */
function diffStorage(
  before: StorageSnapshot,
  after: StorageSnapshot,
): StorageChange[] {
  const changes: StorageChange[] = [];

  const compare = (
    area: StorageChange['area'],
    a: Record<string, string>,
    b: Record<string, string>,
  ) => {
    for (const [k, v] of Object.entries(b)) {
      if (!(k in a)) changes.push({ area, key: k, kind: 'added', after: v });
      else if (a[k] !== v)
        changes.push({ area, key: k, kind: 'changed', before: a[k], after: v });
    }
    for (const k of Object.keys(a)) {
      if (!(k in b))
        changes.push({ area, key: k, kind: 'removed', before: a[k] });
    }
  };

  // cookie 以 name 為鍵。同名不同 domain 的情況少見，
  // 且對「追查 token 存到哪」的用途影響不大。
  const cookieMap = (list: StorageSnapshot['cookies']) =>
    Object.fromEntries(list.map((c) => [c.name, c.value]));
  compare('cookie', cookieMap(before.cookies), cookieMap(after.cookies));
  compare('localStorage', before.localStorage, after.localStorage);
  compare('sessionStorage', before.sessionStorage, after.sessionStorage);

  return changes;
}

/**
 * 把 Playwright 的錯誤轉為可理解的說明。
 *
 * 原始訊息含大量堆疊與內部細節，對 LLM 是雜訊，
 * 且會佔用 context。
 */
function describeUiError(err: unknown): string {
  const msg = String(err);
  if (/Timeout .* exceeded/i.test(msg)) {
    return '找不到符合的元素，或元素在時限內未變為可互動。可先用 page_interactables 確認頁面上有什麼。';
  }
  if (/strict mode violation/i.test(msg)) {
    return '定位條件符合多個元素，請改用更精確的 selector。';
  }
  if (/not visible|outside of the viewport/i.test(msg)) {
    return '元素存在但不可見，可能被遮蔽或需要先捲動。';
  }
  if (/session not started/i.test(msg)) {
    return '瀏覽器尚未啟動。';
  }
  return msg.split('\n')[0] ?? msg;
}

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
    'storage.read': {
      getStorage: () => session.storage(),
    },
    'browser.interact': {
      click: (target: { selector?: string; text?: string }) =>
        session.click(target),
      fill: (selector: string, value: string) => session.fill(selector, value),
      press: (key: string, selector?: string) => session.press(key, selector),
      listInteractables: (limit?: number) => session.interactables(limit),
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
        name: 'storage_get',
        title: '讀取瀏覽器儲存',
        description:
          '讀取目前的 cookie、localStorage 與 sessionStorage。' +
          'cookie 經由瀏覽器 context 取得，因此涵蓋 HttpOnly 項目 ——' +
          '而登入 token 常常正是 HttpOnly，網頁自身的 JavaScript 看不到。' +
          '這是追查「token 存到哪裡」的主要工具。',
        inputSchema: { type: 'object', properties: {} },
        capabilities: ['storage.read'],
        annotations: { readOnlyHint: true, idempotentHint: true },
      }),
      async () => ok(await session.storage()),
    ],

    [
      builtin({
        name: 'storage_diff',
        title: '比較儲存狀態變化',
        description:
          '比較目前的儲存狀態與先前記錄的基準，列出新增、修改與刪除的項目。' +
          '典型用法是在某個操作前後各呼叫一次，' +
          '藉此確認該操作把什麼寫進了 cookie 或 localStorage。' +
          '未提供基準時，會以本工具上次呼叫的結果為基準。',
        inputSchema: {
          type: 'object',
          properties: {
            reset: {
              type: 'boolean',
              description: '只重設基準而不比較，用於標記觀察起點',
              default: false,
            },
          },
        },
        capabilities: ['storage.read'],
        annotations: { readOnlyHint: true },
      }),
      async (args) => {
        const now = await session.storage();
        const base = storageBaseline;
        storageBaseline = now;

        if (args.reset || !base) {
          return ok({
            baselineSet: true,
            changes: [],
            note: base ? '基準已重設' : '首次呼叫，已建立基準',
          });
        }
        return ok({ changes: diffStorage(base, now), since: base.at });
      },
    ],

    [
      builtin({
        name: 'page_interactables',
        title: '列出可互動元素',
        description:
          '列出頁面上可點擊與可輸入的元素，含建議的定位方式。' +
          '不回傳完整 DOM —— 那對複雜網站可能有數 MB。' +
          '用於決定下一步要點什麼或填什麼。',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '回傳筆數上限', default: 60 },
          },
        },
        capabilities: ['browser.interact'],
        annotations: { readOnlyHint: true },
      }),
      async (args) => {
        const limit = Math.min(Number(args.limit) || 60, 300);
        return ok(await session.interactables(limit));
      },
    ],

    [
      builtin({
        name: 'browser_click',
        title: '點擊元素',
        description:
          '點擊頁面上的元素，可用 CSS selector 或可見文字定位。' +
          '此操作會改變頁面狀態，並可能觸發網路請求 ——' +
          '點擊後可用 action_get_effects 查看它導致了什麼。',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' },
            text: { type: 'string', description: '元素的可見文字' },
          },
        },
        capabilities: ['browser.interact'],
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      async (args) => {
        try {
          await session.click({
            ...(args.selector ? { selector: String(args.selector) } : {}),
            ...(args.text ? { text: String(args.text) } : {}),
          });
          return ok({ clicked: args.selector ?? args.text });
        } catch (err) {
          return fail('EXECUTION_FAILED', describeUiError(err));
        }
      },
    ],

    [
      builtin({
        name: 'browser_fill',
        title: '填入欄位',
        description: '在表單欄位中填入文字。會先清空既有內容。',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' },
            value: { type: 'string', description: '要填入的文字' },
          },
          required: ['selector', 'value'],
        },
        capabilities: ['browser.interact'],
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      async (args) => {
        try {
          await session.fill(String(args.selector), String(args.value));
          return ok({ filled: args.selector });
        } catch (err) {
          return fail('EXECUTION_FAILED', describeUiError(err));
        }
      },
    ],

    [
      builtin({
        name: 'browser_press',
        title: '按鍵',
        description:
          '按下鍵盤按鍵，例如 Enter 送出表單。' +
          '給定 selector 時會先聚焦該元素。',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: '按鍵名稱，例如 Enter、Escape、Tab',
            },
            selector: { type: 'string', description: '要先聚焦的元素' },
          },
          required: ['key'],
        },
        capabilities: ['browser.interact'],
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      async (args) => {
        try {
          await session.press(
            String(args.key),
            args.selector ? String(args.selector) : undefined,
          );
          return ok({ pressed: args.key });
        } catch (err) {
          return fail('EXECUTION_FAILED', describeUiError(err));
        }
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
