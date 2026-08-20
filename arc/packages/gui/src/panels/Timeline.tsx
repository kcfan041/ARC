import { useState } from 'react';
import type { ActionRecord, Binding, FlowRecord } from '../lib/types';

/**
 * Timeline 面板
 *
 * 這是 ARC 相對 Chrome DevTools 的核心差異（MVP1-PLAN.md 2.6）：
 *   DevTools 的 Recorder 面板記操作、Network 面板記請求，
 *   兩者不互通。使用者無法回答「這個操作導致了什麼」。
 *
 * 因此 action 預設展開，直接顯示它綁定到的 flow。
 */

type Props = {
  actions: ActionRecord[];
  bindingByAction: Map<string, Binding>;
  flowById: Map<string, FlowRecord>;
  selectedFlowId?: string;
  onSelectFlow: (id: string) => void;
};

function timeOf(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

function labelOf(a: ActionRecord): string {
  const t = a.target;
  if (t.text) return `"${t.text.slice(0, 30)}"`;
  if (t.id) return `#${t.id}`;
  if (t.name) return `[name=${t.name}]`;
  return t.selector.slice(0, 40) || t.tag;
}

export function Timeline({
  actions,
  bindingByAction,
  flowById,
  selectedFlowId,
  onSelectFlow,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (actions.length === 0) {
    return (
      <div className="empty">
        尚無操作記錄
        <div className="hint">
          在開啟的 Chromium 視窗中操作網站，這裡會即時顯示
        </div>
      </div>
    );
  }

  return (
    <div className="timeline">
      {actions.map((a) => {
        const bound = bindingByAction.get(a.id)?.flowIds ?? [];
        const open = !collapsed.has(a.id);
        return (
          <div key={a.id} className="tl-action">
            <div className="tl-head" onClick={() => toggle(a.id)}>
              <span className="tl-caret">{open ? '▾' : '▸'}</span>
              <span className="tl-time">{timeOf(a.at)}</span>
              <span className="tl-kind">{a.kind}</span>
              <span className="tl-label">{labelOf(a)}</span>
              <span className="tl-count">
                {bound.length > 0 ? `${bound.length} 個請求` : '無請求'}
              </span>
            </div>
            {open && bound.length > 0 && (
              <div className="tl-flows">
                {bound.map((fid) => {
                  const f = flowById.get(fid);
                  if (!f) return null;
                  return (
                    <div
                      key={fid}
                      className={
                        'tl-flow' + (fid === selectedFlowId ? ' is-sel' : '')
                      }
                      onClick={() => onSelectFlow(fid)}
                    >
                      <span className={'m m-' + f.method.toLowerCase()}>
                        {f.method}
                      </span>
                      <span className="tl-url">{pathOf(f.url)}</span>
                      <span className="tl-delta">+{f.at - a.at}ms</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
