import { createHash, randomUUID } from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import AdmZip from 'adm-zip';
import {
  createDefaultBrowserConfig,
  resolveBrowserConfig,
  resolveMetaAppPinToRecord,
  type BrowserCommandResult as CoreBrowserCommandResult,
  type MetaAppGalleryRecord,
  type MetaAppPreviewSessionFactory,
} from '@openagentinternet/agent-browser-core';
import * as agentBrowserCore from '@openagentinternet/agent-browser-core';

type PreparePreviewHtml = (input: {
  body: Buffer;
  contentType: string;
  metafileContentBaseUrl: string;
}) => Buffer | string;

// Optional until @openagentinternet/agent-browser-core >= 0.5.3 is pinned:
// with an older core the preview server keeps serving HTML unprepared (the
// pre-0.5.3 behavior) instead of failing every MetaApp open.
const preparePreviewHtml: PreparePreviewHtml | undefined = (
  agentBrowserCore as { preparePreviewHtml?: PreparePreviewHtml }
).preparePreviewHtml;

export function metaAppPreviewHtmlPreparationAvailable(): boolean {
  return preparePreviewHtml !== undefined;
}
import {
  browserFailure,
  browserSuccess,
  type BrowserCacheClearInput,
  type BrowserCacheClearResult,
  type BrowserCacheSnapshot,
  type BrowserCommandResult,
} from '@openagentinternet/agent-browser-host-contract';
import { fetchContentWithFallback } from './localIndexerProxy';
import {
  assertMetaAppZipDownloadIntegrity,
  buildMetaAppZipCandidateUrls,
  isMetaAppZipIntegrityError,
  looksLikeZipArchive,
  wrapMetaAppZipExtractionError,
} from '../libs/metaAppZipDownload';

type FetchResponseLike = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null } | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  json?: () => Promise<unknown>;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

type BotBrowserMetaAppCacheServiceOptions = {
  cacheRoot: string;
  fetch?: FetchLike;
  now?: () => number;
  // Rewrite base for metafile:// subresource references in served preview
  // HTML. Defaults to core defaults resolved against process.env, matching the
  // host browser config resolution.
  resolveMetafileContentBaseUrl?: () => string | Promise<string>;
  // Fixed loopback port candidates for the MetaApp preview origin, tried in
  // order before falling back to an ephemeral port. Defaults to
  // PREVIEW_PORT_CANDIDATES; primarily a test hook.
  previewPortCandidates?: number[];
};

type ArtifactManifest = {
  version: 1;
  cacheKey: string;
  metaAppPinId: string;
  contentReference: string;
  contentType: string;
  indexFile: string;
  artifactPath: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

type ArtifactEntry = {
  cacheKey: string;
  artifactRoot: string;
  artifactDir: string;
  indexFile: string;
  manifestPath: string;
};

type PreviewSession = {
  previewId: string;
  artifactDir: string;
  indexFile: string;
  createdAt: number;
  expiresAt: number;
};

export type BotBrowserMetaAppCacheService = {
  resolveMetaAppPin(pinId: string): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
  /** Preview session for an arbitrary local directory/file (preview-metaapp://localhost). */
  createLocalPreviewSession(input: {
    artifactDir: string;
    indexFile: string;
  }): Promise<{ previewId: string; localPreviewUrl: string }>;
  /** Local extracted source directory of a chain MetaApp, when already cached. */
  getMetaAppArtifactDir(pinId: string): Promise<{ artifactDir: string; indexFile: string } | null>;
  /** Resolve a live preview session id (from a /browser-cache/metaapp-preview/ URL) to its source directory. */
  getPreviewSessionArtifactDir(previewId: string): Promise<{ artifactDir: string; indexFile: string } | null>;
  getCache(): Promise<BrowserCommandResult<BrowserCacheSnapshot>>;
  clearCache(input?: BrowserCacheClearInput): Promise<BrowserCommandResult<BrowserCacheClearResult>>;
  stop(): Promise<void>;
};

const MANIFEST_VERSION = 1;
const LOCAL_HOST = '127.0.0.1';
const PREVIEW_PREFIX = '/browser-cache/metaapp-preview/';
// Fixed candidate ports for the MetaApp preview origin. Browsers key storage
// by scheme+host+port, so an ephemeral port mints a fresh origin on every app
// launch and orphans all MetaApp localStorage. Candidates are tried in order;
// only when every candidate is busy does this run fall back to an ephemeral
// port (with a warning), matching the pre-fix behavior.
const PREVIEW_PORT_CANDIDATES = [47613, 47614, 47615];
const PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_METAAPP_DOWNLOAD_REDIRECTS = 5;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function encodePathSegments(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function normalizeRelativePath(value: unknown, fallback = 'index.html'): string {
  const raw = text(value) || fallback;
  if (!raw || raw.includes('\\') || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error('MetaApp path must be relative.');
  }
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) {
    throw new Error('MetaApp path cannot escape the artifact directory.');
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function artifactCacheKey(input: Pick<ArtifactManifest, 'contentReference' | 'contentType' | 'indexFile'>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      contentReference: text(input.contentReference),
      contentType: text(input.contentType),
      indexFile: normalizeRelativePath(input.indexFile),
    }))
    .digest('hex');
}

function parseMetafilePinId(reference: string): string | null {
  const normalized = text(reference);
  if (!/^metafile:\/\//iu.test(normalized)) {
    return null;
  }
  const pinId = normalized
    .slice('metafile://'.length)
    .split(/[?#]/, 1)[0]
    ?.replace(/\.[A-Za-z0-9]+$/u, '') ?? '';
  return pinId && !pinId.includes('/') && !pinId.includes('\\') ? pinId : null;
}

function buildContentUrls(reference: string): Array<{ url: string; pinId?: string }> {
  const normalized = text(reference);
  if (/^https?:\/\//iu.test(normalized)) {
    return [{ url: normalized }];
  }

  const pinId = parseMetafilePinId(normalized);
  if (!pinId) {
    return [];
  }

  return buildMetaAppZipCandidateUrls(pinId);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeManifest(value: unknown): ArtifactManifest | null {
  const raw = readObject(value);
  if (!raw || raw.version !== MANIFEST_VERSION) {
    return null;
  }
  const cacheKey = text(raw.cacheKey);
  const metaAppPinId = text(raw.metaAppPinId);
  const contentReference = text(raw.contentReference);
  const contentType = text(raw.contentType);
  const indexFile = text(raw.indexFile);
  const artifactPath = text(raw.artifactPath);
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : null;
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null;
  const lastUsedAt = typeof raw.lastUsedAt === 'number' && Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : null;
  if (!cacheKey || !metaAppPinId || !contentReference || !contentType || !indexFile || !artifactPath) {
    return null;
  }
  if (createdAt === null || updatedAt === null || lastUsedAt === null) {
    return null;
  }
  return {
    version: MANIFEST_VERSION,
    cacheKey,
    metaAppPinId,
    contentReference,
    contentType,
    indexFile,
    artifactPath,
    createdAt,
    updatedAt,
    lastUsedAt,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

async function findArtifactDir(payloadRoot: string, indexFile: string): Promise<string> {
  if (await fileExists(path.join(payloadRoot, indexFile))) {
    return payloadRoot;
  }

  const entries = await fs.readdir(payloadRoot, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX');
  if (directories.length === 1) {
    const nestedRoot = path.join(payloadRoot, directories[0].name);
    if (await fileExists(path.join(nestedRoot, indexFile))) {
      return nestedRoot;
    }
  }

  throw new Error('MetaApp artifact indexFile was not found after extraction.');
}

function safeExtractZip(buffer: Buffer, destination: string): void {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (error) {
    wrapMetaAppZipExtractionError(error);
  }
  try {
    for (const entry of zip.getEntries()) {
      const rawName = String(entry.entryName || '').replace(/\\/g, '/');
      if (!rawName) {
        continue;
      }
      const normalized = path.posix.normalize(rawName);
      if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
        throw new Error(`MetaApp zip contains unsafe path: ${rawName}`);
      }
      const destinationPath = path.resolve(destination, ...normalized.split('/'));
      if (!isInside(path.resolve(destination), destinationPath)) {
        throw new Error(`MetaApp zip entry escapes destination: ${rawName}`);
      }
      if (entry.isDirectory) {
        fsSync.mkdirSync(destinationPath, { recursive: true });
        continue;
      }
      fsSync.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fsSync.writeFileSync(destinationPath, entry.getData());
    }
  } catch (error) {
    wrapMetaAppZipExtractionError(error);
  }
}

async function fetchMetaAppArchiveResponse(fetchImpl: FetchLike, url: string): Promise<FetchResponseLike> {
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, { redirect: 'follow' });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    if (redirectCount >= MAX_METAAPP_DOWNLOAD_REDIRECTS) {
      throw new Error(`MetaApp ZIP download exceeded ${MAX_METAAPP_DOWNLOAD_REDIRECTS} redirects.`);
    }
    const location = response.headers?.get?.('location');
    if (!location) {
      throw new Error(`MetaApp ZIP download redirect (HTTP ${response.status}) is missing a Location header.`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function directorySize(rootDir: string): Promise<number> {
  const files = await listFilesRecursive(rootDir);
  let total = 0;
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

function validateCacheKey(value: unknown): string {
  const normalized = text(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('Invalid MetaApp artifact cache key.');
  }
  return normalized;
}

function validatePinId(value: unknown): string {
  const normalized = text(value);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(normalized)) {
    throw new Error('Invalid MetaApp pin id.');
  }
  return normalized;
}

function decodePreviewPath(pathname: string): { previewId: string; assetPath?: string } | null {
  if (!pathname.startsWith(PREVIEW_PREFIX)) {
    return null;
  }
  const rawSegments = pathname.slice(PREVIEW_PREFIX.length).split('/').filter(Boolean);
  if (rawSegments.length < 1) {
    return null;
  }
  const decodedSegments: string[] = [];
  for (const segment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded === '.' || decoded === '..') {
      return null;
    }
    decodedSegments.push(decoded);
  }
  const [previewId, ...assetSegments] = decodedSegments;
  return {
    previewId,
    assetPath: assetSegments.length > 0 ? assetSegments.join('/') : undefined,
  };
}

function writeHttpResponse(
  res: http.ServerResponse,
  method: string,
  statusCode: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

export function createBotBrowserMetaAppCacheService(
  options: BotBrowserMetaAppCacheServiceOptions,
): BotBrowserMetaAppCacheService {
  const cacheRoot = path.resolve(options.cacheRoot);
  const artifactsRoot = path.join(cacheRoot, 'artifacts');
  const pinsRoot = path.join(cacheRoot, 'pins');
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const hasInjectedFetch = Boolean(options.fetch);
  const resolveMetafileContentBaseUrl = options.resolveMetafileContentBaseUrl
    ?? ((): string => resolveBrowserConfig(
      { browser: { ...createDefaultBrowserConfig(), localMode: true } },
      process.env,
    ).metafileContentBaseUrl);

  let server: http.Server | null = null;
  let baseUrl: string | null = null;
  let startingServer: Promise<string> | null = null;
  const sessions = new Map<string, PreviewSession>();

  const pinRecordPath = (pinId: string): string => path.join(pinsRoot, `${pinId}.json`);

  const writePinRecord = async (input: {
    metaAppPinId: string;
    cacheKey: string;
    artifactDir: string;
    contentReference: string;
    contentType: string;
    indexFile: string;
  }): Promise<void> => {
    if (!input.metaAppPinId) {
      return;
    }
    await writeJsonFile(pinRecordPath(input.metaAppPinId), {
      version: MANIFEST_VERSION,
      metaAppPinId: input.metaAppPinId,
      cacheKey: input.cacheKey,
      artifactDir: input.artifactDir,
      contentReference: input.contentReference,
      contentType: input.contentType,
      indexFile: input.indexFile,
      lastUsedAt: now(),
    });
  };

  const entryFromManifest = (cacheKey: string, manifest: ArtifactManifest): ArtifactEntry => {
    const artifactRoot = path.join(artifactsRoot, cacheKey);
    return {
      cacheKey,
      artifactRoot,
      artifactDir: path.join(artifactRoot, manifest.artifactPath),
      indexFile: manifest.indexFile,
      manifestPath: path.join(artifactRoot, 'manifest.json'),
    };
  };

  const getArtifact = async (input: {
    metaAppPinId: string;
    contentReference: string;
    contentType: string;
    indexFile: string;
  }): Promise<ArtifactEntry | null> => {
    const indexFile = normalizeRelativePath(input.indexFile);
    const cacheKey = artifactCacheKey({ ...input, indexFile });
    const artifactRoot = path.join(artifactsRoot, cacheKey);
    const manifestPath = path.join(artifactRoot, 'manifest.json');
    const manifest = normalizeManifest(await readJsonFile(manifestPath));
    if (
      !manifest
      || manifest.cacheKey !== cacheKey
      || manifest.contentReference !== input.contentReference
      || manifest.contentType !== input.contentType
      || manifest.indexFile !== indexFile
    ) {
      return null;
    }
    const entry = entryFromManifest(cacheKey, manifest);
    if (!await fileExists(path.join(entry.artifactDir, indexFile))) {
      return null;
    }
    const touched = { ...manifest, metaAppPinId: input.metaAppPinId, lastUsedAt: now() };
    await writeJsonFile(manifestPath, touched);
    await writePinRecord({ ...input, cacheKey, artifactDir: entry.artifactDir, indexFile });
    return entry;
  };

  const fetchArchive = async (contentReference: string): Promise<Buffer> => {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required to download MetaApp packages.');
    }
    const candidates = buildContentUrls(contentReference);
    if (candidates.length === 0) {
      throw new Error(`Unsupported MetaApp content reference: ${contentReference}`);
    }

    let lastError = '';
    let integrityError = '';
    for (const candidate of candidates) {
      try {
        const response = !hasInjectedFetch && candidate.pinId
          ? await fetchContentWithFallback(
            candidate.pinId,
            candidate.url,
            { redirect: 'follow' },
            looksLikeZipArchive,
          )
          : await fetchMetaAppArchiveResponse(fetchImpl, candidate.url);
        if (!response.ok || !response.arrayBuffer) {
          lastError = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
          lastError = 'empty response body';
          continue;
        }
        assertMetaAppZipDownloadIntegrity(buffer, response);
        return buffer;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;
        if (isMetaAppZipIntegrityError(error) && !integrityError) {
          integrityError = message;
          console.warn('[bot-browser-metaapp-cache] MetaApp ZIP download integrity check failed:', candidate.url, message);
        }
      }
    }
    throw new Error(`MetaApp package download failed: ${integrityError || lastError || 'no usable content URL'}`);
  };

  const writeArtifact = async (input: {
    metaAppPinId: string;
    contentReference: string;
    contentType: string;
    indexFile: string;
    archive: Buffer;
  }): Promise<ArtifactEntry> => {
    const indexFile = normalizeRelativePath(input.indexFile);
    const cacheKey = artifactCacheKey({ ...input, indexFile });
    const artifactRoot = path.join(artifactsRoot, cacheKey);
    const stagingRoot = path.join(artifactsRoot, `.staging-${cacheKey}-${randomUUID()}`);
    const payloadRoot = path.join(stagingRoot, 'payload');
    const createdAt = now();

    await fs.mkdir(artifactsRoot, { recursive: true });
    try {
      await fs.mkdir(payloadRoot, { recursive: true });
      safeExtractZip(input.archive, payloadRoot);
      const artifactDir = await findArtifactDir(payloadRoot, indexFile);
      const artifactPath = path.relative(stagingRoot, artifactDir);
      if (!artifactPath || artifactPath.startsWith('..') || path.isAbsolute(artifactPath)) {
        throw new Error('MetaApp artifact directory escaped the cache root.');
      }
      const manifest: ArtifactManifest = {
        version: MANIFEST_VERSION,
        cacheKey,
        metaAppPinId: input.metaAppPinId,
        contentReference: input.contentReference,
        contentType: input.contentType,
        indexFile,
        artifactPath,
        createdAt,
        updatedAt: createdAt,
        lastUsedAt: createdAt,
      };
      await writeJsonFile(path.join(stagingRoot, 'manifest.json'), manifest);
      await fs.rm(artifactRoot, { recursive: true, force: true });
      await fs.rename(stagingRoot, artifactRoot);
      const entry = entryFromManifest(cacheKey, manifest);
      await writePinRecord({ ...input, cacheKey, artifactDir: entry.artifactDir, indexFile });
      return entry;
    } catch (error) {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  const getOrWriteArtifact = async (input: {
    metaAppPinId: string;
    contentReference: string;
    contentType: string;
    indexFile: string;
  }): Promise<ArtifactEntry> => {
    const existing = await getArtifact(input);
    if (existing) {
      return existing;
    }
    const archive = await fetchArchive(input.contentReference);
    return writeArtifact({ ...input, archive });
  };

  const resolveAssetPath = async (session: PreviewSession, assetPath?: string): Promise<string> => {
    const normalizedAssetPath = normalizeRelativePath(assetPath, session.indexFile);
    const candidate = path.resolve(session.artifactDir, ...normalizedAssetPath.split('/'));
    if (!isInside(session.artifactDir, candidate)) {
      throw new Error('Preview asset path cannot escape the artifact directory.');
    }
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(session.artifactDir),
      fs.realpath(candidate),
    ]);
    if (!isInside(realRoot, realCandidate)) {
      throw new Error('Preview asset path cannot escape the artifact directory.');
    }
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) {
      throw new Error('Preview asset was not found.');
    }
    return realCandidate;
  };

  const handlePreviewRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      writeHttpResponse(res, method, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    const parsed = new URL(req.url ?? '/', `http://${LOCAL_HOST}`);
    const requestPath = decodePreviewPath(parsed.pathname);
    if (!requestPath) {
      writeHttpResponse(res, method, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    const session = sessions.get(requestPath.previewId);
    if (!session || session.expiresAt <= now()) {
      if (session) {
        sessions.delete(requestPath.previewId);
      }
      writeHttpResponse(res, method, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    try {
      const filePath = await resolveAssetPath(session, requestPath.assetPath);
      let body: Buffer | string = await fs.readFile(filePath);
      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      if (preparePreviewHtml && /^text\/html\b/iu.test(contentType)) {
        const prepared = preparePreviewHtml({
          body,
          contentType,
          metafileContentBaseUrl: await resolveMetafileContentBaseUrl(),
        });
        body = typeof prepared === 'string' ? prepared : prepared.toString('utf8');
      }
      writeHttpResponse(res, method, 200, body, { 'Content-Type': contentType });
    } catch {
      writeHttpResponse(res, method, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  };

  const listenOnPort = (localServer: http.Server, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
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
      localServer.listen(port, LOCAL_HOST);
    });

  const ensurePreviewServer = async (): Promise<string> => {
    if (server?.listening && baseUrl) {
      return baseUrl;
    }
    if (startingServer) {
      return startingServer;
    }

    server = http.createServer((req, res) => {
      void handlePreviewRequest(req, res).catch((error) => {
        console.warn('[bot-browser-metaapp-cache] Preview request failed:', error);
        if (!res.headersSent) {
          writeHttpResponse(res, req.method ?? 'GET', 500, 'Internal Server Error', {
            'Content-Type': 'text/plain; charset=utf-8',
          });
        } else {
          res.end();
        }
      });
    });

    startingServer = (async () => {
      const localServer = server;
      if (!localServer) {
        throw new Error('Preview server was not created.');
      }
      // Keep the preview origin stable across app restarts so MetaApp
      // localStorage persists: try the fixed candidates in order and only fall
      // back to an ephemeral port when all of them are busy. A failed candidate
      // (EADDRINUSE) must not discard the server instance — the same server is
      // rebound on the next port.
      let bound = false;
      for (const port of options.previewPortCandidates ?? PREVIEW_PORT_CANDIDATES) {
        try {
          await listenOnPort(localServer, port);
          bound = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
            throw error;
          }
        }
      }
      if (!bound) {
        console.warn(
          '[bot-browser-metaapp-cache] All fixed preview ports are busy; '
          + 'falling back to an ephemeral port for this run. MetaApp localStorage '
          + 'will not survive app restarts until a fixed port is free.',
        );
        await listenOnPort(localServer, 0);
      }
      const address = localServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Preview server did not bind to a TCP port.');
      }
      baseUrl = `http://${LOCAL_HOST}:${address.port}`;
      return baseUrl;
    })().finally(() => {
      startingServer = null;
    }).catch((error) => {
      server = null;
      baseUrl = null;
      throw error;
    });

    return startingServer;
  };

  const createPreviewSession: MetaAppPreviewSessionFactory = async (input) => {
    const artifact = await getOrWriteArtifact({
      metaAppPinId: input.pinId,
      contentReference: input.contentReference,
      contentType: input.contentType,
      indexFile: input.indexFile,
    });
    const serverBaseUrl = await ensurePreviewServer();
    const createdAt = now();
    const previewId = `metaapp-preview-${randomUUID()}`;
    const session: PreviewSession = {
      previewId,
      artifactDir: artifact.artifactDir,
      indexFile: artifact.indexFile,
      createdAt,
      expiresAt: createdAt + PREVIEW_SESSION_TTL_MS,
    };
    sessions.set(previewId, session);
    return {
      previewId,
      localPreviewUrl: `${serverBaseUrl}${PREVIEW_PREFIX}${encodeURIComponent(previewId)}/${encodePathSegments(session.indexFile)}`,
    };
  };

  // preview-metaapp://localhost: serve a live local file or directory through
  // the same preview-asset pipeline used for published MetaApps. Local-dev
  // only, mirroring the ABC standalone host behavior.
  const createLocalPreviewSession = async (input: {
    artifactDir: string;
    indexFile: string;
  }): Promise<{ previewId: string; localPreviewUrl: string }> => {
    const serverBaseUrl = await ensurePreviewServer();
    const createdAt = now();
    const previewId = `local-preview-${randomUUID()}`;
    const session: PreviewSession = {
      previewId,
      artifactDir: input.artifactDir,
      indexFile: input.indexFile,
      createdAt,
      expiresAt: createdAt + PREVIEW_SESSION_TTL_MS,
    };
    sessions.set(previewId, session);
    return {
      previewId,
      localPreviewUrl: `${serverBaseUrl}${PREVIEW_PREFIX}${encodeURIComponent(previewId)}/${encodePathSegments(session.indexFile)}`,
    };
  };

  const listPinRecordFiles = async (): Promise<string[]> => {
    const entries = await fs.readdir(pinsRoot, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(pinsRoot, entry.name));
  };

  const getStats = async (): Promise<BrowserCacheSnapshot> => {
    const artifactDirs = await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
    const artifacts: Array<Record<string, unknown>> = [];
    for (const entry of artifactDirs) {
      if (!entry.isDirectory() || entry.name.startsWith('.staging-')) {
        continue;
      }
      const manifest = normalizeManifest(await readJsonFile(path.join(artifactsRoot, entry.name, 'manifest.json')));
      if (!manifest) {
        continue;
      }
      const artifactRoot = path.join(artifactsRoot, manifest.cacheKey);
      artifacts.push({
        cacheKey: manifest.cacheKey,
        metaAppPinId: manifest.metaAppPinId,
        contentReference: manifest.contentReference,
        contentType: manifest.contentType,
        indexFile: manifest.indexFile,
        artifactDir: path.join(artifactRoot, manifest.artifactPath),
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        lastUsedAt: manifest.lastUsedAt,
        sizeBytes: await directorySize(artifactRoot),
      });
    }
    const pinRecordFiles = await listPinRecordFiles();
    const currentTime = now();
    for (const [previewId, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        sessions.delete(previewId);
      }
    }
    return {
      cacheRoot,
      artifactsRoot,
      pinsRoot,
      artifactCount: artifacts.length,
      pinRecordCount: pinRecordFiles.length,
      totalBytes: await directorySize(cacheRoot),
      activePreviewSessionCount: sessions.size,
      artifacts,
    };
  };

  const cacheKeyFromPinRecord = async (pinId: string): Promise<string> => {
    const raw = readObject(await readJsonFile(pinRecordPath(pinId)));
    return text(raw?.cacheKey);
  };

  const getMetaAppArtifactDir = async (pinId: string): Promise<{ artifactDir: string; indexFile: string } | null> => {
    const raw = readObject(await readJsonFile(pinRecordPath(pinId)));
    const artifactDir = text(raw?.artifactDir);
    const indexFile = text(raw?.indexFile) || 'index.html';
    if (!artifactDir) return null;
    if (!await fileExists(path.join(artifactDir, indexFile))) return null;
    return { artifactDir, indexFile };
  };

  const getPreviewSessionArtifactDir = async (previewId: string): Promise<{ artifactDir: string; indexFile: string } | null> => {
    const session = sessions.get(previewId);
    if (!session || session.expiresAt <= now()) return null;
    if (!await fileExists(path.join(session.artifactDir, session.indexFile))) return null;
    return { artifactDir: session.artifactDir, indexFile: session.indexFile };
  };

  const clearByCacheKey = async (cacheKey: string): Promise<{ clearedArtifacts: number; clearedPinRecords: number }> => {
    const normalizedCacheKey = validateCacheKey(cacheKey);
    const pinRecordFiles = await listPinRecordFiles();
    let clearedPinRecords = 0;
    for (const filePath of pinRecordFiles) {
      const raw = readObject(await readJsonFile(filePath));
      if (text(raw?.cacheKey).toLowerCase() === normalizedCacheKey) {
        await fs.rm(filePath, { force: true });
        clearedPinRecords += 1;
      }
    }
    const artifactRoot = path.join(artifactsRoot, normalizedCacheKey);
    const hadArtifact = await pathExists(artifactRoot);
    await fs.rm(artifactRoot, { recursive: true, force: true });
    sessions.clear();
    return {
      clearedArtifacts: hadArtifact ? 1 : 0,
      clearedPinRecords,
    };
  };

  return {
    async resolveMetaAppPin(pinId) {
      return resolveMetaAppPinToRecord({
        pinId,
        fetch: fetchImpl,
        createPreviewSession,
      });
    },

    createLocalPreviewSession,

    getMetaAppArtifactDir,

    getPreviewSessionArtifactDir,

    async getCache() {
      try {
        return browserSuccess(await getStats());
      } catch (error) {
        return browserFailure(
          'browser_cache_failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async clearCache(input = { all: true }) {
      try {
        const scope = input.scope || (input.all ? 'all' : 'all');
        if (scope === 'all') {
          const stats = await getStats();
          await fs.rm(cacheRoot, { recursive: true, force: true });
          sessions.clear();
          return browserSuccess({
            clearedArtifacts: Number(stats.artifactCount ?? 0),
            clearedPinRecords: Number(stats.pinRecordCount ?? 0),
          });
        }
        if (scope === 'pin') {
          const pinId = validatePinId(input.pinId);
          const cacheKey = await cacheKeyFromPinRecord(pinId);
          await fs.rm(pinRecordPath(pinId), { force: true });
          if (!cacheKey) {
            sessions.clear();
            return browserSuccess({ clearedArtifacts: 0, clearedPinRecords: 1 });
          }
          return browserSuccess(await clearByCacheKey(cacheKey));
        }
        if (scope === 'artifact') {
          return browserSuccess(await clearByCacheKey(validateCacheKey(input.cacheKey)));
        }
        return browserFailure('invalid_cache_scope', `Unsupported cache clear scope: ${scope}`);
      } catch (error) {
        return browserFailure(
          'browser_cache_failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async stop() {
      const localServer = server;
      sessions.clear();
      if (!localServer) {
        baseUrl = null;
        startingServer = null;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        localServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          throw error;
        }
      });
      server = null;
      baseUrl = null;
      startingServer = null;
    },
  };
}
