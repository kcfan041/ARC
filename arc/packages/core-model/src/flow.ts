import type { EpochMs } from './time.js';

/**
 * Network Flow 記錄
 *
 * 命名沿用 mitmproxy 的 Flow 概念（原規格書 §48）。
 *
 * 注意：initiator 只有 CDP 提供，Playwright 的 page.on('request')
 * 不含 initiator stack。因此 Network 收集必須走 CDP。
 */

export type InitiatorType =
  | 'parser'
  | 'script'
  | 'preload'
  | 'SignedExchange'
  | 'preflight'
  | 'other';

export type CallFrame = {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type InitiatorStack = {
  callFrames: CallFrame[];
  /** async 邊界之外的上層 stack，需開啟 setAsyncCallStackDepth 才有 */
  parent?: InitiatorStack;
};

export type FlowInitiator = {
  type: InitiatorType;
  stack?: InitiatorStack;
  /** parser 類型才有：觸發載入的文件 URL */
  url?: string;
  lineNumber?: number;
};

/**
 * Response body 的擷取狀態
 *
 * CDP 的 response body 在導航時會被清空，因此必須在
 * loadingFinished 當下就取，不能等到使用者想看時才抓。
 * 這代表擷取是持續成本，需要預算控制 —— 而預算耗盡、
 * 內容過大、類型被排除都是正常結果，不是錯誤。
 */
export type BodyCaptureStatus =
  /** 已完整擷取 */
  | 'captured'
  /** 超過單筆大小上限，只存了前綴 */
  | 'truncated'
  /** 已達 session 儲存預算上限 */
  | 'budget-exceeded'
  /** 類型被排除（例如串流 segment） */
  | 'skipped'
  /** CDP 取不到（常見於 redirect、快取命中、已被逐出） */
  | 'unavailable';

export type ResponseInfo = {
  status: number;
  statusText?: string;
  /**
   * Response headers。
   *
   * 含 Set-Cookie 等敏感內容 —— core-tools 保留原值
   * （對人工零限制），送往 LLM 與 MCP client 前才遮蔽。
   */
  headers?: Record<string, string>;
  mimeType?: string;
  /** 是否來自快取。快取命中時通常取不到 body。 */
  fromCache?: boolean;
  /** CDP 回報的傳輸位元組數 */
  encodedDataLength?: number;
};

export type BodyRef = {
  status: BodyCaptureStatus;
  /** content-addressed 雜湊，指向 objects/ 中的檔案 */
  hash?: string;
  /** 原始大小（位元組）。truncated 時為截斷前的大小。 */
  size?: number;
  /** 實際存下的位元組數 */
  storedSize?: number;
  /** 原始內容是否為 base64（二進位資源） */
  base64?: boolean;
};

export type FlowRecord = {
  /** flow_1, flow_2, ... */
  id: string;
  /** CDP requestId。redirect 會共用同一個，需注意去重 */
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  /** 統一時基（Unix epoch 毫秒） */
  at: EpochMs;
  initiator: FlowInitiator;
  /** redirect 鏈中的第幾個，0 為原始請求 */
  redirectIndex: number;
  /**
   * Request headers。與 response headers 同樣含敏感內容。
   */
  requestHeaders?: Record<string, string>;
  /** 回應資訊。requestWillBeSent 當下還沒有，稍後補上。 */
  response?: ResponseInfo;
  /** Response body 的擷取結果 */
  body?: BodyRef;
  /**
   * fixture 用來標記自身身分的記號，僅供 S1 量測使用。
   * 從 URL query 中的 marker 參數取得。
   */
  marker?: string;
};

/** 從 URL 取出 fixture 標記（僅 S1 使用） */
export function extractMarker(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('marker') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 瀏覽器儲存快照
 *
 * cookie 經由 CDP／Playwright 的 context 取得，因此涵蓋
 * HttpOnly 項目 —— document.cookie 看不到那些，
 * 而登入 token 常常正是 HttpOnly。
 */
export type CookieRecord = {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
};

export type StorageSnapshot = {
  cookies: CookieRecord[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  at: EpochMs;
};

/** 兩份快照之間的差異 */
export type StorageChange = {
  area: 'cookie' | 'localStorage' | 'sessionStorage';
  key: string;
  kind: 'added' | 'changed' | 'removed';
  before?: string;
  after?: string;
};

/**
 * 可互動元素摘要
 *
 * 刻意不含完整 DOM —— 複雜 SPA 的 DOM 可達數 MB，
 * 塞進 prompt 會直接違反原規格書 §37 的 context 控制原則。
 * 只保留決定「下一步做什麼」所需的資訊。
 */
export type InteractableElement = {
  tag: string;
  /** 建議的定位方式。無穩定屬性時可能為空。 */
  selector?: string;
  text?: string;
  type?: string;
  label?: string;
  href?: string;
  disabled?: boolean;
};
