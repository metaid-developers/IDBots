import fs from 'fs';
import http from 'http';
import path from 'path';

const LOCAL_HOST = '127.0.0.1';
const HEALTH_PATH = '/__idbots/metaapps/health';
const METHOD_NOT_ALLOWED_BODY = 'Method Not Allowed';
const FORBIDDEN_BODY = 'Forbidden';
const NOT_FOUND_BODY = 'Not Found';
const INTERNAL_ERROR_BODY = 'Internal Server Error';

type ServerReadyInfo = {
  baseUrl: string;
  port: number;
};

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

let server: http.Server | null = null;
let activeRoot: string | null = null;
let activeBaseUrl: string | null = null;
let activePort: number | null = null;
let startingServer: Promise<ServerReadyInfo> | null = null;

const isGetOrHead = (method?: string): method is 'GET' | 'HEAD' => {
  return method === 'GET' || method === 'HEAD';
};

const writeResponse = (
  res: http.ServerResponse,
  statusCode: number,
  body: string | Buffer,
  method: 'GET' | 'HEAD',
  headers: Record<string, string> = {},
): void => {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
};

const decodePathSegments = (pathname: string): string[] | null => {
  const rawSegments = pathname.split('/');
  const decodedSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment) {
      continue;
    }
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (!decodedSegment || decodedSegment.includes('/') || decodedSegment.includes('\\')) {
      return null;
    }
    decodedSegments.push(decodedSegment);
  }
  return decodedSegments;
};

const waitForServerListening = (localServer: http.Server): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    const onListening = () => {
      localServer.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      localServer.off('listening', onListening);
      reject(error);
    };

    localServer.once('listening', onListening);
    localServer.once('error', onError);
  });
};

const resolveRequestFile = (root: string, pathname: string): string | null => {
  const segments = decodePathSegments(pathname);
  if (!segments || segments.length < 2) {
    return null;
  }

  const [appId, ...relativeSegments] = segments;
  if (!appId || appId === '.' || appId === '..') {
    return null;
  }
  if (relativeSegments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  const rootRealPath = fs.realpathSync.native(root);
  const candidatePath = path.resolve(rootRealPath, appId, ...relativeSegments);
  let candidateRealPath: string;
  try {
    candidateRealPath = fs.realpathSync.native(candidatePath);
  } catch {
    return null;
  }

  const relativeToRoot = path.relative(rootRealPath, candidateRealPath);
  if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidateRealPath);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  return candidateRealPath;
};

const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const method = req.method ?? 'GET';
  if (!isGetOrHead(method)) {
    res.setHeader('Allow', 'GET, HEAD');
    res.writeHead(405, { 'Cache-Control': 'no-store' });
    res.end(METHOD_NOT_ALLOWED_BODY);
    return;
  }

  const rawUrl = req.url ?? '/';
  const rawPathname = rawUrl.split('?', 1)[0] || '/';
  if (rawPathname === HEALTH_PATH) {
    writeResponse(
      res,
      200,
      JSON.stringify({ ok: true }),
      method,
      { 'Content-Type': 'application/json; charset=utf-8' },
    );
    return;
  }

  const root = activeRoot;
  if (!root) {
    writeResponse(res, 503, NOT_FOUND_BODY, method, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const segments = decodePathSegments(rawPathname);
  if (segments && segments.some((segment) => segment === '.' || segment === '..')) {
    writeResponse(res, 403, FORBIDDEN_BODY, method, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  if (!segments) {
    writeResponse(res, 403, FORBIDDEN_BODY, method, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let filePath: string | null;
  try {
    filePath = resolveRequestFile(root, rawPathname);
  } catch (error) {
    console.warn('[metaapps] Failed to resolve local request:', error);
    writeResponse(res, 500, INTERNAL_ERROR_BODY, method, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  if (!filePath) {
    const statusCode = rawPathname.includes('%2e') || rawPathname.includes('%2E') ? 403 : 404;
    const body = statusCode === 403 ? FORBIDDEN_BODY : NOT_FOUND_BODY;
    writeResponse(res, statusCode, body, method, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  try {
    const body = fs.readFileSync(filePath);
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    writeResponse(res, 200, body, method, { 'Content-Type': contentType });
  } catch (error) {
    console.warn('[metaapps] Failed to read local file:', filePath, error);
    writeResponse(res, 500, INTERNAL_ERROR_BODY, method, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
};

const createServer = (): http.Server => {
  return http.createServer((req, res) => {
    handleRequest(req, res);
  });
};

export async function ensureMetaAppServerReady(root: string): Promise<ServerReadyInfo> {
  const resolvedRoot = path.resolve(root);
  if (server?.listening && activeBaseUrl && activePort !== null) {
    activeRoot = resolvedRoot;
    return { baseUrl: activeBaseUrl, port: activePort };
  }

  activeRoot = resolvedRoot;
  if (startingServer) {
    return startingServer;
  }

  const localServer = server ?? createServer();
  server = localServer;

  startingServer = (async () => {
    try {
      localServer.listen(0, LOCAL_HOST);
      await waitForServerListening(localServer);
      const address = localServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('MetaApp local server did not bind to a TCP address');
      }
      activePort = address.port;
      activeBaseUrl = `http://${LOCAL_HOST}:${address.port}`;
      return { baseUrl: activeBaseUrl, port: activePort };
    } catch (error) {
      server = null;
      activeBaseUrl = null;
      activePort = null;
      throw error;
    } finally {
      startingServer = null;
    }
  })();

  return startingServer;
}

export function getMetaAppBaseUrl(): string | null {
  return activeBaseUrl;
}

export async function stopMetaAppServer(): Promise<void> {
  const localServer = server;

  if (!localServer) {
    startingServer = null;
    activeRoot = null;
    activeBaseUrl = null;
    activePort = null;
    return;
  }

  const pendingStart = startingServer;
  if (pendingStart) {
    await pendingStart.catch(() => undefined);
  }

  if (localServer.listening) {
    await new Promise<void>((resolve, reject) => {
      localServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  server = null;
  activeRoot = null;
  activeBaseUrl = null;
  activePort = null;
  startingServer = null;
}
