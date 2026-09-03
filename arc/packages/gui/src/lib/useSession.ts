import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActionRecord,
  Binding,
  FlowRecord,
  ServerEvent,
  SessionStatus,
} from './types';

/**
 * Session 狀態管理
 *
 * 即時更新（已確認的設計決定）：
 *   使用者在瀏覽器操作完切回 ARC 時，資料應該已經在那裡。
 *   因此用 WebSocket 推送，而非手動重整。
 *
 * 連線流程：
 *   連上 → 先收 snapshot（完整狀態）→ 之後收增量事件
 *   斷線 → 自動重連，重連後再次收到完整 snapshot
 *
 * 為何重連要重收完整快照而非續傳：
 *   斷線期間的事件已經遺失，續傳需要伺服器端維護序號與緩衝。
 *   MVP1 的資料量下，重收完整快照更簡單且不會有狀態不一致。
 */
export function useSession() {
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [status, setStatus] = useState<SessionStatus>({
    recording: false,
    pageUrl: '',
    actionCount: 0,
    flowCount: 0,
    filteredCount: 0,
    capture: { usedBytes: 0, totalBytes: 0, exceeded: false, skipped: 0 },
  });
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as ServerEvent;
        switch (ev.type) {
          case 'snapshot':
            setActions(ev.data.actions);
            setFlows(ev.data.flows);
            setBindings(ev.data.bindings);
            setStatus(ev.data.status);
            break;
          case 'action':
            setActions((prev) => [...prev, ev.data]);
            break;
          case 'flow':
            setFlows((prev) => [...prev, ev.data]);
            break;
          case 'bindings':
            setBindings(ev.data);
            break;
          case 'status':
            setStatus(ev.data);
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const flowById = useMemo(() => {
    const m = new Map<string, FlowRecord>();
    for (const f of flows) m.set(f.id, f);
    return m;
  }, [flows]);

  const bindingByAction = useMemo(() => {
    const m = new Map<string, Binding>();
    for (const b of bindings) m.set(b.actionId, b);
    return m;
  }, [bindings]);

  /** 所有已被綁定的 flow id，用於「顯示被過濾的」開關 */
  const boundFlowIds = useMemo(() => {
    const s = new Set<string>();
    for (const b of bindings) for (const id of b.flowIds) s.add(id);
    return s;
  }, [bindings]);

  const post = useCallback(async (path: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const r = await fetch(`/api${path}${qs}`, { method: 'POST' });
    return r.json();
  }, []);

  const start = useCallback((url?: string) => post('/start', url ? { url } : undefined), [post]);
  const goto = useCallback((url: string) => post('/goto', { url }), [post]);
  const stop = useCallback(() => post('/stop'), [post]);

  return {
    actions,
    flows,
    bindings,
    status,
    connected,
    flowById,
    bindingByAction,
    boundFlowIds,
    start,
    goto,
    stop,
  };
}
