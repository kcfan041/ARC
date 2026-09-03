import type { ActionRecord, Binding, FlowRecord } from '../lib/types';

/**
 * Flow 詳情
 *
 * 除了標準的 request 資訊，額外顯示兩項 DevTools 沒有的：
 *   1. 這個 request 由哪個使用者操作觸發（反查綁定）
 *   2. initiator call stack（供 MVP2 的 position mapping 使用）
 */

type Props = {
  flow?: FlowRecord;
  actions: ActionRecord[];
  bindings: Binding[];
};

/** 擷取狀態的簡短標籤，顯示在標題旁 */
const BODY_LABEL: Record<string, string> = {
  captured: '已擷取',
  truncated: '已截斷',
  'budget-exceeded': '未擷取',
  skipped: '已略過',
  unavailable: '無法取得',
};

/** 未取得內容時的說明。這些都是正常結果，不是錯誤。 */
const BODY_REASON: Record<string, string> = {
  'budget-exceeded': '已達本次工作階段的儲存上限',
  skipped: '此類型預設不擷取（例如串流影片的分段檔）',
  unavailable: '瀏覽器已無法提供此內容（可能來自快取或已被清除）',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || u.pathname;
    return file + (u.search ? u.search.slice(0, 20) : '');
  } catch {
    return url.slice(-40);
  }
}

export function FlowDetail({ flow, actions, bindings }: Props) {
  if (!flow) {
    return <div className="empty">選擇一個請求以查看詳情</div>;
  }

  const owner = bindings.find((b) => b.flowIds.includes(flow.id));
  const action = owner ? actions.find((a) => a.id === owner.actionId) : undefined;
  const frames = flow.initiator.stack?.callFrames ?? [];

  return (
    <div className="detail">
      <div className="d-sec">
        <div className="d-title">General</div>
        <Row k="Method" v={flow.method} />
        <Row k="URL" v={flow.url} wrap />
        <Row k="Type" v={flow.resourceType ?? '—'} />
        {flow.response && (
          <Row
            k="Status"
            v={`${flow.response.status}${
              flow.response.statusText ? ' ' + flow.response.statusText : ''
            }${flow.response.fromCache ? '（快取）' : ''}`}
          />
        )}
        {flow.response?.mimeType && (
          <Row k="MIME" v={flow.response.mimeType} />
        )}
        <Row k="Flow ID" v={flow.id} />
        {flow.redirectIndex > 0 && (
          <Row k="Redirect" v={`第 ${flow.redirectIndex} 次`} />
        )}
      </div>

      <div className="d-sec">
        <div className="d-title">
          回應內容
          {flow.body && (
            <span className="d-note">{BODY_LABEL[flow.body.status]}</span>
          )}
        </div>
        {!flow.body ? (
          <div className="d-empty">尚未完成或未擷取</div>
        ) : flow.body.status === 'captured' || flow.body.status === 'truncated' ? (
          <>
            <Row k="大小" v={formatBytes(flow.body.size ?? 0)} />
            {flow.body.status === 'truncated' && (
              <Row k="已存" v={formatBytes(flow.body.storedSize ?? 0)} />
            )}
            <Row k="內容" v={flow.body.base64 ? '二進位' : '文字'} />
          </>
        ) : (
          <div className="d-empty">
            {BODY_REASON[flow.body.status]}
            {flow.body.size !== undefined && (
              <div className="hint">原始大小 {formatBytes(flow.body.size)}</div>
            )}
          </div>
        )}
      </div>

      <div className="d-sec">
        <div className="d-title">
          觸發來源
          <span className="d-note">DevTools 沒有這一項</span>
        </div>
        {action ? (
          <>
            <Row k="Action" v={`${action.id} · ${action.kind}`} />
            <Row
              k="Target"
              v={action.target.text || action.target.id || action.target.selector}
            />
            <Row k="延遲" v={`${flow.at - action.at} ms`} />
          </>
        ) : (
          <div className="d-empty">
            未綁定到任何操作
            <div className="hint">
              可能是輪詢、預載，或屬於 S1 已知限制
              （輪詢與操作共用端點）
            </div>
          </div>
        )}
      </div>

      <div className="d-sec">
        <div className="d-title">
          Initiator
          <span className="d-note">{flow.initiator.type}</span>
        </div>
        {frames.length > 0 ? (
          <div className="stack">
            {frames.map((f, i) => (
              <div key={i} className="frame">
                <span className="fn">{f.functionName || '(anonymous)'}</span>
                <span className="loc">
                  {shortUrl(f.url)}:{f.lineNumber + 1}:{f.columnNumber + 1}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="d-empty">無 call stack</div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, wrap }: { k: string; v: string; wrap?: boolean }) {
  return (
    <div className="d-row">
      <span className="d-k">{k}</span>
      <span className={'d-v' + (wrap ? ' wrap' : '')}>{v}</span>
    </div>
  );
}
