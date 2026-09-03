import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  ActionKind,
  ActionRecord,
  ClockCalibration,
  FlowInitiator,
  FlowRecord,
} from '@arc/core-model';
import { extractMarker, wallTimeToEpochMs } from '@arc/core-model';
import { ACTION_BINDING, buildInjectScript } from './inject.js';
import {
  CaptureBudget,
  DEFAULT_CAPTURE,
  isStreamSegment,
  type CaptureOptions,
} from './capture.js';

/**
 * 錄製器：Playwright 起 Chromium，CDP 收 Network，注入腳本收 Action。
 *
 * 為何 Network 必須走 CDP：
 *   Playwright 的 page.on('request') 不提供 initiator stack。
 *   而 initiator 是策略 B/C 的核心依據，也是 MVP2 position mapping
 *   的起點（REVIEW.md T1）。
 *
 * 已知副作用：
 *   exposeBinding 會在頁面新增一個全域函式，理論上可被偵測。
 *   S1 階段接受。若日後需規避，改用 CDP 的
 *   Runtime.addBinding + Runtime.bindingCalled（不留全域痕跡）。
 */

export type RecorderOptions = {
  headless?: boolean;
  /** 是否開啟 async call stack（會拖慢頁面，見 REVIEW.md T1 討論） */
  asyncStackDepth?: number;
  /** Response body 擷取策略。見 capture.ts。 */
  capture?: CaptureOptions;
  /**
   * body 的儲存位置。
   *
   * 傳入 content-addressed 儲存器（通常是 ProjectStore.putObject），
   * 讓 recorder 不需要知道專案目錄的存在 ——
   * 那是 core-store 的職責。
   */
  putObject?: (content: Buffer, mime?: string, url?: string) => string;
};

export type RecordingSession = {
  page: Page;
  context: BrowserContext;
  actions: ActionRecord[];
  flows: FlowRecord[];
  /** 時基校準樣本：只有同時具備 monotonic 與 wallTime 的事件才會產生 */
  calibrations: ClockCalibration[];
  /** Response body 的擷取預算使用情況 */
  budget: CaptureBudget;
  /**
   * 未提供 putObject 時，body 暫存於此（以雜湊為鍵）。
   * 有專案目錄時為空 —— 內容直接進 objects/。
   */
  bodies: Map<string, Buffer>;
  close: () => Promise<void>;
};

const VALID_KINDS = new Set<ActionKind>([
  'click',
  'input',
  'change',
  'submit',
  'keydown',
  'scroll',
]);

export async function startRecording(
  opts: RecorderOptions = {},
): Promise<RecordingSession> {
  const browser: Browser = await chromium.launch({
    headless: opts.headless ?? false,
  });
  const context = await browser.newContext();

  const actions: ActionRecord[] = [];
  const flows: FlowRecord[] = [];
  const calibrations: ClockCalibration[] = [];

  // ── Action 收集 ───────────────────────────────────────────
  let actionSeq = 0;
  await context.exposeBinding(ACTION_BINDING, (_source, raw: unknown) => {
    const p = raw as Record<string, unknown>;
    const kind = String(p.kind ?? '') as ActionKind;
    if (!VALID_KINDS.has(kind)) return;
    actionSeq += 1;
    const target = (p.target ?? {}) as Record<string, unknown>;
    actions.push({
      id: `action_${actionSeq}`,
      kind,
      at: Number(p.at ?? Date.now()),
      pageUrl: String(p.pageUrl ?? ''),
      target: {
        selector: String(target.selector ?? ''),
        tag: String(target.tag ?? 'unknown'),
        ...(target.text ? { text: String(target.text) } : {}),
        ...(target.id ? { id: String(target.id) } : {}),
        ...(target.name ? { name: String(target.name) } : {}),
        ...(target.role ? { role: String(target.role) } : {}),
        ...(target.type ? { type: String(target.type) } : {}),
      },
    });
  });

  await context.addInitScript(buildInjectScript(ACTION_BINDING));

  const page = await context.newPage();

  // ── Network 收集（CDP）─────────────────────────────────────
  const cap = { ...DEFAULT_CAPTURE, ...(opts.capture ?? {}) };
  const budget = new CaptureBudget(cap);
  const bodies = new Map<string, Buffer>();

  const cdp = await context.newCDPSession(page);

  // 緩衝區必須「大於」截斷上限，不能等於它。
  //
  // 實測發現：若緩衝區設成 maxBodyBytes，超過該值的內容會在
  // getResponseBody 之前就被 Chromium 逐出，結果是整個取不到
  // （unavailable）而非被截斷（truncated）—— 也就是說，
  // 想截斷保留前半段的意圖反而導致完全失去內容。
  //
  // 因此緩衝區獨立配置，並保留餘裕。代價是瀏覽器記憶體佔用。
  await cdp.send('Network.enable', {
    maxResourceBufferSize: Math.min(
      Math.max(cap.maxBodyBytes * 2, 16 * 1024 * 1024),
      64 * 1024 * 1024,
    ),
    maxTotalBufferSize: Math.min(
      Math.max(cap.maxTotalBytes, 128 * 1024 * 1024),
      512 * 1024 * 1024,
    ),
  });

  if (opts.asyncStackDepth && opts.asyncStackDepth > 0) {
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.setAsyncCallStackDepth', {
      maxDepth: opts.asyncStackDepth,
    });
  }

  let flowSeq = 0;
  // redirect 會沿用同一個 requestId，需記錄已見次數以標示 redirectIndex
  const seenRequestIds = new Map<string, number>();
  // requestId → flow，供 response 事件回填
  const flowByRequestId = new Map<string, FlowRecord>();

  cdp.on('Network.requestWillBeSent', (e: Record<string, any>) => {
    const requestId = String(e.requestId);
    const redirectIndex = seenRequestIds.get(requestId) ?? 0;
    seenRequestIds.set(requestId, redirectIndex + 1);

    // wallTime 只在 requestWillBeSent 提供，是時基校準的來源
    if (typeof e.wallTime === 'number' && typeof e.timestamp === 'number') {
      calibrations.push({
        cdpMonotonicSec: e.timestamp,
        epochMs: wallTimeToEpochMs(e.wallTime),
      });
    }

    const at =
      typeof e.wallTime === 'number' ? wallTimeToEpochMs(e.wallTime) : Date.now();

    const url = String(e.request?.url ?? '');
    flowSeq += 1;

    const initiator: FlowInitiator = {
      type: (e.initiator?.type ?? 'other') as FlowInitiator['type'],
      ...(e.initiator?.stack ? { stack: e.initiator.stack } : {}),
      ...(e.initiator?.url ? { url: String(e.initiator.url) } : {}),
      ...(typeof e.initiator?.lineNumber === 'number'
        ? { lineNumber: e.initiator.lineNumber }
        : {}),
    };

    const marker = extractMarker(url);

    const flow: FlowRecord = {
      id: `flow_${flowSeq}`,
      requestId,
      url,
      method: String(e.request?.method ?? 'GET'),
      ...(e.type ? { resourceType: String(e.type) } : {}),
      at,
      initiator,
      redirectIndex,
      ...(e.request?.headers
        ? { requestHeaders: e.request.headers as Record<string, string> }
        : {}),
      ...(marker ? { marker } : {}),
    };

    flows.push(flow);
    // redirect 時同一個 requestId 會重複出現，後續的 response
    // 屬於最後一次請求，因此覆蓋而非保留第一次
    flowByRequestId.set(requestId, flow);
  });

  // ── Response metadata ─────────────────────────────────────
  cdp.on('Network.responseReceived', (e: Record<string, any>) => {
    const flow = flowByRequestId.get(String(e.requestId));
    if (!flow) return;

    const r = e.response ?? {};
    // headers 用合併 —— ExtraInfo 常先抵達且帶有 Set-Cookie
    // 之類的受保護欄位，直接覆寫會把它們清掉
    flow.response = {
      ...(flow.response ?? {}),
      status: Number(r.status ?? 0),
      ...(r.statusText ? { statusText: String(r.statusText) } : {}),
      ...(r.mimeType ? { mimeType: String(r.mimeType) } : {}),
      ...(r.fromDiskCache || r.fromPrefetchCache ? { fromCache: true } : {}),
      headers: {
        ...(flow.response?.headers ?? {}),
        ...((r.headers as Record<string, string>) ?? {}),
      },
    };
  });

  // ── 原始 headers（含 Set-Cookie）──────────────────────────
  //
  // Chromium 刻意把 Set-Cookie 之類的受保護 header 從
  // responseReceived 中排除。原始值只出現在 ExtraInfo 事件裡。
  //
  // 對逆向分析而言這正是關鍵資訊 —— 追查 token 存到哪裡、
  // 後續請求怎麼帶，都需要看到 Set-Cookie。
  // 實測發現 ExtraInfo 通常「早於」responseReceived 抵達，
  // 因此兩邊都必須用合併而非覆寫，否則後到者會清掉先到的內容。
  cdp.on('Network.responseReceivedExtraInfo', (e: Record<string, any>) => {
    const flow = flowByRequestId.get(String(e.requestId));
    if (!flow || !e.headers) return;
    flow.response = {
      ...(flow.response ?? { status: Number(e.statusCode ?? 0) }),
      headers: { ...(flow.response?.headers ?? {}), ...e.headers },
    };
  });

  cdp.on('Network.requestWillBeSentExtraInfo', (e: Record<string, any>) => {
    const flow = flowByRequestId.get(String(e.requestId));
    if (!flow || !e.headers) return;
    flow.requestHeaders = { ...(flow.requestHeaders ?? {}), ...e.headers };
  });

  // ── Response body ─────────────────────────────────────────
  //
  // 必須在 loadingFinished 當下擷取 —— CDP 的 body 緩衝區
  // 在導航時會被清空，等使用者想看時才抓就來不及了。
  cdp.on('Network.loadingFinished', (e: Record<string, any>) => {
    const requestId = String(e.requestId);
    const flow = flowByRequestId.get(requestId);
    if (!flow) return;

    if (typeof e.encodedDataLength === 'number' && flow.response) {
      flow.response.encodedDataLength = e.encodedDataLength;
    }

    const mime = flow.response?.mimeType;

    if (!budget.shouldCapture(flow.url, mime)) {
      budget.noteSkipped();
      flow.body = {
        status: budget.exceeded
          ? 'budget-exceeded'
          : isStreamSegment(flow.url, mime)
            ? 'skipped'
            : 'skipped',
      };
      return;
    }

    // 這裡刻意不 await —— loadingFinished 的處理器若阻塞，
    // 後續事件會延遲，進而影響時序記錄的準確性
    void captureBody(requestId, flow);
  });

  cdp.on('Network.loadingFailed', (e: Record<string, any>) => {
    const flow = flowByRequestId.get(String(e.requestId));
    if (flow && !flow.body) {
      flow.body = { status: 'unavailable' };
    }
  });

  async function captureBody(requestId: string, flow: FlowRecord): Promise<void> {
    try {
      const res = (await cdp.send('Network.getResponseBody', {
        requestId,
      })) as { body: string; base64Encoded: boolean };

      const raw = res.base64Encoded
        ? Buffer.from(res.body, 'base64')
        : Buffer.from(res.body, 'utf8');

      const grant = budget.allocate(raw.length);
      if (grant === 0) {
        flow.body = { status: 'budget-exceeded', size: raw.length };
        return;
      }

      const truncated = grant < raw.length;
      const content = truncated ? raw.subarray(0, grant) : raw;

      const hash = opts.putObject
        ? opts.putObject(content, flow.response?.mimeType, flow.url)
        : storeInMemory(content);

      flow.body = {
        status: truncated ? 'truncated' : 'captured',
        hash,
        size: raw.length,
        storedSize: content.length,
        ...(res.base64Encoded ? { base64: true } : {}),
      };
    } catch {
      // 取不到是常態，不是錯誤：redirect、快取命中、
      // 已被逐出的緩衝區都會走到這裡
      flow.body = { status: 'unavailable' };
    }
  }

  function storeInMemory(content: Buffer): string {
    const hash = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 32);
    if (!bodies.has(hash)) bodies.set(hash, content);
    return hash;
  }

  return {
    page,
    context,
    actions,
    flows,
    calibrations,
    budget,
    bodies,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
