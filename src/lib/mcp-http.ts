import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { silentLogger, type Logger } from './logger.ts';

export interface McpHttpOptions {
  /** Builds a fresh server per request; the transport is stateless. */
  createMcpServer: () => McpServer;
  port: number;
  host?: string;
  /** Prefix the proxy leaves on the path, e.g. `/ns`. */
  basePath?: string;
  /** Extra readiness check for /healthz; throw or return false when not ready. */
  health?: () => boolean | Promise<boolean>;
  logger?: Logger;
}

export interface McpHttpServer {
  url: string;
  close(): Promise<void>;
}

function normalizeBasePath(basePath = ''): string {
  const trimmed = basePath.replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null
  });
}

export async function startMcpHttpServer(
  options: McpHttpOptions
): Promise<McpHttpServer> {
  const logger = options.logger ?? silentLogger;
  const base = normalizeBasePath(options.basePath);
  const mcpPaths = new Set([`${base}/mcp`, '/mcp']);
  const healthPaths = new Set([`${base}/healthz`, '/healthz']);

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // Stateless mode has no session to attach a GET stream or a DELETE to.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      jsonRpcError(res, 405, 'Method not allowed');
      return;
    }
    const server = options.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (healthPaths.has(path) && req.method === 'GET') {
      const ok = options.health ? await options.health() : true;
      sendJson(res, ok ? 200 : 503, { status: ok ? 'ok' : 'starting' });
      return;
    }
    if (mcpPaths.has(path)) {
      await handleMcp(req, res);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error({ err: String(error), url: req.url }, 'request failed');
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
      else res.end();
    });
  });

  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  const port =
    typeof address === 'object' && address ? address.port : options.port;

  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${String(port)}${base}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeIdleConnections();
      })
  };
}
