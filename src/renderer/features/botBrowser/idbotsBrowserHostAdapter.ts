import {
  applyBrowserSettingsUpdate,
  browserCommandFailed,
  browserCommandSuccess,
  createBrowserSettingsSnapshot,
  createDefaultBrowserConfig,
  fetchBotProfileInfo,
  resolveBrowserConfig,
  resolveBrowserResource,
  type BrowserCommandResult as CoreBrowserCommandResult,
  type BrowserConfigContainer,
  type MetaAppGalleryRecord,
} from '@openagentinternet/agent-browser-core';
import {
  browserFailure,
  browserManualActionRequired,
  browserSuccess,
  type BrowserCacheClearInput,
  type BrowserCacheClearResult,
  type BrowserCacheInput,
  type BrowserCacheSnapshot,
  type BrowserCommandResult,
  type BrowserResolveAction,
  type BrowserResolveInput,
  type BrowserResolveResult,
  type BrowserRuntimeInput,
  type BrowserRuntimeSnapshot,
  type BrowserSettingsInput,
  type BrowserSettingsSnapshot,
  type BrowserSettingsUpdateInput,
  type BrowserTrustedActionInput,
  type BrowserTrustedActionKind,
  type BrowserTrustedActionResult,
} from '@openagentinternet/agent-browser-host-contract';
import type { BrowserEndpointAdapter, BrowserProfileInput } from './browserEndpointShim';
import type {
  CommunityMetaAppInstallResult,
  MetaAppRecord,
} from '../../types/metaApp';
import type { Metabot } from '../../types/metabot';
import {
  normalizeBrowserGlobalMetaId,
  parseLocalMetabotActorId,
} from './botBrowserIntent.js';
import {
  resolveBrowserRuntimeActors,
} from './idbotsBrowserActorModel.js';
import {
  localMetaAppToBrowserRecord,
  normalizeMetaAppSourcePinId,
} from './metaAppBrowserModel.js';
import type { BotBrowserConversationRequest } from './types';
import type { AgentGameSessionResult } from '../../types/agentGame';

/** browser.app.session.<method> trusted-action kinds → host session methods. */
const APP_SESSION_METHODS: Partial<Record<BrowserTrustedActionKind, string>> = {
  'app-session-start': 'start',
  'app-session-list': 'list',
  'app-session-status': 'status',
  'app-session-pause': 'pause',
  'app-session-resume': 'resume',
  'app-session-stop': 'stop',
};

export interface IdBotsBrowserHostAdapterInput {
  listMetabots: () => Promise<Metabot[]>;
  /** Optional host capability override; desktop keeps the full default set. */
  features?: Partial<BrowserRuntimeSnapshot['features']> & { nftBuy?: boolean; mrc721Buy?: boolean };
  /**
   * Sanitized local human identity for the Browser runtime Actor list. Must
   * come from the host's trusted path and carry only display fields
   * (label/globalMetaId/avatar/signingAvailable) — never the mnemonic, keys,
   * wallet snapshots, paths, or raw store rows. Returns null when no human
   * identity is registered.
   */
  getHumanIdentity?: () => Promise<HumanBrowserIdentity | null>;
  listMetaApps: () => Promise<MetaAppRecord[]>;
  resolveBrowserResource?: (
    input: BrowserResolveInput,
  ) => Promise<BrowserCommandResult<BrowserResolveResult>>;
  getBrowserProfile?: (
    input: BrowserProfileInput,
  ) => Promise<BrowserCommandResult<Record<string, unknown>>>;
  getBrowserSettings?: (
    input?: BrowserSettingsInput,
  ) => Promise<BrowserCommandResult<BrowserSettingsSnapshot>>;
  updateBrowserSettings?: (
    input: BrowserSettingsUpdateInput,
  ) => Promise<BrowserCommandResult<BrowserSettingsSnapshot>>;
  resolveMetaAppPin?: (pinId: string) => Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
  installCommunityMetaApp?: (sourcePinId: string) => Promise<CommunityMetaAppInstallResult>;
  resolveMetaAppUrl: (app: MetaAppRecord) => Promise<string>;
  getMetaAppCache?: () => Promise<BrowserCommandResult<BrowserCacheSnapshot>>;
  clearMetaAppCache?: (input: BrowserCacheClearInput) => Promise<BrowserCommandResult<BrowserCacheClearResult>>;
  writeMetaIdPin?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  uploadMetaFile?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  completeLlm?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  requestPermissions?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  /**
   * NFT purchase trusted action (browser.nft.buy): forwards the page's
   * purchase intent to the main-process bridge service, which runs the
   * two-phase confirmation and executes wallet_nft_buy ONLY for a valid
   * user-approved confirmRequest. Keys stay in the host.
   */
  buyNft?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  /**
   * MRC-721 purchase trusted action (browser.mrc721.buy): forwards the page's
   * listing credential to the main-process bridge service, which runs the
   * two-phase confirmation and executes the mrc721_buy worker chain ONLY for
   * a valid user-approved confirmRequest. Keys stay in the host.
   */
  buyMrc721?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  openConversation: (request: BotBrowserConversationRequest) => Promise<void>;
  /**
   * Sends an on-chain /protocols/simplemsg PIN (ECDH-encrypted) to a peer.
   * Used by the private-chat trusted action when it carries authored content
   * (the Bot Browser "Send" modal). Returns the resulting pin/txids.
   */
  sendPrivateChat?: (input: {
    actorId?: string;
    peerGlobalMetaId: string;
    content: string;
    replyPin?: string;
  }) => Promise<{ success: boolean; pinId?: string; txids?: string[]; error?: string }>;
  fetch?: typeof fetch;
  /**
   * Dispatches a browser.app.session.* method to the Agent-Game-v2 host
   * (docs/09 §4, docs/14 §1). Returns the raw IPC envelope: a SessionView /
   * { sessions }, a { __error } envelope, or the two-phase start Phase 1
   * outcome ({ manualAction, confirmation, confirmRequest }).
   */
  runAgentGameSession?: (input: {
    method: string;
    payload?: unknown;
    actorId?: string;
    resourceUri?: string;
  }) => Promise<AgentGameSessionResult>;
}

export interface BotBrowserBridgeTrustedActionRequest {
  actorId?: string;
  resourceUri: string;
  sessionId?: string;
  payload?: unknown;
}

/**
 * Display-only descriptor of the local human identity, supplied by the
 * sanitized main-process path (botBrowser:getHumanActor). signingAvailable is
 * false when the signer is locked (e.g. gas subsidy failed/missing); such an
 * Actor may remain visible but writes fail with an explicit error.
 */
export interface HumanBrowserIdentity {
  label: string;
  globalMetaId: string;
  avatar?: string;
  signingAvailable: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingIpcHandlerError(error: unknown, channel: string): boolean {
  const message = errorMessage(error);
  return message.includes('No handler registered') && message.includes(channel);
}

function safeBridgeMessage(value: unknown, fallback: string): string {
  const message = text(value);
  if (!message) return fallback;
  if (/ipc|handler|channel|route|stack|file:|\/Users\/|\\Users\\/iu.test(message)) {
    return fallback;
  }
  return message;
}

function createInitialBrowserConfig(): BrowserConfigContainer {
  return {
    browser: {
      ...createDefaultBrowserConfig(),
      localMode: true,
    },
  };
}

function ensureLocalBrowserConfig(config: BrowserConfigContainer): BrowserConfigContainer {
  return {
    ...config,
    browser: {
      ...(config.browser ?? {}),
      localMode: true,
    },
  };
}

function normalizeResolveAction(
  action: BrowserResolveAction,
  result: BrowserResolveResult,
): BrowserResolveAction | null {
  if (action.kind === 'service-call' || action.kind === 'service-list') {
    return null;
  }
  // Keep ABC's original action kinds intact. Previously this rewrote
  // `private-chat` into `open-conversation`, but ABC's bot-page header filter
  // (isBotPageHeaderAction) drops `open-conversation` while keeping
  // `private-chat`, so the rewrite hid the Message button. We now only enrich
  // the payload; the action kind is preserved so the UI renders as designed.
  if (action.kind !== 'private-chat') {
    return action;
  }

  const payload = action.payload ?? {};
  const peerGlobalMetaId =
    text(payload.peerGlobalMetaId) ||
    text(payload.targetGlobalMetaId) ||
    text(payload.to) ||
    text(result.owner.globalMetaId);
  const conversationUri = conversationUriFromPayload(payload, peerGlobalMetaId);

  return {
    ...action,
    payload: {
      ...payload,
      peerGlobalMetaId,
      conversationUri,
    },
  };
}

function normalizeResolveResultActions(result: BrowserResolveResult): BrowserResolveResult {
  return {
    ...result,
    actions: result.actions
      .map((action) => normalizeResolveAction(action, result))
      .filter((action): action is BrowserResolveAction => Boolean(action)),
  };
}

function peerGlobalMetaIdFromPayload(payload: Record<string, unknown> | undefined): string {
  return (
    text(payload?.peerGlobalMetaId) ||
    text(payload?.targetGlobalMetaId) ||
    text(payload?.to)
  );
}

function buildConversationUri(peerGlobalMetaId: string): string {
  return `map://simplemsg/conversation?peer=${encodeURIComponent(peerGlobalMetaId)}`;
}

function conversationUriFromPayload(
  payload: Record<string, unknown> | undefined,
  peerGlobalMetaId: string,
): string {
  return text(payload?.conversationUri) || buildConversationUri(peerGlobalMetaId);
}

function hasUsableLocalMetabot(metabots: Metabot[], localMetabotId: number): boolean {
  return metabots.some((metabot) => {
    return metabot.id === localMetabotId && normalizeBrowserGlobalMetaId(metabot.globalmetaid) !== '';
  });
}

function normalizeMetaAppUri(value: string): string {
  const match = value.match(/^metaapp:\/\/(.+)$/iu);
  if (!match) return value;
  const pinId = normalizeMetaAppSourcePinId(match[1]);
  return pinId ? `metaapp://${pinId}` : value;
}

function findMetaAppBySourcePinId(apps: MetaAppRecord[], sourcePinId: string): MetaAppRecord | undefined {
  return apps.find((candidate) => {
    return normalizeMetaAppSourcePinId(candidate.sourcePinId) === sourcePinId;
  });
}

function trustedActionSuccess(
  kind: BrowserTrustedActionKind,
  data: unknown,
): BrowserCommandResult<BrowserTrustedActionResult> {
  return browserSuccess({
    kind,
    handled: true,
    data,
  } as BrowserTrustedActionResult);
}

function trustedActionFailureFromResult(
  result: BrowserCommandResult<unknown>,
  fallbackCode: string,
  fallbackMessage: string,
): BrowserCommandResult<BrowserTrustedActionResult> {
  return browserFailure(
    text((result as { code?: unknown }).code) || fallbackCode,
    safeBridgeMessage((result as { message?: unknown }).message, fallbackMessage),
  );
}

async function runBridgeTrustedAction(
  invoke: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>,
  input: BotBrowserBridgeTrustedActionRequest,
  kind: BrowserTrustedActionKind,
  ipcChannel: string,
  fallbackCode: string,
  fallbackMessage: string,
  unsupportedMessage: string,
): Promise<BrowserCommandResult<BrowserTrustedActionResult>> {
  try {
    const result = await invoke(input);
    if (!result.ok) {
      if (result.state === 'manual_action_required') {
        return result as BrowserCommandResult<BrowserTrustedActionResult>;
      }
      return trustedActionFailureFromResult(result, fallbackCode, fallbackMessage);
    }
    return trustedActionSuccess(kind, result.data);
  } catch (error) {
    if (isMissingIpcHandlerError(error, ipcChannel)) {
      return browserFailure(
        'unsupported_method',
        unsupportedMessage,
      );
    }
    return browserFailure(fallbackCode, fallbackMessage);
  }
}

async function resolveLocalMetaAppRecord(
  input: IdBotsBrowserHostAdapterInput,
  app: MetaAppRecord,
): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>> {
  try {
    const runUrl = await input.resolveMetaAppUrl(app);
    const record = localMetaAppToBrowserRecord(app, runUrl) as MetaAppGalleryRecord | null;
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
  input: IdBotsBrowserHostAdapterInput,
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

function normalizeMetaAppResolveResult(result: BrowserResolveResult): BrowserResolveResult {
  if (result.resourceType !== 'metaapp') {
    return result;
  }

  return {
    ...result,
    normalizedUri: normalizeMetaAppUri(result.normalizedUri),
    actions: result.actions.map((action) => ({
      ...action,
      uri: action.uri ? normalizeMetaAppUri(action.uri) : action.uri,
    })),
  };
}

function createContractSettingsSnapshot(config: BrowserConfigContainer): BrowserSettingsSnapshot {
  const snapshot = createBrowserSettingsSnapshot({ config });
  return {
    browser: { ...snapshot.browser },
    effectiveBrowser: { ...snapshot.effectiveBrowser },
    defaults: { ...snapshot.defaults },
  };
}

export function createIdbotsBrowserHostAdapter(
  input: IdBotsBrowserHostAdapterInput,
): BrowserEndpointAdapter {
  let browserConfig = createInitialBrowserConfig();

  return {
    async getRuntime(_runtimeInput?: BrowserRuntimeInput): Promise<BrowserCommandResult<BrowserRuntimeSnapshot>> {
      const [metabots, humanIdentity] = await Promise.all([
        input.listMetabots(),
        input.getHumanIdentity ? input.getHumanIdentity().catch(() => null) : Promise.resolve(null),
      ]);
      // actors and defaultActor come from one resolver so the default always
      // exists in the (deduplicated) list with matching isDefault flags.
      const { actors, defaultActor } = resolveBrowserRuntimeActors(metabots, humanIdentity);
      return browserSuccess({
        host: { kind: 'idbots', name: 'IDBots', localMode: true },
        actors,
        defaultActor,
        defaultUri: null,
        features: {
          privateChat: true,
          serviceCall: false,
          cacheManagement: true,
          templateSettings: true,
          walletLogin: false,
          nftBuy: true,
          mrc721Buy: true,
          ...input.features,
        },
        labels: {
          actorChip: 'Actor',
          noActorTitle: 'No Actor available',
          noActorBody:
            'Create or import a human account, or create a local Bot, before using IDBots Browser actions.',
          noActorAction: {
            label: 'Open Settings',
            actionKind: 'open-settings',
          },
        },
      });
    },

    async resolveResource(
      resolveInput: BrowserResolveInput,
    ): Promise<BrowserCommandResult<BrowserResolveResult>> {
      if (input.resolveBrowserResource) {
        const hostResult = await input.resolveBrowserResource(resolveInput);
        if (!hostResult.ok) {
          return hostResult;
        }
        return {
          ...hostResult,
          data: normalizeResolveResultActions(normalizeMetaAppResolveResult(hostResult.data)),
        };
      }

      const result = await resolveBrowserResource({
        uri: resolveInput.uri,
        config: resolveBrowserConfig(browserConfig),
        fetch: input.fetch,
        metaAppResolve: (pinId) => resolveMetaAppRecord(input, pinId),
      });

      if (!result.ok) {
        return result;
      }

      return {
        ...result,
        data: normalizeResolveResultActions(normalizeMetaAppResolveResult(result.data)),
      };
    },

    async getProfile(
      profileInput: BrowserProfileInput,
    ): Promise<BrowserCommandResult<Record<string, unknown>>> {
      const globalMetaId = text(profileInput.globalMetaId);
      if (!globalMetaId) {
        return browserFailure('missing_global_metaid', 'Browser info lookup requires a globalMetaId query parameter.');
      }
      if (input.getBrowserProfile) {
        return input.getBrowserProfile({
          actorId: text(profileInput.actorId) || undefined,
          globalMetaId,
        });
      }

      const resolvedConfig = resolveBrowserConfig(browserConfig);
      const profile = await fetchBotProfileInfo({
        baseUrl: resolvedConfig.metasoP2PBaseUrl,
        globalMetaId,
        fetch: input.fetch,
        metafileContentBaseUrl: resolvedConfig.metafileContentBaseUrl,
      });
      if (!profile) {
        return browserFailure('browser_resource_not_found', 'Browser profile info was not found.');
      }
      return browserSuccess(profile);
    },

    async getSettings(_settingsInput?: BrowserSettingsInput): Promise<BrowserCommandResult<BrowserSettingsSnapshot>> {
      if (input.getBrowserSettings) {
        return input.getBrowserSettings(_settingsInput);
      }
      return browserSuccess(createContractSettingsSnapshot(browserConfig));
    },

    async updateSettings(
      settingsInput: BrowserSettingsUpdateInput,
    ): Promise<BrowserCommandResult<BrowserSettingsSnapshot>> {
      if (input.updateBrowserSettings) {
        return input.updateBrowserSettings(settingsInput);
      }
      try {
        browserConfig = ensureLocalBrowserConfig(
          applyBrowserSettingsUpdate(browserConfig, settingsInput.browser),
        );
        return browserSuccess(createContractSettingsSnapshot(browserConfig));
      } catch (error) {
        return browserFailure(
          'invalid_browser_settings',
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async getCache(_cacheInput?: BrowserCacheInput): Promise<BrowserCommandResult<BrowserCacheSnapshot>> {
      if (input.getMetaAppCache) {
        try {
          return await input.getMetaAppCache();
        } catch (error) {
          const message = errorMessage(error);
          if (isMissingIpcHandlerError(error, 'botBrowser:getMetaAppCache')) {
            return browserSuccess({
              cacheRoot: null,
              unavailable: true,
              error: message,
            });
          }
          return browserFailure('browser_cache_unavailable', message);
        }
      }
      return browserSuccess({});
    },

    async clearCache(
      cacheInput: BrowserCacheClearInput,
    ): Promise<BrowserCommandResult<BrowserCacheClearResult>> {
      if (input.clearMetaAppCache) {
        try {
          return await input.clearMetaAppCache(cacheInput);
        } catch (error) {
          return browserFailure('browser_cache_unavailable', errorMessage(error));
        }
      }
      return browserSuccess({});
    },

    async runTrustedAction(
      actionInput: BrowserTrustedActionInput,
    ): Promise<BrowserCommandResult<BrowserTrustedActionResult>> {
      const actionKind = text(actionInput.kind);
      if (actionKind === 'metaid-pin-write') {
        if (!input.writeMetaIdPin) {
          return browserFailure(
            'unsupported_method',
            'MetaID PIN write is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.writeMetaIdPin,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            sessionId: text(actionInput.sessionId) || undefined,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:writeMetaIdPin',
          'pin_write_failed',
          'MetaID PIN write failed.',
          'MetaID PIN write is not supported in this IDBots build.',
        );
      }

      if (actionKind === 'nft-buy') {
        if (!input.buyNft) {
          return browserFailure(
            'unsupported_method',
            'NFT purchase is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.buyNft,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            sessionId: text(actionInput.sessionId) || undefined,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:buyNft',
          'nft_buy_failed',
          'NFT purchase failed.',
          'NFT purchase is not supported in this IDBots build.',
        );
      }

      if (actionKind === 'mrc721-buy') {
        if (!input.buyMrc721) {
          return browserFailure(
            'unsupported_method',
            'MRC-721 purchase is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.buyMrc721,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            sessionId: text(actionInput.sessionId) || undefined,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:mrc721Buy',
          'mrc721_buy_failed',
          'MRC-721 purchase failed.',
          'MRC-721 purchase is not supported in this IDBots build.',
        );
      }

      if (actionKind === 'metafile-upload') {
        if (!input.uploadMetaFile) {
          return browserFailure(
            'unsupported_method',
            'MetaFile upload is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.uploadMetaFile,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            sessionId: text(actionInput.sessionId) || undefined,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:uploadMetaFile',
          'upload_failed',
          'MetaFile upload failed.',
          'MetaFile upload is not supported in this IDBots build.',
        );
      }

      if (actionKind === 'llm-complete') {
        if (!input.completeLlm) {
          return browserFailure(
            'unsupported_method',
            'Local LLM completion is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.completeLlm,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            sessionId: text(actionInput.sessionId) || undefined,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:completeLlm',
          'llm_unavailable',
          'Local LLM completion failed.',
          'Local LLM completion is not supported in this IDBots build.',
        );
      }

      if (actionKind === 'permissions-request') {
        if (!input.requestPermissions) {
          return browserFailure(
            'unsupported_method',
            'Session write permissions are not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.requestPermissions,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            sessionId: text(actionInput.sessionId) || undefined,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:requestPermissions',
          'permissions_failed',
          'Session write permission request failed.',
          'Session write permissions are not supported in this IDBots build.',
        );
      }

      // browser.app.session.* (Agent-Game-v2, docs/09 §4): forward to the
      // AgentGame host IPC. `start` is two-phase — the host's Phase 1 answer
      // comes back as manual_action_required { confirmation, confirmRequest }
      // which ABC renders; the page's Phase 2 echo carries the confirmToken.
      const appSessionMethod = APP_SESSION_METHODS[actionInput.kind];
      if (appSessionMethod) {
        if (!input.runAgentGameSession) {
          return browserFailure(
            'unsupported_method',
            'App sessions are not supported in this IDBots build.',
          );
        }
        const actorId = text(actionInput.actorId);
        if (!actorId) {
          return browserFailure('browser_action_missing_actor', 'A local Bot actor is required.');
        }
        const localMetabotId = parseLocalMetabotActorId(actorId);
        if (localMetabotId === null) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not an available local Bot.');
        }
        const metabots = await input.listMetabots();
        const actorGlobalMetaId = normalizeBrowserGlobalMetaId(
          metabots.find((metabot) => metabot.id === localMetabotId)?.globalmetaid,
        );
        if (!actorGlobalMetaId) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not an available local Bot.');
        }

        try {
          const result = await input.runAgentGameSession({
            method: appSessionMethod,
            payload: actionInput.payload,
            actorId: actorGlobalMetaId,
            resourceUri: actionInput.resourceUri,
          });
          if (result.__error) {
            return browserFailure(
              text(result.code) || 'internal_error',
              safeBridgeMessage(result.message, 'App session request failed.'),
            );
          }
          if (result.manualAction && result.confirmation && result.confirmRequest) {
            return browserManualActionRequired(
              'manual_action_required',
              'Approve the app session request to continue.',
              {
                data: {
                  confirmation: result.confirmation,
                  confirmRequest: result.confirmRequest,
                } as Record<string, unknown>,
              },
            );
          }
          return trustedActionSuccess(actionInput.kind, result);
        } catch (error) {
          if (isMissingIpcHandlerError(error, 'agentGame:session')) {
            return browserFailure(
              'unsupported_method',
              'App sessions are not supported in this IDBots build.',
            );
          }
          return browserFailure('internal_error', 'App session request failed.');
        }
      }

      if (actionInput.kind === 'copy-uri') {
        return browserSuccess({
          kind: actionInput.kind,
          handled: true,
          data: {
            copiedText:
              text(actionInput.payload?.uri) ||
              text(actionInput.payload?.currentUri) ||
              actionInput.resourceUri,
          },
        });
      }

      if (actionInput.kind === 'open-conversation' || actionInput.kind === 'private-chat') {
        const actorId = text(actionInput.actorId);
        if (!actorId) {
          return browserFailure('browser_action_missing_actor', 'A local Bot actor is required.');
        }
        const localMetabotId = parseLocalMetabotActorId(actorId);
        if (localMetabotId === null) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not an available local Bot.');
        }
        const metabots = await input.listMetabots();
        if (!hasUsableLocalMetabot(metabots, localMetabotId)) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not an available local Bot.');
        }

        const peerGlobalMetaId = normalizeBrowserGlobalMetaId(
          peerGlobalMetaIdFromPayload(actionInput.payload),
        );
        if (!peerGlobalMetaId) {
          return browserFailure('browser_action_missing_peer', 'A peer GlobalMetaID is required.');
        }

        // ABC's private-chat modal submits the authored text as payload.content.
        // When present, send it as an on-chain /protocols/simplemsg PIN rather
        // than only opening an empty conversation (mirrors OAC's chat.private).
        const content = text(actionInput.payload?.content);
        if (actionInput.kind === 'private-chat' && content) {
          if (!input.sendPrivateChat) {
            return browserFailure(
              'browser_action_not_supported',
              'On-chain private messaging is not supported in this IDBots build.',
            );
          }
          const replyPin = text(actionInput.payload?.replyPin) || undefined;
          const sendResult = await input.sendPrivateChat({
            actorId,
            peerGlobalMetaId,
            content,
            ...(replyPin ? { replyPin } : {}),
          });
          if (!sendResult.success) {
            return browserFailure(
              'browser_action_send_failed',
              sendResult.error || 'Failed to send the private message.',
            );
          }

          // Let ABC show its post-send confirmation modal. The modal's
          // "View conversation" button will invoke the open-conversation action.
          return browserSuccess({
            kind: actionInput.kind,
            handled: true,
            data: {
              message: 'Private message sent.',
              ...(sendResult.pinId ? { pinId: sendResult.pinId } : {}),
              ...(sendResult.txids ? { txids: sendResult.txids } : {}),
            },
          });
        }

        // No authored content (or open-conversation): just open the thread.
        const conversationUri = conversationUriFromPayload(actionInput.payload, peerGlobalMetaId);
        await input.openConversation({
          actionKind: actionInput.kind,
          actorId,
          resourceUri: actionInput.resourceUri,
          peerGlobalMetaId,
          conversationUri,
          peerName: text(actionInput.payload?.peerName) || undefined,
          peerAvatar: text(actionInput.payload?.peerAvatar) || undefined,
        });

        return browserSuccess({
          kind: actionInput.kind,
          handled: true,
          data: { message: 'Conversation opened in IDBots.' },
        });
      }

      return browserFailure(
        'browser_action_not_supported',
        `IDBots Browser does not support ${actionInput.kind}.`,
      );
    },
  };
}
