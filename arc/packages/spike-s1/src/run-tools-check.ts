import {
  Workspace,
  AGENT_DEFAULT_CAPABILITIES,
  isReadOnlyTool,
  type ToolDefinition,
} from '@arc/core-tools';
import { buildScope, extractPath, expandVary } from '@arc/tool-runtime';
import { startFixtureServer, FIXTURE_URL } from './fixture/server.js';

/**
 * 工具框架 P1 驗證
 *
 * 驗證重點：
 *   1. 原語工具有完整簽章（REVIEW.md C3 的要求）
 *   2. capability 注入：未宣告的能力不存在於作用域
 *   3. agent-facade 的能力收窄確實生效
 *   4. 宣告式工具（Tier 1）可執行且 dry-run 不發送請求
 *   5. 機械驗證：sourceFlow 必須真實存在
 */

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

async function main() {
  const server = await startFixtureServer(8734);
  const ws = new Workspace({ headless: true });

  try {
    console.log('');
    console.log('工具框架 P1 驗證');
    console.log('════════════════════════════════════════════════════════');

    // ── 1. 工具簽章完整性（C3）─────────────────────────
    console.log('');
    console.log('1. 工具簽章（REVIEW.md C3）');
    const listed = ws.listTools();
    if (!listed.ok) throw new Error('listTools failed');
    const defs = listed.data;

    check(`註冊了 ${defs.length} 個原語工具`, defs.length >= 6);
    check(
      '每個工具都有 description',
      defs.every((d) => d.description.length > 10),
    );
    check(
      '每個工具都有 inputSchema',
      defs.every((d) => d.inputSchema?.type === 'object'),
    );
    check(
      '每個工具都宣告了 capabilities',
      defs.every((d) => Array.isArray(d.capabilities) && d.capabilities.length > 0),
    );

    // ── 2. capability 注入（安全核心）───────────────────
    console.log('');
    console.log('2. Capability 注入 — 未宣告的能力不存在');

    const readOnlyTool = defs.find((d) => d.name === 'network_list')!;
    const navTool = defs.find((d) => d.name === 'browser_goto')!;

    const caps = {
      'session.read': { listFlows: () => [], getFlow: () => undefined },
      'browser.navigate': { goto: async () => {} },
      'browser.eval': { evaluate: async () => {} },
      'network.replay': { replay: async () => ({ status: 200, body: {} }) },
    };

    const roScope = buildScope(readOnlyTool, caps);
    check(
      'network_list 拿得到 listFlows',
      typeof roScope.scope.listFlows === 'function',
    );
    check(
      'network_list 拿不到 goto（未宣告）',
      !('goto' in roScope.scope),
      `scope keys: ${Object.keys(roScope.scope).join(',')}`,
    );
    check(
      'network_list 拿不到 evaluate（未宣告）',
      !('evaluate' in roScope.scope),
    );
    check(
      'network_list 拿不到 replay（未宣告）',
      !('replay' in roScope.scope),
    );

    const navScope = buildScope(navTool, caps);
    check('browser_goto 拿得到 goto', typeof navScope.scope.goto === 'function');
    check('browser_goto 拿不到 evaluate', !('evaluate' in navScope.scope));

    check(
      '唯讀判定依 capabilities 而非 annotations',
      isReadOnlyTool(readOnlyTool) && !isReadOnlyTool(navTool),
    );

    // annotations 不可信：工具可以謊稱唯讀
    const liar: ToolDefinition = {
      name: 'liar',
      description: '宣稱唯讀但需要 eval 能力',
      inputSchema: { type: 'object' },
      capabilities: ['browser.eval'],
      annotations: { readOnlyHint: true }, // ← 謊言
      tier: 'declarative',
      origin: { kind: 'ai-generated' },
    };
    check(
      'annotations 謊稱唯讀時，capabilities 仍正確判定為非唯讀',
      !isReadOnlyTool(liar),
    );

    // ── 3. agent-facade 能力收窄 ───────────────────────
    console.log('');
    console.log('3. Agent 能力收窄（MVP1-PLAN 3.4）');

    check(
      'LLM 預設不含 browser.eval',
      !AGENT_DEFAULT_CAPABILITIES.has('browser.eval'),
    );

    ws.registry.upsert(liar, () => ({ ok: true, data: null }));
    const denied = await ws.callTool(
      'liar',
      {},
      { allowedCapabilities: AGENT_DEFAULT_CAPABILITIES },
    );
    check(
      '需要 browser.eval 的工具被 agent 呼叫時遭拒',
      !denied.ok && denied.error.code === 'CAPABILITY_DENIED',
      denied.ok ? '竟然成功' : denied.error.code,
    );

    const agentList = ws.listTools({
      allowedCapabilities: AGENT_DEFAULT_CAPABILITIES,
    });
    check(
      'agent 的工具清單不含超出能力的工具',
      agentList.ok && !agentList.data.some((d) => d.name === 'liar'),
    );
    ws.registry.unregister('liar');

    // ── 4. 實際執行原語 ────────────────────────────────
    console.log('');
    console.log('4. 原語工具實際執行');

    await ws.session.start('http://127.0.0.1:8734/');
    await new Promise((r) => setTimeout(r, 2500));
    const page = (ws.session as unknown as { rec: { page: { click: (s: string) => Promise<void> } } }).rec.page;
    await page.click('#c1-btn');
    await new Promise((r) => setTimeout(r, 1400));

    const status = await ws.callTool('session_status');
    check('session_status 可呼叫', status.ok);

    const actions = await ws.callTool('action_list');
    check(
      'action_list 取得操作記錄',
      actions.ok && (actions.data as unknown[]).length > 0,
    );

    const effects = await ws.callTool('action_get_effects', {
      actionId: 'action_1',
    });
    const eff = effects.ok
      ? (effects.data as { flows: unknown[] })
      : { flows: [] };
    check(
      'action_get_effects 回傳操作觸發的請求',
      effects.ok && eff.flows.length > 0,
      `flows: ${eff.flows.length}`,
    );

    const notFound = await ws.callTool('network_get', { flowId: 'flow_999' });
    check(
      '不存在的 flow 回傳 NOT_FOUND',
      !notFound.ok && notFound.error.code === 'NOT_FOUND',
    );

    const unknown = await ws.callTool('no_such_tool');
    check(
      '未知工具回傳 NOT_FOUND',
      !unknown.ok && unknown.error.code === 'NOT_FOUND',
    );

    // ── 5. Tier 1 宣告式工具 ───────────────────────────
    console.log('');
    console.log('5. Tier 1 宣告式工具');

    const flowsRes = await ws.callTool('network_list', { limit: 5 });
    const firstFlow = flowsRes.ok
      ? (flowsRes.data as { id: string }[])[0]
      : undefined;

    ws.registerDeclarative(
      {
        name: 'demo_paginate',
        description: '示範：對已觀測的請求改變 page 參數重放',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['dry-run', 'probe', 'full'] },
          },
        },
        capabilities: ['session.read', 'network.replay'],
        tier: 'declarative',
        origin: { kind: 'ai-generated' },
        scope: { domain: '127.0.0.1', tags: ['pagination'] },
      },
      {
        steps: [
          {
            kind: 'replay',
            sourceFlow: firstFlow?.id ?? 'flow_1',
            vary: { page: { from: 1, to: 5 } },
            extract: '$.items[*].id',
            limit: { maxRequests: 5, ratePerSec: 1 },
          },
        ],
      },
    );

    check('宣告式工具已註冊', !!ws.registry.get('demo_paginate'));

    const dry = await ws.callTool('demo_paginate', { mode: 'dry-run' });
    const dryData = dry.ok
      ? (dry.data as { planned: unknown[]; results: unknown[] })
      : undefined;
    check(
      'dry-run 列出 5 個計畫請求',
      dry.ok && dryData?.planned.length === 5,
      dry.ok ? `planned: ${dryData?.planned.length}` : 'call failed',
    );
    check('dry-run 不實際發送請求', dry.ok && dryData?.results.length === 0);

    // 機械驗證：sourceFlow 必須真實存在
    ws.registerDeclarative(
      {
        name: 'fabricated',
        description: '引用不存在的 flow，模擬 LLM 憑空捏造',
        inputSchema: { type: 'object' },
        capabilities: ['session.read', 'network.replay'],
        tier: 'declarative',
        origin: { kind: 'ai-generated' },
      },
      {
        steps: [
          { kind: 'replay', sourceFlow: 'flow_does_not_exist', vary: {} },
        ],
      },
    );
    const fabricated = await ws.callTool('fabricated', { mode: 'dry-run' });
    check(
      '引用不存在的 flow 被拒絕（LLM 不得憑空產生）',
      !fabricated.ok && fabricated.error.code === 'NOT_FOUND',
    );

    // ── 6. 輔助函式 ────────────────────────────────────
    console.log('');
    console.log('6. 宣告式輔助函式');

    const varied = expandVary({ page: { from: 1, to: 3 } }, {});
    check('expandVary 展開範圍', varied.length === 3);

    const extracted = extractPath(
      { data: { items: [{ url: 'a' }, { url: 'b' }] } },
      '$.data.items[*].url',
    );
    check(
      'extractPath 抽取陣列欄位',
      extracted.length === 2 && extracted[0] === 'a',
      JSON.stringify(extracted),
    );

    // ── 7. 作用域過濾（context 控制）───────────────────
    console.log('');
    console.log('7. 作用域過濾（原規格書 §37 context 控制）');

    const scoped = ws.listTools({ domain: 'example.com' });
    check(
      '不相符的網域工具被排除',
      scoped.ok && !scoped.data.some((d) => d.name === 'demo_paginate'),
    );
    const matched = ws.listTools({ domain: '127.0.0.1' });
    check(
      '相符的網域工具保留',
      matched.ok && matched.data.some((d) => d.name === 'demo_paginate'),
    );

    // ── 8. 匯出 ────────────────────────────────────────
    console.log('');
    console.log('8. 工具匯出');

    const exported = ws.exportTool('demo_paginate');
    check('宣告式工具可匯出為純資料', exported.ok);
    const primitiveExport = ws.exportTool('network_list');
    check(
      '原語工具不可匯出（行為在程式碼裡）',
      !primitiveExport.ok,
    );

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  通過 ${pass} / ${pass + fail}`);
    console.log('');
  } finally {
    await ws.close();
    await server.close();
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
