import { Workspace, AGENT_DEFAULT_CAPABILITIES } from '@arc/core-tools';
import {
  AgentFacade,
  createProvider,
  redact,
  reveal,
  providerFromEnv,
  type ToolHost,
} from '@arc/agent-facade';
import { startFixtureServer } from './fixture/server.js';

/**
 * 工具框架 P2.5 驗證 — LLM 層
 *
 * 驗證重點：
 *   1. 遮蔽：憑證與個資不會外流
 *   2. 能力收窄：LLM 看不到、也呼叫不到超出範圍的工具
 *   3. 真實 tool calling：模型能否從 schema 正確推導參數
 *   4. context 控制：過長的結果會被截斷
 */

let pass = 0;
let fail = 0;

/** 接受布林或回傳布林的函式，後者可讓斷言就地計算 */
function check(
  name: string,
  cond: boolean | (() => boolean),
  detail?: string,
) {
  let result: boolean;
  try {
    result = typeof cond === 'function' ? cond() : cond;
  } catch (err) {
    result = false;
    detail = detail ?? String(err);
  }
  if (result) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('');
  console.log('工具框架 P2.5 驗證 — LLM 層');
  console.log('════════════════════════════════════════════════════════');

  // ── 1. 遮蔽（不需要 LLM，先測）─────────────────────
  console.log('');
  console.log('1. 敏感資料遮蔽（REVIEW.md M5）');

  const sample = {
    id: 'flow_1',
    url: 'https://example.com/api/me',
    headers: {
      authorization: 'Bearer sk-abc123456789012345678901234567890',
      cookie: 'session=xyz789; theme=dark',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
    },
    body: {
      email: 'user@example.com',
      accessToken:
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      displayName: 'Alice',
      itemCount: 42,
    },
  };

  const r = redact(sample);
  const json = JSON.stringify(r.value);

  check('Authorization 被遮蔽', !json.includes('sk-abc123456789012345678901234567890'));
  check('Cookie 被遮蔽', !json.includes('session=xyz789'));
  check('JWT 被遮蔽', !json.includes('eyJhbGciOiJIUzI1NiJ9'));
  check('email 被遮蔽', !json.includes('user@example.com'));
  check(
    '非敏感欄位保留',
    json.includes('Alice') && json.includes('42') && json.includes('Mozilla/5.0'),
  );
  check('遮蔽記錄可還原原值', () => {
    const first = r.redactions[0];
    return !!first && reveal(r.redactions, first.id) === first.original;
  });
  check(
    '遮蔽處留下可辨識的標記',
    /\[已遮蔽:\w[\w-]*#r\d+\]/.test(json),
    json.slice(0, 120),
  );

  // 相同的值應得到相同的標記
  const dup = redact({ a: 'user@example.com', b: 'user@example.com' });
  const dupJson = JSON.stringify(dup.value) as string;
  const marks = dupJson.match(/#r\d+/g) ?? [];
  check(
    '相同的值使用同一個標記',
    marks.length === 2 && marks[0] === marks[1],
    marks.join(','),
  );

  check('信用卡號被遮蔽（Luhn 驗證）', () => {
    const c = redact({ card: '4111 1111 1111 1111' });
    return !JSON.stringify(c.value).includes('4111 1111 1111 1111');
  });
  check('一般長數字不被誤判為卡號', () => {
    const c = redact({ n: '1234567890123456789' });
    return JSON.stringify(c.value).includes('1234567890123456789');
  });

  // ── 準備 workspace ─────────────────────────────────
  const server = await startFixtureServer(8737);
  const ws = new Workspace({ headless: true });

  try {
    await ws.session.start('http://127.0.0.1:8737/');
    await new Promise((r2) => setTimeout(r2, 2000));
    const page = (
      ws.session as unknown as {
        rec: { page: { click: (s: string) => Promise<void> } };
      }
    ).rec.page;
    await page.click('#c1-btn');
    await new Promise((r2) => setTimeout(r2, 1200));
    await page.click('#c5-btn');
    await new Promise((r2) => setTimeout(r2, 1400));

    const host: ToolHost = {
      listTools: (o) => ws.listTools(o),
      callTool: (n, a, o) => ws.callTool(n, a, o),
    };

    // ── 2. 能力收窄 ──────────────────────────────────
    console.log('');
    console.log('2. 能力收窄');

    ws.registerSandboxed(
      {
        name: 'needs_eval_tool',
        description: '宣告 browser.eval 的工具',
        inputSchema: { type: 'object' },
        capabilities: ['browser.eval'],
        tier: 'sandboxed',
        origin: { kind: 'ai-generated' },
      },
      { body: 'return 1;' },
    );

    const provider = providerFromEnv();
    if (!provider) {
      console.log('');
      console.log('  ⚠ 未設定 LLM 環境變數，跳過需要模型的項目');
      console.log('    需要 OPENAI_API_KEY / ARC_LLM_BASE_URL / ARC_LLM_MODEL');
      console.log('');
      console.log(`  通過 ${pass} / ${pass + fail}（僅遮蔽層）`);
      process.exit(fail === 0 ? 0 : 1);
    }

    const facade = new AgentFacade(host, provider, {
      allowedCapabilities: AGENT_DEFAULT_CAPABILITIES,
    });

    const visible = facade.availableTools();
    check(
      'LLM 看不到超出能力範圍的工具',
      !visible.some((t) => t.name === 'needs_eval_tool'),
      visible.map((t) => t.name).join(','),
    );
    check('LLM 看得到唯讀原語', visible.some((t) => t.name === 'network_list'));

    const denied = await ws.callTool(
      'needs_eval_tool',
      {},
      { allowedCapabilities: AGENT_DEFAULT_CAPABILITIES },
    );
    check(
      '越權呼叫被拒絕',
      !denied.ok && denied.error.code === 'CAPABILITY_DENIED',
    );

    // ── 3. 真實 tool calling ─────────────────────────
    console.log('');
    console.log(`3. 真實 tool calling（${provider.name} / ${provider.model}）`);

    const turn = await facade.ask(
      '這個 session 裡有哪些網路請求？只要告訴我數量和它們的路徑。',
    );

    check('模型有呼叫工具', turn.toolCalls.length > 0, `rounds=${turn.rounds}`);
    check(
      '呼叫的是存在的工具',
      turn.toolCalls.every((c) => !!ws.registry.get(c.name)),
      turn.toolCalls.map((c) => c.name).join(','),
    );
    check(
      '工具呼叫成功',
      turn.toolCalls.some((c) => c.result.ok),
      turn.toolCalls
        .map((c) => (c.result.ok ? 'ok' : c.result.error.code))
        .join(','),
    );
    check('模型產生了文字回覆', turn.content.length > 0);
    check('未達到輪次上限', turn.stoppedReason !== 'max_rounds');

    console.log('');
    console.log('  ── 模型實際呼叫 ──');
    for (const c of turn.toolCalls) {
      console.log(
        `    ${c.name}(${JSON.stringify(c.arguments)}) → ${c.result.ok ? 'ok' : c.result.error.code}`,
      );
    }
    console.log('');
    console.log('  ── 模型回覆 ──');
    console.log(
      '    ' + turn.content.replace(/\n/g, '\n    ').slice(0, 400),
    );

    // ── 4. 針對性提問 ────────────────────────────────
    console.log('');
    console.log('4. 跨層關聯提問（ARC 的核心能力）');

    const turn2 = await facade.ask(
      '使用者的第一個操作觸發了哪些請求？請引用具體的 action 與 flow 識別碼。',
    );

    check(
      '模型使用了關聯查詢工具',
      turn2.toolCalls.some(
        (c) => c.name === 'action_get_effects' || c.name === 'action_list',
      ),
      turn2.toolCalls.map((c) => c.name).join(','),
    );
    check(
      '回覆中引用了識別碼',
      /action_\d+|flow_\d+/.test(turn2.content),
      turn2.content.slice(0, 150),
    );

    console.log('');
    console.log('  ── 模型回覆 ──');
    console.log(
      '    ' + turn2.content.replace(/\n/g, '\n    ').slice(0, 500),
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
