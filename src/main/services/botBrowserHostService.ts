import {
  applyBrowserSettingsUpdate,
  browserCommandFailed,
  browserCommandSuccess,
  classifyLocalFile,
  createBrowserSettingsSnapshot,
  createDefaultBrowserConfig,
  fetchBotProfileInfo,
  resolveBrowserConfig,
  resolveBrowserResource,
  type BrowserBaseConfig,
  type BrowserCommandResult as CoreBrowserCommandResult,
  type BrowserConfigContainer,
  type BrowserNameAliasProvider,
  type BrowserResolveResult,
  type MetaAppGalleryRecord,
} from '@openagentinternet/agent-browser-core';
import { createBrowserNameAliasProviders } from '@openagentinternet/agent-browser-name-resolvers';
import fs from 'fs';
import path from 'path';
import {
  browserFailure,
  browserSuccess,
  type BrowserCommandResult,
  type BrowserResolveInput,
  type BrowserSettingsInput,
  type BrowserSettingsSnapshot,
  type BrowserSettingsUpdateInput,
} from '@openagentinternet/agent-browser-host-contract';

import type { MetaAppRecord } from '../metaAppManager';
import type { QaQuestionDetail } from './qaRecallService';
import type { CommunityMetaAppInstallResult } from './metaAppChainService';
import { normalizeProfileAvatarUrl } from '../utils/avatarSource';
import { fetchLatestNftAvatarDeclaration, resolveLatestNftAvatarForIdentity } from './nftAvatarService';
import { extractPinIdFromReference } from './pinAssetService';

export interface BotBrowserHostService {
  resolveResource(input: BrowserResolveInput): Promise<BrowserCommandResult<BrowserResolveResult>>;
  getProfile(input: BotBrowserProfileInput): Promise<BrowserCommandResult<BotBrowserProfileSnapshot>>;
  getSettings(input?: BrowserSettingsInput): Promise<BrowserCommandResult<BrowserSettingsSnapshot>>;
  updateSettings(input: BrowserSettingsUpdateInput): Promise<BrowserCommandResult<BrowserSettingsSnapshot>>;
}

export interface BotBrowserProfileInput {
  actorId?: string;
  globalMetaId: string;
}

export type BotBrowserProfileSnapshot = Record<string, unknown>;

export interface CreateBotBrowserHostServiceInput {
  listMetaApps: () => Promise<MetaAppRecord[]> | MetaAppRecord[];
  resolveMetaAppPin?: (pinId: string) => Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
  installCommunityMetaApp?: (sourcePinId: string) => Promise<CommunityMetaAppInstallResult>;
  resolveMetaAppUrl: (app: MetaAppRecord) => Promise<string>;
  /**
   * Serves an arbitrary local directory/file for preview-metaapp://localhost
   * and preview-file://localhost resolution. `viewer` marks a preview-file
   * session whose index file must be rendered as the local-file viewer
   * document instead of being served raw.
   */
  createLocalPreviewSession?: (input: {
    artifactDir: string;
    indexFile: string;
    viewer?: boolean;
  }) => Promise<{ previewId: string; localPreviewUrl: string }>;
  /**
   * On-chain Q&A (feat/metaweb-qa phase 3): probe whether a pinId is an
   * indexed simplequestion. Contract: resolves with the question detail for a
   * question pin, resolves with null ONLY when the pin is definitively not a
   * question (index says 40400), and THROWS when the answer is indeterminate
   * (network/API failure) — indeterminate answers must not be cached.
   */
  resolveQaQuestion?: (pinId: string) => Promise<QaQuestionDetail | null>;
  /** Build the Bot Browser run URL of the bundled Q&A app at one question. */
  resolveQaAppUrl?: (questionPinId: string) => Promise<string>;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  nameAliasProviders?: BrowserNameAliasProvider[];
  ensNameAliasProviderFactory?: (config: {
    chainId: 1;
    rpcUrls: string[];
    textKey: string;
  }) => BrowserNameAliasProvider;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return null;
}

function normalizeUrl(value: unknown): string {
  return text(value).replace(/\/+$/u, '');
}

function normalizeUrlList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return rawItems
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeUrl(item))
    .filter(Boolean);
}

function normalizeMetaAppSourcePinId(sourcePinId: unknown): string {
  return typeof sourcePinId === 'string' ? sourcePinId.trim().toLowerCase() : '';
}

function canOpenMetaAppInBrowser(app: MetaAppRecord | null | undefined): boolean {
  return normalizeMetaAppSourcePinId(app?.sourcePinId) !== '';
}

function buildMetaAppBrowserUri(app: MetaAppRecord): string {
  const sourcePinId = normalizeMetaAppSourcePinId(app.sourcePinId);
  return sourcePinId ? `metaapp://${encodeURIComponent(sourcePinId)}` : '';
}

function browserRenderableUrl(value: unknown): string {
  const url = text(value);
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function codeContentReference(app: MetaAppRecord): string {
  const codePinId = text(app.codePinId);
  return codePinId ? `metafile://${codePinId}` : '';
}

function localMetaAppToBrowserRecord(
  app: MetaAppRecord,
  resolvedUrl: string,
): MetaAppGalleryRecord | null {
  if (!canOpenMetaAppInBrowser(app)) return null;
  const runUrl = browserRenderableUrl(resolvedUrl);
  if (!runUrl) return null;

  const sourcePinId = normalizeMetaAppSourcePinId(app.sourcePinId);
  const name = text(app.name) || sourcePinId;
  const ownerGlobalMetaId = text(app.creatorMetaId);
  const contentReference = codeContentReference(app);

  return {
    pinId: sourcePinId,
    firstPinId: sourcePinId,
    operation: 'local-installed',
    title: name,
    appName: name,
    prompt: text(app.prompt) || undefined,
    icon: text(app.icon) || undefined,
    coverImg: text(app.cover) || undefined,
    intro: text(app.description) || undefined,
    version: text(app.version) || '0.0.0',
    runtime: 'idbots-local',
    indexFile: text(app.entry) || 'index.html',
    code: contentReference,
    content: contentReference,
    contentType: 'text/html',
    codeType: contentReference ? 'application/zip' : 'text/html',
    tags: [],
    ownerGlobalMetaId,
    network: 'mvc',
    localUiUrl: runUrl,
    runUrl,
    updatedAt: Number.isFinite(app.updatedAt) ? app.updatedAt : Date.now(),
    source: text(app.sourceType) || 'idbots-local',
    raw: {
      app,
      browserUri: buildMetaAppBrowserUri(app),
    },
  };
}

function createInitialBrowserConfig(): BrowserConfigContainer {
  return {
    browser: {
      ...createDefaultBrowserConfig(),
      localMode: true,
      // IDBots is a local desktop host: preview-file://localhost reads the
      // owner's own files for in-tab previews, so the host opts in.
      enablePreviewFile: true,
    },
  };
}

/** pin://<pinId> URIs eligible for the Q&A question probe (phase 3 routing). */
const QA_QUESTION_PIN_URI_RE = /^pin:\/\/([0-9a-f]{20,70}i\d+)$/i;
/** Bound the "is this pin a question" cache — a forever-growing map is a leak. */
const QA_QUESTION_CACHE_MAX = 500;

/**
 * Build the BrowserResource that renders an on-chain Q&A question through the
 * bundled qanda MetaApp: an html-iframe pointing at the app's question route.
 * Shape mirrors the core resolvers (pinResolver / buildMetaAppResolveResult)
 * so the ABC UI chrome (title/proof/actions) renders it natively.
 */
function buildQaQuestionResource(input: {
  uri: string;
  detail: QaQuestionDetail;
  runUrl: string;
}): BrowserResolveResult {
  const question = input.detail.question;
  const publisher = question.publisher ?? { globalMetaId: '', metaId: '', name: '', avatar: '' };
  return {
    uri: input.uri,
    normalizedUri: input.uri,
    resourceType: 'metaapp',
    title: question.title || question.pinId,
    owner: {
      // The page IS a MetaApp render (the bundled qanda app), so the
      // metaapp-publisher kind applies; the question author rides in the name.
      kind: 'metaapp-publisher',
      globalMetaId: publisher.globalMetaId,
      name: publisher.name || publisher.globalMetaId || 'Unknown publisher',
      verificationState: 'partial',
    },
    renderer: {
      type: 'html-iframe',
      contentType: 'text/html',
      url: input.runUrl,
    },
    status: {
      state: 'resolved',
      verificationState: 'partial',
      message: 'On-chain Q&A question resolved.',
    },
    proof: {
      pinId: question.pinId,
      publisherGlobalMetaId: publisher.globalMetaId || undefined,
      protocolPath: '/protocols/simplequestion',
      verificationState: 'partial',
      details: {
        answerCount: question.answerCount,
        likeCount: question.likeCount,
        dislikeCount: question.dislikeCount,
        chainName: question.chainName || undefined,
      },
    },
    source: {
      resolver: 'idbots-qa-question',
      url: input.runUrl,
      fetchedAt: Date.now(),
    },
    actions: [
      {
        id: 'copy-uri',
        label: 'Copy URI',
        kind: 'copy',
        enabled: true,
        uri: input.uri,
      },
    ],
  };
}

function ensureLocalBrowserConfig(config: BrowserConfigContainer): BrowserConfigContainer {
  return {
    ...config,
    browser: {
      ...(config.browser ?? {}),
      localMode: true,
      enablePreviewFile: true,
    },
  };
}

function toHostResult<T>(result: CoreBrowserCommandResult<T>): BrowserCommandResult<T> {
  if (result.ok) {
    return browserSuccess(result.data);
  }
  const failure = result as Exclude<CoreBrowserCommandResult<T>, { ok: true }>;
  return browserFailure(
    failure.code,
    failure.message,
    failure.data ? { data: failure.data } : undefined,
  );
}

function findMetaAppBySourcePinId(apps: MetaAppRecord[], sourcePinId: string): MetaAppRecord | undefined {
  return apps.find((candidate) => normalizeMetaAppSourcePinId(candidate.sourcePinId) === sourcePinId);
}

async function resolveLocalMetaAppRecord(
  input: CreateBotBrowserHostServiceInput,
  app: MetaAppRecord,
): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>> {
  try {
    const runUrl = await input.resolveMetaAppUrl(app);
    const record = localMetaAppToBrowserRecord(app, runUrl);
    if (!record) {
      return browserCommandFailed('browser_resolve_failed', 'MetaApp is not renderable in Bot Browser.');
    }
    return browserCommandSuccess(record);
  } catch (error) {
    return browserCommandFailed(
      'browser_resolve_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function resolveMetaAppRecord(
  input: CreateBotBrowserHostServiceInput,
  pinId: string,
): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>> {
  const normalizedPinId = normalizeMetaAppSourcePinId(pinId);
  if (input.resolveMetaAppPin && normalizedPinId) {
    const cachedResult = await input.resolveMetaAppPin(normalizedPinId);
    if (cachedResult.ok) {
      return cachedResult;
    }
  }

  const apps = await input.listMetaApps();
  const localApp = findMetaAppBySourcePinId(apps, normalizedPinId);
  if (localApp) {
    return resolveLocalMetaAppRecord(input, localApp);
  }

  if (!input.installCommunityMetaApp || !normalizedPinId) {
    return browserCommandFailed('browser_resource_not_found', 'Resource not found.');
  }

  const installResult = await input.installCommunityMetaApp(normalizedPinId);
  if (!installResult?.success) {
    return browserCommandFailed(
      'browser_resource_not_found',
      installResult?.error || `MetaApp not found: ${normalizedPinId}`,
    );
  }

  const refreshedApps = await input.listMetaApps();
  const installedApp =
    findMetaAppBySourcePinId(refreshedApps, normalizedPinId) ||
    refreshedApps.find((candidate) => text(candidate.id) === text(installResult.appId));
  if (!installedApp) {
    return browserCommandFailed(
      'browser_resource_not_found',
      `MetaApp installed but local record was not found: ${normalizedPinId}`,
    );
  }

  return resolveLocalMetaAppRecord(input, installedApp);
}

function resolveHostBrowserConfig(
  config: BrowserConfigContainer,
  env: Record<string, string | undefined>,
): BrowserBaseConfig {
  const resolved = resolveBrowserConfig(config, env);
  const rawBrowser = objectRecord(config.browser);
  const rawNameResolution = objectRecord(rawBrowser?.nameResolution);
  const rawEns = objectRecord(rawNameResolution?.ens);

  const envNameResolutionEnabled = normalizeBoolean(env.METABOT_BROWSER_NAME_RESOLUTION_ENABLED);
  const envEnsEnabled = normalizeBoolean(env.METABOT_BROWSER_ENS_ENABLED);
  const envRpcUrls = normalizeUrlList(env.METABOT_BROWSER_ENS_RPC_URLS);

  const browserNameResolutionEnabled = typeof rawNameResolution?.enabled === 'boolean'
    ? rawNameResolution.enabled
    : null;
  const browserEnsEnabled = typeof rawEns?.enabled === 'boolean'
    ? rawEns.enabled
    : null;
  const explicitBrowserRpcUrls = rawEns && hasOwn(rawEns, 'rpcUrls')
    ? normalizeUrlList(rawEns.rpcUrls)
    : null;

  const explicitEmptyRpcUrls = env.METABOT_BROWSER_ENS_RPC_URLS !== undefined
    ? envRpcUrls.length === 0
    : Array.isArray(explicitBrowserRpcUrls) && explicitBrowserRpcUrls.length === 0;

  const nameResolutionEnabled = envNameResolutionEnabled
    ?? browserNameResolutionEnabled
    ?? resolved.nameResolution.enabled;
  const ensEnabledInput = envEnsEnabled
    ?? browserEnsEnabled
    ?? resolved.nameResolution.ens.enabled;
  const rpcUrls = explicitEmptyRpcUrls
    ? []
    : [...resolved.nameResolution.ens.rpcUrls];

  return {
    ...resolved,
    nameResolution: {
      enabled: nameResolutionEnabled,
      ens: {
        ...resolved.nameResolution.ens,
        enabled: nameResolutionEnabled && ensEnabledInput && rpcUrls.length > 0,
        rpcUrls,
      },
    },
  };
}

function createHostSettingsSnapshot(
  config: BrowserConfigContainer,
  env: Record<string, string | undefined>,
): BrowserSettingsSnapshot {
  const snapshot = createBrowserSettingsSnapshot({ config, env });
  const effective = resolveHostBrowserConfig(config, env);
  return {
    browser: { ...snapshot.browser },
    effectiveBrowser: {
      ...snapshot.effectiveBrowser,
      ...effective,
      nameResolution: {
        ...effective.nameResolution,
        ens: {
          ...effective.nameResolution.ens,
          rpcUrls: [...effective.nameResolution.ens.rpcUrls],
        },
      },
    },
    defaults: { ...snapshot.defaults },
    ...(snapshot.configPath ? { configPath: snapshot.configPath } : {}),
  };
}

function resolveFetch(fetchImpl: typeof fetch | undefined): typeof fetch | undefined {
  if (fetchImpl) return fetchImpl;
  return typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined;
}

export function withMetafileAvatarResponse(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const contentType = typeof response.headers?.get === 'function'
      ? response.headers.get('content-type') ?? ''
      : 'application/json';
    if (!contentType.includes('application/json')) {
      return response;
    }
    const jsonResponse = typeof response.clone === 'function' ? response.clone() : response;
    const payload = await jsonResponse.json().catch(() => null) as {
      data?: { avatar?: unknown; avatarId?: unknown };
    } | null;
    const rawAvatar = payload?.data?.avatar;
    const pinId = extractPinIdFromReference(typeof rawAvatar === 'string' ? rawAvatar : null);
    if (!payload?.data || !pinId) {
      return response;
    }
    return new Response(JSON.stringify({
      ...payload,
      data: { ...payload.data, avatar: `/content/${pinId}`, avatarId: pinId },
    }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Fetch a Bot's latest profile (name/avatar) from the same MetaSO P2P API the
 * Bot Browser profile page uses, with the same config resolution (env vars and
 * local browser settings). Used to refresh stale A2A peer name/avatar caches.
 */
export async function fetchLatestBotProfileInfo(
  globalMetaId: string,
  input: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {},
): Promise<{ name: string | null; avatar: string | null } | null> {
  const targetId = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!targetId) return null;
  const fetchImpl = resolveFetch(input.fetch);
  if (!fetchImpl) return null;
  const resolvedConfig = resolveHostBrowserConfig(createInitialBrowserConfig(), input.env ?? process.env);
  const profile = await fetchBotProfileInfo({
    baseUrl: resolvedConfig.metasoP2PBaseUrl,
    globalMetaId: targetId,
    fetch: withMetafileAvatarResponse(fetchImpl),
    metafileContentBaseUrl: resolvedConfig.metafileContentBaseUrl,
  });
  const nftAvatar = await resolveLatestNftAvatarForIdentity(
    { globalMetaId: targetId },
    { fetchDeclaration: (identity) => fetchLatestNftAvatarDeclaration(identity, fetchImpl) },
  );
  if (!profile && !nftAvatar) return null;
  const rawName = typeof profile?.name === 'string' ? profile.name.trim() : '';
  const rawAvatar = typeof profile?.avatar === 'string' ? profile.avatar.trim() : '';
  return {
    // fetchBotProfileInfo falls back to the raw globalMetaId when no name is
    // published; treat that as "no name" so callers keep their own fallbacks.
    name: rawName && rawName !== targetId ? rawName : null,
    // fetchBotProfileInfo turns the on-chain "no avatar" marker `/content/`
    // into an absolute URL against the P2P base (e.g. `https://so.metaid.io/content/`,
    // a 404). Drop such markers so we never store a broken avatar.
    avatar: nftAvatar?.reference ?? normalizeProfileAvatarUrl(rawAvatar),
  };
}


function createNameAliasProviders(input: {
  configured: BrowserNameAliasProvider[] | undefined;
  ensNameAliasProviderFactory: CreateBotBrowserHostServiceInput['ensNameAliasProviderFactory'];
  config: BrowserBaseConfig;
}): BrowserNameAliasProvider[] {
  return createBrowserNameAliasProviders({
    configured: input.configured,
    config: input.config,
    ...(input.ensNameAliasProviderFactory
      ? { ensNameAliasProviderFactory: input.ensNameAliasProviderFactory }
      : {}),
  });
}

/**
 * preview-metaapp://localhost resolution: stat the path, resolve the entry
 * file, and hand the directory to the host's local preview session factory.
 * Mirrors the ABC standalone host's resolveLocalPreviewPath.
 */
async function resolveLocalPreviewPath(
  input: CreateBotBrowserHostServiceInput,
  localPath: string,
): Promise<{ previewId: string; localPreviewUrl: string; contentType: string }> {
  if (!input.createLocalPreviewSession) {
    throw new Error('Local preview is not supported by this host.');
  }
  let fsPath = localPath;
  // Windows drive form: /C:/x/y -> C:/x/y
  if (process.platform === 'win32' && /^\/[A-Za-z]:[\/]/.test(fsPath)) {
    fsPath = fsPath.slice(1);
  }
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(fsPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new Error(`Local path not found: ${fsPath}`);
    if (code === 'EACCES') throw new Error(`Permission denied: ${fsPath}`);
    throw error;
  }

  let artifactDir: string;
  let indexFile: string;
  let contentType: string;
  if (stats.isDirectory()) {
    const candidates = ['index.html', 'index.htm'];
    const found = await Promise.all(
      candidates.map(async (name) => {
        try {
          await fs.promises.access(path.join(fsPath, name));
          return name;
        } catch {
          return null;
        }
      }),
    );
    indexFile = found.find((name): name is string => name !== null) ?? '';
    if (!indexFile) {
      throw new Error(`No index.html found in directory: ${fsPath}`);
    }
    artifactDir = fsPath;
    contentType = 'text/html';
  } else {
    artifactDir = path.dirname(fsPath);
    indexFile = path.basename(fsPath);
    // classifyLocalFile covers the whole previewable surface (md/pdf/media/…),
    // so a single file preview resolves its real MIME instead of the former
    // 'text/html' fallback that pushed unknown types into html-iframe.
    contentType = classifyLocalFile(indexFile).contentType;
  }

  const session = await input.createLocalPreviewSession({ artifactDir, indexFile });
  return { previewId: session.previewId, localPreviewUrl: session.localPreviewUrl, contentType };
}

/**
 * preview-file://localhost resolution: stat the file, classify it, and hand
 * it to the same local preview session pipeline as preview-metaapp — flagged
 * `viewer` for viewer kinds (markdown/text/code/csv) so the preview server
 * renders the sanitized viewer document instead of the raw bytes. Mirrors
 * the ABC standalone host's resolveLocalFilePreviewPath.
 */
async function resolveLocalFilePreviewPath(
  input: CreateBotBrowserHostServiceInput,
  localPath: string,
): Promise<{ previewId: string; localPreviewUrl: string; contentType: string }> {
  if (!input.createLocalPreviewSession) {
    throw new Error('Local preview is not supported by this host.');
  }
  let filePath = localPath;
  // Windows drive form: /C:/x/y -> C:/x/y
  if (process.platform === 'win32' && /^\/[A-Za-z]:[\/]/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new Error(`Local path not found: ${filePath}`);
    if (code === 'EACCES') throw new Error(`Permission denied: ${filePath}`);
    throw error;
  }
  if (stats.isDirectory()) {
    throw new Error('preview-file needs a file path; use preview-metaapp:// for directories.');
  }

  const fileClass = classifyLocalFile(filePath);
  const session = await input.createLocalPreviewSession({
    artifactDir: path.dirname(filePath),
    indexFile: path.basename(filePath),
    ...(fileClass.viewer ? { viewer: true } : {}),
  });
  const localPreviewUrl = fileClass.viewer
    ? `${session.localPreviewUrl}?abc-viewer=1`
    : session.localPreviewUrl;
  return { previewId: session.previewId, localPreviewUrl, contentType: fileClass.contentType };
}

export function createBotBrowserHostService(
  input: CreateBotBrowserHostServiceInput,
): BotBrowserHostService {
  const env = input.env ?? process.env;
  const fetchImpl = resolveFetch(input.fetch);
  let browserConfig = createInitialBrowserConfig();
  // pinId → "is an indexed Q&A question". Negative entries spare repeated
  // generic pin opens from re-probing the Q&A index; a thrown probe
  // (indeterminate) is never cached.
  const qaQuestionPinCache = new Map<string, boolean>();

  function rememberQaQuestionPin(pinId: string, isQuestion: boolean): void {
    qaQuestionPinCache.delete(pinId);
    qaQuestionPinCache.set(pinId, isQuestion);
    if (qaQuestionPinCache.size > QA_QUESTION_CACHE_MAX) {
      const oldest = qaQuestionPinCache.keys().next().value;
      if (typeof oldest === 'string') qaQuestionPinCache.delete(oldest);
    }
  }

  /**
   * Phase 3 routing: pin://<questionPinId> opens the bundled qanda app's
   * question page instead of the generic pin inspector. Falls through
   * silently (null) for non-question pins, non-pin URIs, unwired hosts, and
   * indeterminate probes — the generic resolver stays authoritative there.
   */
  const tryResolveQaQuestionResource = async (
    uri: string,
  ): Promise<BrowserResolveResult | null> => {
    if (!input.resolveQaQuestion || !input.resolveQaAppUrl) return null;
    const match = QA_QUESTION_PIN_URI_RE.exec(text(uri));
    if (!match) return null;
    const pinId = match[1].toLowerCase();
    const cached = qaQuestionPinCache.get(pinId);
    if (cached === false) return null;
    let detail: QaQuestionDetail | null = null;
    try {
      detail = await input.resolveQaQuestion(pinId);
    } catch {
      // Indeterminate (network/API failure): fall through WITHOUT caching.
      return null;
    }
    if (!detail || !detail.question || !detail.question.pinId) {
      rememberQaQuestionPin(pinId, false);
      return null;
    }
    rememberQaQuestionPin(pinId, true);
    const runUrl = await input.resolveQaAppUrl(detail.question.pinId);
    return buildQaQuestionResource({ uri: text(uri), detail, runUrl });
  };

  return {
    async resolveResource(resolveInput) {
      const qaResource = await tryResolveQaQuestionResource(resolveInput.uri);
      if (qaResource) {
        return toHostResult(browserCommandSuccess(qaResource));
      }
      const resolvedConfig = resolveHostBrowserConfig(browserConfig, env);
      const nameAliasProviders = createNameAliasProviders({
        configured: input.nameAliasProviders,
        ensNameAliasProviderFactory: input.ensNameAliasProviderFactory,
        config: resolvedConfig,
      });
      const result = await resolveBrowserResource({
        uri: resolveInput.uri,
        config: resolvedConfig,
        fetch: fetchImpl,
        nameAliasProviders,
        metaAppResolve: (pinId) => resolveMetaAppRecord(input, pinId),
        ...(input.createLocalPreviewSession
          ? {
            previewMetaAppLocalResolve: ({ path: localPath }: { path: string }) =>
              resolveLocalPreviewPath(input, localPath),
            previewFileLocalResolve: ({ path: localPath }: { path: string }) =>
              resolveLocalFilePreviewPath(input, localPath),
          }
          : {}),
      });
      return toHostResult(result);
    },

    async getProfile(profileInput) {
      const globalMetaId = text(profileInput.globalMetaId);
      if (!globalMetaId) {
        return browserFailure('missing_global_metaid', 'Browser info lookup requires a globalMetaId query parameter.');
      }
      if (!fetchImpl) {
        return browserFailure('browser_resolve_failed', 'A fetch implementation is required to resolve Browser profile info.');
      }

      const resolvedConfig = resolveHostBrowserConfig(browserConfig, env);
      const profile = await fetchBotProfileInfo({
        baseUrl: resolvedConfig.metasoP2PBaseUrl,
        globalMetaId,
        fetch: withMetafileAvatarResponse(fetchImpl),
        metafileContentBaseUrl: resolvedConfig.metafileContentBaseUrl,
      });
      if (!profile) {
        return browserFailure('browser_resource_not_found', 'Browser profile info was not found.');
      }
      return browserSuccess(profile);
    },

    async getSettings(_settingsInput) {
      return browserSuccess(createHostSettingsSnapshot(browserConfig, env));
    },

    async updateSettings(settingsInput) {
      try {
        browserConfig = ensureLocalBrowserConfig(
          applyBrowserSettingsUpdate(browserConfig, settingsInput.browser),
        );
        return browserSuccess(createHostSettingsSnapshot(browserConfig, env));
      } catch (error) {
        return browserFailure(
          'invalid_browser_settings',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
