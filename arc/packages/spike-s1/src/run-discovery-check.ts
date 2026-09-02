import { Workspace, AGENT_DEFAULT_CAPABILITIES, type ToolDefinition } from '@arc/core-tools';
import { searchTools, summarise, tokenise, ALWAYS_VISIBLE } from '@arc/tool-runtime';
import { READ_ONLY_CAPABILITIES } from '@arc/core-model';
import { AgentFacade, providerFromEnv, type ToolHost } from '@arc/agent-facade';
import { startFixtureServer } from './fixture/server.js';

/**
 * 工具框架 P5 驗證 — 檢索與分層揭露
 *
 * 要解決的問題（MVP1-PLAN 3A.6）：
 *   300 工具 × 每個 schema 約 200 tokens = 60,000 tokens
 *   → 還沒開始工作，context 就滿了
 *
 * 驗證重點：
 *   1. 切詞（含中文）
 *   2. 檢索排序與召回
 *   3. 摘要成本遠低於完整 schema
 *   4. 分層揭露：工具超量時只保留常駐核心
 *   5. 規模測試：300 個工具下 context 仍受控
 *   6. 真實模型能否自行使用 find_tools
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

/** 產生大量工具以測試規模 */
function makeTools(n: number): ToolDefinition[] {
  const topics = [
    ['media', '影片與圖片', ['media', 'video']],
    ['paging', '分頁與翻頁', ['pagination']],
    ['auth', '登入與憑證', ['auth']],
    ['search', '搜尋結果', ['search']],
    ['export', '匯出資料', ['export']],
  ] as const;

  return Array.from({ length: n }, (_, i) => {
    const t = topics[i % topics.length]!;
    return {
      name: `${t[0]}_tool_${i}`,
      description: `處理${t[1]}相關的操作，編號 ${i}。這是用於規模測試的合成工具。`,
      inputSchema: {
        type: 'object',
        properties: { arg: { type: 'string', description: '參數' } },
      },
      capabilities: ['session.read'],
      tier: 'declarative',
      origin: { kind: 'ai-generated' },
      scope: { tags: [...t[2]] },
    } satisfies ToolDefinition;
  });
}

async function main() {
  console.log('');
  console.log('工具框架 P5 驗證 — 檢索與分層揭露');
  console.log('════════════════════════════════════════════════════════');

  // ── 1. 切詞 ────────────────────────────────────────
  console.log('');
  console.log('1. 切詞');

  check('英文切詞', () => tokenise('network list').includes('network'));
  check(
    '蛇底命名拆開',
    () => {
      const t = tokenise('network_list');
      return t.includes('network') && t.includes('list');
    },
  );
  check('中文以二字窗切分', () => tokenise('抓取影片').includes('影片'));
  check('中英混合', () => {
    const t = tokenise('找出 video 網址');
    return t.includes('video') && t.includes('網址');
  });

  // ── 2. 檢索 ────────────────────────────────────────
  console.log('');
  console.log('2. 檢索排序');

  const corpus = makeTools(50);
  corpus.push({
    name: 'extract_video_urls',
    title: '抽出影片網址',
    description: '從已觀測的請求中找出影片的真實網址。',
    inputSchema: { type: 'object' },
    capabilities: ['session.read'],
    tier: 'declarative',
    origin: { kind: 'builtin' },
    scope: { tags: ['media', 'video'] },
  });

  const byName = searchTools(corpus, 'extract_video_urls');
  check(
    '名稱完全命中排第一',
    byName[0]?.def.name === 'extract_video_urls',
    byName[0]?.def.name,
  );

  const byIntent = searchTools(corpus, '找出影片網址');
  check(
    '中文意圖可命中',
    byIntent.some((h) => h.def.name === 'extract_video_urls'),
    byIntent.slice(0, 3).map((h) => h.def.name).join(','),
  );

  const byTag = searchTools(corpus, 'pagination');
  check(
    '標籤可命中',
    byTag.length > 0 && byTag.every((h) => h.def.name.startsWith('paging')),
    byTag.slice(0, 3).map((h) => h.def.name).join(','),
  );

  check('回傳筆數受 limit 控制', searchTools(corpus, 'tool', { limit: 5 }).length === 5);
  check('無關意圖不亂命中', searchTools(corpus, 'zzzznonexistent').length === 0);
  check('命中原因可追溯', (byName[0]?.matched.length ?? 0) > 0, byName[0]?.matched.join(','));

  // ── 3. 摘要成本 ────────────────────────────────────
  console.log('');
  console.log('3. 摘要成本');

  const full = JSON.stringify(corpus[0]);
  const brief = JSON.stringify(summarise(corpus[0]!, READ_ONLY_CAPABILITIES));
  check(
    `摘要比完整 schema 小（${brief.length} vs ${full.length} 字元）`,
    brief.length < full.length * 0.7,
    `ratio ${(brief.length / full.length).toFixed(2)}`,
  );
  check('摘要保留判斷所需資訊', () => {
    const s = summarise(corpus[0]!, READ_ONLY_CAPABILITIES);
    return !!s.name && !!s.brief && typeof s.readOnly === 'boolean';
  });
  check('摘要正確標示唯讀', summarise(corpus[0]!, READ_ONLY_CAPABILITIES).readOnly);

  // ── 4. 分層揭露 ────────────────────────────────────
  console.log('');
  console.log('4. 分層揭露');

  const fixture = await startFixtureServer(8741);
  const ws = new Workspace({ headless: true });

  try {
    const host: ToolHost = {
      listTools: (o) => ws.listTools(o),
      callTool: (n, a, o) => ws.callTool(n, a, o),
    };

    // 少量工具時全部可見
    const smallFacade = new AgentFacade(
      host,
      { name: 'stub', model: 'stub', chat: async () => ({ content: '', toolCalls: [], finishReason: 'stop' }) },
      { maxToolsInContext: 40 },
    );
    const baseline = smallFacade.availableTools().length;
    check(`工具少於上限時全部可見（${baseline} 個）`, baseline > 0);
    check('未隱藏任何工具', smallFacade.hiddenToolCount() === 0);

    // 註冊 300 個工具
    for (const def of makeTools(300)) {
      ws.registerDeclarative(def, { steps: [{ kind: 'filter', urlContains: '/api/' }] });
    }

    const listedAll = ws.listTools({ limit: 10_000 });
    check(
      '★ registry 中確實有 300+ 個工具',
      listedAll.ok && listedAll.data.length >= 300,
      listedAll.ok ? String(listedAll.data.length) : 'failed',
    );

    const visible = smallFacade.availableTools();
    check(
      '★ 超量時只保留常駐核心工具',
      visible.length < 20,
      `可見 ${visible.length} 個`,
    );
    check(
      '★ 常駐清單包含 find_tools',
      visible.some((t) => t.name === 'find_tools'),
      visible.map((t) => t.name).join(','),
    );
    check(
      '常駐清單皆在 ALWAYS_VISIBLE 內',
      visible.every((t) => ALWAYS_VISIBLE.has(t.name)),
    );
    check(
      '被隱藏的工具數量正確回報',
      smallFacade.hiddenToolCount() > 280,
      `隱藏 ${smallFacade.hiddenToolCount()} 個（應 > 280）`,
    );

    // context 成本比較
    const fullCost = JSON.stringify(listedAll.ok ? listedAll.data : []).length;
    const trimmedCost = JSON.stringify(visible).length;
    check(
      `★ context 成本大幅下降（${Math.round(fullCost / 1000)}k → ${Math.round(trimmedCost / 1000)}k 字元）`,
      trimmedCost < fullCost * 0.15,
      `ratio ${(trimmedCost / fullCost).toFixed(3)}`,
    );

    // ── 5. find_tools 原語 ───────────────────────────
    console.log('');
    console.log('5. find_tools 原語');

    const found = await ws.callTool('find_tools', { intent: '分頁', limit: 5 });
    check('find_tools 可呼叫', found.ok);
    if (found.ok) {
      const hits = found.data as { name: string; brief: string }[];
      check('回傳結果非空', hits.length > 0, `${hits.length} 筆`);
      check(
        '回傳的是摘要而非完整 schema',
        hits.every((h) => !('inputSchema' in h)),
      );
      check(
        '命中相關工具',
        hits.some((h) => h.name.startsWith('paging')),
        hits.map((h) => h.name).slice(0, 3).join(','),
      );
    }

    const foundZh = await ws.callTool('find_tools', { intent: '影片' });
    check(
      '中文意圖可用',
      foundZh.ok && (foundZh.data as unknown[]).length > 0,
      foundZh.ok ? `${(foundZh.data as unknown[]).length} 筆` : '失敗',
    );

    check(
      'find_tools 本身宣告為唯讀',
      ws.registry.get('find_tools')?.def.capabilities.every((c) =>
        READ_ONLY_CAPABILITIES.has(c),
      ) ?? false,
    );

    // ── 6. 真實模型 ──────────────────────────────────
    const provider = providerFromEnv();
    if (!provider) {
      console.log('');
      console.log('  ⚠ 未設定 LLM 環境變數，跳過真實模型驗證');
    } else {
      console.log('');
      console.log(`6. 真實模型自行檢索（${provider.model}）`);

      await ws.session.start('http://127.0.0.1:8741/');
      await new Promise((r) => setTimeout(r, 2000));
      const page = (
        ws.session as unknown as {
          rec: { page: { click: (s: string) => Promise<void> } };
        }
      ).rec.page;
      await page.click('#c1-btn');
      await new Promise((r) => setTimeout(r, 1300));

      const facade = new AgentFacade(host, provider, {
        allowedCapabilities: AGENT_DEFAULT_CAPABILITIES,
        maxToolsInContext: 40,
      });

      console.log(
        `  （模型只看得到 ${facade.availableTools().length} 個工具，` +
          `另有 ${facade.hiddenToolCount()} 個需檢索）`,
      );

      const turn = await facade.ask(
        '我想找一個可以處理分頁的工具。有嗎？請告訴我工具名稱。',
      );

      check(
        '★ 模型自行使用 find_tools',
        turn.toolCalls.some((c) => c.name === 'find_tools'),
        turn.toolCalls.map((c) => c.name).join(','),
      );
      check(
        '模型回覆中提到找到的工具',
        /paging_tool_\d+/.test(turn.content),
        turn.content.slice(0, 160),
      );

      console.log('');
      console.log('  ── 模型呼叫 ──');
      for (const c of turn.toolCalls) {
        console.log(`    ${c.name}(${JSON.stringify(c.arguments)})`);
      }
      console.log('  ── 模型回覆 ──');
      console.log('    ' + turn.content.replace(/\n/g, '\n    ').slice(0, 300));
    }

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
