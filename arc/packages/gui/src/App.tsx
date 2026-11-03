import { useState } from 'react';
import { useSession } from './lib/useSession';
import { Timeline } from './panels/Timeline';
import { NetworkList } from './panels/NetworkList';
import { FlowDetail } from './panels/FlowDetail';
import { Tools } from './panels/Tools';
import { Storage } from './panels/Storage';

/**
 * ARC 主畫面
 *
 * 版面決策（取代原規格書 §5.1 的四欄式）：
 *   原設計中間欄是嵌入的 Chromium。MVP1-PLAN 2.5 決定不嵌入，
 *   改開獨立視窗 —— 那一欄因此消失，版面需要重新設計。
 *
 *   使用情境也隨之改變：
 *     原本   使用者在 ARC 內操作網站，一切都在同一個視窗
 *     現在   在瀏覽器操作 → 切回 ARC 看發生了什麼 → 再切回去
 *
 *   ARC 的視窗變成「事後檢視與調查」而非操作台，
 *   因此採用主從式 + 頂層分頁：這是 DevTools / Charles / mitmweb
 *   共用的成熟模式，使用者不需重新學習。
 */

type Tab = 'timeline' | 'network' | 'storage' | 'tools';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function App() {
  const s = useSession();
  const [tab, setTab] = useState<Tab>('timeline');
  const [selectedFlowId, setSelectedFlowId] = useState<string>();
  const [showFiltered, setShowFiltered] = useState(false);
  const [urlInput, setUrlInput] = useState('http://127.0.0.1:8731/');

  const selectedFlow = selectedFlowId ? s.flowById.get(selectedFlowId) : undefined;

  const onStart = async () => {
    await s.start(urlInput || undefined);
  };

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">ARC</span>

        <span className={'dot' + (s.connected ? ' on' : '')} title={s.connected ? '已連線' : '連線中斷'} />

        <input
          className="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="要調查的網址"
          spellCheck={false}
        />

        {!s.status.recording ? (
          <button className="btn primary" onClick={onStart}>
            開始錄製
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => s.goto(urlInput)}>
              前往
            </button>
            <button className="btn danger" onClick={() => s.stop()}>
              停止
            </button>
          </>
        )}

        <nav className="tabs">
          <button
            className={'tab' + (tab === 'timeline' ? ' on' : '')}
            onClick={() => setTab('timeline')}
          >
            Timeline
          </button>
          <button
            className={'tab' + (tab === 'network' ? ' on' : '')}
            onClick={() => setTab('network')}
          >
            Network
          </button>
          <button
            className={'tab' + (tab === 'storage' ? ' on' : '')}
            onClick={() => setTab('storage')}
          >
            Storage
          </button>
          <button
            className={'tab' + (tab === 'tools' ? ' on' : '')}
            onClick={() => setTab('tools')}
          >
            Tools
          </button>
        </nav>
      </header>

      {tab === 'tools' || tab === 'storage' ? (
        // 工具面板自帶主從式版面，佔滿整個工作區
        <main className="body body-full">
          {tab === 'tools' ? <Tools /> : <Storage />}
        </main>
      ) : (
        <main className="body">
          <section className="left">
            {tab === 'timeline' ? (
              <Timeline
                actions={s.actions}
                bindingByAction={s.bindingByAction}
                flowById={s.flowById}
                selectedFlowId={selectedFlowId}
                onSelectFlow={setSelectedFlowId}
              />
            ) : (
              <NetworkList
                flows={s.flows}
                boundFlowIds={s.boundFlowIds}
                showFiltered={showFiltered}
                selectedId={selectedFlowId}
                onSelect={setSelectedFlowId}
              />
            )}
          </section>

          <section className="right">
            <FlowDetail
              flow={selectedFlow}
              actions={s.actions}
              bindings={s.bindings}
            />
          </section>
        </main>
      )}

      <footer className="status">
        <span>{s.status.actionCount} actions</span>
        <span>{s.status.flowCount} flows</span>
        <span className="muted">{s.status.filteredCount} 已過濾</span>

        <label className="toggle">
          <input
            type="checkbox"
            checked={showFiltered}
            onChange={(e) => setShowFiltered(e.target.checked)}
          />
          顯示被過濾的請求
        </label>

        {s.status.capture && s.status.capture.usedBytes > 0 && (
          <span
            className={s.status.capture.exceeded ? 'warn-text' : 'muted'}
            title={
              s.status.capture.exceeded
                ? '已達儲存上限，之後的回應內容不再擷取（錄製繼續進行）'
                : `已略過 ${s.status.capture.skipped} 筆`
            }
          >
            已存 {fmtBytes(s.status.capture.usedBytes)}
            {s.status.capture.exceeded && ' · 已達上限'}
          </span>
        )}

        <span className="spacer" />
        <span className="muted" title="來自 S1 實測：C/D 策略 @ 500ms">
          binding: D-rhythm @ 500ms
        </span>
      </footer>
    </div>
  );
}
