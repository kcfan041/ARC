import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Workspace } from '@arc/core-tools';
import { createArcMcpServer } from './server.js';
import { WorkspaceMcpHost } from './host.js';

/**
 * ARC MCP Server 進入點（stdio）
 *
 * 供 Claude Desktop 等 MCP client 啟動。設定範例：
 *
 *   {
 *     "mcpServers": {
 *       "arc": {
 *         "command": "npx",
 *         "args": ["tsx", "<專案路徑>/arc/packages/mcp-server/src/run.ts"]
 *       }
 *     }
 *   }
 *
 * 只用 stdio transport —— 刻意不啟用 SDK 的 HTTP transport，
 * 那會拉進 express、hono、oauth 等一整套依賴，
 * 而本地 client 並不需要。
 *
 * ★ stdout 專供協定使用。任何診斷訊息一律走 stderr，
 *   否則會破壞 JSON-RPC 訊框。
 */

const ws = new Workspace({
  headless: process.env.ARC_HEADLESS === '1',
});

const host = new WorkspaceMcpHost(ws, process.env.ARC_START_URL);
const server = createArcMcpServer(host);

const shutdown = async () => {
  try {
    await ws.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error('[arc] MCP server ready on stdio');
