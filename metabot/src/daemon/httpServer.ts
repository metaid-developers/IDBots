import http from 'node:http';
import { Buffer } from 'node:buffer';
import { commandFailed } from '../core/contracts/commandResult';
import { handleDaemonRoutes } from './routes/daemon';
import { handleIdentityRoutes } from './routes/identity';
import { handleNetworkRoutes } from './routes/network';
import { handleServicesRoutes } from './routes/services';
import { handleTraceRoutes } from './routes/trace';
import { handleUiRoutes } from './routes/ui';
import type { MetabotDaemonHttpHandlers, RouteContext, RouteHandler } from './routes/types';

const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

const ROUTES: RouteHandler[] = [
  handleDaemonRoutes,
  handleIdentityRoutes,
  handleNetworkRoutes,
  handleServicesRoutes,
  handleTraceRoutes,
  handleUiRoutes,
];

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += bufferChunk.byteLength;
    if (totalBytes > JSON_BODY_LIMIT_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(bufferChunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object request body.');
  }
  return parsed as Record<string, unknown>;
}

export function createHttpServer(handlers: MetabotDaemonHttpHandlers = {}): http.Server {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    const context: RouteContext = {
      req,
      res,
      url: requestUrl,
      handlers,
      readJsonBody: () => readJsonBody(req),
      sendJson: (status, payload) => sendJson(res, status, payload),
      sendHtml: (status, html) => sendHtml(res, status, html),
      sendMethodNotAllowed: (allowed) => {
        res.setHeader('allow', allowed.join(', '));
        sendJson(res, 405, commandFailed('method_not_allowed', `Expected ${allowed.join(' or ')}.`));
      },
    };

    try {
      for (const route of ROUTES) {
        const handled = await route(context);
        if (handled) {
          return;
        }
      }

      context.sendJson(404, commandFailed('not_found', `No route matched ${requestUrl.pathname}.`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (requestUrl.pathname.startsWith('/ui/')) {
        context.sendHtml(500, `<!doctype html><html><body><h1>MetaBot UI Error</h1><pre>${message}</pre></body></html>`);
        return;
      }
      context.sendJson(500, commandFailed('internal_error', message));
    }
  });
}
