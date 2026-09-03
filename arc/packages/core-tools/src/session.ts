import type {
  ActionRecord,
  Binding,
  FlowRecord,
  InteractableElement,
  StorageSnapshot,
  StrategyName,
} from '@arc/core-model';
import {
  startRecording,
  type CaptureOptions,
  type RecordingSession,
} from '@arc/browser-runtime';
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
  /** Response body 擷取的預算狀態 */
  capture: {
    usedBytes: number;
    totalBytes: number;
    exceeded: boolean;
    skipped: number;
  };
};

export type SessionOptions = {
  headless?: boolean;
  strategy?: StrategyName;
  windowMs?: number;
  /** Response body 擷取策略。見 browser-runtime/capture.ts。 */
  capture?: CaptureOptions;
  /**
   * body 的儲存位置。由 Workspace 接上 ProjectStore.putObject，
   * 未提供時 recorder 會暫存於記憶體。
   */
  putObject?: (content: Buffer, mime?: string, url?: string) => string;
  /** 與 putObject 對應的讀取端 */
  getObject?: (hash: string) => Buffer | undefined;
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
      capture: this.captureBudget(),
    };
  }

  async start(url?: string): Promise<void> {
    if (this.rec) return;
    this.rec = await startRecording({
      headless: this.opts.headless ?? false,
      ...(this.opts.capture ? { capture: this.opts.capture } : {}),
      ...(this.opts.putObject ? { putObject: this.opts.putObject } : {}),
    });
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
  /** Response body 的擷取預算使用情況 */
  captureBudget(): {
    usedBytes: number;
    totalBytes: number;
    exceeded: boolean;
    skipped: number;
  } {
    const b = this.rec?.budget;
    return {
      usedBytes: b?.usedBytes ?? 0,
      totalBytes: b?.totalBytes ?? 0,
      exceeded: b?.exceeded ?? false,
      skipped: b?.skipped ?? 0,
    };
  }

  /**
   * 取回已擷取的 response body。
   *
   * 有專案目錄時內容在 objects/，否則在 recorder 的記憶體暫存。
   * 兩種情況都以同一個 content-addressed 雜湊定址。
   */
  getBody(hash: string): Buffer | undefined {
    const inMemory = this.rec?.bodies.get(hash);
    if (inMemory) return inMemory;
    return this.opts.getObject?.(hash);
  }

  /**
   * 讀取瀏覽器儲存狀態。
   *
   * cookie 走 CDP 的 Storage domain 而非 document.cookie ——
   * 後者看不到 HttpOnly 的項目，而登入 token 常常正是 HttpOnly。
   * 這對「追查 token 存到哪裡」是關鍵差異。
   *
   * localStorage / sessionStorage 只能在頁面 context 中讀取，
   * 因此走 evaluate。
   */
  async storage(): Promise<StorageSnapshot> {
    if (!this.rec) {
      return { cookies: [], localStorage: {}, sessionStorage: {}, at: Date.now() };
    }

    const cookies = await this.rec.context.cookies();

    // 以字串形式傳入而非函式。
    //
    // tsx／esbuild 會為具名函式注入 __name 輔助函式，
    // 那在頁面環境中不存在，導致 ReferenceError。
    // 字串不經轉譯，因此不受影響。
    const web = (await this.rec.page.evaluate(`(function () {
      function dump(s) {
        var out = {};
        for (var i = 0; i < s.length; i += 1) {
          var k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) || '';
        }
        return out;
      }
      try {
        return {
          localStorage: dump(window.localStorage),
          sessionStorage: dump(window.sessionStorage)
        };
      } catch (e) {
        // about:blank 或第三方 cookie 政策下會拋 SecurityError
        return { localStorage: {}, sessionStorage: {} };
      }
    })()`)) as {
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
    };

    return {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      })),
      localStorage: web.localStorage,
      sessionStorage: web.sessionStorage,
      at: Date.now(),
    };
  }

  /**
   * 點擊元素。
   *
   * 依原規格書 §11.1 的操作優先序：DOM selector 優先於座標。
   * 這裡只支援 selector 與可見文字，不提供滑鼠座標 ——
   * 座標在版面變動時會失效，且無法從記錄回推意圖。
   */
  async click(target: { selector?: string; text?: string }): Promise<void> {
    const page = this.requirePage();
    if (target.selector) {
      await page.click(target.selector, { timeout: 10_000 });
      return;
    }
    if (target.text) {
      // 以可見文字定位，涵蓋按鈕與連結
      await page
        .getByText(target.text, { exact: false })
        .first()
        .click({ timeout: 10_000 });
      return;
    }
    throw new Error('click requires selector or text');
  }

  /** 填入表單欄位。會先清空既有內容。 */
  async fill(selector: string, value: string): Promise<void> {
    await this.requirePage().fill(selector, value, { timeout: 10_000 });
  }

  /** 按鍵。用於送出表單或觸發快捷鍵。 */
  async press(key: string, selector?: string): Promise<void> {
    const page = this.requirePage();
    if (selector) {
      await page.press(selector, key, { timeout: 10_000 });
    } else {
      await page.keyboard.press(key);
    }
  }

  /**
   * 取得頁面上可互動元素的摘要。
   *
   * 不回傳完整 DOM —— 複雜 SPA 的 DOM 可達數 MB，
   * 塞進 prompt 會直接違反原規格書 §37 的 context 控制原則。
   *
   * 改為只列出可點擊與可輸入的元素，這是決定「下一步做什麼」
   * 所需的資訊。定位優先採用穩定的屬性（id、name、
   * data-testid、aria-label），與 §11.1 的優先序一致。
   */
  async interactables(limit = 100): Promise<InteractableElement[]> {
    const page = this.requirePage();
    // 數值先夾在合理範圍再內插，避免任何注入可能
    const max = Math.min(Math.max(1, Math.floor(limit)), 500);

    // 同樣以字串傳入，理由見 storage() 的註解
    return (await page.evaluate(`(function () {
      var sel = 'a[href], button, input, select, textarea, ' +
        '[role="button"], [role="link"], [role="tab"], [onclick]';
      var nodes = document.querySelectorAll(sel);
      var out = [];

      for (var i = 0; i < nodes.length; i += 1) {
        if (out.length >= ${max}) break;
        var el = nodes[i];

        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (style.visibility === 'hidden' || style.display === 'none') continue;

        // 定位優先序：id > data-testid > name > aria-label
        var id = el.getAttribute('id');
        var testId = el.getAttribute('data-testid');
        var name = el.getAttribute('name');
        var aria = el.getAttribute('aria-label');
        var selector = '';
        if (id) selector = '#' + (window.CSS && CSS.escape ? CSS.escape(id) : id);
        else if (testId) selector = '[data-testid="' + testId + '"]';
        else if (name) selector = el.tagName.toLowerCase() + '[name="' + name + '"]';
        else if (aria) selector = '[aria-label="' + aria + '"]';

        var text = ((el.innerText || el.getAttribute('value') || '') + '')
          .trim().slice(0, 60);

        var item = { tag: el.tagName.toLowerCase() };
        if (selector) item.selector = selector;
        if (text) item.text = text;
        if (el.type) item.type = el.type;
        if (aria) item.label = aria;
        if (el.href) item.href = (el.href + '').slice(0, 200);
        if (el.disabled) item.disabled = true;
        out.push(item);
      }
      return out;
    })()`)) as InteractableElement[];
  }

  private requirePage() {
    if (!this.rec) throw new Error('session not started');
    return this.rec.page;
  }

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
