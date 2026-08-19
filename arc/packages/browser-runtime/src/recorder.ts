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
};

export type RecordingSession = {
  page: Page;
  context: BrowserContext;
  actions: ActionRecord[];
  flows: FlowRecord[];
  /** 時基校準樣本：只有同時具備 monotonic 與 wallTime 的事件才會產生 */
  calibrations: ClockCalibration[];
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
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  if (opts.asyncStackDepth && opts.asyncStackDepth > 0) {
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.setAsyncCallStackDepth', {
      maxDepth: opts.asyncStackDepth,
    });
  }

  let flowSeq = 0;
  // redirect 會沿用同一個 requestId，需記錄已見次數以標示 redirectIndex
  const seenRequestIds = new Map<string, number>();

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

    flows.push({
      id: `flow_${flowSeq}`,
      requestId,
      url,
      method: String(e.request?.method ?? 'GET'),
      ...(e.type ? { resourceType: String(e.type) } : {}),
      at,
      initiator,
      redirectIndex,
      ...(marker ? { marker } : {}),
    });
  });

  return {
    page,
    context,
    actions,
    flows,
    calibrations,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
