import type {
  ActionRecord,
  Binding,
  FlowRecord,
  StrategyName,
} from '@arc/core-model';
import { startRecording, type RecordingSession } from '@arc/browser-runtime';
import { STRATEGIES } from '@arc/correlator';

/**
 * Investigation Session — core-tools 的核心物件
 *
 * 對應 MVP1-PLAN.md 3.3：完整能力、零限制。
 * 唯一的義務是把所有操作記錄下來。
 *
 * 這一層存在的理由（MVP1-PLAN.md 3.7）：
 *   gui / cli / agent-facade 都只能經由 core-tools 存取能力。
 *   若允許 GUI 直接 import browser-runtime，
 *   GUI 與 Agent 的能力會逐漸失衡，違反原規格書 §42 原則 3。
 */

export type SessionEvent =
  | { type: 'action'; data: ActionRecord }
  | { type: 'flow'; data: FlowRecord }
  | { type: 'bindings'; data: Binding[] }
  | { type: 'status'; data: SessionStatus };

export type SessionStatus = {
  recording: boolean;
  pageUrl: string;
  actionCount: number;
  flowCount: number;
  /** 被綁定策略過濾掉的 flow 數量。對應 S1 的 c9 限制。 */
  filteredCount: number;
};

export type SessionOptions = {
  headless?: boolean;
  strategy?: StrategyName;
  windowMs?: number;
};

type Listener = (ev: SessionEvent) => void;

/** 預設綁定設定，來自 S1 實測結果 */
export const DEFAULT_STRATEGY: StrategyName = 'D-rhythm';
export const DEFAULT_WINDOW_MS = 500;

export class InvestigationSession {
  private rec?: RecordingSession;
  private listeners = new Set<Listener>();
  private seenActions = 0;
  private seenFlows = 0;
  private poll?: NodeJS.Timeout;

  readonly strategy: StrategyName;
  readonly windowMs: number;

  constructor(private opts: SessionOptions = {}) {
    this.strategy = opts.strategy ?? DEFAULT_STRATEGY;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: SessionEvent) {
    for (const fn of this.listeners) fn(ev);
  }

  get actions(): ActionRecord[] {
    return this.rec?.actions ?? [];
  }

  get flows(): FlowRecord[] {
    return this.rec?.flows ?? [];
  }

  /** 依當前策略計算綁定 */
  bindings(): Binding[] {
    if (!this.rec) return [];
    return STRATEGIES[this.strategy](this.rec.actions, this.rec.flows, {
      windowMs: this.windowMs,
    });
  }

  status(): SessionStatus {
    const bound = new Set(this.bindings().flatMap((b) => b.flowIds));
    return {
      recording: !!this.rec,
      pageUrl: this.rec?.page.url() ?? '',
      actionCount: this.actions.length,
      flowCount: this.flows.length,
      filteredCount: Math.max(0, this.flows.length - bound.size),
    };
  }

  async start(url?: string): Promise<void> {
    if (this.rec) return;
    this.rec = await startRecording({ headless: this.opts.headless ?? false });
    if (url) await this.rec.page.goto(url, { waitUntil: 'domcontentloaded' });

    // recorder 目前以陣列累積事件，尚無 callback 介面。
    // 這裡以輪詢偵測新增項目並推送給前端。
    //
    // 之所以可以接受：輪詢只在 Node 程序內比對陣列長度，
    // 沒有 IPC 或網路成本。
    // MVP1 實作階段應改為 recorder 直接提供 callback。
    this.poll = setInterval(() => this.drain(), 120);
  }

  private drain() {
    if (!this.rec) return;
    let changed = false;

    while (this.seenActions < this.rec.actions.length) {
      const a = this.rec.actions[this.seenActions];
      this.seenActions += 1;
      if (a) {
        this.emit({ type: 'action', data: a });
        changed = true;
      }
    }

    while (this.seenFlows < this.rec.flows.length) {
      const f = this.rec.flows[this.seenFlows];
      this.seenFlows += 1;
      if (f) {
        this.emit({ type: 'flow', data: f });
        changed = true;
      }
    }

    if (changed) {
      this.emit({ type: 'bindings', data: this.bindings() });
      this.emit({ type: 'status', data: this.status() });
    }
  }

  async goto(url: string): Promise<void> {
    if (!this.rec) throw new Error('session not started');
    await this.rec.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  /**
   * 在網站自己的 context 中重放一個已觀測的請求。
   *
   * 對應原規格書 §21 Level 2（Browser Context Testing），
   * 也是 MVP1-PLAN.md 1.5 決定的主要產出形式：
   *   讓網站自己處理 cookie、signature、token、指紋，
   *   使用者不需要理解那些機制如何運作。
   *
   * 安全性質（MVP1-PLAN.md 3.4）：
   *   method 與 origin 一律沿用原始 request，呼叫端無權指定。
   *   只有 changes 中列出的 query 參數會被改變。
   *   因此在結構上無法呼叫「網站自己沒有呼叫過」的端點。
   */
  async replay(
    flowId: string,
    changes: Record<string, unknown> = {},
  ): Promise<{ status: number; body: unknown }> {
    if (!this.rec) throw new Error('session not started');
    const flow = this.rec.flows.find((f) => f.id === flowId);
    if (!flow) throw new Error(`no such flow: ${flowId}`);

    // 只改變 query 參數，其餘沿用原始請求
    const target = new URL(flow.url);
    for (const [k, v] of Object.entries(changes)) {
      target.searchParams.set(k, String(v));
    }

    return this.rec.page.evaluate(
      async ({ url, method }) => {
        const r = await fetch(url, { method, credentials: 'include' });
        const text = await r.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* 非 JSON 則保留原文 */
        }
        return { status: r.status, body: parsed };
      },
      { url: target.toString(), method: flow.method },
    );
  }

  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    await this.rec?.close();
    this.rec = undefined;
    this.emit({ type: 'status', data: this.status() });
  }
}
