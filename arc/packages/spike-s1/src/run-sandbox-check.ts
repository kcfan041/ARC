import { Workspace, warmupSandbox, AGENT_DEFAULT_CAPABILITIES } from '@arc/core-tools';
import { runInSandbox, probeSandboxGlobals } from '@arc/tool-runtime';
import { startFixtureServer } from './fixture/server.js';

/**
 * 工具框架 P2 驗證 — QuickJS 沙箱
 *
 * 驗證重點：
 *   1. 隔離性：全域環境是空的，沒有 fetch / require / process
 *   2. capability 注入：只看得到宣告過的能力
 *   3. 資源限制：時間、記憶體、堆疊、host 呼叫次數
 *   4. 錯誤分類：資源超限與程式錯誤可區分
 *   5. 執行間互不影響
 *   6. 與 Registry 整合：Tier 2 工具可註冊、呼叫、匯出
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

type Res = Awaited<ReturnType<typeof runInSandbox>>;
const val = (r: Res) => (r.ok ? r.data.value : undefined);
const code = (r: Res) => (r.ok ? undefined : r.error.code);

async function main() {
  await warmupSandbox();
  const server = await startFixtureServer(8736);
  const ws = new Workspace({ headless: true });

  try {
    console.log('');
    console.log('工具框架 P2 驗證 — QuickJS 沙箱');
    console.log('════════════════════════════════════════════════════════');

    // ── 1. 隔離性 ──────────────────────────────────────
    console.log('');
    console.log('1. 隔離性 — 全域環境');

    const globals = await probeSandboxGlobals();
    const g = (globals.ok ? globals.data.value : {}) as Record<string, string>;

    check('沒有 fetch', g.fetch === 'undefined');
    check('沒有 require', g.require === 'undefined');
    check('沒有 process', g.process === 'undefined');
    check('沒有 XMLHttpRequest', g.XMLHttpRequest === 'undefined');
    check('沒有 WebSocket', g.WebSocket === 'undefined');
    check('沒有 setTimeout', g.setTimeout === 'undefined');

    // eval 與 Function 在 QuickJS 內部仍可用，但它們同樣受限於
    // 沙箱作用域 —— 拿不到任何未注入的東西，因此不構成逃逸途徑。
    const evalEscape = await runInSandbox(
      `try { return eval("typeof fetch"); } catch (e) { return 'blocked'; }`,
      {},
    );
    check(
      'eval 存在但無法藉此取得未注入的能力',
      val(evalEscape) === 'undefined' || val(evalEscape) === 'blocked',
      String(val(evalEscape)),
    );

    // ── 2. capability 注入 ─────────────────────────────
    console.log('');
    console.log('2. Capability 注入');

    const injected = await runInSandbox(
      `return { allowed: typeof allowed_fn, denied: typeof denied_fn };`,
      { allowed_fn: () => 1 },
    );
    const inj = val(injected) as { allowed: string; denied: string };
    check('已注入的能力可見', inj?.allowed === 'function');
    check('未注入的能力不存在', inj?.denied === 'undefined');

    const called = await runInSandbox(
      `var r = get_flows(); return r.length;`,
      { get_flows: async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    );
    check('注入的非同步函式可呼叫且回傳正確', val(called) === 3);

    check(
      'asyncify 使非同步函式在沙箱內表現為同步（無需 await）',
      called.ok && called.data.hostCalls === 1,
    );

    // ── 3. 資源限制 ────────────────────────────────────
    console.log('');
    console.log('3. 資源限制');

    const t0 = Date.now();
    const infinite = await runInSandbox(`while(1){}`, {}, { timeMs: 500 });
    const elapsed = Date.now() - t0;
    check('無窮迴圈被中斷', code(infinite) === 'TIMEOUT');
    check(
      `中斷發生在時限附近（實際 ${elapsed}ms）`,
      elapsed < 1500,
      `${elapsed}ms`,
    );

    const memory = await runInSandbox(
      `var a=[]; for(var i=0;i<500000;i++){ a.push({x:i,y:'padding'}); } return a.length;`,
      {},
      { memoryBytes: 1024 * 1024, timeMs: 10_000 },
    );
    check(
      '記憶體超限被攔截',
      code(memory) === 'RESOURCE_EXCEEDED',
      memory.ok ? '竟然成功' : memory.error.message.slice(0, 50),
    );

    const stack = await runInSandbox(
      `function f(){ return f(); } return f();`,
      {},
      { stackBytes: 128 * 1024, timeMs: 5000 },
    );
    check(
      '堆疊溢位被攔截',
      code(stack) === 'RESOURCE_EXCEEDED',
      stack.ok ? '竟然成功' : stack.error.message.slice(0, 50),
    );

    const hostLimit = await runInSandbox(
      `for(var i=0;i<50;i++){ ping(); } return 'done';`,
      { ping: () => 1 },
      { maxHostCalls: 5 },
    );
    check(
      'host 呼叫次數上限生效',
      code(hostLimit) === 'RESOURCE_EXCEEDED',
      hostLimit.ok ? '竟然成功' : hostLimit.error.message.slice(0, 50),
    );

    // ── 4. 錯誤分類 ────────────────────────────────────
    console.log('');
    console.log('4. 錯誤分類');

    const syntax = await runInSandbox(`this is not valid js`, {});
    check(
      '語法錯誤歸類為 EXECUTION_FAILED',
      code(syntax) === 'EXECUTION_FAILED',
    );

    const thrown = await runInSandbox(`throw new Error('工具內部錯誤');`, {});
    check(
      '工具拋出的例外歸類為 EXECUTION_FAILED',
      code(thrown) === 'EXECUTION_FAILED' &&
        !thrown.ok &&
        thrown.error.message.includes('工具內部錯誤'),
    );

    check(
      '資源超限與程式錯誤可區分',
      code(memory) === 'RESOURCE_EXCEEDED' &&
        code(syntax) === 'EXECUTION_FAILED',
    );

    // host 函式拋錯時，錯誤要能傳回沙箱內
    const hostThrow = await runInSandbox(
      `try { boom(); return 'no-throw'; } catch (e) { return 'caught'; }`,
      {
        boom: () => {
          throw new Error('host side failure');
        },
      },
    );
    check(
      'host 函式的錯誤可被沙箱內的 try/catch 攔截',
      val(hostThrow) === 'caught',
      String(val(hostThrow)),
    );

    // ── 5. 執行間隔離 ──────────────────────────────────
    console.log('');
    console.log('5. 執行間隔離');

    await runInSandbox(`globalThis.leaked = 'secret'; return 1;`, {});
    const leak = await runInSandbox(
      `return typeof globalThis.leaked;`,
      {},
    );
    check('前次執行的全域變數不會殘留', val(leak) === 'undefined');

    const afterCrash = await runInSandbox(`return 42;`, {});
    check('前次執行崩潰後仍可正常執行', val(afterCrash) === 42);

    // ── 6. 與 Registry 整合 ────────────────────────────
    console.log('');
    console.log('6. Tier 2 工具整合');

    await ws.session.start('http://127.0.0.1:8736/');
    await new Promise((r) => setTimeout(r, 2000));
    const page = (
      ws.session as unknown as {
        rec: { page: { click: (s: string) => Promise<void> } };
      }
    ).rec.page;
    await page.click('#c1-btn');
    await new Promise((r) => setTimeout(r, 1200));

    ws.registerSandboxed(
      {
        name: 'count_api_flows',
        description:
          '示範 Tier 2：用迴圈與條件判斷統計 API 請求，' +
          '這是宣告式模型表達不了的邏輯。',
        inputSchema: {
          type: 'object',
          properties: {
            needle: { type: 'string', description: '網址須包含的字串' },
          },
        },
        capabilities: ['session.read'],
        tier: 'sandboxed',
        origin: { kind: 'ai-generated' },
      },
      {
        body: `
          var flows = listFlows();
          var needle = args.needle || '/api/';
          var counts = {};
          for (var i = 0; i < flows.length; i++) {
            var u = flows[i].url;
            if (u.indexOf(needle) === -1) continue;
            var key = u.split('?')[0];
            counts[key] = (counts[key] || 0) + 1;
          }
          log('掃描了', flows.length, '筆');
          return counts;
        `,
      },
    );

    check('Tier 2 工具已註冊', !!ws.registry.get('count_api_flows'));
    check(
      'tier 標示正確',
      ws.registry.get('count_api_flows')?.def.tier === 'sandboxed',
    );

    const counted = await ws.callTool('count_api_flows', { needle: '/api/' });
    const cd = counted.ok
      ? (counted.data as { value: Record<string, number>; logs: string[] })
      : undefined;
    check(
      'Tier 2 工具可執行並取得真實 session 資料',
      counted.ok && Object.keys(cd?.value ?? {}).length > 0,
      counted.ok ? JSON.stringify(cd?.value) : '呼叫失敗',
    );
    check('log 輸出可取得', (cd?.logs.length ?? 0) > 0);

    // 沙箱工具只宣告 session.read，因此拿不到 replay
    ws.registerSandboxed(
      {
        name: 'overreach',
        description: '只宣告 session.read 卻嘗試使用 replay',
        inputSchema: { type: 'object' },
        capabilities: ['session.read'],
        tier: 'sandboxed',
        origin: { kind: 'ai-generated' },
      },
      { body: `return typeof replay;` },
    );
    const over = await ws.callTool('overreach');
    check(
      '未宣告的能力在沙箱內不存在',
      over.ok && (over.data as { value: string }).value === 'undefined',
      over.ok ? String((over.data as { value: string }).value) : 'call failed',
    );

    // agent 能力收窄同樣適用於 Tier 2
    ws.registerSandboxed(
      {
        name: 'needs_eval',
        description: '宣告 browser.eval 的沙箱工具',
        inputSchema: { type: 'object' },
        capabilities: ['browser.eval'],
        tier: 'sandboxed',
        origin: { kind: 'ai-generated' },
      },
      { body: `return 1;` },
    );
    const denied = await ws.callTool(
      'needs_eval',
      {},
      { allowedCapabilities: AGENT_DEFAULT_CAPABILITIES },
    );
    check(
      'agent 能力收窄對 Tier 2 一樣生效',
      !denied.ok && denied.error.code === 'CAPABILITY_DENIED',
    );

    const exported = ws.exportTool('count_api_flows');
    check('Tier 2 工具可匯出為純資料', exported.ok);

    // 參數以 JSON 注入而非字串拼接，避免參數被當成程式碼
    ws.registerSandboxed(
      {
        name: 'arg_injection',
        description: '確認參數不會被當成程式碼執行',
        inputSchema: { type: 'object' },
        capabilities: ['session.read'],
        tier: 'sandboxed',
        origin: { kind: 'ai-generated' },
      },
      { body: `return args.evil;` },
    );
    const injection = await ws.callTool('arg_injection', {
      evil: "'; globalThis.pwned = true; var x = '",
    });
    check(
      '參數以資料形式注入，不會被當成程式碼',
      injection.ok &&
        (injection.data as { value: string }).value ===
          "'; globalThis.pwned = true; var x = '",
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
