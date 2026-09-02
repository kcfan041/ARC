import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, type ToolDefinition } from '@arc/core-tools';
import { ProjectStore, hashSpec } from '@arc/core-store';
import { startFixtureServer } from './fixture/server.js';

/**
 * 工具框架 P3.5 驗證 — 持久化
 *
 * 對應 REVIEW.md T4。
 *
 * 最關鍵的一項：關掉再開，工具與觀測記錄仍在。
 * 這正是 MVP1-PLAN 2.6 指出的、DevTools 結構上缺少的能力 ——
 * 「關掉分頁後一切消失，明天無法接續」。
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

const DEMO_TOOL: ToolDefinition = {
  name: 'persisted_demo',
  title: '持久化示範',
  description: '用來驗證工具能否跨重啟存活',
  inputSchema: {
    type: 'object',
    properties: { needle: { type: 'string' } },
  },
  capabilities: ['session.read'],
  tier: 'sandboxed',
  origin: { kind: 'ai-generated' },
  scope: { domain: '127.0.0.1', tags: ['demo'] },
};

const DEMO_SPEC = {
  body: `var flows = listFlows();
         var n = args.needle || '/api/';
         var hits = 0;
         for (var i = 0; i < flows.length; i++) {
           if (flows[i].url.indexOf(n) !== -1) hits++;
         }
         return { total: flows.length, matched: hits };`,
};

async function main() {
  console.log('');
  console.log('工具框架 P3.5 驗證 — 持久化（REVIEW.md T4）');
  console.log('════════════════════════════════════════════════════════');

  const dir = mkdtempSync(join(tmpdir(), 'arc-store-'));
  const fixture = await startFixtureServer(8739);

  try {
    // ── 1. Schema ────────────────────────────────────
    console.log('');
    console.log('1. Schema 建立');

    {
      const store = new ProjectStore(dir);
      check('專案目錄已建立', existsSync(join(dir, 'arc.db')));
      check('objects 目錄已建立', existsSync(join(dir, 'objects')));
      check('schema 版本已記錄', store.schemaVersion === 1);
      store.close();
    }

    // ── 2. 第一次 session：建工具、跑操作 ─────────────
    console.log('');
    console.log('2. 第一次執行 — 建立工具與觀測記錄');

    let firstFlowCount = 0;
    let firstActionCount = 0;

    {
      const ws = new Workspace({ headless: true, projectDir: dir });
      check('Workspace 已接上 store', !!ws.store);

      ws.registerSandboxed(DEMO_TOOL, DEMO_SPEC);
      check('工具已註冊', !!ws.registry.get('persisted_demo'));
      check(
        '工具已寫入資料庫',
        !!ws.store?.getTool('persisted_demo'),
      );

      await ws.session.start('http://127.0.0.1:8739/');
      await new Promise((r) => setTimeout(r, 2000));
      const page = (
        ws.session as unknown as {
          rec: { page: { click: (s: string) => Promise<void> } };
        }
      ).rec.page;
      await page.click('#c1-btn');
      await new Promise((r) => setTimeout(r, 1300));
      await page.click('#c5-btn');
      await new Promise((r) => setTimeout(r, 1400));

      firstActionCount = ws.session.actions.length;
      firstFlowCount = ws.session.flows.length;

      const result = await ws.callTool('persisted_demo', { needle: '/api/' });
      check(
        '工具可執行並取得真實資料',
        result.ok,
        result.ok ? JSON.stringify((result.data as { value: unknown }).value) : '失敗',
      );

      ws.persistSession('session_1');
      check('session 已寫入', (ws.store?.listSessions().length ?? 0) === 1);

      ws.store?.addNote('flow', ws.session.flows[0]?.id ?? 'flow_1', '這是測試註記', {
        bookmarked: true,
      });
      check('註記已寫入', (ws.store?.listNotes().length ?? 0) === 1);

      await ws.close();
    }

    // ── 3. 重啟：資料是否還在 ────────────────────────
    console.log('');
    console.log('3. 重啟後 — 這是 P3.5 的核心驗證');

    {
      const ws = new Workspace({ headless: true, projectDir: dir });

      const listed = ws.listTools();
      check(
        '★ 工具在重啟後自動載回',
        !!ws.registry.get('persisted_demo'),
        listed.ok ? listed.data.map((t) => t.name).join(',') : '列出失敗',
      );

      const def = ws.registry.get('persisted_demo')?.def;
      check('工具的 tier 正確保存', def?.tier === 'sandboxed');
      check(
        '工具的 capabilities 正確保存',
        JSON.stringify(def?.capabilities) === JSON.stringify(['session.read']),
        JSON.stringify(def?.capabilities),
      );
      check(
        '工具的 scope 正確保存',
        def?.scope?.domain === '127.0.0.1',
        JSON.stringify(def?.scope),
      );
      check(
        '工具的 origin 正確保存',
        def?.origin.kind === 'ai-generated',
      );

      const loaded = ws.store?.loadObservations('session_1');
      check(
        '★ 觀測記錄在重啟後仍在',
        (loaded?.flows.length ?? 0) === firstFlowCount &&
          (loaded?.actions.length ?? 0) === firstActionCount,
        `flows ${loaded?.flows.length}/${firstFlowCount}, actions ${loaded?.actions.length}/${firstActionCount}`,
      );
      check(
        '綁定關係在重啟後仍在',
        (loaded?.bindings.length ?? 0) > 0,
        `bindings: ${loaded?.bindings.length}`,
      );
      check(
        '綁定記錄了產生它的策略',
        loaded?.bindings[0]?.strategy === 'D-rhythm',
        loaded?.bindings[0]?.strategy,
      );
      check('註記在重啟後仍在', (ws.store?.listNotes().length ?? 0) === 1);
      check(
        '註記的書籤狀態保存',
        ws.store?.listNotes()[0]?.bookmarked === true,
      );

      // 載回的工具要能真的執行，不只是資料還在
      await ws.session.start('http://127.0.0.1:8739/');
      await new Promise((r) => setTimeout(r, 1500));
      const rerun = await ws.callTool('persisted_demo', { needle: '/api/' });
      check(
        '★ 載回的工具可以實際執行',
        rerun.ok,
        rerun.ok ? JSON.stringify((rerun.data as { value: unknown }).value) : '失敗',
      );

      await ws.close();
    }

    // ── 4. 信任記錄 ──────────────────────────────────
    console.log('');
    console.log('4. 信任記錄（P4 的基礎）');

    {
      const ws = new Workspace({ headless: true, projectDir: dir });

      check('新工具預設未核准', !ws.isToolApproved('persisted_demo'));

      const approved = ws.approveTool('persisted_demo', '人工檢視過');
      check('核准操作成功', approved.ok);
      check('核准後狀態改變', ws.isToolApproved('persisted_demo'));

      // 內容改變後舊核准應失效 —— 這是信任綁定到 spec 雜湊的目的
      ws.registerSandboxed(DEMO_TOOL, {
        body: 'return "內容已被改動";',
      });
      check(
        '★ 工具內容改變後核准自動失效',
        !ws.isToolApproved('persisted_demo'),
      );

      check(
        '核准記錄保留歷史',
        (ws.store?.listApprovals('persisted_demo').length ?? 0) === 1,
      );

      await ws.close();
    }

    // ── 5. content-addressed 儲存 ────────────────────
    console.log('');
    console.log('5. Content-addressed 檔案儲存');

    {
      const store = new ProjectStore(dir);
      const body = JSON.stringify({ data: 'x'.repeat(5000) });

      const h1 = store.putObject(body, 'application/json', 'https://x/a');
      const h2 = store.putObject(body, 'application/json', 'https://x/b');
      check('相同內容得到相同雜湊（天然去重）', h1 === h2);

      const back = store.getObject(h1);
      check('內容可正確取回', back?.toString('utf8') === body);

      const h3 = store.putObject('不同的內容');
      check('不同內容得到不同雜湊', h3 !== h1);

      check(
        'spec 雜湊對相同內容穩定',
        hashSpec({ a: 1 }) === hashSpec({ a: 1 }) &&
          hashSpec({ a: 1 }) !== hashSpec({ a: 2 }),
      );

      store.close();
    }

    // ── 6. 無專案目錄時仍可運作 ──────────────────────
    console.log('');
    console.log('6. 未指定專案目錄時');

    {
      const ws = new Workspace({ headless: true });
      check('store 為 undefined', ws.store === undefined);
      ws.registerSandboxed(DEMO_TOOL, DEMO_SPEC);
      check('工具仍可註冊（僅存在於記憶體）', !!ws.registry.get('persisted_demo'));
      check('核准操作回報未設定專案', !ws.approveTool('persisted_demo').ok);
      await ws.close();
    }

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  通過 ${pass} / ${pass + fail}`);
    console.log('');
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
