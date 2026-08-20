import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { startGuiServer } from './server.js';

/**
 * GUI 啟動器
 *
 * 開發時：先跑 `npm run dev --workspace @arc/gui`（Vite dev server，
 *         有 HMR），再跑本腳本。Vite 會把 /api 與 /ws 代理到這裡。
 * 檢視時：先 `npm run build --workspace @arc/gui`，
 *         本腳本會直接提供建置產物。
 */

const here = dirname(fileURLToPath(import.meta.url));
const guiDist = join(here, '../../gui/dist');

const opts: Parameters<typeof startGuiServer>[0] = {};
if (existsSync(guiDist)) opts.staticDir = guiDist;

const srv = await startGuiServer(opts);

console.log('');
console.log('  ARC GUI');
console.log(`  ${srv.url}`);
if (!opts.staticDir) {
  console.log('');
  console.log('  尚未建置前端。可選擇：');
  console.log('    npm run gui:build   建置後由本 server 提供');
  console.log('    npm run gui:dev     Vite dev server（有 HMR）→ :8732');
}
console.log('');

const shutdown = async () => {
  console.log('\n關閉中…');
  await srv.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
