import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Workspace, type SessionEvent } from '@arc/core-tools';

/**
 * GUI Server
 *
 * 決策（見 MVP1-PLAN.md GUI 章節）：
 *   MVP1 不打包成桌面應用，改以 localhost 網頁提供介面。
 *
 * 理由：
 *   視窗數量其實相同 —— 無論哪種方案，使用者都會有
 *   「ARC 介面」與「Playwright 開的 Chromium」兩個視窗。
 *   而後端本來就是 Node 程序在跑 Playwright，
 *   多開一個 HTTP server 幾乎零成本，且順便解決即時更新。
 *
 *   是否打包成 Electron / Tauri 可延到 MVP2 之後再決定 ——
 *   屆時才會知道是否真的需要原生選單、全域快捷鍵、檔案對話框。
 */

/** 讀取 request body 並解析為 JSON。空 body 回傳 undefined。 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // 工具封裝不應超過此大小；避免無上限地累積記憶體
    if (size > 8 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export type GuiServerOptions = {
  port?: number;
  /** 前端建置產物目錄 */
  staticDir?: string;
  headless?: boolean;
  /** 專案目錄。給定時工具會持久化，重啟後自動載回。 */
  projectDir?: string;
};

export async function startGuiServer(opts: GuiServerOptions = {}) {
  const port = opts.port ?? 8730;
  // GUI 走 Workspace 而非直接用 Session —— 這樣工具面板
  // 與人工操作共用同一個 registry，符合 §42 原則 3
  // （GUI / CLI / Agent 共用同一套 API）。
  const workspace = new Workspace({
    headless: opts.headless ?? false,
    ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
  });
  const session = workspace.session;
  const clients = new Set<WebSocket>();

  const broadcast = (ev: SessionEvent) => {
    const msg = JSON.stringify(ev);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  };
  session.on(broadcast);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // ── 控制 API ──────────────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      try {
        if (url.pathname === '/api/start' && req.method === 'POST') {
          const target = url.searchParams.get('url') ?? undefined;
          await session.start(target);
          res.end(JSON.stringify({ ok: true, status: session.status() }));
          return;
        }
        if (url.pathname === '/api/goto' && req.method === 'POST') {
          const target = url.searchParams.get('url');
          if (!target) {
            res.writeHead(400).end(JSON.stringify({ ok: false, error: 'missing url' }));
            return;
          }
          await session.goto(target);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === '/api/stop' && req.method === 'POST') {
          await session.stop();
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === '/api/snapshot') {
          res.end(
            JSON.stringify({
              actions: session.actions,
              flows: session.flows,
              bindings: session.bindings(),
              status: session.status(),
            }),
          );
          return;
        }

        // ── 工具面板 ────────────────────────────────────
        //
        // 人工路徑不套用 allowedCapabilities —— core-tools
        // 對人工零限制（MVP1-PLAN 3.0）。收窄只作用於 LLM。
        if (url.pathname === '/api/tools') {
          const listed = workspace.listTools({ limit: 10_000 });
          res.end(
            JSON.stringify({
              ok: listed.ok,
              tools: listed.ok ? listed.data : [],
              approvals: listed.ok
                ? Object.fromEntries(
                    listed.data.map((t) => [
                      t.name,
                      workspace.isToolApproved(t.name),
                    ]),
                  )
                : {},
              persistent: !!workspace.store,
            }),
          );
          return;
        }

        if (url.pathname === '/api/tools/call' && req.method === 'POST') {
          const name = url.searchParams.get('name');
          if (!name) {
            res
              .writeHead(400)
              .end(JSON.stringify({ ok: false, error: 'missing name' }));
            return;
          }
          const args = await readJson(req);
          const result = await workspace.callTool(
            name,
            (args ?? {}) as Record<string, unknown>,
          );
          res.end(JSON.stringify(result));
          return;
        }

        if (url.pathname === '/api/tools/export') {
          const name = url.searchParams.get('name');
          if (!name) {
            res
              .writeHead(400)
              .end(JSON.stringify({ ok: false, error: 'missing name' }));
            return;
          }
          res.end(JSON.stringify(workspace.packageTool(name, 'arc-gui')));
          return;
        }

        if (url.pathname === '/api/tools/review' && req.method === 'POST') {
          const pkg = await readJson(req);
          res.end(JSON.stringify(workspace.reviewImport(pkg)));
          return;
        }

        if (url.pathname === '/api/tools/import' && req.method === 'POST') {
          const pkg = await readJson(req);
          // approve 只在明確指定時傳入 —— 否則會覆蓋掉
          // importTool 的預設行為（唯讀工具自動核准）
          const approveParam = url.searchParams.get('approve');
          res.end(
            JSON.stringify(
              workspace.importTool(pkg, {
                ...(approveParam !== null
                  ? { approve: approveParam === '1' }
                  : {}),
                source: url.searchParams.get('source') ?? 'file',
              }),
            ),
          );
          return;
        }

        if (url.pathname === '/api/tools/approve' && req.method === 'POST') {
          const name = url.searchParams.get('name');
          if (!name) {
            res
              .writeHead(400)
              .end(JSON.stringify({ ok: false, error: 'missing name' }));
            return;
          }
          res.end(
            JSON.stringify(workspace.approveTool(name, '於 GUI 中人工核准')),
          );
          return;
        }
      } catch (err) {
        res
          .writeHead(500)
          .end(JSON.stringify({ ok: false, error: String(err) }));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    // ── 靜態檔案 ──────────────────────────────────────────
    if (!opts.staticDir) {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(
        '<!doctype html><meta charset=utf-8><p style="font:14px ui-monospace">' +
          'GUI 尚未建置。請先執行 <code>npm run build --workspace @arc/gui</code>',
      );
      return;
    }

    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    // 防止路徑穿越
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = join(opts.staticDir, safe);

    if (existsSync(file)) {
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(file));
      return;
    }

    // SPA fallback
    const index = join(opts.staticDir, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html']! });
      res.end(readFileSync(index));
      return;
    }

    res.writeHead(404).end('not found');
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500).end(String(err));
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    // 新連線先給完整快照，之後才收增量事件
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        data: {
          actions: session.actions,
          flows: session.flows,
          bindings: session.bindings(),
          status: session.status(),
        },
      }),
    );
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    session,
    workspace,
    close: async () => {
      // 用 workspace.close() 而非 session.stop()，
      // 才會一併關閉外部 MCP 子程序與資料庫連線
      await workspace.close();
      for (const ws of clients) ws.close();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
