import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.ts';
import { createStationProvider, type Deps } from './context.ts';
import { createCache } from './lib/cache.ts';
import { startMcpHttpServer } from './lib/mcp-http.ts';
import { createLogger } from './log.ts';
import { createNsClient } from './ns/client.ts';
import { registerTools } from './tools/index.ts';

// src/ and dist/ both sit one level below package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

const INSTRUCTIONS =
  'Dutch Railways (NS) travel information. Tools accept station names, NS codes or UIC codes. Times are Europe/Amsterdam, HH:mm, with the date only when it is not today. Prices are in euros. This is not an official NS service.';

export function createPerronServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: 'perron', version },
    { instructions: INSTRUCTIONS }
  );
  registerTools(server, deps);
  return server;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const ns = createNsClient({ apiKey: config.NS_API_KEY, logger });
  const cache = createCache({
    redisUrl: config.REDIS_URL,
    prefix: 'perron:',
    logger
  });
  const stations = createStationProvider(ns, cache);
  const deps: Deps = { ns, cache, stations, now: () => new Date(), logger };

  // Warm the station list; a failure is retried on the first tool call.
  stations()
    .then((index) => {
      logger.info({ stations: index.size }, 'station list loaded');
    })
    .catch((error: unknown) => {
      logger.warn({ err: String(error) }, 'station list not loaded yet');
    });

  const http = await startMcpHttpServer({
    createMcpServer: () => createPerronServer(deps),
    port: config.PORT,
    host: config.HOST,
    basePath: config.BASE_PATH,
    logger
  });
  logger.info({ url: http.url, redis: !!config.REDIS_URL }, 'perron listening');

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    Promise.all([http.close(), cache.close()])
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
