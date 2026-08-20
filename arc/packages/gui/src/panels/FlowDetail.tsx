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
        <Row k="Flow ID" v={flow.id} />
        {flow.redirectIndex > 0 && (
          <Row k="Redirect" v={`第 ${flow.redirectIndex} 次`} />
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
