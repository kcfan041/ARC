import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * S1 Fixture 靜態伺服器
 *
 * 刻意用 node:http 而非任何框架 —— spike 程式碼預期會被丟棄，
 * 不值得為它增加依賴。
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, 'page.html'), 'utf8');

export const FIXTURE_PORT = 8731;
export const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/`;

export function startFixtureServer(port = FIXTURE_PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // ── response 擷取用的各類型端點 ──────────────────
    //
    // 刻意涵蓋文字、二進位、大型內容與敏感 header，
    // 用以驗證擷取策略與遮蔽路徑。

    if (url.pathname === '/blob/image.png') {
      // 1x1 透明 PNG，用於驗證二進位擷取
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
          'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
      return;
    }

    if (url.pathname === '/blob/large.json') {
      // 超過測試用的單筆上限，驗證截斷
      const size = Number(url.searchParams.get('size')) || 200_000;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ padding: 'x'.repeat(size) }));
      return;
    }

    if (url.pathname === '/blob/script.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('export const answer = 42;\n');
      return;
    }

    if (url.pathname === '/stream/seg-1.ts') {
      // 串流分段，預設應被排除
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end(Buffer.alloc(2048, 7));
      return;
    }

    if (url.pathname === '/api/login') {
      // 回應含敏感 header 與 token，驗證遮蔽路徑
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=abc123secret; Path=/; HttpOnly',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          accessToken:
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
          email: 'user@example.com',
          displayName: 'Alice',
        }),
      );
      return;
    }

    // 操作觸發走 /api/data 與 /api/shared，
    // 雜訊走 /api/poll 與 /api/prefetch。
    // 分開端點是為了讓 urlPattern 能區分兩者（見 periodic.ts 註解）。
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          marker: url.searchParams.get('marker'),
          at: Date.now(),
        }),
      );
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(PAGE);
      return;
    }

    res.writeHead(404).end('not found');
  });

  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

// 直接執行時作為獨立伺服器啟動（供人工開瀏覽器查看）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  startFixtureServer().then(() => {
    console.log(`fixture: ${FIXTURE_URL}`);
  });
}
