import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowRecord } from '../lib/types';

/**
 * Network 清單
 *
 * 自行實作虛擬捲動而非引入套件：
 *   固定列高的情況下，虛擬捲動的核心只有十來行 ——
 *   算出可視範圍的起訖 index，只渲染那一段，
 *   上下用 spacer 撐開捲動高度。
 *   MVP1 不值得為此增加依賴；若日後需要可變列高再換 TanStack Virtual。
 *
 * 效能風險（MVP1-PLAN GUI 章節）：
 *   真實網站單一 session 可達數千筆 flow。
 *   若全部渲染，DOM 節點數會拖垮捲動。
 */

const ROW_H = 26;
const OVERSCAN = 8;

type Props = {
  flows: FlowRecord[];
  boundFlowIds: Set<string>;
  showFiltered: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
};

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

export function NetworkList({
  flows,
  boundFlowIds,
  showFiltered,
  selectedId,
  onSelect,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  const visible = useMemo(
    () => (showFiltered ? flows : flows.filter((f) => boundFlowIds.has(f.id))),
    [flows, boundFlowIds, showFiltered],
  );

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const total = visible.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const slice = visible.slice(start, end);

  return (
    <div
      className="netlist"
      ref={boxRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: total * ROW_H, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: start * ROW_H,
            left: 0,
            right: 0,
          }}
        >
          {slice.map((f) => {
            const unbound = !boundFlowIds.has(f.id);
            return (
              <div
                key={f.id}
                className={
                  'net-row' +
                  (f.id === selectedId ? ' is-sel' : '') +
                  (unbound ? ' is-unbound' : '')
                }
                style={{ height: ROW_H }}
                onClick={() => onSelect(f.id)}
              >
                <span className={'m m-' + f.method.toLowerCase()}>{f.method}</span>
                <span className="net-url" title={f.url}>
                  {pathOf(f.url)}
                </span>
                <span className="net-type">{f.resourceType ?? '—'}</span>
                <span className="net-init">{f.initiator.type}</span>
              </div>
            );
          })}
        </div>
      </div>
      {total === 0 && (
        <div className="empty">
          {flows.length === 0 ? '尚無請求' : '所有請求都被過濾（可勾選下方開關顯示）'}
        </div>
      )}
    </div>
  );
}
