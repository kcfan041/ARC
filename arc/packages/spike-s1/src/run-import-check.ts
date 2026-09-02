import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace, type ToolDefinition, type ToolPackage } from '@arc/core-tools';
import { computeIntegrity, packageTool, resolveName, reviewImport } from '@arc/tool-runtime';
import { startFixtureServer } from './fixture/server.js';

/**
 * 工具框架 P4 驗證 — 匯入匯出與信任鏈
 *
 * 驗證重點：
 *   1. 封裝與完整性雜湊
 *   2. 匯入審查（能力宣告、blocker、warning）
 *   3. 名稱衝突改名而非覆蓋
 *   4. 信任鏈：唯讀自動核准、有副作用需確認、內容改變即失效
 *   5. Tier 3 外部 MCP Server
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

const READONLY_TOOL: ToolDefinition = {
  name: 'count_flows',
  description: '統計符合條件的請求數量',
  inputSchema: { type: 'object', properties: { needle: { type: 'string' } } },
  capabilities: ['session.read'],
  tier: 'sandboxed',
  origin: { kind: 'ai-generated' },
};

const READONLY_SPEC = {
  body: `var f = listFlows();
         var n = args.needle || '/api/';
         var c = 0;
         for (var i = 0; i < f.length; i++) if (f[i].url.indexOf(n) !== -1) c++;
         return { total: f.length, matched: c };`,
};

const SIDE_EFFECT_TOOL: ToolDefinition = {
  name: 'replay_paginated',
  description: '重放請求並改變頁碼',
  inputSchema: { type: 'object' },
  capabilities: ['session.read', 'network.replay'],
  tier: 'declarative',
  origin: { kind: 'ai-generated' },
};

async function main() {
  console.log('');
  console.log('工具框架 P4 驗證 — 匯入匯出與信任鏈');
  console.log('════════════════════════════════════════════════════════');

  const dir = mkdtempSync(join(tmpdir(), 'arc-p4-'));
  const fixture = await startFixtureServer(8740);

  try {
    // ── 1. 封裝與完整性 ──────────────────────────────
    console.log('');
    console.log('1. 封裝與完整性雜湊');

    const pkg = packageTool(READONLY_TOOL, READONLY_SPEC, 'test-suite');
    check('封裝格式正確', pkg.kind === 'arc.tool-package');
    check('含版本標示', pkg.version === 1);
    check('含完整性雜湊', pkg.integrity.length === 32);

    check(
      '雜湊對鍵順序穩定',
      computeIntegrity({ ...READONLY_TOOL }, READONLY_SPEC) === pkg.integrity,
    );
    check(
      '內容改變則雜湊改變',
      computeIntegrity(READONLY_TOOL, { body: 'return 1;' }) !== pkg.integrity,
    );

    // ── 2. 匯入審查 ──────────────────────────────────
    console.log('');
    console.log('2. 匯入審查');

    const known = new Set([
      'session.read',
      'network.replay',
      'browser.eval',
    ] as const);

    const review = reviewImport(pkg, { knownCapabilities: known as never });
    check('合法封裝通過審查', !('error' in review));

    if (!('error' in review)) {
      check('列出宣告的能力', review.capabilities.length === 1);
      check('正確判定為唯讀', review.allReadOnly);
      check('無 blocker', review.blockers.length === 0);
    }

    check('非封裝格式被拒絕', () => {
      const r = reviewImport({ foo: 'bar' });
      return 'error' in r;
    });

    check('原語工具不可匯入', () => {
      const r = reviewImport(
        packageTool({ ...READONLY_TOOL, tier: 'primitive' }, READONLY_SPEC),
      );
      return !('error' in r) && r.blockers.length > 0;
    });

    check('未知能力被擋下', () => {
      const r = reviewImport(
        packageTool(
          { ...READONLY_TOOL, capabilities: ['fs.write' as never] },
          READONLY_SPEC,
        ),
        { knownCapabilities: known as never },
      );
      return !('error' in r) && r.blockers.length > 0;
    });

    check('雜湊不符時發出警告', () => {
      const tampered: ToolPackage = { ...pkg, integrity: 'x'.repeat(32) };
      const r = reviewImport(tampered);
      return !('error' in r) && r.integrityMismatch && r.warnings.length > 0;
    });

    check('annotations 謊稱唯讀時發出警告', () => {
      const liar = packageTool(
        {
          ...SIDE_EFFECT_TOOL,
          annotations: { readOnlyHint: true },
        },
        {},
      );
      const r = reviewImport(liar);
      return (
        !('error' in r) &&
        !r.allReadOnly &&
        r.warnings.some((w) => w.includes('自稱唯讀'))
      );
    });

    // ── 3. 名稱衝突 ──────────────────────────────────
    console.log('');
    console.log('3. 名稱衝突');

    check('無衝突時保留原名', resolveName('foo', new Set()) === 'foo');
    check(
      '衝突時加上來源前綴',
      resolveName('foo', new Set(['foo']), 'partner') === 'partner_foo',
    );
    check(
      '前綴也衝突時加序號',
      resolveName('foo', new Set(['foo', 'p_foo']), 'p') === 'p_foo_2',
    );

    // ── 4. 實際匯入與信任鏈 ──────────────────────────
    console.log('');
    console.log('4. 匯入與信任鏈');

    const ws = new Workspace({ headless: true, projectDir: dir });

    const imported = ws.importTool(pkg, { source: 'partner' });
    check('唯讀工具匯入成功', imported.ok);
    if (imported.ok) {
      check('未改名（無衝突）', !imported.data.renamed);
      check('★ 唯讀工具自動核准', imported.data.approved);
      check('工具已註冊', !!ws.registry.get(imported.data.name));
      check(
        'origin 標記為 imported',
        ws.registry.get(imported.data.name)?.def.origin.kind === 'imported',
      );
      check(
        'origin 記錄了來源',
        ws.registry.get(imported.data.name)?.def.origin.from === 'partner',
      );
    }

    const sidePkg = packageTool(SIDE_EFFECT_TOOL, {
      steps: [{ kind: 'filter', urlContains: '/api/' }],
    });
    const sideImport = ws.importTool(sidePkg, { source: 'partner' });
    check('有副作用的工具匯入成功', sideImport.ok);
    check(
      '★ 有副作用的工具不自動核准',
      sideImport.ok && !sideImport.data.approved,
    );

    if (sideImport.ok) {
      check(
        '核准前狀態為未核准',
        !ws.isToolApproved(sideImport.data.name),
      );
      ws.approveTool(sideImport.data.name, '人工檢視過');
      check('人工核准後生效', ws.isToolApproved(sideImport.data.name));
    }

    // 匯入與內建原語同名的工具
    const clashing = packageTool(
      { ...READONLY_TOOL, name: 'network_list' },
      READONLY_SPEC,
    );
    const clashImport = ws.importTool(clashing, { source: 'partner' });
    check('與內建原語同名時仍可匯入', clashImport.ok);
    check(
      '★ 自動改名而非覆蓋',
      clashImport.ok && clashImport.data.renamed,
      clashImport.ok ? clashImport.data.name : '',
    );
    check(
      '內建原語未被覆蓋',
      ws.registry.get('network_list')?.def.tier === 'primitive',
    );

    // ── 5. 匯入的工具實際可執行 ──────────────────────
    console.log('');
    console.log('5. 匯入的工具實際執行');

    await ws.session.start('http://127.0.0.1:8740/');
    await new Promise((r) => setTimeout(r, 2000));
    const page = (
      ws.session as unknown as {
        rec: { page: { click: (s: string) => Promise<void> } };
      }
    ).rec.page;
    await page.click('#c1-btn');
    await new Promise((r) => setTimeout(r, 1300));

    if (imported.ok) {
      const result = await ws.callTool(imported.data.name, { needle: '/api/' });
      check(
        '★ 匯入的工具可執行並取得真實資料',
        result.ok,
        result.ok
          ? JSON.stringify((result.data as { value: unknown }).value)
          : '執行失敗',
      );
    }

    // ── 6. 匯出往返 ──────────────────────────────────
    console.log('');
    console.log('6. 匯出往返');

    if (imported.ok) {
      const exported = ws.packageTool(imported.data.name, 'arc');
      check('已匯入的工具可再匯出', exported.ok);
      if (exported.ok) {
        check(
          '往返後 spec 內容不變',
          JSON.stringify(exported.data.spec) === JSON.stringify(READONLY_SPEC),
        );
        check(
          '往返後雜湊自洽',
          computeIntegrity(exported.data.def, exported.data.spec) ===
            exported.data.integrity,
        );
      }
    }

    check('原語無法匯出為封裝', !ws.packageTool('network_list').ok);

    // ── 7. 重啟後匯入的工具與核准仍在 ────────────────
    console.log('');
    console.log('7. 重啟後');

    const importedName = imported.ok ? imported.data.name : '';
    const sideName = sideImport.ok ? sideImport.data.name : '';
    await ws.close();

    {
      const ws2 = new Workspace({ headless: true, projectDir: dir });
      check('匯入的工具在重啟後仍在', !!ws2.registry.get(importedName));
      check('核准狀態在重啟後仍在', ws2.isToolApproved(importedName));
      check('人工核准的工具亦保留', ws2.isToolApproved(sideName));

      // 改動內容後核准應失效
      ws2.registerSandboxed(
        { ...READONLY_TOOL, name: importedName },
        { body: 'return "已被改動";' },
      );
      check(
        '★ 內容改動後核准自動失效',
        !ws2.isToolApproved(importedName),
      );
      await ws2.close();
    }

    // ── 8. Tier 3 外部 MCP Server ───────────────────
    console.log('');
    console.log('8. Tier 3 外部 MCP Server');

    {
      const ws3 = new Workspace({ headless: true });
      const here = dirname(fileURLToPath(import.meta.url));
      const serverEntry = join(here, '../../mcp-server/src/run.ts');

      // 用 ARC 自己的 MCP server 當外部 server —— 這同時
      // 驗證了 client 與 server 兩端的互通性
      const connected = await ws3.connectMcpServer({
        name: 'peer',
        command: 'npx',
        args: ['tsx', serverEntry],
        env: { ARC_HEADLESS: '1' },
      });

      check('連接外部 MCP Server 成功', connected.ok, 
        connected.ok ? '' : connected.error);

      if (connected.ok) {
        check('取得外部工具清單', connected.tools.length > 0);
        check(
          '外部工具改名以避免與內建衝突',
          connected.tools.every((t) => t.localName !== t.remoteName),
          connected.tools.map((t) => t.localName).slice(0, 3).join(','),
        );
        check(
          '★ 外部工具 tier 標為 external',
          connected.tools.every((t) => t.def.tier === 'external'),
        );
        check(
          '★ 外部工具能力宣告為空（我方無法限制對方程序）',
          connected.tools.every((t) => t.def.capabilities.length === 0),
        );

        const remote = connected.tools.find((t) =>
          t.remoteName === 'session_status',
        );
        if (remote) {
          const res = await ws3.callTool(remote.localName, {});
          check('★ 可透過協定呼叫外部工具', res.ok,
            res.ok ? '' : JSON.stringify(res.error));
        }

        check('server 清單正確', ws3.mcpServers.length === 1);
        await ws3.disconnectMcpServer('peer');
        check('中斷後工具被移除', ws3.mcpServers.length === 0);
        check(
          '中斷後工具不在 registry',
          connected.tools.every((t) => !ws3.registry.get(t.localName)),
        );
      }

      await ws3.close();
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
