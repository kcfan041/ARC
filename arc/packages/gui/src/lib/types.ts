/**
 * 前端型別
 *
 * 刻意重新宣告而非 import @arc/core-tools 的型別：
 * 前端與後端透過 JSON 傳輸，只需要結構相容。
 * 若直接 import，Vite 會把整個 core-tools（含 Playwright）
 * 拉進前端的依賴圖。
 *
 * 代價：型別可能與後端不同步。
 * MVP1 實作階段應改為從 core-model 產生共用的 schema。
 */

export type ActionKind =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'keydown'
  | 'scroll';

export type ActionRecord = {
  id: string;
  kind: ActionKind;
  at: number;
  pageUrl: string;
  target: {
    selector: string;
    tag: string;
    text?: string;
    id?: string;
    name?: string;
    role?: string;
    type?: string;
  };
};

export type CallFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type FlowRecord = {
  id: string;
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  at: number;
  redirectIndex: number;
  initiator: {
    type: string;
    stack?: { callFrames: CallFrame[] };
    url?: string;
  };
};

export type Binding = {
  actionId: string;
  flowIds: string[];
  strategy: string;
  windowMs: number;
};

export type SessionStatus = {
  recording: boolean;
  pageUrl: string;
  actionCount: number;
  flowCount: number;
  /** 被綁定策略過濾掉的 flow 數。對應 S1 的 c9 已知限制。 */
  filteredCount: number;
};

export type Snapshot = {
  actions: ActionRecord[];
  flows: FlowRecord[];
  bindings: Binding[];
  status: SessionStatus;
};

export type ServerEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'action'; data: ActionRecord }
  | { type: 'flow'; data: FlowRecord }
  | { type: 'bindings'; data: Binding[] }
  | { type: 'status'; data: SessionStatus };
