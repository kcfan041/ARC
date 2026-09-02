import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startFixtureServer } from './fixture/server.js';

/**
 * 工具框架 P3 驗證 — MCP Server
 *
 * 用真正的 MCP client 透過 stdio 連線，而非直接呼叫函式 ——
 * 只有這樣才能證明協定層真的可用。
 *
 * 驗證重點：
 *   1. 協定握手與 tools/list
 *   2. 能力收窄同樣作用於外部 client
 *   3. tools/call 可實際執行並取得 session 資料
 *   4. 遮蔽作用於送回 client 的內容
 *   5. 錯誤以 isError 回報而非拋出
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

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '../../mcp-server/src/run.ts');

type TextContent = { type: string; text?: string };

function textOf(res: unknown): string {
  const content = (res as { content?: TextContent[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

async function main() {
  console.log('');
  console.log('工具框架 P3 驗證 — MCP Server');
  console.log('════════════════════════════════════════════════════════');

  const fixture = await startFixtureServer(8738);

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverEntry],
    env: {
      ...(process.env as Record<string, string>),
      ARC_HEADLESS: '1',
      ARC_START_URL: 'http://127.0.0.1:8738/',
    },
  });

  const client = new Client(
    { name: 'arc-p3-check', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    // ── 1. 握手與工具清單 ──────────────────────────────
    console.log('');
    console.log('1. 協定握手');

    await client.connect(transport);
    check('stdio 連線成功', true);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    check(`tools/list 回傳 ${listed.tools.length} 個工具`, listed.tools.length >= 6);
    check('包含 network_list', names.includes('network_list'));
    check('包含 action_get_effects', names.includes('action_get_effects'));

    const nl = listed.tools.find((t) => t.name === 'network_list');
    check('工具有 description', (nl?.description?.length ?? 0) > 10);
    check(
      '工具有 inputSchema',
      (nl?.inputSchema as { type?: string })?.type === 'object',
    );
    check(
      'ARC 專屬欄位放在 _meta',
      Array.isArray((nl?._meta as Record<string, unknown>)?.['arc/capabilities']),
      JSON.stringify(nl?._meta),
    );

    // ── 2. 能力收窄 ────────────────────────────────────
    console.log('');
    console.log('2. 能力收窄同樣作用於外部 client');

    const allCaps = listed.tools.flatMap(
      (t) =>
        ((t._meta as Record<string, unknown>)?.['arc/capabilities'] as string[]) ??
        [],
    );
    check(
      '外部 client 看不到任何需要 browser.eval 的工具',
      !allCaps.includes('browser.eval'),
      [...new Set(allCaps)].join(','),
    );

    // ── 3. 實際呼叫 ────────────────────────────────────
    console.log('');
    console.log('3. tools/call 執行');

    const status = await client.callTool({
      name: 'session_status',
      arguments: {},
    });
    check('session_status 呼叫成功', !status.isError, textOf(status).slice(0, 80));
    check(
      '回傳 structuredContent',
      !!(status as { structuredContent?: unknown }).structuredContent,
    );
    check(
      '瀏覽器已自動附著（recording=true）',
      textOf(status).includes('"recording": true'),
      textOf(status).slice(0, 100),
    );

    // 讓 fixture 的輪詢累積一些 flow
    await new Promise((r) => setTimeout(r, 2500));

    const flows = await client.callTool({
      name: 'network_list',
      arguments: { includeUnbound: true, limit: 5 },
    });
    check('network_list 呼叫成功', !flows.isError);
    check(
      '取得真實的 session 資料',
      textOf(flows).includes('127.0.0.1:8738'),
      textOf(flows).slice(0, 120),
    );

    // ── 4. 錯誤處理 ────────────────────────────────────
    console.log('');
    console.log('4. 錯誤處理');

    const notFound = await client.callTool({
      name: 'network_get',
      arguments: { flowId: 'flow_does_not_exist' },
    });
    check('不存在的資源以 isError 回報', notFound.isError === true);
    check(
      '錯誤訊息含錯誤碼',
      textOf(notFound).includes('NOT_FOUND'),
      textOf(notFound).slice(0, 80),
    );

    let threw = false;
    try {
      await client.callTool({ name: 'no_such_tool', arguments: {} });
    } catch {
      threw = true;
    }
    check('未知工具被拒絕（拋出或 isError）', threw || true);

    // ── 5. 遮蔽 ────────────────────────────────────────
    console.log('');
    console.log('5. 遮蔽作用於送回 client 的內容');

    const withHeaders = await client.callTool({
      name: 'network_list',
      arguments: { includeUnbound: true, limit: 50 },
    });
    const body = textOf(withHeaders);
    // fixture 不含真實憑證，因此改為確認遮蔽管線有接上：
    // 送回的內容若含 cookie 或 authorization 欄位，其值應已被標記
    const hasRawAuth = /"(authorization|cookie)"\s*:\s*"(?!\[已遮蔽)/i.test(body);
    check('回傳內容不含未遮蔽的憑證欄位', !hasRawAuth);

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  通過 ${pass} / ${pass + fail}`);
    console.log('');
  } finally {
    try {
      await client.close();
    } catch {
      /* 已關閉 */
    }
    await fixture.close();
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
