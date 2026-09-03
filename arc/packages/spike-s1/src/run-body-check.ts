import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@arc/core-tools';
import { redact } from '@arc/agent-facade';
import { isStreamSegment } from '@arc/browser-runtime';
import { startFixtureServer } from './fixture/server.js';

/**
 * Response 擷取驗證
 *
 * 驗證重點：
 *   1. 各類型內容都能擷取（JSON / HTML / JS / 二進位）
 *   2. 狀態碼與 headers 有記錄
 *   3. 單筆上限的截斷
 *   4. 串流分段預設排除
 *   5. 預算耗盡時停止擷取但錄製繼續
 *   6. ★ 新增的 headers 有走到遮蔽路徑
 *   7. 重啟後 body 仍可取回
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

const BASE = 'http://127.0.0.1:8743';

/** 讓頁面實際發出請求，使 CDP 有東西可擷取 */
async function fetchIn(page: { evaluate: (fn: string) => Promise<unknown> }, path: string) {
  await page.evaluate(
    `fetch(${JSON.stringify(path)}).then(r => r.arrayBuffer()).then(() => 1)`,
  );
  await new Promise((r) => setTimeout(r, 400));
}

async function main() {
  console.log('');
  console.log('Response 擷取驗證');
  console.log('════════════════════════════════════════════════════════');

  const dir = mkdtempSync(join(tmpdir(), 'arc-body-'));
  const fixture = await startFixtureServer(8743);

  try {
    // ── 1-4. 基本擷取 ────────────────────────────────
    const ws = new Workspace({
      headless: true,
      projectDir: dir,
      capture: { maxBodyBytes: 100_000 },
    });

    await ws.session.start(`${BASE}/`);
    await new Promise((r) => setTimeout(r, 1800));
    const page = (
      ws.session as unknown as { rec: { page: never } }
    ).rec.page as unknown as { evaluate: (fn: string) => Promise<unknown> };

    await fetchIn(page, '/api/data?marker=body-json');
    await fetchIn(page, '/blob/script.js');
    await fetchIn(page, '/blob/image.png');
    await fetchIn(page, '/blob/large.json?size=200000');
    await fetchIn(page, '/stream/seg-1.ts');
    await fetchIn(page, '/api/login');
    await new Promise((r) => setTimeout(r, 900));

    const find = (needle: string) =>
      ws.session.flows.find((f) => f.url.includes(needle));

    console.log('');
    console.log('1. 各類型內容擷取');

    const json = find('marker=body-json');
    check('JSON 已擷取', json?.body?.status === 'captured', json?.body?.status);
    check('JSON 有狀態碼', json?.response?.status === 200, String(json?.response?.status));
    check('JSON 有 mimeType', json?.response?.mimeType?.includes('json') ?? false);

    const jsonBody = await ws.callTool('network_get_body', { flowId: json?.id });
    const jd = jsonBody.ok ? (jsonBody.data as Record<string, unknown>) : undefined;
    check('可透過工具取回 JSON 內容', jd?.available === true);
    check(
      '內容正確',
      String(jd?.content ?? '').includes('body-json'),
      String(jd?.content ?? '').slice(0, 60),
    );

    const js = find('script.js');
    check('JavaScript 已擷取', js?.body?.status === 'captured', js?.body?.status);
    const jsBody = await ws.callTool('network_get_body', { flowId: js?.id });
    check(
      'JavaScript 內容正確',
      jsBody.ok &&
        String((jsBody.data as { content?: string }).content ?? '').includes('42'),
    );

    const html = ws.session.flows.find((f) => f.resourceType === 'Document');
    check('HTML 文件已擷取', html?.body?.status === 'captured', html?.body?.status);

    const img = find('image.png');
    check('二進位已擷取', img?.body?.status === 'captured', img?.body?.status);
    check('二進位標記為 base64', img?.body?.base64 === true);
    const imgBody = await ws.callTool('network_get_body', { flowId: img?.id });
    const imd = imgBody.ok ? (imgBody.data as Record<string, unknown>) : undefined;
    check('★ 二進位不回傳原始資料給呼叫端', imd?.binary === true);
    check('二進位仍提供 hash 供取用', typeof imd?.hash === 'string');

    console.log('');
    console.log('2. 截斷與排除');

    const large = find('large.json');
    check(
      '超過單筆上限時截斷',
      large?.body?.status === 'truncated',
      `${large?.body?.status} size=${large?.body?.size} stored=${large?.body?.storedSize}`,
    );
    check(
      '截斷後記錄原始大小',
      (large?.body?.size ?? 0) > (large?.body?.storedSize ?? 0),
    );
    const largeBody = await ws.callTool('network_get_body', { flowId: large?.id });
    check(
      '截斷的內容仍可取回並標記',
      largeBody.ok && (largeBody.data as { truncated?: boolean }).truncated === true,
    );

    const seg = find('seg-1.ts');
    check('★ 串流分段預設排除', seg?.body?.status === 'skipped', seg?.body?.status);
    const segBody = await ws.callTool('network_get_body', { flowId: seg?.id });
    check(
      '排除時說明原因',
      segBody.ok &&
        String((segBody.data as { reason?: string }).reason ?? '').length > 0,
      segBody.ok ? String((segBody.data as { reason?: string }).reason) : '',
    );

    check('isStreamSegment 認得 .ts', isStreamSegment('/x/seg-1.ts'));
    check('isStreamSegment 認得 .m4s', isStreamSegment('/x/chunk_1.m4s'));
    check(
      'playlist 不算分段（很小且是結構關鍵）',
      !isStreamSegment('/x/index.m3u8'),
    );

    console.log('');
    console.log('3. Headers 與遮蔽');

    const login = find('/api/login');
    check('記錄 response headers', !!login?.response?.headers);
    check(
      'Set-Cookie 有被記錄（core-tools 對人工零限制）',
      JSON.stringify(login?.response?.headers ?? {}).includes('abc123secret'),
    );
    check('記錄 request headers', !!login?.requestHeaders);

    // ★ 最關鍵的一項：新增的欄位必須走到遮蔽路徑
    const redacted = JSON.stringify(redact(login).value);
    check(
      '★ response headers 的 Set-Cookie 已遮蔽',
      !redacted.includes('abc123secret'),
      redacted.slice(0, 120),
    );
    check(
      '★ request headers 也走遮蔽路徑',
      !/"cookie"\s*:\s*"(?!\[已遮蔽)/i.test(redacted),
    );

    const loginBody = await ws.callTool('network_get_body', { flowId: login?.id });
    const lb = loginBody.ok
      ? String((loginBody.data as { content?: string }).content ?? '')
      : '';
    check('body 中的 token 原值可被人工取得', lb.includes('eyJhbGciOiJIUzI1NiJ9'));
    const redactedBody = JSON.stringify(redact({ content: lb }).value);
    check(
      '★ body 中的 JWT 送往 LLM 前被遮蔽',
      !redactedBody.includes('eyJhbGciOiJIUzI1NiJ9'),
    );
    check(
      '★ body 中的 email 送往 LLM 前被遮蔽',
      !redactedBody.includes('user@example.com'),
    );

    console.log('');
    console.log('4. 預算');

    const b = ws.session.captureBudget();
    check('預算有記錄使用量', b.usedBytes > 0, `${b.usedBytes} bytes`);
    check('預算未耗盡', !b.exceeded);
    check('略過的筆數有記錄', b.skipped > 0, `${b.skipped} 筆`);

    const bodyHash = json?.body?.hash;
    await ws.persistSession('body_session');
    await ws.close();

    // ── 5. 重啟後 ────────────────────────────────────
    console.log('');
    console.log('5. 重啟後');

    {
      const ws2 = new Workspace({ headless: true, projectDir: dir });
      const back = bodyHash ? ws2.store?.getObject(bodyHash) : undefined;
      check(
        '★ body 在重啟後仍可取回',
        !!back && back.toString('utf8').includes('body-json'),
        back ? back.toString('utf8').slice(0, 50) : '取不到',
      );
      await ws2.close();
    }

    // ── 6. 預算耗盡 ──────────────────────────────────
    console.log('');
    console.log('6. 預算耗盡時的行為');

    {
      const dir2 = mkdtempSync(join(tmpdir(), 'arc-budget-'));
      const ws3 = new Workspace({
        headless: true,
        projectDir: dir2,
        // 刻意設極小的預算
        capture: { maxTotalBytes: 4096, maxBodyBytes: 4096 },
      });
      await ws3.session.start(`${BASE}/`);
      await new Promise((r) => setTimeout(r, 1500));
      const p3 = (ws3.session as unknown as { rec: { page: never } })
        .rec.page as unknown as { evaluate: (fn: string) => Promise<unknown> };

      for (let i = 0; i < 4; i += 1) {
        await fetchIn(p3, `/blob/large.json?size=50000&n=${i}`);
      }
      await new Promise((r) => setTimeout(r, 800));

      const bg = ws3.session.captureBudget();
      check('預算耗盡', bg.exceeded, `${bg.usedBytes}/${bg.totalBytes}`);
      check(
        '★ 錄製繼續進行（flow 仍被記錄）',
        ws3.session.flows.length > 3,
        `${ws3.session.flows.length} flows`,
      );
      check(
        '耗盡後的請求標記為 budget-exceeded',
        ws3.session.flows.some((f) => f.body?.status === 'budget-exceeded'),
        ws3.session.flows
          .map((f) => f.body?.status)
          .filter(Boolean)
          .join(','),
      );
      check(
        '綁定功能不受影響',
        Array.isArray(ws3.session.bindings()),
      );

      await ws3.close();
      rmSync(dir2, { recursive: true, force: true });
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
