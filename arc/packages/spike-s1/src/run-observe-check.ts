import { Workspace, AGENT_DEFAULT_CAPABILITIES } from '@arc/core-tools';
import { redact } from '@arc/agent-facade';
import { startFixtureServer } from './fixture/server.js';

/**
 * 觀測能力驗證 — storage 與 interact
 *
 * 補齊此前只有宣告、沒有原語的三個 capability：
 *   storage.read       追查 token 存到哪裡
 *   browser.interact   讓 LLM 能操作頁面而非只能觀察
 *
 * 驗證重點：
 *   1. cookie 讀取涵蓋 HttpOnly（document.cookie 看不到的部分）
 *   2. storage_diff 能指出某個操作寫了什麼
 *   3. 互動原語可實際操作頁面
 *   4. 互動後可經由 action_get_effects 追出後果
 *   5. ★ storage 內容送往 LLM 前有遮蔽
 *   6. 錯誤訊息對 LLM 可理解
 */

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean | (() => boolean), detail?: string) {
  let r: boolean;
  try {
    r = typeof cond === 'function' ? cond() : cond;
  } catch (err) {
    r = false;
    detail = detail ?? String(err);
  }
  if (r) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

type Dict = Record<string, unknown>;

async function main() {
  console.log('');
  console.log('觀測能力驗證 — storage 與 interact');
  console.log('════════════════════════════════════════════════════════');

  const fixture = await startFixtureServer(8749);
  const ws = new Workspace({ headless: true });

  try {
    await ws.session.start('http://127.0.0.1:8749/');
    await new Promise((r) => setTimeout(r, 1800));

    // ── 1. 儲存讀取 ──────────────────────────────────
    console.log('');
    console.log('1. 儲存讀取');

    const empty = await ws.callTool('storage_get');
    check('storage_get 可呼叫', empty.ok);
    const e0 = empty.ok ? (empty.data as Dict) : {};
    check('回傳三種儲存區', 'cookies' in e0 && 'localStorage' in e0 && 'sessionStorage' in e0);

    // 建立基準，然後觸發會寫入 cookie 的請求
    await ws.callTool('storage_diff', { reset: true });

    const page = (
      ws.session as unknown as {
        rec: { page: { evaluate: (f: string) => Promise<unknown> } };
      }
    ).rec.page;
    await page.evaluate(`fetch('/api/login').then(r => r.text())`);
    await page.evaluate(
      `localStorage.setItem('access_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
       localStorage.setItem('theme', 'dark');
       sessionStorage.setItem('nonce', 'abc123');`,
    );
    await new Promise((r) => setTimeout(r, 700));

    const after = await ws.callTool('storage_get');
    const st = after.ok ? (after.data as Dict) : {};
    const cookies = (st.cookies ?? []) as { name: string; httpOnly: boolean }[];

    check(
      '★ 讀得到 HttpOnly cookie（網頁自身的 JS 看不到）',
      cookies.some((c) => c.name === 'session' && c.httpOnly),
      cookies.map((c) => `${c.name}${c.httpOnly ? '(httpOnly)' : ''}`).join(','),
    );

    // 對照：頁面自己的 document.cookie 確實看不到
    const visible = await page.evaluate('document.cookie');
    check(
      '對照組：document.cookie 看不到該項目',
      !String(visible).includes('session='),
      String(visible) || '(空)',
    );

    check(
      '讀得到 localStorage',
      Object.keys((st.localStorage ?? {}) as Dict).length === 2,
    );
    check(
      '讀得到 sessionStorage',
      Object.keys((st.sessionStorage ?? {}) as Dict).length === 1,
    );

    // ── 2. storage diff ──────────────────────────────
    console.log('');
    console.log('2. 變化追蹤');

    const diff = await ws.callTool('storage_diff');
    const changes = diff.ok
      ? ((diff.data as Dict).changes as {
          area: string;
          key: string;
          kind: string;
        }[])
      : [];

    check('storage_diff 可呼叫', diff.ok);
    check(
      '★ 偵測到 localStorage 的新增',
      changes.some((c) => c.area === 'localStorage' && c.key === 'access_token' && c.kind === 'added'),
      changes.map((c) => `${c.area}:${c.key}:${c.kind}`).join(' '),
    );
    check(
      '★ 偵測到 cookie 的新增',
      changes.some((c) => c.area === 'cookie' && c.kind === 'added'),
    );
    check(
      '偵測到 sessionStorage 的新增',
      changes.some((c) => c.area === 'sessionStorage' && c.key === 'nonce'),
    );

    // 修改與刪除
    await ws.callTool('storage_diff', { reset: true });
    await page.evaluate(
      `localStorage.setItem('theme', 'light'); localStorage.removeItem('access_token');`,
    );
    const diff2 = await ws.callTool('storage_diff');
    const c2 = diff2.ok
      ? ((diff2.data as Dict).changes as { key: string; kind: string }[])
      : [];
    check(
      '偵測到修改',
      c2.some((c) => c.key === 'theme' && c.kind === 'changed'),
      c2.map((c) => `${c.key}:${c.kind}`).join(' '),
    );
    check(
      '偵測到刪除',
      c2.some((c) => c.key === 'access_token' && c.kind === 'removed'),
    );

    // ── 3. 遮蔽 ──────────────────────────────────────
    console.log('');
    console.log('3. 遮蔽（storage 依定義含憑證）');

    const snapshot = await ws.session.storage();
    const raw = JSON.stringify(snapshot);
    check(
      'core-tools 保留原值（對人工零限制）',
      raw.includes('abc123') || raw.includes('dark'),
    );

    await page.evaluate(
      `localStorage.setItem('access_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');`,
    );
    const withToken = await ws.session.storage();
    const redacted = JSON.stringify(redact(withToken).value);

    check(
      '★ localStorage 中的 JWT 送往 LLM 前被遮蔽',
      !redacted.includes('eyJhbGciOiJIUzI1NiJ9'),
      redacted.slice(0, 100),
    );
    check(
      '★ cookie 值被遮蔽',
      !redacted.includes('abc123secret'),
    );
    check(
      '非敏感項目保留（遮蔽不過度）',
      redacted.includes('dark') || redacted.includes('theme'),
    );

    // ── 4. 互動 ──────────────────────────────────────
    console.log('');
    console.log('4. 互動原語');

    const el = await ws.callTool('page_interactables', { limit: 30 });
    const items = el.ok ? (el.data as { selector?: string; text?: string }[]) : [];
    check('page_interactables 可呼叫', el.ok);
    check('列出可互動元素', items.length > 0, `${items.length} 個`);
    check(
      '提供可用的定位方式',
      items.filter((i) => i.selector).length > 0,
      items.slice(0, 3).map((i) => i.selector ?? i.text).join(','),
    );
    check(
      '★ 不回傳完整 DOM（context 控制）',
      JSON.stringify(items).length < 20_000,
      `${JSON.stringify(items).length} 字元`,
    );

    const before = ws.session.flows.length;
    const clicked = await ws.callTool('browser_click', { selector: '#c1-btn' });
    check('browser_click 可執行', clicked.ok, clicked.ok ? '' : JSON.stringify(clicked.error));
    await new Promise((r) => setTimeout(r, 1200));
    check(
      '★ 點擊確實觸發了網路請求',
      ws.session.flows.length > before,
      `${before} → ${ws.session.flows.length}`,
    );

    // 以文字定位
    const byText = await ws.callTool('browser_click', { text: '觸發 c5' });
    check('可用可見文字定位', byText.ok, byText.ok ? '' : JSON.stringify(byText.error));
    await new Promise((r) => setTimeout(r, 1000));

    // ── 5. 互動與綁定串接 ────────────────────────────
    console.log('');
    console.log('5. 互動 → 綁定 → 追出後果');

    const actions = ws.session.actions;
    check(
      '★ 工具觸發的點擊有被記錄為 action',
      actions.length >= 2,
      `${actions.length} 個 action`,
    );

    const lastAction = actions[actions.length - 1];
    if (lastAction) {
      const effects = await ws.callTool('action_get_effects', {
        actionId: lastAction.id,
      });
      const flows = effects.ok
        ? ((effects.data as Dict).flows as unknown[])
        : [];
      check(
        '★ 可追出該操作觸發了哪些請求',
        effects.ok && flows.length > 0,
        `${flows.length} 個請求`,
      );
    }

    // ── 6. 錯誤處理 ──────────────────────────────────
    console.log('');
    console.log('6. 錯誤處理');

    const missing = await ws.callTool('browser_click', {
      selector: '#does-not-exist',
    });
    check('點擊不存在的元素回報失敗', !missing.ok);
    check(
      '★ 錯誤訊息對 LLM 可理解（非原始堆疊）',
      !missing.ok &&
        missing.error.message.includes('page_interactables') &&
        missing.error.message.length < 200,
      missing.ok ? '' : missing.error.message.slice(0, 120),
    );

    const noArgs = await ws.callTool('browser_click', {});
    check('未給定位條件時回報失敗', !noArgs.ok);

    // ── 7. 能力邊界 ──────────────────────────────────
    console.log('');
    console.log('7. 能力邊界');

    const listed = ws.listTools({ limit: 100 });
    const names = listed.ok ? listed.data.map((t) => t.name) : [];
    check('新原語已註冊', 
      ['storage_get', 'storage_diff', 'page_interactables',
       'browser_click', 'browser_fill', 'browser_press']
        .every((n) => names.includes(n)),
      names.join(','),
    );

    const agentTools = ws.listTools({
      allowedCapabilities: AGENT_DEFAULT_CAPABILITIES,
      limit: 100,
    });
    const agentNames = agentTools.ok ? agentTools.data.map((t) => t.name) : [];
    check(
      'LLM 可使用 storage 與互動能力',
      agentNames.includes('storage_get') && agentNames.includes('browser_click'),
    );
    check(
      'browser.eval 仍不對 LLM 開放',
      !AGENT_DEFAULT_CAPABILITIES.has('browser.eval'),
    );

    const storageTool = ws.registry.get('storage_get')?.def;
    check(
      'storage_get 宣告為唯讀能力',
      storageTool?.capabilities.join(',') === 'storage.read',
    );
    const clickTool = ws.registry.get('browser_click')?.def;
    check(
      'browser_click 宣告為有副作用',
      clickTool?.annotations?.readOnlyHint === false,
    );

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  通過 ${pass} / ${pass + fail}`);
    console.log('');
  } finally {
    await ws.close();
    await fixture.close();
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
