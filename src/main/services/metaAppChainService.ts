import fs from 'fs';
import path from 'path';
import { fetchContentWithFallback, fetchJsonWithFallbackOnMiss, isEmptyListDataPayload } from './localIndexerProxy';

let AdmZip: typeof import('adm-zip') | null = null;
try {
  AdmZip = require('adm-zip');
} catch {
  AdmZip = null;
}

const MANAPI_BASE = 'https://manapi.metaid.io';
const MAN_CONTENT_BASE = 'https://man.metaid.io/content';
const METAAPP_PROTOCOL_PATH = '/protocols/metaapp';
const METAAPPS_CONFIG_FILE_NAME = 'metaapps.config.json';
const DEFAULT_COMMUNITY_METAAPPS_PAGE_SIZE = 30;
const COMMUNITY_METAAPPS_INSTALL_SCAN_PAGE_SIZE = 100;
const COMMUNITY_METAAPPS_SCAN_MAX_PAGES = 100;
const COMMUNITY_METAAPPS_ROOT_CURSOR = '0';

type LocalMetaAppLike = {
  id: string;
  version: string;
  creatorMetaId: string;
  sourceType: string;
};

type MetaAppManagerLike = {
  listMetaApps: () => LocalMetaAppLike[];
  ensureMetaAppsRoot: () => string;
};

type CommunityMetaAppListPageInput = {
  cursor?: string;
  size?: number;
};

type CommunityMetaAppListPage = {
  list: unknown[];
  nextCursor: string | null;
};

type FetchListFn = (
  input?: CommunityMetaAppListPageInput,
) => Promise<unknown[] | CommunityMetaAppListPage>;

type FetchZipFn = (pinId: string) => Promise<Buffer>;

type ListCommunityMetaAppsInput = {
  manager: Pick<MetaAppManagerLike, 'listMetaApps'>;
  fetchList?: FetchListFn;
  cursor?: string;
  size?: number;
};

type InstallCommunityMetaAppInput = {
  sourcePinId: string;
  manager: Pick<MetaAppManagerLike, 'listMetaApps' | 'ensureMetaAppsRoot'>;
  fetchList?: FetchListFn;
  fetchCodeZip?: FetchZipFn;
  now?: () => number;
};

type ChainMetaAppPayload = {
  title: string;
  appName: string;
  intro: string;
  icon: string;
  cover: string;
  runtime: string;
  version: string;
  indexFile: string;
  code: string;
  codeType: string;
  disabled: boolean;
};

type ChainMetaAppCandidate = {
  sourcePinId: string;
  creatorMetaId: string;
  publishedAt: number;
  payload: ChainMetaAppPayload;
};

export type CommunityMetaAppStatus = 'install' | 'installed' | 'update' | 'uninstallable';

export type CommunityMetaAppRecord = {
  appId: string;
  name: string;
  description: string;
  icon?: string;
  cover?: string;
  version: string;
  runtime: string;
  creatorMetaId: string;
  sourcePinId: string;
  publishedAt: number;
  indexFile: string;
  codeUri: string;
  codePinId: string;
  status: CommunityMetaAppStatus;
  installable: boolean;
  reason: string;
};

export type CommunityMetaAppListResult = {
  success: boolean;
  apps: CommunityMetaAppRecord[];
  nextCursor?: string | null;
  error?: string;
};

export type CommunityMetaAppInstallResult = {
  success: boolean;
  appId?: string;
  name?: string;
  status?: 'installed' | 'updated' | 'already-installed';
  error?: string;
};

type MetaAppsConfig = {
  version?: number;
  description?: string;
  defaults?: Record<string, {
    version?: string;
    'creator-metaid'?: string;
    'source-type'?: string;
    icon?: string;
    cover?: string;
    installedAt?: number;
    updatedAt?: number;
  }>;
};

const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
};

const asText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : String(value || '').trim()
);

const asBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  const normalized = asText(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const normalizeListCursor = (value: unknown): string => {
  const normalized = asText(value);
  return normalized || COMMUNITY_METAAPPS_ROOT_CURSOR;
};

const normalizeListPageSize = (
  value: unknown,
  fallback = DEFAULT_COMMUNITY_METAAPPS_PAGE_SIZE,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.trunc(parsed));
};

const normalizeFetchListResult = (value: unknown): CommunityMetaAppListPage => {
  if (Array.isArray(value)) {
    return { list: value, nextCursor: null };
  }

  const parsed = parseJsonObject(value);
  if (!parsed) {
    return { list: [], nextCursor: null };
  }

  const data = parseJsonObject(parsed.data);
  const list = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(parsed.list)
      ? parsed.list
      : [];
  const nextCursor = asText(data?.nextCursor ?? parsed.nextCursor) || null;

  return { list, nextCursor };
};

const normalizeVersion = (value: string): string => {
  const trimmed = asText(value);
  return trimmed || '0';
};

const splitVersionCore = (value: string): { core: number[]; prerelease: Array<string | number> } => {
  const normalized = normalizeVersion(value).replace(/^v/i, '');
  const withoutBuild = normalized.split('+', 1)[0] || '0';
  const dashIndex = withoutBuild.indexOf('-');
  const mainPart = dashIndex >= 0 ? withoutBuild.slice(0, dashIndex) : withoutBuild;
  const prereleasePart = dashIndex >= 0 ? withoutBuild.slice(dashIndex + 1) : '';
  const core = (mainPart || '0').split('.').map((part) => parseInt(part, 10) || 0);
  const prerelease = prereleasePart
    ? prereleasePart.split('.').map((part) => (/^\d+$/.test(part) ? parseInt(part, 10) : part))
    : [];
  return { core, prerelease };
};

const compareVersions = (a: string, b: string): number => {
  const aa = splitVersionCore(a);
  const bb = splitVersionCore(b);
  const coreLength = Math.max(aa.core.length, bb.core.length);
  for (let i = 0; i < coreLength; i += 1) {
    const va = aa.core[i] || 0;
    const vb = bb.core[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }

  if (aa.prerelease.length === 0 && bb.prerelease.length === 0) return 0;
  if (aa.prerelease.length === 0) return 1;
  if (bb.prerelease.length === 0) return -1;

  const prereleaseLength = Math.max(aa.prerelease.length, bb.prerelease.length);
  for (let i = 0; i < prereleaseLength; i += 1) {
    const va = aa.prerelease[i];
    const vb = bb.prerelease[i];
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    if (va === vb) continue;

    const vaIsNumber = typeof va === 'number';
    const vbIsNumber = typeof vb === 'number';
    if (vaIsNumber && vbIsNumber) return va < vb ? -1 : 1;
    if (vaIsNumber) return -1;
    if (vbIsNumber) return 1;
    return String(va) < String(vb) ? -1 : 1;
  }

  return 0;
};

const supportsBrowserRuntime = (runtime: string): boolean => {
  const tokens = asText(runtime)
    .split(/[\s,|/]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return tokens.includes('browser') || tokens.includes('web');
};

const extractMetafilePinId = (uri: string): string => {
  const trimmed = asText(uri);
  if (!trimmed.toLowerCase().startsWith('metafile://')) {
    return '';
  }
  const pinId = trimmed.slice('metafile://'.length).trim();
  if (!pinId || pinId.includes('/') || pinId.includes('\\')) {
    return '';
  }
  return pinId;
};

const sanitizeAppId = (name: string, fallbackPinId: string): string => {
  const raw = asText(name);
  const collapsedWhitespace = raw.replace(/\s+/g, '-');
  const sanitized = collapsedWhitespace
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.+/g, '.')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');

  if (sanitized) {
    return sanitized;
  }

  const fallback = asText(fallbackPinId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return fallback ? `metaapp-${fallback}` : `metaapp-${Date.now()}`;
};

const normalizeIndexFile = (input: string): string => {
  const raw = asText(input).replace(/^\/+/, '');
  if (!raw) return '';
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return '';
  }
  return normalized;
};

const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  if (!relative) return false;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

const createTempDirIn = (root: string, prefix: string): string => {
  return fs.mkdtempSync(path.join(root, `${prefix}-${Date.now()}-`));
};

const decodeChainPayload = (item: unknown): ChainMetaAppCandidate | null => {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const sourcePinId = asText(obj.id);
  if (!sourcePinId) return null;

  const creatorMetaId = asText(obj.globalMetaId || obj.createMetaId || obj.metaid);
  const publishedAt = Number(obj.timestamp) || 0;
  const content = parseJsonObject(obj.contentSummary || obj.content || obj.contentBody);
  if (!content) return null;

  const title = asText(content.title);
  const appName = asText(content.appName);
  if (!title && !appName) return null;

  return {
    sourcePinId,
    creatorMetaId,
    publishedAt,
    payload: {
      title,
      appName,
      intro: asText(content.intro),
      icon: asText(content.icon),
      cover: asText(content.coverImg),
      runtime: asText(content.runtime),
      version: normalizeVersion(asText(content.version)),
      indexFile: normalizeIndexFile(asText(content.indexFile)),
      code: asText(content.code),
      codeType: asText(content.codeType || content.contentType),
      disabled: asBoolean(content.disabled),
    },
  };
};

const resolveInstallability = (
  chain: ChainMetaAppCandidate,
  localApp: LocalMetaAppLike | undefined,
): { status: CommunityMetaAppStatus; installable: boolean; reason: string } => {
  const codePinId = extractMetafilePinId(chain.payload.code);

  if (chain.payload.disabled) {
    return { status: 'uninstallable', installable: false, reason: '该应用已被发布者禁用' };
  }
  if (!supportsBrowserRuntime(chain.payload.runtime)) {
    return { status: 'uninstallable', installable: false, reason: '仅支持 browser 运行时的应用可安装' };
  }
  if (!codePinId) {
    return { status: 'uninstallable', installable: false, reason: '应用 code 字段不是有效的 metafile 引用' };
  }

  if (!localApp) {
    return { status: 'install', installable: true, reason: '' };
  }

  const sameCreator = asText(localApp.creatorMetaId) === asText(chain.creatorMetaId);
  const chainManaged = asText(localApp.sourceType) === 'chain-community';

  if (!sameCreator || !chainManaged) {
    return { status: 'uninstallable', installable: false, reason: '本地存在同名应用且来源/作者不匹配，已阻止覆盖安装' };
  }

  if (compareVersions(chain.payload.version, normalizeVersion(localApp.version)) > 0) {
    return { status: 'update', installable: true, reason: '' };
  }

  return { status: 'installed', installable: false, reason: '' };
};

const toCommunityRecord = (
  chain: ChainMetaAppCandidate,
  localMap: Map<string, LocalMetaAppLike>,
): CommunityMetaAppRecord => {
  const appId = sanitizeAppId(chain.payload.appName || chain.payload.title, chain.sourcePinId);
  const localApp = localMap.get(appId);
  const installability = resolveInstallability(chain, localApp);
  const codePinId = extractMetafilePinId(chain.payload.code);

  return {
    appId,
    name: chain.payload.title || chain.payload.appName || appId,
    description: chain.payload.intro || chain.payload.title || chain.payload.appName || appId,
    icon: chain.payload.icon || undefined,
    cover: chain.payload.cover || undefined,
    version: normalizeVersion(chain.payload.version),
    runtime: chain.payload.runtime,
    creatorMetaId: chain.creatorMetaId,
    sourcePinId: chain.sourcePinId,
    publishedAt: chain.publishedAt,
    indexFile: chain.payload.indexFile,
    codeUri: chain.payload.code,
    codePinId,
    status: installability.status,
    installable: installability.installable,
    reason: installability.reason,
  };
};

const defaultFetchList: FetchListFn = async (input = {}) => {
  const cursor = normalizeListCursor(input.cursor);
  const size = normalizeListPageSize(input.size);
  const url = new URL(`${MANAPI_BASE}/pin/path/list`);
  url.searchParams.set('cursor', cursor);
  url.searchParams.set('size', String(size));
  url.searchParams.set('path', METAAPP_PROTOCOL_PATH);
  const localPath = `/api/pin/path/list${url.search}`;
  const response = await fetchJsonWithFallbackOnMiss(localPath, url.toString(), isEmptyListDataPayload);
  if (!response.ok) {
    throw new Error(`MetaApp chain list request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as unknown;
  return normalizeFetchListResult(json);
};

const defaultFetchCodeZip: FetchZipFn = async (pinId) => {
  const fallbackUrl = `${MAN_CONTENT_BASE}/${encodeURIComponent(pinId)}`;
  const response = await fetchContentWithFallback(pinId, fallbackUrl);
  if (!response.ok) {
    throw new Error(`MetaApp code download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error('MetaApp code zip is empty');
  }
  return buffer;
};

export async function listCommunityMetaApps(input: ListCommunityMetaAppsInput): Promise<CommunityMetaAppListResult> {
  try {
    const fetchList = input.fetchList || defaultFetchList;
    const rawPage = normalizeFetchListResult(await fetchList({
      cursor: normalizeListCursor(input.cursor),
      size: normalizeListPageSize(input.size),
    }));
    const rawList = rawPage.list;
    const localApps = input.manager.listMetaApps() || [];
    const localMap = new Map<string, LocalMetaAppLike>();
    localApps.forEach((app) => {
      localMap.set(asText(app.id), {
        id: asText(app.id),
        version: normalizeVersion(asText(app.version)),
        creatorMetaId: asText(app.creatorMetaId),
        sourceType: asText(app.sourceType),
      });
    });

    const decoded = rawList
      .map((item) => decodeChainPayload(item))
      .filter((item): item is ChainMetaAppCandidate => Boolean(item));

    const records = decoded
      .map((item) => toCommunityRecord(item, localMap))
      .sort((a, b) => b.publishedAt - a.publishedAt || a.name.localeCompare(b.name));

    return {
      success: true,
      apps: records,
      nextCursor: rawPage.nextCursor,
    };
  } catch (error) {
    return {
      success: false,
      apps: [],
      nextCursor: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const findCommunityMetaAppBySourcePinId = async (
  input: Pick<InstallCommunityMetaAppInput, 'sourcePinId' | 'manager' | 'fetchList'>,
): Promise<{ record?: CommunityMetaAppRecord; error?: string }> => {
  let cursor = COMMUNITY_METAAPPS_ROOT_CURSOR;

  for (let pageIndex = 0; pageIndex < COMMUNITY_METAAPPS_SCAN_MAX_PAGES; pageIndex += 1) {
    const result = await listCommunityMetaApps({
      manager: input.manager,
      fetchList: input.fetchList,
      cursor,
      size: COMMUNITY_METAAPPS_INSTALL_SCAN_PAGE_SIZE,
    });

    if (!result.success) {
      return { error: result.error || 'Failed to load community MetaApps' };
    }

    const record = result.apps.find((item) => item.sourcePinId === input.sourcePinId);
    if (record) {
      return { record };
    }

    const nextCursor = asText(result.nextCursor);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
  }

  return {};
};

const safeExtractZip = (buffer: Buffer, destination: string): void => {
  if (!AdmZip) {
    throw new Error('adm-zip is not installed. Run: npm install adm-zip');
  }
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  for (const entry of entries) {
    const rawName = String(entry.entryName || '').replace(/\\/g, '/');
    if (!rawName) continue;
    const normalized = path.posix.normalize(rawName);
    if (!normalized || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error(`MetaApp zip contains unsafe path: ${rawName}`);
    }

    const destinationPath = path.resolve(destination, ...normalized.split('/'));
    if (!isPathInside(path.resolve(destination), destinationPath)) {
      throw new Error(`MetaApp zip entry escapes destination: ${rawName}`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(destinationPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, entry.getData());
  }
};

const resolveContentRoot = (extractRoot: string): string => {
  const entries = fs.readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'));
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractRoot, entries[0].name);
  }
  return extractRoot;
};

const findFirstIndexHtml = (root: string, depth: number): string | null => {
  if (depth < 0) return null;

  const direct = path.join(root, 'index.html');
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return direct;
  }

  if (depth === 0) return null;

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = findFirstIndexHtml(path.join(root, entry.name), depth - 1);
    if (child) return child;
  }
  return null;
};

const resolveEntryFile = (contentRoot: string, indexFile: string): { absolutePath: string; relativePath: string } => {
  const normalizedIndex = normalizeIndexFile(indexFile);
  if (normalizedIndex) {
    const candidate = path.resolve(contentRoot, ...normalizedIndex.split('/'));
    if (isPathInside(contentRoot, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { absolutePath: candidate, relativePath: normalizedIndex };
    }
  }

  const discovered = findFirstIndexHtml(contentRoot, 4);
  if (!discovered) {
    throw new Error('MetaApp zip does not contain a runnable index file');
  }

  const relativePath = path.relative(contentRoot, discovered).split(path.sep).join('/');
  if (!relativePath || relativePath.startsWith('..')) {
    throw new Error('Resolved index file is outside content root');
  }

  return { absolutePath: discovered, relativePath };
};

const quoteValue = (value: string): string => {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const buildAppMd = (params: {
  name: string;
  description: string;
  appId: string;
  relativeEntry: string;
  version: string;
  creatorMetaId: string;
  sourcePinId: string;
  codePinId: string;
}): string => {
  return [
    '---',
    `name: ${quoteValue(params.name)}`,
    `description: ${quoteValue(params.description)}`,
    `entry: ${quoteValue(`/${params.appId}/${params.relativeEntry}`)}`,
    `version: ${quoteValue(params.version)}`,
    `creator-metaid: ${quoteValue(params.creatorMetaId)}`,
    'source-type: chain-community',
    `chain-pinid: ${quoteValue(params.sourcePinId)}`,
    `chain-code-pinid: ${quoteValue(params.codePinId)}`,
    '---',
    '',
    `该应用来自链上 /protocols/metaapp，安装记录 PIN: ${params.sourcePinId}`,
    '',
    '## When To Use',
    `当用户希望使用 ${params.name} 时，优先调用 open_metaapp 打开本地入口。`,
    '',
  ].join('\n');
};

const loadMetaAppsConfig = (root: string): MetaAppsConfig => {
  const configPath = path.join(root, METAAPPS_CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    return {
      version: 1,
      description: 'Default MetaApp configuration for IDBots',
      defaults: {},
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as MetaAppsConfig;
    return {
      version: typeof parsed?.version === 'number' ? parsed.version : 1,
      description: typeof parsed?.description === 'string' ? parsed.description : 'Default MetaApp configuration for IDBots',
      defaults: parsed?.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {},
    };
  } catch {
    return {
      version: 1,
      description: 'Default MetaApp configuration for IDBots',
      defaults: {},
    };
  }
};

const writeMetaAppsConfig = (root: string, config: MetaAppsConfig): void => {
  const configPath = path.join(root, METAAPPS_CONFIG_FILE_NAME);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

const replaceDirSafely = (sourceDir: string, targetDir: string): void => {
  const stageDir = sourceDir;
  const backupDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.backup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const hasTarget = fs.existsSync(targetDir);

  if (!hasTarget) {
    fs.renameSync(stageDir, targetDir);
    return;
  }

  fs.renameSync(targetDir, backupDir);
  try {
    fs.renameSync(stageDir, targetDir);
  } catch (error) {
    if (!fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  }

  fs.rmSync(backupDir, { recursive: true, force: true });
};

export async function installCommunityMetaApp(input: InstallCommunityMetaAppInput): Promise<CommunityMetaAppInstallResult> {
  const sourcePinId = asText(input.sourcePinId);
  if (!sourcePinId) {
    return { success: false, error: 'sourcePinId is required' };
  }

  const lookup = await findCommunityMetaAppBySourcePinId({
    sourcePinId,
    manager: input.manager,
    fetchList: input.fetchList,
  });

  if (lookup.error) {
    return { success: false, error: lookup.error };
  }

  const targetRecord = lookup.record;
  if (!targetRecord) {
    return { success: false, error: `MetaApp protocol pin not found: ${sourcePinId}` };
  }

  if (targetRecord.status === 'installed') {
    return {
      success: true,
      appId: targetRecord.appId,
      name: targetRecord.name,
      status: 'already-installed',
    };
  }

  if (!targetRecord.installable) {
    return {
      success: false,
      error: targetRecord.reason || 'MetaApp is not installable',
    };
  }

  const now = input.now || (() => Date.now());
  const fetchCodeZip = input.fetchCodeZip || defaultFetchCodeZip;

  let extractRoot = '';
  let stageDir = '';

  try {
    const root = path.resolve(input.manager.ensureMetaAppsRoot());
    fs.mkdirSync(root, { recursive: true });

    const zipBuffer = await fetchCodeZip(targetRecord.codePinId);

    extractRoot = createTempDirIn(root, '.metaapp-extract');
    safeExtractZip(zipBuffer, extractRoot);
    const contentRoot = path.resolve(resolveContentRoot(extractRoot));
    const resolvedEntry = resolveEntryFile(contentRoot, targetRecord.indexFile);

    stageDir = createTempDirIn(root, `.${targetRecord.appId}.stage`);
    fs.cpSync(contentRoot, stageDir, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: false,
    });

    const appMd = buildAppMd({
      name: targetRecord.name,
      description: targetRecord.description,
      appId: targetRecord.appId,
      relativeEntry: resolvedEntry.relativePath,
      version: targetRecord.version,
      creatorMetaId: targetRecord.creatorMetaId,
      sourcePinId: targetRecord.sourcePinId,
      codePinId: targetRecord.codePinId,
    });
    fs.writeFileSync(path.join(stageDir, 'APP.md'), appMd, 'utf8');

    const targetDir = path.join(root, targetRecord.appId);
    replaceDirSafely(stageDir, targetDir);
    stageDir = '';

    const config = loadMetaAppsConfig(root);
    const defaults = config.defaults || {};
    const existing = defaults[targetRecord.appId] || {};
    const nowTs = now();
    defaults[targetRecord.appId] = {
      ...existing,
      version: targetRecord.version,
      'creator-metaid': targetRecord.creatorMetaId,
      'source-type': 'chain-community',
      icon: targetRecord.icon,
      cover: targetRecord.cover,
      installedAt: typeof existing.installedAt === 'number' ? existing.installedAt : nowTs,
      updatedAt: nowTs,
    };
    writeMetaAppsConfig(root, {
      version: typeof config.version === 'number' ? config.version : 1,
      description: config.description || 'Default MetaApp configuration for IDBots',
      defaults,
    });

    return {
      success: true,
      appId: targetRecord.appId,
      name: targetRecord.name,
      status: targetRecord.status === 'update' ? 'updated' : 'installed',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (stageDir) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    if (extractRoot) {
      fs.rmSync(extractRoot, { recursive: true, force: true });
    }
  }
}
