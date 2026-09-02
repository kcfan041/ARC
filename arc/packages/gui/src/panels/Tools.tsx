import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 工具面板
 *
 * MVP1 為唯讀檢視 + 執行，不做編輯。
 *
 * 不做編輯的理由：
 *   編輯 Tier 2 的 body 等同於在 GUI 中寫 JavaScript，
 *   需要引入程式碼編輯器，且「改動已核准的工具」
 *   是高風險操作。等實際使用後再判斷是否值得。
 *
 * 面板要誠實反映三種 tier 的信任差異（MVP1-PLAN 3A.4）：
 *   primitive / declarative / sandboxed  執行在我方，能力受控
 *   external                             執行在對方程序，不受控
 */

type ToolDef = {
  name: string;
  title?: string;
  description: string;
  tier: string;
  capabilities: string[];
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }> };
  origin: { kind: string; from?: string };
  scope?: { domain?: string; tags?: string[] };
  annotations?: { readOnlyHint?: boolean };
};

type ToolsResponse = {
  ok: boolean;
  tools: ToolDef[];
  approvals: Record<string, boolean>;
  persistent: boolean;
};

const READ_ONLY = new Set([
  'session.read',
  'network.read',
  'storage.read',
  'code.read',
]);

function isReadOnly(t: ToolDef): boolean {
  return t.capabilities.length > 0 && t.capabilities.every((c) => READ_ONLY.has(c));
}

const TIER_LABEL: Record<string, string> = {
  primitive: '內建',
  declarative: '宣告式',
  sandboxed: '沙箱',
  external: '外部',
};

export function Tools() {
  const [data, setData] = useState<ToolsResponse>();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('');
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<string>();
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const r = await fetch('/api/tools');
    setData(await r.json());
  };

  useEffect(() => {
    void load();
  }, []);

  const tools = data?.tools ?? [];

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.scope?.tags ?? []).some((g) => g.toLowerCase().includes(q)),
    );
  }, [tools, filter]);

  const current = tools.find((t) => t.name === selected);

  const run = async () => {
    if (!current) return;
    setRunning(true);
    setResult(undefined);
    try {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(args || '{}');
      } catch {
        setResult('參數不是有效的 JSON');
        return;
      }
      const r = await fetch(
        `/api/tools/call?name=${encodeURIComponent(current.name)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed),
        },
      );
      setResult(JSON.stringify(await r.json(), null, 2));
    } finally {
      setRunning(false);
    }
  };

  const approve = async (name: string) => {
    await fetch(`/api/tools/approve?name=${encodeURIComponent(name)}`, {
      method: 'POST',
    });
    await load();
  };

  const exportTool = async (name: string) => {
    const r = await fetch(`/api/tools/export?name=${encodeURIComponent(name)}`);
    const res = await r.json();
    if (!res.ok) {
      setResult(JSON.stringify(res, null, 2));
      return;
    }
    const blob = new Blob([JSON.stringify(res.data, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.arctool.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    let pkg: unknown;
    try {
      pkg = JSON.parse(text);
    } catch {
      setResult('檔案不是有效的 JSON');
      return;
    }

    const reviewRes = await fetch('/api/tools/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pkg),
    });
    const review = await reviewRes.json();

    if ('error' in review) {
      setResult(`無法匯入：${review.error}`);
      return;
    }
    if (review.blockers?.length) {
      setResult(`無法匯入：\n${review.blockers.join('\n')}`);
      return;
    }

    // 確認畫面：明確列出該工具宣告了哪些能力
    const caps = review.capabilities
      .map((c: { name: string; readOnly: boolean }) =>
        `  ${c.name}${c.readOnly ? '（唯讀）' : '（有副作用）'}`,
      )
      .join('\n');
    const warnings = review.warnings?.length
      ? `\n\n注意：\n${review.warnings.map((w: string) => `  ${w}`).join('\n')}`
      : '';

    const message =
      `匯入工具「${review.def.name}」？\n\n` +
      `說明：${review.def.description}\n\n` +
      `它宣告了以下能力：\n${caps}${warnings}`;

    if (!confirm(message)) return;

    const r = await fetch('/api/tools/import?source=file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pkg),
    });
    const out = await r.json();
    setResult(JSON.stringify(out, null, 2));
    await load();
    if (out.ok) setSelected(out.data.name);
  };

  return (
    <div className="tools">
      <div className="tools-list">
        <div className="tools-bar">
          <input
            className="tools-filter"
            placeholder={`搜尋 ${tools.length} 個工具`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
          />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            匯入
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
        </div>

        {shown.map((t) => {
          const ro = isReadOnly(t);
          const approved = data?.approvals[t.name];
          const needsApproval = t.tier !== 'primitive' && !ro && !approved;
          return (
            <div
              key={t.name}
              className={'tool-row' + (t.name === selected ? ' is-sel' : '')}
              onClick={() => {
                setSelected(t.name);
                setResult(undefined);
                setArgs('{}');
              }}
            >
              <span className={'tier tier-' + t.tier}>
                {TIER_LABEL[t.tier] ?? t.tier}
              </span>
              <span className="tool-name">{t.name}</span>
              {ro ? (
                <span className="badge ro" title="只宣告唯讀能力">
                  唯讀
                </span>
              ) : (
                <span className="badge fx" title="宣告了具副作用的能力">
                  副作用
                </span>
              )}
              {needsApproval && (
                <span className="badge warn" title="尚未核准">
                  待核准
                </span>
              )}
            </div>
          );
        })}

        {shown.length === 0 && <div className="empty">沒有符合的工具</div>}
      </div>

      <div className="tools-detail">
        {!current ? (
          <div className="empty">選擇一個工具以查看詳情</div>
        ) : (
          <>
            <div className="d-sec">
              <div className="d-title">
                {current.title ?? current.name}
                <span className={'tier tier-' + current.tier}>
                  {TIER_LABEL[current.tier] ?? current.tier}
                </span>
              </div>
              <p className="tool-desc">{current.description}</p>
            </div>

            <div className="d-sec">
              <div className="d-title">
                能力宣告
                <span className="d-note">決定它實際拿得到什麼</span>
              </div>
              {current.tier === 'external' ? (
                <div className="warn-box">
                  這是外部 MCP Server 提供的工具，執行發生在對方的程序中。
                  ARC 無法限制它在自己的程序內做什麼 ——
                  信任等級等同於執行一個第三方程式。
                </div>
              ) : current.capabilities.length === 0 ? (
                <div className="d-empty">未宣告任何能力</div>
              ) : (
                <div className="caps">
                  {current.capabilities.map((c) => (
                    <span
                      key={c}
                      className={'cap' + (READ_ONLY.has(c) ? ' ro' : '')}
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
              {current.annotations?.readOnlyHint === true &&
                !isReadOnly(current) && (
                  <div className="warn-box">
                    此工具自稱唯讀，但宣告的能力並非全部唯讀。
                    以能力宣告為準 —— 自述欄位不可信。
                  </div>
                )}
            </div>

            <div className="d-sec">
              <div className="d-title">來源</div>
              <Row k="類型" v={current.origin.kind} />
              {current.origin.from && <Row k="來自" v={current.origin.from} />}
              {current.scope?.domain && (
                <Row k="作用網域" v={current.scope.domain} />
              )}
              {current.scope?.tags?.length && (
                <Row k="標籤" v={current.scope.tags.join(', ')} />
              )}
              <Row
                k="核准狀態"
                v={
                  current.tier === 'primitive'
                    ? '內建，無需核准'
                    : data?.approvals[current.name]
                      ? '已核准'
                      : '未核准'
                }
              />
            </div>

            <div className="d-sec">
              <div className="d-title">執行</div>
              <textarea
                className="args"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
                rows={4}
              />
              <div className="tool-actions">
                <button className="btn primary sm" onClick={run} disabled={running}>
                  {running ? '執行中…' : '執行'}
                </button>
                {current.tier !== 'primitive' &&
                  !data?.approvals[current.name] && (
                    <button
                      className="btn sm"
                      onClick={() => approve(current.name)}
                    >
                      核准
                    </button>
                  )}
                {current.tier !== 'primitive' && current.tier !== 'external' && (
                  <button
                    className="btn sm"
                    onClick={() => exportTool(current.name)}
                  >
                    匯出
                  </button>
                )}
              </div>
              {current.inputSchema?.properties && (
                <div className="schema-hint">
                  參數：
                  {Object.entries(current.inputSchema.properties).map(
                    ([k, v]) => (
                      <span key={k} className="param" title={v.description}>
                        {k}
                        <em>{v.type}</em>
                      </span>
                    ),
                  )}
                </div>
              )}
            </div>

            {result !== undefined && (
              <div className="d-sec">
                <div className="d-title">結果</div>
                <pre className="result">{result}</pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="d-row">
      <span className="d-k">{k}</span>
      <span className="d-v">{v}</span>
    </div>
  );
}
