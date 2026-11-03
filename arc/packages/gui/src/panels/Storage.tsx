import { useEffect, useState } from 'react';
import type { StorageSnapshot } from '../lib/types';

type StorageResult =
  | { ok: true; data: StorageSnapshot }
  | { ok: false; error: { message?: string } | string };

const HIDDEN_VALUE = '••••••••';

export function Storage() {
  const [snapshot, setSnapshot] = useState<StorageSnapshot>();
  const [showValues, setShowValues] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch('/api/storage');
      const result = (await response.json()) as StorageResult;
      if (!response.ok || !result.ok) {
        const detail = result.ok
          ? `HTTP ${response.status}`
          : typeof result.error === 'string'
            ? result.error
            : result.error.message;
        throw new Error(detail || '無法讀取 Storage');
      }
      setSnapshot(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const display = (value: string) => (showValues ? value : HIDDEN_VALUE);
  const localEntries = Object.entries(snapshot?.localStorage ?? {});
  const sessionEntries = Object.entries(snapshot?.sessionStorage ?? {});

  return (
    <div className="storage">
      <div className="storage-bar">
        <span className="storage-time">
          {snapshot ? `擷取於 ${new Date(snapshot.at).toLocaleTimeString()}` : '尚未擷取'}
        </span>
        <span className="spacer" />
        <label className="toggle">
          <input
            type="checkbox"
            checked={showValues}
            onChange={(event) => setShowValues(event.target.checked)}
          />
          顯示原值
        </label>
        <button className="btn sm" onClick={() => void load()} disabled={loading}>
          {loading ? '讀取中' : '重新整理'}
        </button>
      </div>

      {error && <div className="storage-error">{error}</div>}

      <StorageSection title="Cookies" count={snapshot?.cookies.length ?? 0}>
        {snapshot?.cookies.length ? (
          <div className="storage-table cookies">
            <div className="storage-head"><span>名稱</span><span>值</span><span>Domain / Path</span><span>屬性</span></div>
            {snapshot.cookies.map((cookie) => (
              <div className="storage-row" key={`${cookie.domain}\0${cookie.path}\0${cookie.name}`}>
                <span>{cookie.name}</span>
                <span className="storage-value">{display(cookie.value)}</span>
                <span>{cookie.domain}{cookie.path}</span>
                <span className="storage-flags">
                  {cookie.httpOnly && <b>HttpOnly</b>}
                  {cookie.secure && <b>Secure</b>}
                </span>
              </div>
            ))}
          </div>
        ) : <Empty />}
      </StorageSection>

      <StorageSection title="Local Storage" count={localEntries.length}>
        <KeyValueTable entries={localEntries} display={display} />
      </StorageSection>

      <StorageSection title="Session Storage" count={sessionEntries.length}>
        <KeyValueTable entries={sessionEntries} display={display} />
      </StorageSection>
    </div>
  );
}

function StorageSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="storage-section">
      <h2>{title}<span>{count}</span></h2>
      {children}
    </section>
  );
}

function KeyValueTable({ entries, display }: { entries: [string, string][]; display: (value: string) => string }) {
  if (entries.length === 0) return <Empty />;
  return (
    <div className="storage-table key-values">
      <div className="storage-head"><span>鍵</span><span>值</span></div>
      {entries.map(([key, value]) => (
        <div className="storage-row" key={key}>
          <span>{key}</span>
          <span className="storage-value">{display(value)}</span>
        </div>
      ))}
    </div>
  );
}

function Empty() {
  return <div className="storage-empty">沒有資料</div>;
}
