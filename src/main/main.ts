import { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, shell, nativeImage, systemPreferences, Menu } from 'electron';
import type { Session, WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import os from 'os';
import { SqliteStore } from './sqliteStore';
import { isSqliteWasmBoundsError, runWithSqliteWasmRecovery } from './sqliteRecovery';
import { CoworkStore } from './coworkStore';
import { McpStore, type McpServerFormData } from './mcpStore';
import type { MemoryBackend } from './memory/memoryBackend';
import {
  CoworkRunner,
  isDelegationPriceNumeric,
  type DelegationRequest,
} from './libs/coworkRunner';
import { SkillManager } from './skillManager';
import { MetaAppManager } from './metaAppManager';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { getCurrentApiConfig, resolveCurrentApiConfig, setStoreGetter } from './libs/claudeSettings';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
import { resolveContinueSystemPrompt } from './libs/coworkPromptStrategy';
import { generateSessionTitle } from './libs/coworkUtil';
import { ensureSandboxReady, getSandboxStatus, onSandboxProgress } from './libs/coworkSandboxRuntime';
import { startCoworkOpenAICompatProxy, stopCoworkOpenAICompatProxy, setScheduledTaskDeps } from './libs/coworkOpenAICompatProxy';
import { buildImageSkillEnvOverrides } from './libs/skillImageProviderEnv';
import { IMGatewayManager, IMPlatform, IMGatewayConfig } from './im';
import { APP_NAME } from './appConstants';
import { getSkillServiceManager } from './skillServices';
import { createTray, destroyTray, updateTrayMenu } from './trayManager';
import { isAutoLaunched, getAutoLaunchEnabled, setAutoLaunchEnabled } from './autoLaunchManager';
import { ScheduledTaskStore } from './scheduledTaskStore';
import { MetabotStore } from './metabotStore';
import { ServiceOrderStore, type ServiceOrderRecord } from './serviceOrderStore';
import { Scheduler } from './libs/scheduler';
import { initLogger, getLogFilePath } from './logger';
import { resolveRuntimeDataPaths } from './libs/runtimeDataPaths';
import { shouldAcquireSingleInstanceLock } from './libs/singleInstanceLock';
import { mockCreateWalletAndFund, mockPushConfigToChain, mockUpdateConfigOnChain } from './services/chainActionMock';
import { createMetaBotWallet, getPrivateKeyBufferForEcdh } from './services/metabotWalletService';
import { fetchMetaidInfoByAddress, fetchMetaidInfoByMetaid, fetchMetaidRestoreProfile, type MetaidAddressInfo } from './services/metabotRestoreService';
import { requestMvcGasSubsidy } from './services/mvcSubsidyService';
import { getAddressBalance } from './services/addressBalanceService';
import { getMetabotWalletAssets } from './services/metabotWalletAssetService';
import {
  getFeeSummary,
  getDefaultFeeRate,
  buildTransferPreview,
  executeTransfer,
  type TransferChain,
} from './services/transferService';
import { getRate as getGlobalFeeRate, getAllTiers as getGlobalFeeTiers } from './services/feeRateStore';
import {
  buildTokenTransferPreview as buildTokenTransferPreviewService,
  executeTokenTransfer as executeTokenTransferService,
  getTokenTransferChain,
} from './services/metabotTokenTransferService';
import { registerMetabotWalletIpcHandlers } from './services/metabotWalletIpc';
import { startMetaidRpcServer } from './services/metaidRpcServer';
import { syncMetaBotEditChangesToChain, syncMetaBotToChain } from './services/metaidCore';
import { getOfficialSkillsStatus, installOfficialSkill, syncAllOfficialSkills } from './services/skillSyncService';
import {
  startMetaWebListener,
  hasListenerSocket,
  isListenerRunning,
  isListenerSocketConnected,
  stopMetaWebListener,
  type ListenerConfig,
} from './services/metaWebListenerService';
import {
  normalizeListenerConfig,
  planPrivateChatListenerReadiness,
  shouldRunListener,
} from './services/metaWebListenerReadiness';
import { startOrchestrator as startCognitiveOrchestrator, stopOrchestrator as stopCognitiveOrchestrator } from './services/cognitiveOrchestrator';
import {
  endPrivateChatA2AConversation,
  startPrivateChatDaemon,
  stopPrivateChatDaemon,
} from './services/privateChatDaemon';
import { performChatCompletionForOrchestrator } from './services/cognitiveChatCompletion';
import { runOrchestratorSkillTurn } from './services/orchestratorCoworkBridge';
import { createPin, getPinData } from './services/metaidCore';
import type { DiscoverySnapshot } from './services/providerDiscoveryService';
import { ProviderDiscoveryService } from './services/providerDiscoveryService';
import { IdchatPresenceService } from './services/idchatPresenceService';
import { fetchLocalPresenceSnapshot } from './services/p2pPresenceClient';
import {
  ProviderPingService,
  resolveDelegationOrderability,
} from './services/providerPingService';
import {
  PrivateChatHistorySyncService,
  storePrivateChatHistoryMessages,
} from './services/privateChatHistorySyncService';
import { syncP2PRuntimeConfig } from './services/p2pRuntimeConfigSync';
import { encryptGroupMessageECB, computeEcdhSharedSecretSha256, computeEcdhSharedSecret, ecdhEncrypt, ecdhDecrypt } from './services/metaWebCrypto';
import { assignGroupChatTask, type AssignGroupChatTaskParams } from './services/assignGroupChatTaskService';
import { cancelActiveDownload, downloadUpdate, installUpdate } from './libs/appUpdateInstaller';
import { fetchFromLocalOrFallback, fetchJsonWithFallbackOnMiss, isEmptyListDataPayload } from './services/localIndexerProxy';
import { resolveMetaidAvatarSource, resolvePinAssetSource } from './services/pinAssetService';
import * as p2pIndexerService from './services/p2pIndexerService';
import * as p2pConfigService from './services/p2pConfigService';
import { runAppCleanup as runSharedAppCleanup } from './services/appCleanup';
import { ensureMetaAppServerReady, stopMetaAppServer } from './services/metaAppLocalServer';
import { openMetaApp, resolveMetaAppUrl } from './services/metaAppOpenService';
import { installCommunityMetaApp, listCommunityMetaApps } from './services/metaAppChainService';
import { getP2PLocalBase } from './services/p2pLocalEndpoint';
import { getMetaidRpcBase } from './services/metaidRpcEndpoint';
import { isSemanticallyEmptyMetaidInfoPayload } from './services/metabotRestoreService';
import {
  ServiceOrderLifecycleService,
  ServiceOrderOpenOrderExistsError,
  ServiceOrderSelfOrderNotAllowedError,
} from './services/serviceOrderLifecycleService';
import { ServiceRefundSyncService } from './services/serviceRefundSyncService';
import { ServiceRefundSettlementService } from './services/serviceRefundSettlementService';
import { fetchProtocolPinsFromIndexer } from './services/protocolPinFetch';
import { buildRefundRequestPayload } from './services/serviceOrderProtocols.js';
import { ensureBuyerOrderObserverSession } from './services/buyerOrderObserverSession';
import { ensureServiceOrderObserverSession } from './services/serviceOrderObserverSession';
import {
  buildDelegationOrderPayloadFromSettlement,
  resolveDelegationSettlement,
} from './services/delegationSettlement';
import { extractOrderRequestText } from './services/orderPayment';
import {
  ORDER_RAW_REQUEST_MAX_CHARS,
  extractOrderRawRequest,
  normalizeOrderRawRequest,
} from './shared/orderMessage.js';
import {
  normalizeGigSquareSettlementDraft,
  parseGigSquareSettlementAsset,
} from './shared/gigSquareSettlementAsset.js';
import { verifyMrc20Transfer } from './services/mrc20PaymentVerification';
import { buildTransactionExplorerUrl } from './services/serviceOrderPresentation.js';
import { recoverMissingRefundPendingOrderSessions } from './services/serviceOrderSessionRecovery';
import {
  extractSessionOrderTxid,
  findMatchingOrderSessionId,
  resolveOrderSessionId,
  selectProtocolPinContent,
} from './services/serviceOrderSessionResolution.js';
import { publishServiceOrderEventToCowork as publishServiceOrderEventToCoworkStore } from './services/serviceOrderCoworkBridge';
import {
  buildRemoteSkillServiceUpsertStatement,
  isRemoteSkillServiceListSemanticMiss,
  parseRemoteSkillServiceRow,
  syncRemoteSkillServicesWithCursor,
} from './services/gigSquareRemoteServiceSync';
import {
  repairServiceRatingAggregate,
  syncGigSquareRatings,
} from './services/gigSquareRatingSyncService';
import {
  buildMyServiceOrderDetails,
  buildMyServiceSummaries,
  clampPageSize,
  type GigSquareMyServiceRating,
} from './services/gigSquareMyServicesService';
import { resolveSellerOrderServiceMatch } from './services/gigSquareMyServicesRepairService';
import {
  resolveCurrentMarketplaceServices,
  resolveServiceActionAvailability,
  type GigSquareResolvedCurrentService,
} from './services/gigSquareServiceStateService';
import {
  GIG_SQUARE_MUTATION_SYNC_DELAY_MS,
  buildGigSquareLocalServiceRecordForModify,
  buildGigSquareLocalServiceRecordForRevoke,
  buildGigSquareModifyMetaidPayload,
  buildGigSquareRevokeMetaidPayload,
  buildGigSquareServicePayload,
  normalizeGigSquareModifyDraft,
  resolveGigSquareSettlementPaymentAddress,
  validateGigSquareModifyDraft,
  validateGigSquareServiceMutation,
  type GigSquareModifyDraft,
} from './services/gigSquareServiceMutationService';
import { GigSquareRefundsService } from './services/gigSquareRefundsService';

// 设置应用程序名称
app.name = APP_NAME;
app.setName(APP_NAME);

const normalizeMetaAppVisualFallback = (value?: string): string | undefined => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.toLowerCase().startsWith('metafile://')) {
    return undefined;
  }
  return normalized;
};

const resolveMetaAppVisualFields = async <T extends { icon?: string; cover?: string }>(record: T): Promise<T> => {
  const [icon, cover] = await Promise.all([
    record.icon ? resolvePinAssetSource(record.icon) : Promise.resolve(null),
    record.cover ? resolvePinAssetSource(record.cover) : Promise.resolve(null),
  ]);
  return {
    ...record,
    icon: icon || normalizeMetaAppVisualFallback(record.icon),
    cover: cover || normalizeMetaAppVisualFallback(record.cover),
  };
};

const LEGACY_APP_NAMES = ['OctoBot', 'octobot'];
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const IPC_MESSAGE_CONTENT_MAX_CHARS = 120_000;
const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;
const IPC_STRING_MAX_CHARS = 4_000;
const IPC_MAX_DEPTH = 5;
const IPC_MAX_KEYS = 80;
const IPC_MAX_ITEMS = 40;
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_LOCAL_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
const LOCAL_IMAGE_PREVIEW_EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
};
const RESTORE_MNEMONIC_WORDS = 12;
const SERVICE_ORDER_TIMEOUT_SCAN_INTERVAL_MS = 60_000;
const SERVICE_ORDER_REFUND_SYNC_INTERVAL_MS = 60_000;
const SERVICE_REFUND_REQUEST_PATH = '/protocols/service-refund-request';
const SERVICE_REFUND_FINALIZE_PATH = '/protocols/service-refund-finalize';
const SERVICE_REFUND_SYNC_SIZE = 200;
const SERVICE_REFUND_SYNC_MAX_PAGES = 10;
const SYSTEM_PROXY_BYPASS_RULES = '<local>,127.0.0.1,[::1]';

const applySystemProxyWithLoopbackBypass = async (targetSession: Session, scope: string): Promise<void> => {
  await targetSession.setProxy({
    mode: 'system',
    proxyBypassRules: SYSTEM_PROXY_BYPASS_RULES,
  });
  console.log(`[Proxy] ${scope} set to follow system proxy with loopback bypass (${SYSTEM_PROXY_BYPASS_RULES})`);
};

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

const sanitizeAttachmentFileName = (value?: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'attachment';
  const fileName = path.basename(raw);
  const sanitized = fileName.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'attachment';
};

const inferAttachmentExtension = (fileName: string, mimeType?: string): string => {
  const fromName = path.extname(fileName).toLowerCase();
  if (fromName) {
    return fromName;
  }
  if (typeof mimeType === 'string') {
    const normalized = mimeType.toLowerCase().split(';')[0].trim();
    return MIME_EXTENSION_MAP[normalized] ?? '';
  }
  return '';
};

const normalizeServiceOrderPaymentChain = (currency?: string | null): 'mvc' | 'btc' | 'doge' => {
  const normalized = String(currency || '').trim().toUpperCase();
  if (normalized === 'BTC') return 'btc';
  if (normalized === 'DOGE') return 'doge';
  return 'mvc';
};

const isFreeServicePrice = (value: unknown): boolean => {
  const raw = toSafeString(value).trim();
  if (!raw) return false;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric === 0;
};

const generateSyntheticOrderTxid = (): string => {
  return randomBytes(32).toString('hex');
};

const getRefundAddressForOrder = (
  metabot: { mvc_address?: string | null; btc_address?: string | null; doge_address?: string | null },
  paymentChain: string
): string => {
  if (paymentChain === 'btc') {
    return String(metabot.btc_address || '').trim();
  }
  if (paymentChain === 'doge') {
    return String(metabot.doge_address || '').trim();
  }
  return String(metabot.mvc_address || '').trim();
};

const resolveInlineAttachmentDir = (cwd?: string): string => {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, '.cowork-temp', 'attachments', 'manual');
    }
  }
  return path.join(app.getPath('temp'), 'idbots', 'attachments');
};

const ensurePngFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
};

const truncateIpcString = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated in main IPC forwarding]`;
};

const sanitizeIpcPayload = (value: unknown, depth = 0, seen?: WeakSet<object>): unknown => {
  const localSeen = seen ?? new WeakSet<object>();
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateIpcString(value, IPC_STRING_MAX_CHARS);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  if (depth >= IPC_MAX_DEPTH) {
    return '[truncated-depth]';
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, IPC_MAX_ITEMS).map((entry) => sanitizeIpcPayload(entry, depth + 1, localSeen));
    if (value.length > IPC_MAX_ITEMS) {
      result.push(`[truncated-items:${value.length - IPC_MAX_ITEMS}]`);
    }
    return result;
  }
  if (typeof value === 'object') {
    if (localSeen.has(value as object)) {
      return '[circular]';
    }
    localSeen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, IPC_MAX_KEYS)) {
      result[key] = sanitizeIpcPayload(entry, depth + 1, localSeen);
    }
    if (entries.length > IPC_MAX_KEYS) {
      result.__truncated_keys__ = entries.length - IPC_MAX_KEYS;
    }
    return result;
  }
  return String(value);
};

const sanitizeCoworkMessageForIpc = (message: any): any => {
  if (!message || typeof message !== 'object') {
    return message;
  }
  return {
    ...message,
    content: typeof message.content === 'string'
      ? truncateIpcString(message.content, IPC_MESSAGE_CONTENT_MAX_CHARS)
      : '',
    metadata: message.metadata ? sanitizeIpcPayload(message.metadata) : undefined,
  };
};

const sanitizePermissionRequestForIpc = (request: any): any => {
  if (!request || typeof request !== 'object') {
    return request;
  }
  return {
    ...request,
    toolInput: sanitizeIpcPayload(request.toolInput ?? {}),
  };
};

const emitCoworkStreamMessage = (sessionId: string, message: unknown): void => {
  const safeMessage = sanitizeCoworkMessageForIpc(message);
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage });
      } catch (error) {
        console.error('Failed to forward cowork message:', error);
      }
    }
  });
};

const emitProviderDiscoveryChanged = (snapshot: DiscoverySnapshot): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('providerDiscovery:changed', snapshot);
      } catch (error) {
        console.error('Failed to forward provider discovery snapshot:', error);
      }
    }
  });
};

const publishServiceOrderEventToCowork = (
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderRecord
): void => {
  const result = publishServiceOrderEventToCoworkStore(getCoworkStore(), type, order);
  if (result.message && order.coworkSessionId) {
    emitCoworkStreamMessage(order.coworkSessionId, result.message);
  }
  if (result.delegationStateChange) {
    emitDelegationStateChange(result.delegationStateChange);
  }
};


const GIG_SQUARE_SERVICE_PATH = '/protocols/skill-service';
const GIG_SQUARE_CHATPUBKEY_PATH = '/info/chatpubkey';
const GIG_SQUARE_SERVICE_LIMIT = 10;
const GIG_SQUARE_MY_SERVICES_PAGE_SIZE = 8;
const GIG_SQUARE_MY_SERVICE_ORDERS_PAGE_SIZE = 10;
const GIG_SQUARE_SYNC_SIZE = 200;
const GIG_SQUARE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

type GigSquareService = {
  id: string;
  pinId?: string;
  sourceServicePinId?: string;
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  settlementKind?: string | null;
  paymentChain?: string | null;
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  createAddress?: string | null;
  paymentAddress?: string | null;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerMetaBot?: string | null;
  providerSkill?: string | null;
  status?: number;
  operation?: string | null;
  path?: string | null;
  originalId?: string | null;
  available?: number;
  ratingAvg?: number;
  ratingCount?: number;
  updatedAt?: number;
  refundRisk?: {
    hasUnresolvedRefund: boolean;
    unresolvedRefundAgeHours: number;
    hidden?: boolean;
  } | null;
};

type GigSquareCurrentMyService = GigSquareResolvedCurrentService<GigSquareService> & {
  creatorMetabotId: number | null;
  creatorMetabotName: string | null;
  creatorMetabotAvatar: string | null;
  canModify: boolean;
  canRevoke: boolean;
  blockedReason: string | null;
};

type GigSquareLocalServiceRecord = {
  id: string;
  pinId: string;
  sourceServicePinId: string;
  currentPinId: string;
  txid: string;
  metabotId: number;
  providerGlobalMetaId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  skillDocument: string;
  inputType: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  revokedAt: number | null;
  updatedAt: number;
};

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizePositiveInteger = (value: unknown, fallback: number): number => {
  const parsed = toSafeNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const buildPrivateMessagePayload = (to: string, encryptedContent: string, replyPin = ''): string => {
  const body = {
    to,
    timestamp: Math.floor(Date.now() / 1000),
    content: encryptedContent,
    contentType: 'text/plain',
    encrypt: 'ecdh',
    replyPin: replyPin || '',
  };
  return JSON.stringify(body);
};

const extractChatPubkeyFromList = (list: any[], metaid: string): string | null => {
  if (!Array.isArray(list)) return null;
  const normalized = metaid.trim();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const itemMetaid = toSafeString((item as Record<string, unknown>).metaid || (item as Record<string, unknown>).createMetaId || '');
    const itemGlobal = toSafeString((item as Record<string, unknown>).globalMetaId || '');
    if (normalized && normalized !== itemMetaid && normalized !== itemGlobal) continue;
    const raw = toSafeString(
      (item as Record<string, unknown>).contentSummary
      || (item as Record<string, unknown>).content
      || (item as Record<string, unknown>).contentBody
      || ''
    ).trim();
    if (raw) return raw;
  }
  return null;
};

const sanitizeDbParams = (params: unknown[]): (string | number | null)[] => {
  return params.map((value) => (
    value == null || (typeof value === 'number' && Number.isNaN(value)) ? null : (value as string | number | null)
  ));
};

const parseDataUrlImage = (dataUrl: string): { mime: string; buffer: Buffer } | null => {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  const base64 = match[2];
  if (!base64) return null;
  try {
    const buffer = Buffer.from(base64, 'base64');
    return { mime, buffer };
  } catch {
    return null;
  }
};

const ensureGigSquareSchema = (): void => {
  if (gigSquareSchemaReady) return;
  const sqliteStore = getStore();
  const db = sqliteStore.getDatabase();
  db.run(`
    CREATE TABLE IF NOT EXISTS gig_square_services (
      id TEXT PRIMARY KEY,
      pin_id TEXT NOT NULL,
      source_service_pin_id TEXT,
      current_pin_id TEXT,
      txid TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      provider_global_metaid TEXT NOT NULL,
      provider_skill TEXT NOT NULL,
      service_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      service_icon TEXT,
      price TEXT NOT NULL,
      currency TEXT NOT NULL,
      skill_document TEXT,
      input_type TEXT NOT NULL,
      output_type TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const gigSquareColumnsResult = db.exec('PRAGMA table_info(gig_square_services)');
  const gigSquareColumns = (gigSquareColumnsResult[0]?.values ?? []).map((row) => String(row[1]));
  if (!gigSquareColumns.includes('source_service_pin_id')) {
    db.run('ALTER TABLE gig_square_services ADD COLUMN source_service_pin_id TEXT');
  }
  if (!gigSquareColumns.includes('current_pin_id')) {
    db.run('ALTER TABLE gig_square_services ADD COLUMN current_pin_id TEXT');
  }
  if (!gigSquareColumns.includes('revoked_at')) {
    db.run('ALTER TABLE gig_square_services ADD COLUMN revoked_at INTEGER');
  }
  db.run(`
    UPDATE gig_square_services
    SET source_service_pin_id = COALESCE(NULLIF(TRIM(source_service_pin_id), ''), pin_id, id)
    WHERE source_service_pin_id IS NULL OR TRIM(source_service_pin_id) = ''
  `);
  db.run(`
    UPDATE gig_square_services
    SET current_pin_id = COALESCE(NULLIF(TRIM(current_pin_id), ''), pin_id, id)
    WHERE current_pin_id IS NULL OR TRIM(current_pin_id) = ''
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gig_square_services_metabot
    ON gig_square_services(metabot_id, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gig_square_services_service_name
    ON gig_square_services(service_name);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gig_square_services_current_pin
    ON gig_square_services(current_pin_id);
  `);
  sqliteStore.getSaveFunction()();
  gigSquareSchemaReady = true;
};

const insertGigSquareServiceRow = (input: {
  id: string;
  pinId: string;
  sourceServicePinId?: string;
  currentPinId?: string;
  txid?: string;
  metabotId: number;
  providerGlobalMetaId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  skillDocument: string;
  inputType: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
  revokedAt?: number | null;
  updatedAt?: number;
}): void => {
  ensureGigSquareSchema();
  const sqliteStore = getStore();
  const db = sqliteStore.getDatabase();
  const now = input.updatedAt ?? Date.now();
  db.run(
    `
      INSERT INTO gig_square_services (
        id, pin_id, source_service_pin_id, current_pin_id, txid, metabot_id, provider_global_metaid, provider_skill,
        service_name, display_name, description, service_icon, price, currency,
        skill_document, input_type, output_type, endpoint, payload_json, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pin_id = excluded.pin_id,
        source_service_pin_id = excluded.source_service_pin_id,
        current_pin_id = excluded.current_pin_id,
        txid = excluded.txid,
        metabot_id = excluded.metabot_id,
        provider_global_metaid = excluded.provider_global_metaid,
        provider_skill = excluded.provider_skill,
        service_name = excluded.service_name,
        display_name = excluded.display_name,
        description = excluded.description,
        service_icon = excluded.service_icon,
        price = excluded.price,
        currency = excluded.currency,
        skill_document = excluded.skill_document,
        input_type = excluded.input_type,
        output_type = excluded.output_type,
        endpoint = excluded.endpoint,
        payload_json = excluded.payload_json,
        revoked_at = excluded.revoked_at,
        updated_at = excluded.updated_at
    `,
    sanitizeDbParams([
      input.id,
      input.pinId,
      input.sourceServicePinId || input.pinId,
      input.currentPinId || input.pinId,
      input.txid ?? '',
      input.metabotId,
      input.providerGlobalMetaId,
      input.providerSkill,
      input.serviceName,
      input.displayName,
      input.description,
      input.serviceIcon,
      input.price,
      input.currency,
      input.skillDocument,
      input.inputType,
      input.outputType,
      input.endpoint,
      input.payloadJson,
      input.revokedAt ?? null,
      now,
      now,
    ])
  );
  sqliteStore.getSaveFunction()();
};

const hasGigSquareLocalServiceRecord = (servicePinId: string): boolean => {
  ensureGigSquareSchema();
  const normalizedServicePinId = toSafeString(servicePinId).trim();
  if (!normalizedServicePinId) return false;
  const result = getStore().getDatabase().exec(
    `SELECT 1
     FROM gig_square_services
     WHERE id = ?
        OR pin_id = ?
        OR source_service_pin_id = ?
        OR current_pin_id = ?
     LIMIT 1`,
    sanitizeDbParams([
      normalizedServicePinId,
      normalizedServicePinId,
      normalizedServicePinId,
      normalizedServicePinId,
    ]),
  );
  return Boolean(result[0]?.values?.length);
};

const resolveGigSquareLocalServiceMetabotId = (servicePinId: string): number | null => {
  ensureGigSquareSchema();
  const normalizedServicePinId = toSafeString(servicePinId).trim();
  if (!normalizedServicePinId) return null;
  const result = getStore().getDatabase().exec(
    `SELECT metabot_id
     FROM gig_square_services
     WHERE id = ?
        OR pin_id = ?
        OR source_service_pin_id = ?
        OR current_pin_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    sanitizeDbParams([
      normalizedServicePinId,
      normalizedServicePinId,
      normalizedServicePinId,
      normalizedServicePinId,
    ]),
  );
  const raw = result[0]?.values?.[0]?.[0];
  const metabotId = Math.trunc(toSafeNumber(raw));
  return Number.isFinite(metabotId) && metabotId > 0 ? metabotId : null;
};

const listGigSquareLocalServiceRecords = (): GigSquareLocalServiceRecord[] => {
  ensureGigSquareSchema();
  const db = getStore().getDatabase();
  const result = db.exec(`
    SELECT id, pin_id, source_service_pin_id, current_pin_id, txid, metabot_id, provider_global_metaid,
           provider_skill, service_name, display_name, description, service_icon, price, currency,
           skill_document, input_type, output_type, endpoint, payload_json, revoked_at, updated_at
    FROM gig_square_services
    ORDER BY updated_at DESC
  `);
  if (!result.length || !result[0].values.length) return [];
  const columns = result[0].columns as string[];
  const rows = result[0].values as unknown[][];
  return rows.map((row) => {
    const raw = columns.reduce<Record<string, unknown>>((acc, col, idx) => {
      acc[col] = row[idx];
      return acc;
    }, {});
    const payloadJson = toSafeString(raw.payload_json).trim();
    let payloadSummary: Record<string, unknown> | null = null;
    if (payloadJson) {
      try {
        const parsed = JSON.parse(payloadJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payloadSummary = parsed as Record<string, unknown>;
        }
      } catch {
        payloadSummary = null;
      }
    }
    // Local service rows persist canonical currency plus payload_json; structured settlement
    // metadata is rehydrated from the payload until later order-ledger schema work lands.
    const settlement = parseGigSquareSettlementAsset({
      currency: toSafeString(raw.currency).trim(),
      settlementKind: toSafeString(payloadSummary?.settlementKind).trim(),
      paymentChain: toSafeString(payloadSummary?.paymentChain).trim(),
      mrc20Ticker: toSafeString(payloadSummary?.mrc20Ticker).trim(),
      mrc20Id: toSafeString(payloadSummary?.mrc20Id).trim(),
    });
    return {
      id: toSafeString(raw.id).trim(),
      pinId: toSafeString(raw.pin_id).trim(),
      sourceServicePinId: toSafeString(raw.source_service_pin_id).trim() || toSafeString(raw.pin_id).trim(),
      currentPinId: toSafeString(raw.current_pin_id).trim() || toSafeString(raw.pin_id).trim(),
      txid: toSafeString(raw.txid).trim(),
      metabotId: Math.trunc(toSafeNumber(raw.metabot_id)),
      providerGlobalMetaId: toSafeString(raw.provider_global_metaid).trim(),
      providerSkill: toSafeString(raw.provider_skill).trim(),
      serviceName: toSafeString(raw.service_name).trim(),
      displayName: toSafeString(raw.display_name).trim(),
      description: toSafeString(raw.description).trim(),
      serviceIcon: toSafeString(raw.service_icon).trim() || null,
      price: toSafeString(raw.price).trim(),
      currency: settlement.protocolCurrency,
      settlementKind: settlement.settlementKind,
      paymentChain: settlement.paymentChain,
      mrc20Ticker: settlement.mrc20Ticker,
      mrc20Id: settlement.mrc20Id,
      skillDocument: toSafeString(raw.skill_document).trim(),
      inputType: toSafeString(raw.input_type).trim(),
      outputType: toSafeString(raw.output_type).trim(),
      endpoint: toSafeString(raw.endpoint).trim(),
      payloadJson,
      revokedAt: raw.revoked_at == null ? null : Math.trunc(toSafeNumber(raw.revoked_at)),
      updatedAt: Math.trunc(toSafeNumber(raw.updated_at)),
    };
  });
};

const markGigSquareLocalServiceRevoked = (service: {
  id: string;
  currentPinId?: string;
  sourceServicePinId?: string;
  creatorMetabotId?: number | null;
  providerGlobalMetaId?: string;
  providerSkill?: string | null;
  serviceName?: string;
  displayName?: string;
  description?: string;
  serviceIcon?: string | null;
  price?: string;
  currency?: string;
  outputType?: string | null;
  endpoint?: string | null;
}): void => {
  ensureGigSquareSchema();
  const normalizedServicePinId = toSafeString(service.currentPinId || service.id).trim();
  if (!normalizedServicePinId) return;
  const now = Date.now();
  const db = getStore().getDatabase();
  db.run(
    `UPDATE gig_square_services
     SET revoked_at = ?,
         updated_at = ?
     WHERE id = ?
        OR pin_id = ?
        OR source_service_pin_id = ?
        OR current_pin_id = ?`,
    sanitizeDbParams([
      now,
      now,
      normalizedServicePinId,
      normalizedServicePinId,
      normalizedServicePinId,
      normalizedServicePinId,
    ]),
  );
  if (!hasGigSquareLocalServiceRecord(normalizedServicePinId)) {
    insertGigSquareServiceRow(buildGigSquareLocalServiceRecordForRevoke({
      service,
      now,
    }));
    return;
  }
  getStore().getSaveFunction()();
};

const updateGigSquareLocalServiceAfterModify = (input: {
  targetService: {
    id: string;
    currentPinId?: string;
    sourceServicePinId?: string;
    creatorMetabotId?: number | null;
    providerGlobalMetaId?: string;
    providerSkill?: string | null;
    serviceName?: string;
    displayName?: string;
    description?: string;
    serviceIcon?: string | null;
    price?: string;
    currency?: string;
    outputType?: string | null;
    endpoint?: string | null;
  };
  currentPinId: string;
  providerSkill: string;
  serviceName: string;
  displayName: string;
  description: string;
  serviceIcon: string | null;
  price: string;
  currency: string;
  outputType: string;
  endpoint: string;
  payloadJson: string;
}): void => {
  ensureGigSquareSchema();
  const normalizedTargetServiceId = toSafeString(
    input.targetService.currentPinId || input.targetService.id
  ).trim();
  if (!normalizedTargetServiceId) return;
  const now = Date.now();
  const db = getStore().getDatabase();
  db.run(
    `UPDATE gig_square_services
     SET current_pin_id = ?,
         provider_skill = ?,
         service_name = ?,
         display_name = ?,
         description = ?,
         service_icon = ?,
         price = ?,
         currency = ?,
         output_type = ?,
         endpoint = ?,
         payload_json = ?,
         revoked_at = NULL,
         updated_at = ?
     WHERE id = ?
        OR pin_id = ?
        OR source_service_pin_id = ?
        OR current_pin_id = ?`,
    sanitizeDbParams([
      toSafeString(input.currentPinId).trim() || normalizedTargetServiceId,
      input.providerSkill,
      input.serviceName,
      input.displayName,
      input.description,
      input.serviceIcon,
      input.price,
      input.currency,
      input.outputType,
      input.endpoint,
      input.payloadJson,
      now,
      normalizedTargetServiceId,
      normalizedTargetServiceId,
      normalizedTargetServiceId,
      normalizedTargetServiceId,
    ]),
  );
  if (!hasGigSquareLocalServiceRecord(normalizedTargetServiceId)) {
    insertGigSquareServiceRow(buildGigSquareLocalServiceRecordForModify({
      service: input.targetService,
      currentPinId: toSafeString(input.currentPinId).trim() || normalizedTargetServiceId,
      providerSkill: input.providerSkill,
      serviceName: input.serviceName,
      displayName: input.displayName,
      description: input.description,
      serviceIcon: input.serviceIcon,
      price: input.price,
      currency: input.currency,
      outputType: input.outputType,
      endpoint: input.endpoint,
      payloadJson: input.payloadJson,
      now,
    }));
    return;
  }
  getStore().getSaveFunction()();
};

let gigSquareSyncInProgress = false;

async function syncRemoteSkillServices(): Promise<void> {
  if (gigSquareSyncInProgress) return;
  gigSquareSyncInProgress = true;
  try {
    const sqliteStore = getStore();
    const db = sqliteStore.getDatabase();
    await syncRemoteSkillServicesWithCursor({
      pageSize: GIG_SQUARE_SYNC_SIZE,
      fetchPage: async (cursor?: string) => {
        const url = new URL('https://manapi.metaid.io/pin/path/list');
        url.searchParams.set('path', GIG_SQUARE_SERVICE_PATH);
        url.searchParams.set('size', String(GIG_SQUARE_SYNC_SIZE));
        if (cursor) url.searchParams.set('cursor', cursor);
        const localPath = `/api/pin/path/list${url.search}`;
        const response = await fetchJsonWithFallbackOnMiss(
          localPath,
          url.toString(),
          isRemoteSkillServiceListSemanticMiss,
        );
        if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
        const json = await response.json();
        return {
          list: Array.isArray(json?.data?.list) ? json.data.list as Record<string, unknown>[] : [],
          nextCursor: typeof json?.data?.nextCursor === 'string' ? json.data.nextCursor : null,
        };
      },
      upsertService: (parsed) => {
        const statement = buildRemoteSkillServiceUpsertStatement(parsed);
        db.run(statement.sql, sanitizeDbParams(statement.params));
        repairServiceRatingAggregate(db, parsed.id);
      },
    });
    sqliteStore.getSaveFunction()();
  } finally {
    gigSquareSyncInProgress = false;
  }
}

const GIG_SQUARE_RATING_PATH = '/protocols/skill-service-rate';
const GIG_SQUARE_RATING_SYNC_SIZE = 200;
const GIG_SQUARE_RATING_MAX_PAGES = 10;
const GIG_SQUARE_RATING_LATEST_PIN_KEY = 'gig_square_rating.latest_pin_id';
const GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY = 'gig_square_rating.backfill_cursor';

async function syncRemoteSkillServiceRatings(): Promise<void> {
  const sqliteStore = getStore();
  const db = sqliteStore.getDatabase();

  const kvGet = (key: string): string | null => {
    const r = db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!r.length || !r[0].values.length) return null;
    return String(r[0].values[0][0]);
  };
  const kvSet = (key: string, value: string) => {
    db.run(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()]
    );
  };
  await syncGigSquareRatings({
    db,
    latestPinId: kvGet(GIG_SQUARE_RATING_LATEST_PIN_KEY),
    backfillCursor: kvGet(GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY),
    maxPages: GIG_SQUARE_RATING_MAX_PAGES,
    fetchPage: async (cursor?: string) => {
      const url = new URL('https://manapi.metaid.io/pin/path/list');
      url.searchParams.set('path', GIG_SQUARE_RATING_PATH);
      url.searchParams.set('size', String(GIG_SQUARE_RATING_SYNC_SIZE));
      if (cursor) url.searchParams.set('cursor', cursor);

      const resp = await fetchJsonWithFallbackOnMiss(
        `/api/pin/path/list${url.search}`,
        url.toString(),
        isEmptyListDataPayload
      );
      if (!resp.ok) {
        throw new Error(`Sync failed: ${resp.status}`);
      }

      const json = await resp.json() as Record<string, unknown>;
      const data = json?.data as Record<string, unknown> | undefined;
      return {
        list: Array.isArray(data?.list) ? data.list as Record<string, unknown>[] : [],
        nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : null,
      };
    },
    setLatestPinId: (pinId: string) => {
      kvSet(GIG_SQUARE_RATING_LATEST_PIN_KEY, pinId);
    },
    setBackfillCursor: (cursor: string) => {
      kvSet(GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY, cursor);
    },
    clearBackfillCursor: () => {
      db.run('DELETE FROM kv WHERE key = ?', [GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY]);
    },
  });

  sqliteStore.getSaveFunction()();
}

async function syncGigSquareRemoteData(): Promise<void> {
  await syncRemoteSkillServices();
  await syncRemoteSkillServiceRatings();
  if (providerDiscoveryService) {
    await providerDiscoveryService.refreshNow().catch((error) => {
      console.warn('[ProviderDiscovery] Refresh after GigSquare sync failed:', error);
    });
  }
}

function listRemoteSkillServicesFromDb(): GigSquareService[] {
  const db = getStore().getDatabase();
  const result = db.exec(`
    SELECT id, pin_id, source_service_pin_id, status, operation, path, original_id, available,
           metaid, global_metaid, address, create_address, payment_address, service_name, display_name, description,
           price, currency, avatar, service_icon, provider_meta_bot, provider_skill, updated_at, rating_avg, rating_count
    FROM remote_skill_service
    ORDER BY
      CASE WHEN rating_count > 0
        THEN (rating_avg * rating_count + 4.0 * 5) / (rating_count + 5)
        ELSE 0
      END DESC,
      rating_count DESC,
      updated_at DESC
  `);
  if (!result.length || !result[0].values.length) return [];
  const columns = result[0].columns as string[];
  const rows = result[0].values as (string | number)[][];
  return rows.map((row) => {
    const raw = columns.reduce<Record<string, unknown>>((acc, col, idx) => {
      acc[col] = row[idx];
      return acc;
    }, {});
    return parseRemoteSkillServiceRow(raw) as GigSquareService;
  });
}

function listCurrentRemoteGigSquareServices(): Array<GigSquareResolvedCurrentService<GigSquareService>> {
  return resolveCurrentMarketplaceServices(
    listRemoteSkillServicesFromDb(),
    listGigSquareLocalServiceRecords(),
  );
}

function listGigSquareRatingsFromDb(serviceId?: string): GigSquareMyServiceRating[] {
  const db = getStore().getDatabase();
  const trimmedServiceId = typeof serviceId === 'string' ? serviceId.trim() : '';
  const params: string[] = [];
  const clauses = [
    'service_paid_tx IS NOT NULL',
    "TRIM(service_paid_tx) <> ''",
  ];
  if (trimmedServiceId) {
    clauses.push('service_id = ?');
    params.push(trimmedServiceId);
  }
  const result = db.exec(`
    SELECT pin_id, service_id, service_paid_tx, rate, comment, rater_global_metaid, rater_metaid, created_at
    FROM remote_skill_service_rating_seen
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
  `, params);
  if (!result.length || !result[0].values.length) return [];
  const columns = result[0].columns as string[];
  const rows = result[0].values as (string | number | null)[][];
  return rows.map((row) => {
    const raw = columns.reduce<Record<string, unknown>>((acc, col, idx) => {
      acc[col] = row[idx];
      return acc;
    }, {});
    return {
      pinId: toSafeString(raw.pin_id).trim() || null,
      serviceId: toSafeString(raw.service_id).trim(),
      servicePaidTx: toSafeString(raw.service_paid_tx).trim() || null,
      rate: toSafeNumber(raw.rate),
      comment: toSafeString(raw.comment).trim() || null,
      raterGlobalMetaId: toSafeString(raw.rater_global_metaid).trim() || null,
      raterMetaId: toSafeString(raw.rater_metaid).trim() || null,
      createdAt: toSafeNumber(raw.created_at),
    };
  });
}

const listOwnedGigSquareProviderGlobalMetaIds = (): Set<string> => new Set(
  getMetabotStore()
    .listMetabots()
    .map((metabot) => toSafeString(metabot.globalmetaid).trim())
    .filter(Boolean)
);
const resolveGigSquareServiceCreatorMetabot = (
  service: GigSquareService,
): { id: number | null; name: string | null; avatar: string | null } => {
  const metabotStore = getMetabotStore();
  const providerGlobalMetaId = toSafeString(service.providerGlobalMetaId).trim();
  const providerMetaId = toSafeString(service.providerMetaId).trim();
  const createAddress = toSafeString(service.createAddress ?? service.providerAddress).trim();

  if (providerGlobalMetaId) {
    const byGlobalMeta = metabotStore.getMetabotByGlobalMetaId(providerGlobalMetaId);
    if (byGlobalMeta) {
      return {
        id: byGlobalMeta.id,
        name: toSafeString(byGlobalMeta.name).trim() || null,
        avatar: byGlobalMeta.avatar ?? null,
      };
    }
  }

  const byAddressOrMetaid = metabotStore
    .listMetabots()
    .find((metabot) => {
      const mvcAddress = toSafeString(metabot.mvc_address).trim();
      const btcAddress = toSafeString(metabot.btc_address).trim();
      const dogeAddress = toSafeString(metabot.doge_address).trim();
      if (
        createAddress
        && (mvcAddress === createAddress || btcAddress === createAddress || dogeAddress === createAddress)
      ) {
        return true;
      }
      return Boolean(providerMetaId) && toSafeString(metabot.metaid).trim() === providerMetaId;
    });

  if (!byAddressOrMetaid) {
    return { id: null, name: null, avatar: null };
  }

  return {
    id: byAddressOrMetaid.id,
    name: toSafeString(byAddressOrMetaid.name).trim() || null,
    avatar: byAddressOrMetaid.avatar ?? null,
  };
};

const listCurrentMyGigSquareServices = (): GigSquareCurrentMyService[] => {
  const ownedGlobalMetaIds = listOwnedGigSquareProviderGlobalMetaIds();
  const resolvedCurrentRows = resolveCurrentMarketplaceServices(
    listRemoteSkillServicesFromDb().filter((service) =>
      ownedGlobalMetaIds.has(toSafeString(service.providerGlobalMetaId).trim())
    ),
    listGigSquareLocalServiceRecords(),
  );

  return resolvedCurrentRows.map((service) => {
    const creator = resolveGigSquareServiceCreatorMetabot(service);
    const actionAvailability = resolveServiceActionAvailability({
      currentService: service,
      creatorMetabotExists: creator.id != null,
    });
    return {
      ...service,
      creatorMetabotId: creator.id,
      creatorMetabotName: creator.name,
      creatorMetabotAvatar: creator.avatar,
      canModify: actionAvailability.canModify,
      canRevoke: actionAvailability.canRevoke,
      blockedReason: actionAvailability.blockedReason,
    };
  });
};

const unwrapMetaidInfoRecord = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const nested = record.MetaIdInfo ?? record.metaIdInfo ?? record.metaidInfo;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return {
      ...record,
      ...(nested as Record<string, unknown>),
    };
  }
  return record;
};

async function fetchMetaidUserInfoByGlobalMetaId(globalMetaId: string): Promise<{
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
}> {
  const normalizedGlobalMetaId = toSafeString(globalMetaId).trim();
  if (!normalizedGlobalMetaId) {
    return {};
  }
  const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(normalizedGlobalMetaId)}`;
  const fallbackUrl = `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/${encodeURIComponent(normalizedGlobalMetaId)}`;
  const res = await fetchJsonWithFallbackOnMiss(localPath, fallbackUrl, isSemanticallyEmptyMetaidInfoPayload);
  const payload = await res.json() as { code?: number; message?: string; data?: Record<string, unknown> };
  const data = unwrapMetaidInfoRecord(payload?.data);
  if (data) {
    const avatarUrl = await resolveMetaidAvatarSource(data);
    if (avatarUrl) {
      data.avatarUrl = avatarUrl;
    }
    payload.data = data;
  }
  return payload;
}

let gigSquareMyServicesSyncPromise: Promise<void> | null = null;
let gigSquareMyServicesPendingRemoteRefresh = false;

const getPrivateChatOrderText = (
  db: ReturnType<SqliteStore['getDatabase']>,
  pinId: string,
): string | null => {
  const normalizedPinId = toSafeString(pinId).trim();
  if (!normalizedPinId) return null;
  const result = db.exec(
    `SELECT content
     FROM private_chat_messages
     WHERE pin_id = ?
     LIMIT 1`,
    [normalizedPinId],
  );
  const content = toSafeString(result[0]?.values?.[0]?.[0]).trim();
  return content || null;
};

const getCoworkOrderText = (
  db: ReturnType<SqliteStore['getDatabase']>,
  sessionId: string,
): string | null => {
  const normalizedSessionId = toSafeString(sessionId).trim();
  if (!normalizedSessionId) return null;
  const result = db.exec(
    `SELECT content
     FROM cowork_messages
     WHERE session_id = ?
       AND type = 'user'
     ORDER BY
       CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
       sequence ASC,
       created_at ASC
     LIMIT 1`,
    [normalizedSessionId],
  );
  const content = toSafeString(result[0]?.values?.[0]?.[0]).trim();
  return content || null;
};

const looksLikeRecoveredServiceOrderText = (value: string | null): boolean => {
  const normalized = toSafeString(value).trim();
  if (!normalized) return false;
  return normalized.startsWith('[ORDER]') || /txid\s*[:：=]?\s*[0-9a-fA-F]{64}/.test(normalized);
};

const recoverMissingRefundPendingOrderObserverSessions = async (): Promise<void> => {
  const db = getStore().getDatabase();
  const metabotStore = getMetabotStore();
  const recovered = await recoverMissingRefundPendingOrderSessions({
    coworkStore: getCoworkStore(),
    orderStore: getServiceOrderStore(),
    resolveLocalMetabotIdByGlobalMetaId: (globalMetaId) => {
      const metabot = metabotStore.getMetabotByGlobalMetaId(globalMetaId);
      return metabot?.id ?? null;
    },
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => {
      const metabot = metabotStore.getMetabotById(localMetabotId);
      return metabot?.globalmetaid ?? null;
    },
    resolveOrderText: (order) => {
      const privateOrderText = getPrivateChatOrderText(db, toSafeString(order.orderMessagePinId).trim());
      if (looksLikeRecoveredServiceOrderText(privateOrderText)) {
        return privateOrderText;
      }
      const coworkOrderText = getCoworkOrderText(db, toSafeString(order.coworkSessionId).trim());
      return looksLikeRecoveredServiceOrderText(coworkOrderText) ? coworkOrderText : null;
    },
    resolvePeerInfo: (order) => {
      const peerMetabot = metabotStore.getMetabotByGlobalMetaId(order.counterpartyGlobalMetaid);
      const localMetabot = metabotStore.getMetabotById(order.localMetabotId);
      return {
        peerName: peerMetabot?.name ?? null,
        peerAvatar: typeof peerMetabot?.avatar === 'string' ? peerMetabot.avatar : null,
        serverBotGlobalMetaId: localMetabot?.globalmetaid ?? null,
      };
    },
  });

  for (const session of recovered) {
    if (session.initialMessage) {
      emitCoworkStreamMessage(session.coworkSessionId, session.initialMessage);
    }
    if (session.recoveryMessage) {
      emitCoworkStreamMessage(session.coworkSessionId, session.recoveryMessage);
    }
  }
};

function listGigSquareRatingServiceIdByTxid(): Map<string, string> {
  const map = new Map<string, string>();
  for (const rating of listGigSquareRatingsFromDb()) {
    const paymentTxid = toSafeString(rating.servicePaidTx).trim();
    const serviceId = toSafeString(rating.serviceId).trim();
    if (!paymentTxid || !serviceId || map.has(paymentTxid)) {
      continue;
    }
    map.set(paymentTxid, serviceId);
  }
  return map;
}

function repairSellerOrdersForGigSquareMyServices(): void {
  const services = listRemoteSkillServicesFromDb();
  if (services.length === 0) return;

  const db = getStore().getDatabase();
  const store = getServiceOrderStore();
  const sellerOrders = store.listOrdersByRole('seller');
  if (sellerOrders.length === 0) return;

  const ratingServiceIdByTxid = listGigSquareRatingServiceIdByTxid();
  const metabotGlobalMetaIdById = new Map(
    getMetabotStore()
      .listMetabots()
      .map((metabot) => [metabot.id, toSafeString(metabot.globalmetaid).trim()] as const),
  );
  const privateTextCache = new Map<string, string | null>();
  const coworkTextCache = new Map<string, string | null>();

  for (const order of sellerOrders) {
    const providerGlobalMetaId = metabotGlobalMetaIdById.get(order.localMetabotId) ?? '';
    const orderMessagePinId = toSafeString(order.orderMessagePinId).trim();
    const coworkSessionId = toSafeString(order.coworkSessionId).trim();

    let orderText: string | null = null;
    if (orderMessagePinId) {
      if (!privateTextCache.has(orderMessagePinId)) {
        privateTextCache.set(orderMessagePinId, getPrivateChatOrderText(db, orderMessagePinId));
      }
      orderText = privateTextCache.get(orderMessagePinId) ?? null;
    }
    if (!orderText && coworkSessionId) {
      if (!coworkTextCache.has(coworkSessionId)) {
        coworkTextCache.set(coworkSessionId, getCoworkOrderText(db, coworkSessionId));
      }
      orderText = coworkTextCache.get(coworkSessionId) ?? null;
    }

    const match = resolveSellerOrderServiceMatch({
      order: {
        id: order.id,
        providerGlobalMetaId,
        servicePinId: order.servicePinId,
        serviceName: order.serviceName,
        paymentTxid: order.paymentTxid,
        paymentAmount: order.paymentAmount,
        paymentCurrency: order.paymentCurrency,
        createdAt: order.createdAt,
      },
      services,
      ratingServiceIdByTxid,
      orderText,
    });
    if (!match) {
      continue;
    }

    if (
      toSafeString(order.servicePinId).trim() === match.serviceId
      && toSafeString(order.serviceName).trim() === match.serviceName
    ) {
      continue;
    }
    store.repairOrderServiceReference(order.id, {
      servicePinId: match.serviceId,
      serviceName: match.serviceName,
    });
  }
}

async function syncGigSquareMyServicesData(options?: { refresh?: boolean }): Promise<void> {
  if (options?.refresh) {
    gigSquareMyServicesPendingRemoteRefresh = true;
  }
  if (gigSquareMyServicesSyncPromise) {
    return gigSquareMyServicesSyncPromise;
  }

  gigSquareMyServicesSyncPromise = (async () => {
    do {
      const shouldRefresh = gigSquareMyServicesPendingRemoteRefresh;
      gigSquareMyServicesPendingRemoteRefresh = false;
      if (shouldRefresh) {
        try {
          await syncGigSquareRemoteData();
        } catch (error) {
          console.warn('[GigSquare] My services remote refresh failed', error);
        }
      }
      repairSellerOrdersForGigSquareMyServices();
    } while (gigSquareMyServicesPendingRemoteRefresh);
  })().finally(() => {
    gigSquareMyServicesSyncPromise = null;
  });

  return gigSquareMyServicesSyncPromise;
}

type CaptureRect = { x: number; y: number; width: number; height: number };

const normalizeCaptureRect = (rect?: Partial<CaptureRect> | null): CaptureRect | null => {
  if (!rect) return null;
  const normalized = {
    x: Math.max(0, Math.round(typeof rect.x === 'number' ? rect.x : 0)),
    y: Math.max(0, Math.round(typeof rect.y === 'number' ? rect.y : 0)),
    width: Math.max(0, Math.round(typeof rect.width === 'number' ? rect.width : 0)),
    height: Math.max(0, Math.round(typeof rect.height === 'number' ? rect.height : 0)),
  };
  return normalized.width > 0 && normalized.height > 0 ? normalized : null;
};

const resolveTaskWorkingDirectory = (workspaceRoot: string): string => {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  fs.mkdirSync(resolvedWorkspaceRoot, { recursive: true });
  if (!fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Selected workspace is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};

const resolveExistingTaskWorkingDirectory = (workspaceRoot: string): string => {
  const trimmed = workspaceRoot.trim();
  if (!trimmed) {
    throw new Error('Please select a task folder before submitting.');
  }
  const resolvedWorkspaceRoot = path.resolve(trimmed);
  if (!fs.existsSync(resolvedWorkspaceRoot) || !fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Task folder does not exist or is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};

const getDefaultExportImageName = (defaultFileName?: string): string => {
  const normalized = typeof defaultFileName === 'string' && defaultFileName.trim()
    ? defaultFileName.trim()
    : `cowork-session-${Date.now()}`;
  return ensurePngFileName(sanitizeExportFileName(normalized));
};

const savePngWithDialog = async (
  webContents: WebContents,
  pngData: Buffer,
  defaultFileName?: string,
): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> => {
  const defaultName = getDefaultExportImageName(defaultFileName);
  const ownerWindow = BrowserWindow.fromWebContents(webContents);
  const saveOptions = {
    title: 'Export Session Image',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: true, canceled: true };
  }

  const outputPath = ensurePngFileName(saveResult.filePath);
  await fs.promises.writeFile(outputPath, pngData);
  return { success: true, canceled: false, path: outputPath };
};

const configureUserDataPath = (): void => {
  const currentUserDataPath = app.getPath('userData');
  const currentAppDataPath = app.getPath('appData');
  const resolvedPaths = resolveRuntimeDataPaths({
    appDataPath: currentAppDataPath,
    currentUserDataPath,
    appName: APP_NAME,
  });

  if (resolvedPaths.appDataPath !== currentAppDataPath) {
    app.setPath('appData', resolvedPaths.appDataPath);
    console.log(`[Main] appData path updated: ${currentAppDataPath} -> ${resolvedPaths.appDataPath}`);
  }

  const nextUserDataPath = resolvedPaths.userDataPath;
  if (currentUserDataPath !== nextUserDataPath) {
    app.setPath('userData', nextUserDataPath);
    console.log(`[Main] userData path updated: ${currentUserDataPath} -> ${nextUserDataPath}`);
  }
};

const migrateLegacyUserData = (): void => {
  const appDataPath = app.getPath('appData');
  const userDataPath = app.getPath('userData');
  const legacyRoots = LEGACY_APP_NAMES
    .map(name => path.join(appDataPath, name))
    .filter(legacyPath => legacyPath !== userDataPath && fs.existsSync(legacyPath));

  if (legacyRoots.length === 0) {
    return;
  }

  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }

  for (const legacyRoot of legacyRoots) {
    try {
      const entries = fs.readdirSync(legacyRoot);
      for (const entry of entries) {
        const sourcePath = path.join(legacyRoot, entry);
        const targetPath = path.join(userDataPath, entry);
        if (fs.existsSync(targetPath)) {
          continue;
        }
        fs.cpSync(sourcePath, targetPath, {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: false,
        });
      }
      console.log(`[Main] Migrated missing user data from legacy directory: ${legacyRoot}`);
    } catch (error) {
      console.warn(`[Main] Failed to migrate legacy user data from ${legacyRoot}:`, error);
    }
  }
};

configureUserDataPath();
initLogger();

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';
const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' ||
  process.env.ELECTRON_ENABLE_LOGGING === 'true';
const disableGpu =
  process.env.IDBOTS_DISABLE_GPU === '1' ||
  process.env.IDBOTS_DISABLE_GPU === 'true' ||
  process.env.ELECTRON_DISABLE_GPU === '1' ||
  process.env.ELECTRON_DISABLE_GPU === 'true';
const disableLinuxSandbox =
  process.env.IDBOTS_DISABLE_LINUX_SANDBOX === '1' ||
  process.env.IDBOTS_DISABLE_LINUX_SANDBOX === 'true';
const reloadOnChildProcessGone =
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === '1' ||
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === 'true';
const TITLEBAR_HEIGHT = 48;
const TITLEBAR_COLORS = {
  dark: { color: '#0F1117', symbolColor: '#E4E5E9' },
  // Align light title bar with app light surface-muted tone to reduce visual contrast.
  light: { color: '#F3F4F6', symbolColor: '#1A1D23' },
} as const;

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeWindowsShellPath = (inputPath: string): string => {
  if (!isWindows) return inputPath;

  const trimmed = inputPath.trim();
  if (!trimmed) return inputPath;

  let normalized = trimmed;
  if (/^file:\/\//i.test(normalized)) {
    normalized = safeDecodeURIComponent(normalized.replace(/^file:\/\//i, ''));
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  const unixDriveMatch = normalized.match(/^[/\\]([A-Za-z])[/\\](.+)$/);
  if (unixDriveMatch) {
    const drive = unixDriveMatch[1].toUpperCase();
    const rest = unixDriveMatch[2].replace(/[/\\]+/g, '\\');
    return `${drive}:\\${rest}`;
  }

  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(1).replace(/\//g, '\\');
    return `${drive}${rest}`;
  }

  return normalized;
};

const EXTERNAL_URL_PROTOCOL_ALLOWLIST = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const REMOTE_FETCH_PROTOCOL_ALLOWLIST = new Set(['http:', 'https:']);

const isAllowedExternalUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    if (!EXTERNAL_URL_PROTOCOL_ALLOWLIST.has(parsed.protocol)) {
      return false;
    }
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const isAllowedRemoteFetchUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return REMOTE_FETCH_PROTOCOL_ALLOWLIST.has(parsed.protocol) && !!parsed.hostname;
  } catch {
    return false;
  }
};

// ==================== macOS Permissions ====================

/**
 * Check calendar permission on macOS by attempting to access Calendar app
 * Returns: 'authorized' | 'denied' | 'restricted' | 'not-determined'
 * On Windows, checks if Outlook is available
 * On Linux, returns 'not-supported'
 */
const checkCalendarPermission = async (): Promise<string> => {
  if (process.platform === 'darwin') {
    try {
      // Try to access Calendar to check permission
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Quick test to see if we can access Calendar
      await execAsync('osascript -l JavaScript -e \'Application("Calendar").name()\'', { timeout: 5000 });
      console.log('[Permissions] macOS Calendar access: authorized');
      return 'authorized';
    } catch (error: any) {
      // Check if it's a permission error
      if (error.stderr?.includes('不能获取对象') ||
          error.stderr?.includes('not authorized') ||
          error.stderr?.includes('Permission denied')) {
        console.log('[Permissions] macOS Calendar access: not-determined (needs permission)');
        return 'not-determined';
      }
      console.warn('[Permissions] Failed to check macOS calendar permission:', error);
      return 'not-determined';
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a system-level calendar permission like macOS
    // Instead, we check if Outlook is available
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Check if Outlook COM object is accessible
      const checkScript = `
        try {
          $Outlook = New-Object -ComObject Outlook.Application
          $Outlook.Version
        } catch { exit 1 }
      `;
      await execAsync('powershell -Command "' + checkScript + '"', { timeout: 10000 });
      console.log('[Permissions] Windows Outlook is available');
      return 'authorized';
    } catch (error) {
      console.log('[Permissions] Windows Outlook not available or not accessible');
      return 'not-determined';
    }
  }

  return 'not-supported';
};

/**
 * Request calendar permission on macOS
 * On Windows, attempts to initialize Outlook COM object
 */
const requestCalendarPermission = async (): Promise<boolean> => {
  if (process.platform === 'darwin') {
    try {
      // On macOS, we trigger permission by trying to access Calendar
      // The system will show permission dialog if needed
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      await execAsync('osascript -l JavaScript -e \'Application("Calendar").calendars()[0].name()\'', { timeout: 10000 });
      return true;
    } catch (error) {
      console.warn('[Permissions] Failed to request macOS calendar permission:', error);
      return false;
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a permission dialog for COM objects
    // We just check if Outlook is available
    const status = await checkCalendarPermission();
    return status === 'authorized';
  }

  return false;
};



// 配置应用
if (isLinux) {
  if (disableLinuxSandbox) {
    app.commandLine.appendSwitch('no-sandbox');
  }
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
if (disableGpu) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // 禁用硬件加速
  app.disableHardwareAcceleration();
}
if (enableVerboseLogging) {
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('v', '1');
}

// 配置网络服务
app.on('ready', () => {
  // 配置网络服务重启策略
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'off'
  });
});

// 添加错误处理
app.on('render-process-gone', (_event, webContents, details) => {
  console.error('Render process gone:', details);
  const shouldReload =
    details.reason === 'crashed' ||
    details.reason === 'killed' ||
    details.reason === 'oom' ||
    details.reason === 'launch-failed' ||
    details.reason === 'integrity-failure';
  if (shouldReload) {
    scheduleReload(`render-process-gone (${details.reason})`, webContents);
  }
});

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details);
  if (reloadOnChildProcessGone && (details.type === 'GPU' || details.type === 'Utility')) {
    scheduleReload(`child-process-gone (${details.type}/${details.reason})`);
  }
});

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

let store: SqliteStore | null = null;
let coworkStore: CoworkStore | null = null;
let mcpStore: McpStore | null = null;
let coworkRunner: CoworkRunner | null = null;
let skillManager: SkillManager | null = null;
let metaAppManager: MetaAppManager | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let scheduledTaskStore: ScheduledTaskStore | null = null;
let metabotStore: MetabotStore | null = null;
let serviceOrderStore: ServiceOrderStore | null = null;
let serviceOrderLifecycleService: ServiceOrderLifecycleService | null = null;
let serviceRefundSyncService: ServiceRefundSyncService | null = null;
let serviceRefundSettlementService: ServiceRefundSettlementService | null = null;
let gigSquareRefundsService: GigSquareRefundsService | null = null;
let gigSquareSchemaReady = false;
let scheduler: Scheduler | null = null;
let metaidRpcServer: ReturnType<typeof startMetaidRpcServer> | null = null;
let idchatPresenceService: IdchatPresenceService | null = null;
let providerDiscoveryService: ProviderDiscoveryService | null = null;
let providerPingService: ProviderPingService | null = null;
let privateChatHistorySyncService: PrivateChatHistorySyncService | null = null;

const listPendingPrivateMessages = (): Array<Record<string, unknown>> => {
  const db = getStore().getDatabase();
  try {
    const result = db.exec(
      `SELECT id, from_global_metaid, from_metaid, to_global_metaid, content, encryption, from_chat_pubkey, chain_timestamp
       FROM private_chat_messages
       WHERE is_processed = 0
       ORDER BY id DESC
       LIMIT 50`
    );
    if (!result[0]?.values?.length) {
      return [];
    }

    const columns = result[0].columns as string[];
    return (result[0].values as unknown[][]).map((row) => (
      columns.reduce((acc: Record<string, unknown>, column, index) => {
        acc[column] = row[index];
        return acc;
      }, {})
    ));
  } catch {
    return [];
  }
};

const listRecentPrivateMessages = (): Array<Record<string, unknown>> => {
  const db = getStore().getDatabase();
  try {
    const result = db.exec(
      `SELECT id, from_global_metaid, from_metaid, to_global_metaid, content, encryption, from_chat_pubkey, chain_timestamp
       FROM private_chat_messages
       ORDER BY id DESC
       LIMIT 200`
    );
    if (!result[0]?.values?.length) {
      return [];
    }

    const columns = result[0].columns as string[];
    return (result[0].values as unknown[][]).map((row) => (
      columns.reduce((acc: Record<string, unknown>, column, index) => {
        acc[column] = row[index];
        return acc;
      }, {})
    ));
  } catch {
    return [];
  }
};

const METAWEB_LISTENER_CONFIG_KEY = 'metaweb_listener_config';

const getListenerConfigFromStore = (): ListenerConfig => {
  const stored = getStore().get<ListenerConfig>(METAWEB_LISTENER_CONFIG_KEY);
  return normalizeListenerConfig(stored);
};

const waitForListenerSocketConnection = async (
  globalMetaId: string,
  timeoutMs: number,
): Promise<boolean> => {
  const normalizedGlobalMetaId = globalMetaId.trim();
  if (!normalizedGlobalMetaId) {
    return false;
  }

  const deadline = Date.now() + Math.max(250, timeoutMs);
  while (Date.now() <= deadline) {
    if (isListenerSocketConnected(normalizedGlobalMetaId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return isListenerSocketConnected(normalizedGlobalMetaId);
};

const startListenerWithConfig = async (config: ListenerConfig) => {
  const sqliteStore = getStore();
  const db = sqliteStore.getDatabase();
  const saveDb = sqliteStore.getSaveFunction();
  const getMetaBots = () =>
    getMetabotStore().listMetabots().map((m) => ({ id: m.id, name: m.name, globalmetaid: m.globalmetaid }));
  const emitLog = (log: string) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('idbots:listener-log', log);
      }
    });
  };
  const resolvePrivateKeyByGlobalMetaId = async (globalMetaId: string): Promise<Buffer | null> => {
    const metabotStore = getMetabotStore();
    const metabot = metabotStore.getMetabotByGlobalMetaId(globalMetaId);
    if (!metabot) return null;
    const wallet = metabotStore.getMetabotWalletByMetabotId(metabot.id);
    if (!wallet?.mnemonic?.trim()) return null;
    return getPrivateKeyBufferForEcdh(
      wallet.mnemonic,
      wallet.path || "m/44'/10001'/0'/0/0"
    );
  };
  await startMetaWebListener(
    db,
    getMetaBots,
    config,
    emitLog,
    saveDb,
    resolvePrivateKeyByGlobalMetaId
  );
};

const ensurePrivateChatListenerReady = async (
  metabotId: number,
  timeoutMs = 5000,
): Promise<{ success: boolean; error?: string }> => {
  const metabot = getMetabotStore().getMetabotById(metabotId);
  const localGlobalMetaId = toSafeString(metabot?.globalmetaid).trim();
  const plan = planPrivateChatListenerReadiness({
    localGlobalMetaId,
    config: getListenerConfigFromStore(),
    hasSocket: hasListenerSocket(localGlobalMetaId),
    isSocketConnected: isListenerSocketConnected(localGlobalMetaId),
  });
  if (!plan.success) {
    return { success: false, error: plan.error };
  }
  if (plan.persistConfig) {
    getStore().set(METAWEB_LISTENER_CONFIG_KEY, plan.config);
  }
  if (plan.shouldStartListener) {
    await startListenerWithConfig(plan.config);
  }
  if (!plan.shouldWaitForConnection) {
    return { success: true };
  }

  const connected = await waitForListenerSocketConnection(
    localGlobalMetaId,
    Math.min(timeoutMs, 5000),
  );
  if (!connected) {
    return {
      success: false,
      error: plan.shouldStartListener
        ? 'Local MetaWeb listener socket did not connect in time'
        : 'Local MetaWeb listener socket is still disconnected',
    };
  }

  return { success: true };
};

const syncP2PRuntimeConfigForCurrentMetabots = async (): Promise<void> => {
  await syncP2PRuntimeConfig({
    store: getStore(),
    metabots: getMetabotStore().listMetabots(),
    configPath: path.join(app.getPath('userData'), 'man-p2p-config.json'),
  });
};
let storeInitPromise: Promise<SqliteStore> | null = null;

const initStore = async (): Promise<SqliteStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    storeInitPromise = SqliteStore.create(app.getPath('userData'));
  }
  return storeInitPromise;
};

const getStore = (): SqliteStore => {
  if (!store) {
    throw new Error('Store not initialized. Call initStore() first.');
  }
  return store;
};

let sqliteRecoveryPromise: Promise<void> | null = null;

const resetSqliteBackedSingletons = async (): Promise<void> => {
  if (coworkRunner) {
    try {
      coworkRunner.stopAllSessions();
    } catch (error) {
      console.warn('[SQLiteRecovery] Failed to stop cowork sessions before reset:', error);
    }
  }
  if (imGatewayManager) {
    await imGatewayManager.stopAll().catch((error) => {
      console.warn('[SQLiteRecovery] Failed to stop IM gateways before reset:', error);
    });
  }
  stopMetaWebListener();
  coworkStore = null;
  mcpStore = null;
  coworkRunner = null;
  imGatewayManager = null;
  scheduledTaskStore = null;
  metabotStore = null;
  serviceOrderStore = null;
  serviceOrderLifecycleService = null;
  serviceRefundSyncService = null;
  serviceRefundSettlementService = null;
  gigSquareRefundsService = null;
  gigSquareSchemaReady = false;
  providerPingService = null;
  privateChatHistorySyncService = null;
};

const restartSqliteBackedDaemons = (input: {
  restartScheduler: boolean;
  restartListener: boolean;
  restartImGateways: boolean;
}): void => {
  try {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    stopCognitiveOrchestrator();
    stopPrivateChatDaemon();

    if (input.restartScheduler) {
      getScheduler().start();
    }

    const skillMgr = getSkillManager();
    startCognitiveOrchestrator(
      getStore().getDatabase(),
      getStore().getSaveFunction(),
      (id: number) => {
        const m = getMetabotStore().getMetabotById(id);
        return m
          ? {
              id: m.id,
              name: m.name,
              role: m.role ?? '',
              soul: m.soul ?? '',
              llm_id: m.llm_id ?? null,
              globalmetaid: m.globalmetaid ?? null,
              metaid: m.metaid,
              boss_global_metaid: m.boss_global_metaid ?? null,
            }
          : null;
      },
      performChatCompletionForOrchestrator,
      async (metabotId: number, groupId: string, nickName: string, content: string) => {
        const encryptedContent = encryptGroupMessageECB(content, groupId);
        const payload = {
          groupId,
          nickName,
          content: encryptedContent,
          contentType: 'text/plain',
          encryption: 'aes',
          timestamp: Date.now(),
        };
        await createPin(getMetabotStore(), metabotId, {
          operation: 'create',
          path: '/protocols/simplegroupchat',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
        });
      },
      {
        getSkillsPromptForIds: (_ids: string[]) =>
          skillMgr.buildAutoRoutingPromptForSkillIds(skillMgr.listSkills().map((s) => s.id)),
        skillsRoots: skillMgr.getAllSkillRoots(),
        runSkillTurnViaCowork: (params) =>
          runOrchestratorSkillTurn(getCoworkRunner(), getCoworkStore(), params),
      }
    );

    startPrivateChatDaemon(
      getStore().getDatabase(),
      getStore().getSaveFunction(),
      getCoworkStore(),
      getMetabotStore(),
      getCoworkRunner(),
      createPin,
      (msg) => console.log(msg),
      getServiceOrderLifecycleService(),
      async ({ skillId, skillName }) => skillMgr.buildAutoRoutingPromptForOrderSkill({ skillId, skillName }),
      (channel, data) => {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            try { win.webContents.send(channel as string, data); } catch { /* ignore */ }
          }
        });
      },
      getListenerConfigFromStore
    );

    if (input.restartListener) {
      const listenerConfig = getListenerConfigFromStore();
      if (shouldRunListener(listenerConfig)) {
        startListenerWithConfig(listenerConfig).catch((listenerError) => {
          console.warn('[SQLiteRecovery] Failed to restart MetaWeb listener:', listenerError);
        });
      }
    }

    if (input.restartImGateways) {
      getIMGatewayManager().startAllEnabled().catch((imError) => {
        console.warn('[SQLiteRecovery] Failed to restart IM gateways:', imError);
      });
    }
  } catch (error) {
    console.warn('[SQLiteRecovery] Failed to restart sqlite-backed daemons:', error);
  }
};

const recoverSqliteStore = async (error: unknown, operationName: string): Promise<void> => {
  if (!sqliteRecoveryPromise) {
    sqliteRecoveryPromise = (async () => {
      console.warn(`[SQLiteRecovery] Recovering after sql.js wasm failure during ${operationName}:`, error);
      const shouldRestartScheduler = Boolean(scheduler);
      const shouldRestartListener = isListenerRunning();
      const shouldRestartImGateways = Boolean(imGatewayManager);
      await resetSqliteBackedSingletons();
      try {
        store?.close();
      } catch (closeError) {
        console.warn('[SQLiteRecovery] Failed to close damaged SQLite database:', closeError);
      }
      SqliteStore.resetSqlJsRuntimeForRecovery();
      storeInitPromise = null;
      store = await initStore();
      setStoreGetter(() => store);
      restartSqliteBackedDaemons({
        restartScheduler: shouldRestartScheduler,
        restartListener: shouldRestartListener,
        restartImGateways: shouldRestartImGateways,
      });
      console.info(`[SQLiteRecovery] SQLite store recovered for ${operationName}.`);
    })().finally(() => {
      sqliteRecoveryPromise = null;
    });
  }
  await sqliteRecoveryPromise;
};

const withSqliteRecovery = <T>(
  operationName: string,
  operation: () => T | Promise<T>,
): Promise<T> => runWithSqliteWasmRecovery(operationName, operation, recoverSqliteStore);

const rethrowSqliteWasmBoundsError = (error: unknown): void => {
  if (isSqliteWasmBoundsError(error)) {
    throw error;
  }
};

const getCoworkStore = () => {
  if (!coworkStore) {
    const sqliteStore = getStore();
    coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
    const cleaned = coworkStore.autoDeleteNonPersonalMemories();
    if (cleaned > 0) {
      console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
    }
  }
  return coworkStore;
};

const getMcpStore = () => {
  if (!mcpStore) {
    const sqliteStore = getStore();
    mcpStore = new McpStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return mcpStore;
};

// ---------------------------------------------------------------------------
// Delegation pipeline — orchestrates handshake, payment, order, A2A, blocking
// ---------------------------------------------------------------------------

/**
 * Broadcast a delegation state change event to all renderer windows.
 */
const emitDelegationStateChange = (data: {
  sessionId: string;
  blocking: boolean;
  orderId?: string;
  message?: string;
}) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('cowork:delegation:stateChange', data);
      } catch { /* ignore */ }
    }
  });
};

/**
 * Inject a system message into a cowork session and forward it to all
 * renderer windows so it appears in the chat immediately.
 */
const injectDelegationSystemMessage = (sessionId: string, content: string) => {
  const coworkStoreInst = getCoworkStore();
  const message = coworkStoreInst.addMessage(sessionId, {
    type: 'system',
    content,
  });
  const safeMessage = sanitizeCoworkMessageForIpc(message);
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage });
      } catch { /* ignore */ }
    }
  });
};

/**
 * Resolve the ECDH chat pubkey for a given provider globalMetaId.
 * This mirrors the logic in the `gigSquare:fetchProviderInfo` handler.
 */
const resolveChatPubkeyForProvider = async (
  providerGlobalMetaId: string,
  providerMetaId?: string
): Promise<string | null> => {
  // First try fetching info directly
  let chatPubkey: string | null = null;
  try {
    const info = await fetchMetaidInfoByMetaid(providerGlobalMetaId);
    chatPubkey = toSafeString(info?.chatpubkey).trim() || null;
  } catch { /* ignore */ }

  if (chatPubkey) return chatPubkey;

  // Fall back to searching /info/chatpubkey pins
  const buildUrl = (metaid: string | null, size: number) => {
    const url = new URL('https://manapi.metaid.io/pin/path/list');
    url.searchParams.set('path', GIG_SQUARE_CHATPUBKEY_PATH);
    url.searchParams.set('size', String(size));
    if (metaid) {
      url.searchParams.set('metaid', metaid);
    }
    return url.toString();
  };

  const fetchList = async (url: string) => {
    const localPath = `/api/pin/path/list${new URL(url).search}`;
    const response = await fetchJsonWithFallbackOnMiss(localPath, url, isEmptyListDataPayload);
    if (!response.ok) return [];
    const json = await response.json();
    return Array.isArray(json?.data?.list) ? json.data.list : [];
  };

  const candidates = [providerMetaId, providerGlobalMetaId].filter(Boolean) as string[];
  for (const metaid of candidates) {
    const list = await fetchList(buildUrl(metaid, 20));
    chatPubkey = extractChatPubkeyFromList(list, metaid);
    if (chatPubkey) return chatPubkey;
  }

  // Broader search without metaid filter
  const list = await fetchList(buildUrl(null, 200));
  const matchId = providerMetaId || providerGlobalMetaId || '';
  chatPubkey = extractChatPubkeyFromList(list, matchId);
  return chatPubkey;
};

/**
 * Execute the full delegation pipeline when the LLM emits [DELEGATE_REMOTE_SERVICE].
 *
 * Steps:
 * 1. Resolve service from provider discovery available services
 * 2. PING/PONG handshake with the provider
 * 3. Execute payment
 * 4. Build & send encrypted ORDER message via createPin
 * 5. Create buyer order record
 * 6. Enter delegation blocking mode
 */
const executeDelegationPipeline = async (
  sessionId: string,
  delegation: DelegationRequest
): Promise<void> => {
  const LOG_TAG = '[DelegationPipeline]';

  const coworkStoreInst = getCoworkStore();

  // -----------------------------------------------------------------------
  // Step 0: Resolve session context (metabotId, wallet, etc.)
  // -----------------------------------------------------------------------
  const session = coworkStoreInst.getSession(sessionId);
  if (!session) {
    console.error(LOG_TAG, 'Session not found:', sessionId);
    return;
  }

  const metabotId = session.metabotId;
  if (metabotId == null || typeof metabotId !== 'number') {
    injectDelegationSystemMessage(sessionId, `Delegation failed: no MetaBot associated with this session.`);
    return;
  }

  const metabotStore = getMetabotStore();
  const metabot = metabotStore.getMetabotById(metabotId);
  if (!metabot) {
    injectDelegationSystemMessage(sessionId, `Delegation failed: MetaBot #${metabotId} not found.`);
    return;
  }

  const wallet = metabotStore.getMetabotWalletByMetabotId(metabotId);
  if (!wallet?.mnemonic?.trim()) {
    injectDelegationSystemMessage(sessionId, `Delegation failed: MetaBot wallet mnemonic is missing.`);
    return;
  }

  // -----------------------------------------------------------------------
  // Step 1: Resolve service from provider discovery available services
  // -----------------------------------------------------------------------
  const pollingService = getProviderDiscoveryService();
  const orderability = resolveDelegationOrderability({
    availableServices: pollingService.availableServices,
    allServices: listCurrentRemoteGigSquareServices(),
    servicePinId: delegation.servicePinId,
    providerGlobalMetaId: delegation.providerGlobalMetaid,
  });

  if (orderability.status === 'missing') {
    console.warn(LOG_TAG, 'Service not found in available services or DB');
    injectDelegationSystemMessage(
      sessionId,
      `Delegation failed: Service "${delegation.serviceName}" (${delegation.servicePinId}) not found.`
    );
    return;
  }

  if (orderability.status === 'offline' || !orderability.service) {
    console.warn(LOG_TAG, 'Service exists in DB but is not currently orderable');
    injectDelegationSystemMessage(
      sessionId,
      `Provider for "${delegation.serviceName}" appears offline. The service was not found in available online services. Please try again later.`
    );
    return;
  }

  const service = orderability.service;
  if (!service) {
    return;
  }

  const rawOrderRequest = normalizeOrderRawRequest(delegation.rawRequest)
    || normalizeOrderRawRequest(delegation.taskContext)
    || normalizeOrderRawRequest(delegation.userTask);
  if (rawOrderRequest.length > ORDER_RAW_REQUEST_MAX_CHARS) {
    injectDelegationSystemMessage(
      sessionId,
      `Delegation cancelled: the request is too long. Keep it within ${ORDER_RAW_REQUEST_MAX_CHARS} characters, or use an attachment/file-based input instead.`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Request too long' });
    return;
  }

  const providerGlobalMetaId = toSafeString(service.providerGlobalMetaId || service.globalMetaId).trim();

  // -----------------------------------------------------------------------
  // Step 1b: Self-order guard — reject before payment if buyer === provider
  // -----------------------------------------------------------------------
  const buyerGlobalMetaId = (metabot.globalmetaid || '').trim();
  if (buyerGlobalMetaId && providerGlobalMetaId && buyerGlobalMetaId === providerGlobalMetaId) {
    injectDelegationSystemMessage(
      sessionId,
      `Delegation rejected: a MetaBot cannot order its own service. Provider "${delegation.serviceName}" belongs to the same MetaBot.`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Self-order rejected' });
    return;
  }

  const serviceOrderLifecycle = getServiceOrderLifecycleService();
  // -----------------------------------------------------------------------
  // Step 2: PING/PONG handshake
  // -----------------------------------------------------------------------
  injectDelegationSystemMessage(
    sessionId,
    `Checking availability of "${delegation.serviceName}" provider...`
  );
  emitDelegationStateChange({ sessionId, blocking: false, message: 'Pinging provider...' });

  const listenerReady = await ensurePrivateChatListenerReady(metabotId, 5000);
  if (!listenerReady.success) {
    injectDelegationSystemMessage(
      sessionId,
      `Delegation failed: ${listenerReady.error || 'Local MetaWeb listener is not connected.'}`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Listener offline' });
    return;
  }

  let chatPubkey: string | null = null;
  try {
    chatPubkey = await resolveChatPubkeyForProvider(
      providerGlobalMetaId,
      toSafeString(service.providerMetaId).trim() || undefined
    );
  } catch (error) {
    console.warn(LOG_TAG, 'Failed to resolve chat pubkey:', error);
  }

  if (!chatPubkey) {
    injectDelegationSystemMessage(
      sessionId,
      `Delegation failed: Could not resolve chat pubkey for provider "${delegation.serviceName}".`
    );
    pollingService.markOffline(providerGlobalMetaId);
    return;
  }

  let pongReceived = false;
  try {
    pongReceived = await getProviderPingService().pingProvider({
      metabotId,
      toGlobalMetaId: providerGlobalMetaId,
      toChatPubkey: chatPubkey,
      timeoutMs: 15000,
      allowOnlineFallback: true,
    });
  } catch (error) {
    console.error(LOG_TAG, 'PING/PONG handshake failed:', error);
    pongReceived = false;
  }

  if (!pongReceived) {
    pollingService.markOffline(providerGlobalMetaId);
    injectDelegationSystemMessage(
      sessionId,
      `Provider for "${delegation.serviceName}" is not responding (PONG timeout). Marked offline. Please try an alternative service or try again later.`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Provider offline' });
    return;
  }

  // -----------------------------------------------------------------------
  // Step 3: Execute payment
  // -----------------------------------------------------------------------
  const rawPrice = delegation.price || service.price || '0';
  const rawCurrency = delegation.currency || service.currency || 'SPACE';
  const delegationSettlement = resolveDelegationSettlement({
    rawPrice,
    rawCurrency,
    service: {
      currency: toSafeString(service.currency).trim(),
      settlementKind: toSafeString(service.settlementKind).trim(),
      paymentChain: toSafeString(service.paymentChain).trim(),
      mrc20Ticker: toSafeString(service.mrc20Ticker).trim(),
      mrc20Id: toSafeString(service.mrc20Id).trim(),
    },
  });
  const price = delegationSettlement.price || '0';
  const normalizedCurrency = delegationSettlement.displayCurrency;

  if (!isDelegationPriceNumeric(price)) {
    injectDelegationSystemMessage(
      sessionId,
      `Delegation payment failed before broadcast: invalid amount format "${rawPrice}". No payment was sent, and the delegation has been cancelled.`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Invalid payment amount' });
    return;
  }

  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    injectDelegationSystemMessage(
      sessionId,
      `Delegation payment failed before broadcast: invalid amount format "${rawPrice}". No payment was sent, and the delegation has been cancelled.`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Invalid payment amount' });
    return;
  }

  const isFreeDelegation = numericPrice === 0;
  const paymentChain = delegationSettlement.paymentChain as TransferChain;
  let paymentTxid = isFreeDelegation ? generateSyntheticOrderTxid() : '';
  let paymentCommitTxid: string | null = null;
  const formatPaymentFailureMessage = (errorMsg: string): string => (
    /decimalerror|invalid argument/i.test(errorMsg)
      ? `Delegation payment failed before broadcast: ${errorMsg}. No payment was sent, and the delegation has been cancelled.`
      : `Delegation payment failed: ${errorMsg}. The delegation has been cancelled before the service order was sent.`
  );

  if (isFreeDelegation) {
    injectDelegationSystemMessage(
      sessionId,
      `Free service detected (${price} ${normalizedCurrency}). Skipping payment and sending service order...`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Sending order...' });
  } else {
    const paymentAddress = toSafeString(service.paymentAddress || service.providerAddress || service.address).trim();
    if (!paymentAddress) {
      injectDelegationSystemMessage(sessionId, `Delegation failed: No payment address found for provider.`);
      return;
    }

    injectDelegationSystemMessage(
      sessionId,
      `Sending payment of ${price} ${normalizedCurrency} to provider...`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Processing payment...' });

    try {
      const feeRate = await resolveTransferFeeRate(paymentChain);
      if (delegationSettlement.paymentMode === 'mrc20') {
        const mrc20Id = String(delegationSettlement.mrc20Id || '').trim();
        if (!mrc20Id) {
          injectDelegationSystemMessage(
            sessionId,
            'Delegation payment failed before broadcast: missing MRC20 asset identity. No payment was sent, and the delegation has been cancelled.'
          );
          emitDelegationStateChange({ sessionId, blocking: false, message: 'Missing MRC20 asset' });
          return;
        }
        const assets = await getMetabotWalletAssets(metabotStore, {
          metabotId,
        });
        const asset = assets.mrc20Assets.find((candidate) => candidate.mrc20Id === mrc20Id);
        if (!asset) {
          injectDelegationSystemMessage(
            sessionId,
            `Delegation payment failed before broadcast: MRC20 asset ${mrc20Id} is unavailable in the current wallet. No payment was sent, and the delegation has been cancelled.`
          );
          emitDelegationStateChange({ sessionId, blocking: false, message: 'MRC20 asset unavailable' });
          return;
        }

        const transferResult = await executeTokenTransferService(metabotStore, {
          kind: 'mrc20',
          metabotId,
          asset,
          toAddress: paymentAddress,
          amount: price,
          feeRate,
        });
        paymentTxid = transferResult.revealTxId || transferResult.txId || '';
        paymentCommitTxid = transferResult.commitTxId || null;
      } else {
        const transferResult = await executeTransfer(metabotStore, {
          metabotId,
          chain: paymentChain,
          toAddress: paymentAddress,
          amountSpaceOrDoge: price,
          feeRate,
        });

        if (!transferResult.success) {
          const errorMsg = (transferResult as { success: false; error: string }).error || 'Payment failed';
          injectDelegationSystemMessage(
            sessionId,
            formatPaymentFailureMessage(errorMsg)
          );
          emitDelegationStateChange({ sessionId, blocking: false, message: 'Payment failed' });
          return;
        }

        paymentTxid = (transferResult as { success: true; txId: string }).txId;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown payment error';
      injectDelegationSystemMessage(
        sessionId,
        formatPaymentFailureMessage(errorMsg)
      );
      emitDelegationStateChange({ sessionId, blocking: false, message: 'Payment error' });
      return;
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Build ORDER message, ECDH encrypt, send via createPin
  // -----------------------------------------------------------------------
  if (!isFreeDelegation) {
    injectDelegationSystemMessage(
      sessionId,
      `Payment confirmed (tx: ${paymentTxid.slice(0, 12)}...). Sending service order to provider...`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Sending order...' });
  }

  const orderPayload = buildDelegationOrderPayloadFromSettlement({
    rawRequest: rawOrderRequest,
    taskContext: delegation.taskContext,
    userTask: delegation.userTask,
    serviceName: delegation.serviceName || service.serviceName || service.displayName,
    providerSkill: toSafeString(service.providerSkill).trim(),
    servicePinId: delegation.servicePinId,
    paymentTxid: isFreeDelegation ? '' : paymentTxid,
    paymentCommitTxid: isFreeDelegation ? null : paymentCommitTxid,
    orderReference: isFreeDelegation ? paymentTxid : '',
    settlement: delegationSettlement,
  });

  let buyerObserverSessionId: string | null = null;
  try {
    const observerSession = await ensureBuyerOrderObserverSession(coworkStoreInst, {
      metabotId,
      peerGlobalMetaId: providerGlobalMetaId,
      peerName: toSafeString(service.providerMetaBot || service.providerName).trim() || null,
      peerAvatar: toSafeString(service.avatar).trim() || null,
      serviceId: delegation.servicePinId,
      servicePrice: price,
      serviceCurrency: normalizedCurrency,
      servicePaymentChain: delegationSettlement.paymentChain,
      serviceSettlementKind: delegationSettlement.settlementKind,
      serviceMrc20Ticker: delegationSettlement.mrc20Ticker,
      serviceMrc20Id: delegationSettlement.mrc20Id,
      servicePaymentCommitTxid: paymentCommitTxid,
      serviceSkill: toSafeString(service.providerSkill).trim() || delegation.serviceName || null,
      serverBotGlobalMetaId: providerGlobalMetaId,
      servicePaidTx: paymentTxid,
      orderPayload,
    });
    buyerObserverSessionId = observerSession.coworkSessionId;
    if (observerSession.initialMessage) {
      emitCoworkStreamMessage(observerSession.coworkSessionId, observerSession.initialMessage);
    }
  } catch (error) {
    console.warn(LOG_TAG, 'Failed to create buyer observer session:', error);
  }

  let orderPinId: string | null = null;
  try {
    const privateKeyBuffer = await getPrivateKeyBufferForEcdh(
      wallet.mnemonic,
      wallet.path || "m/44'/10001'/0'/0/0"
    );
    const sharedSecret = computeEcdhSharedSecretSha256(privateKeyBuffer, chatPubkey);
    const encrypted = ecdhEncrypt(orderPayload, sharedSecret);
    const payloadStr = buildPrivateMessagePayload(providerGlobalMetaId, encrypted, '');

    const result = await createPin(metabotStore, metabotId, {
      operation: 'create',
      path: '/protocols/simplemsg',
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: payloadStr,
    });

    orderPinId = result.pinId ?? null;
  } catch (error) {
    console.error(LOG_TAG, 'Failed to send ORDER message:', error);
    if (buyerObserverSessionId) {
      const failureMessage = coworkStoreInst.addMessage(buyerObserverSessionId, {
        type: 'system',
        content: isFreeDelegation
          ? `系统提示：免费服务订单发送失败。订单标识：${paymentTxid}。请稍后重试。`
          : `系统提示：支付已完成，但服务订单发送失败。付款 txid：${paymentTxid}。请稍后重试或联系服务方处理退款。`,
        metadata: {
          sourceChannel: 'metaweb_order',
          refreshSessionSummary: true,
        },
      });
      emitCoworkStreamMessage(buyerObserverSessionId, failureMessage);
    }
    injectDelegationSystemMessage(
      sessionId,
      isFreeDelegation
        ? `Failed to send free order to provider. No payment transaction was required.`
        : `Failed to send order to provider. Payment was sent (tx: ${paymentTxid}). Please contact support if funds are not returned.`
    );
    emitDelegationStateChange({ sessionId, blocking: false, message: 'Order send failed' });
    return;
  }

  // -----------------------------------------------------------------------
  // Step 5: Create buyer order via ServiceOrderLifecycleService
  // -----------------------------------------------------------------------
    let orderId = '';
    try {
      const order = serviceOrderLifecycle.createBuyerOrder({
        localMetabotId: metabotId,
        counterpartyGlobalMetaId: providerGlobalMetaId,
        servicePinId: delegation.servicePinId,
        serviceName: delegation.serviceName || delegation.servicePinId,
        paymentTxid,
        paymentChain: delegationSettlement.paymentChain,
        paymentAmount: price,
        paymentCurrency: normalizedCurrency,
        settlementKind: delegationSettlement.settlementKind,
        mrc20Ticker: delegationSettlement.mrc20Ticker || undefined,
        mrc20Id: delegationSettlement.mrc20Id || undefined,
        paymentCommitTxid: paymentCommitTxid || undefined,
        coworkSessionId: sessionId,
        orderMessagePinId: orderPinId,
      });
      orderId = order.id;
    } catch (error) {
      if (
        error instanceof ServiceOrderOpenOrderExistsError ||
        error instanceof ServiceOrderSelfOrderNotAllowedError
      ) {
        console.warn(LOG_TAG, 'Order creation blocked:', error.message);
        injectDelegationSystemMessage(
          sessionId,
          isFreeDelegation
            ? `Order creation failed: ${error.message}. Free order id: ${paymentTxid}`
            : `Order creation failed: ${error.message}. Payment tx: ${paymentTxid}`
        );
        emitDelegationStateChange({ sessionId, blocking: false, message: 'Order creation failed' });
        return;
      }
      console.error(LOG_TAG, 'Failed to create buyer order:', error);
      injectDelegationSystemMessage(
        sessionId,
        isFreeDelegation
          ? `Order tracking failed for free order (${paymentTxid}). Service should still be delivered.`
          : `Order tracking failed (payment was sent, tx: ${paymentTxid}). Service should still be delivered.`
      );
      // Continue to blocking mode even if order tracking failed — the order was sent
    }

    // -----------------------------------------------------------------------
    // Step 6: Enter delegation blocking mode
    // -----------------------------------------------------------------------
    coworkStoreInst.setDelegationBlocking(sessionId, true, orderId || paymentTxid);

    const paymentLine = isFreeDelegation
      ? `Payment: free service (${price} ${normalizedCurrency}), no transaction required.`
      : (() => {
        const txLink = buildTransactionExplorerUrl(paymentChain, paymentTxid);
        return txLink
          ? `Payment: ${paymentTxid.slice(0, 16)}... | [View transaction](${txLink})`
          : `Payment: ${paymentTxid.slice(0, 16)}...`;
      })();
    injectDelegationSystemMessage(
      sessionId,
      `Order sent to "${delegation.serviceName}" provider. Waiting for delivery...\n${paymentLine}`
    );

    emitDelegationStateChange({
      sessionId,
      blocking: true,
      orderId: orderId || paymentTxid,
      message: `Waiting for delivery from "${delegation.serviceName}"`,
    });
};

const getCoworkRunner = () => {
  if (!coworkRunner) {
    coworkRunner = new CoworkRunner(getCoworkStore(), {
      getSkillSessionEnvOverrides: async (sessionId: string): Promise<Record<string, string>> => {
        const session = getCoworkStore().getSession(sessionId);
        const overrides: Record<string, string> = {};
        if (session?.title === '[Orchestrator] skill-turn' && session.cwd) {
          overrides.SKILLS_ROOT = session.cwd;
          overrides.IDBOTS_SKILLS_ROOT = session.cwd;
        }
        const skillIds = session?.activeSkillIds ?? [];
        const metabotStore = getMetabotStore();
        const metabotId = session?.metabotId;
        const metabot =
          metabotId != null && typeof metabotId === 'number'
            ? metabotStore.getMetabotById(metabotId)
            : null;
        Object.assign(
          overrides,
          buildImageSkillEnvOverrides({
            activeSkillIds: skillIds,
            metabotLlmId: metabot?.llm_id ?? null,
            appConfig: getStore().get('app_config'),
            processEnv: process.env,
          })
        );
        if (metabotId != null && typeof metabotId === 'number') {
          const wallet = metabot ? metabotStore.getMetabotWalletByMetabotId(metabotId) : null;
          if (metabot && wallet) {
            Object.assign(overrides, {
              IDBOTS_METABOT_ID: String(metabotId),
              IDBOTS_METABOT_MNEMONIC: wallet.mnemonic,
              IDBOTS_TWIN_NAME: metabot.name,
              IDBOTS_METABOT_PATH: wallet.path,
              IDBOTS_RPC_URL: getMetaidRpcBase(),
            });
            if (metabot.globalmetaid) {
              overrides.IDBOTS_METABOT_GLOBALMETAID = metabot.globalmetaid;
            }
            if (metabot.mvc_address) {
              overrides.IDBOTS_METABOT_MVC_ADDRESS = metabot.mvc_address;
            }
            if (metabot.btc_address) {
              overrides.IDBOTS_METABOT_BTC_ADDRESS = metabot.btc_address;
            }
            if (metabot.doge_address) {
              overrides.IDBOTS_METABOT_DOGE_ADDRESS = metabot.doge_address;
            }
            return overrides;
          }
        }
        const twin = metabotStore.getTwinWallet();
        if (!twin && Object.keys(overrides).length === 0) return overrides;
        if (twin) {
          Object.assign(overrides, {
            IDBOTS_METABOT_ID: String(twin.id),
            IDBOTS_METABOT_MNEMONIC: twin.mnemonic,
            IDBOTS_TWIN_NAME: twin.name,
            IDBOTS_METABOT_PATH: twin.path,
            IDBOTS_RPC_URL: getMetaidRpcBase(),
          });
          const twinMetabot = metabotStore.getMetabotById(twin.id);
          if (twinMetabot?.globalmetaid) {
            overrides.IDBOTS_METABOT_GLOBALMETAID = twinMetabot.globalmetaid;
          }
          if (twinMetabot?.mvc_address) {
            overrides.IDBOTS_METABOT_MVC_ADDRESS = twinMetabot.mvc_address;
          }
          if (twinMetabot?.btc_address) {
            overrides.IDBOTS_METABOT_BTC_ADDRESS = twinMetabot.btc_address;
          }
          if (twinMetabot?.doge_address) {
            overrides.IDBOTS_METABOT_DOGE_ADDRESS = twinMetabot.doge_address;
          }
        }
        return overrides;
      },
      getRemoteServicesPrompt: () => {
        try {
          const services = getProviderDiscoveryService().getDiscoverySnapshot().availableServices;
          return getSkillManager().buildRemoteServicesPrompt(services);
        } catch { return null; }
      },
      mcpServerProvider: () => getMcpStore().getEnabledServers(),
      getMetabotById: (id: number) => {
        const m = getMetabotStore().getMetabotById(id);
        return m ? { name: m.name, role: m.role, soul: m.soul, background: m.background ?? null, goal: m.goal ?? null } : null;
      },
      openMetaApp: async (input) => {
        return openMetaApp({
          appId: input.appId,
          targetPath: input.targetPath,
          manager: getMetaAppManager(),
          ensureServerReady: ensureMetaAppServerReady,
          shellOpenExternal: shell.openExternal,
        });
      },
      resolveMetaAppUrl: async (input) => {
        return resolveMetaAppUrl({
          appId: input.appId,
          targetPath: input.targetPath,
          manager: getMetaAppManager(),
          ensureServerReady: ensureMetaAppServerReady,
        });
      },
    });

    // Set up event listeners to forward to renderer
    coworkRunner.on('message', (sessionId: string, message: any) => {
      const safeMessage = sanitizeCoworkMessageForIpc(message);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage });
          } catch (error) {
            console.error('Failed to forward cowork message:', error);
          }
        }
      });
    });

    coworkRunner.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
      const safeContent = truncateIpcString(content, IPC_UPDATE_CONTENT_MAX_CHARS);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:messageUpdate', { sessionId, messageId, content: safeContent });
          } catch (error) {
            console.error('Failed to forward cowork message update:', error);
          }
        }
      });
    });

    coworkRunner.on('permissionRequest', (sessionId: string, request: any) => {
      if (coworkRunner?.getSessionConfirmationMode(sessionId) === 'text') {
        return;
      }
      const safeRequest = sanitizePermissionRequestForIpc(request);
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('cowork:stream:permission', { sessionId, request: safeRequest });
          } catch (error) {
            console.error('Failed to forward cowork permission request:', error);
          }
        }
      });
    });

    coworkRunner.on('complete', (sessionId: string, claudeSessionId: string | null) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:stream:complete', { sessionId, claudeSessionId });
        }
      });
    });

    coworkRunner.on('error', (sessionId: string, error: string) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:stream:error', { sessionId, error });
        }
      });
    });

    // Handle delegation requests from the LLM
    coworkRunner.on('delegation:requested', (sessionId: string, delegation: DelegationRequest) => {
      // Execute the full delegation pipeline asynchronously.
      // Errors are handled inside the pipeline; we catch here as a safety net.
      executeDelegationPipeline(sessionId, delegation).catch((error) => {
        console.error('[CoworkRunner] Delegation pipeline unhandled error:', error);
        injectDelegationSystemMessage(
          sessionId,
          `Delegation pipeline encountered an unexpected error: ${error instanceof Error ? error.message : String(error)}`
        );
        emitDelegationStateChange({ sessionId, blocking: false, message: 'Pipeline error' });
      });
    });
  }
  return coworkRunner;
};

const getSkillManager = () => {
  if (!skillManager) {
    skillManager = new SkillManager(getStore);
  }
  return skillManager;
};

const getMetaAppManager = () => {
  if (!metaAppManager) {
    metaAppManager = new MetaAppManager();
  }
  return metaAppManager;
};

const getIMGatewayManager = () => {
  if (!imGatewayManager) {
    const sqliteStore = getStore();

    // Get Cowork dependencies for IM Cowork mode
    const runner = getCoworkRunner();
    const store = getCoworkStore();

    imGatewayManager = new IMGatewayManager(
      sqliteStore.getDatabase(),
      sqliteStore.getSaveFunction(),
      {
        coworkRunner: runner,
        coworkStore: store,
      }
    );

    // Initialize with LLM config provider
    imGatewayManager.initialize({
      getLLMConfig: async () => {
        const appConfig = sqliteStore.get<any>('app_config');
        if (!appConfig) return null;

        // Find first enabled provider
        const providers = appConfig.providers || {};
        for (const [providerName, providerConfig] of Object.entries(providers) as [string, any][]) {
          if (providerConfig.enabled && providerConfig.apiKey) {
            const model = providerConfig.models?.[0]?.id;
            return {
              apiKey: providerConfig.apiKey,
              baseUrl: providerConfig.baseUrl,
              model: model,
              provider: providerName,
            };
          }
        }

        // Fallback to legacy api config
        if (appConfig.api?.key) {
          return {
            apiKey: appConfig.api.key,
            baseUrl: appConfig.api.baseUrl,
            model: appConfig.model?.defaultModel,
          };
        }

        return null;
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });

    // Forward IM events to renderer
    imGatewayManager.on('statusChange', (status) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:status:change', status);
        }
      });
    });

    imGatewayManager.on('message', (message) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('im:message:received', message);
        }
      });
    });

    imGatewayManager.on('error', ({ platform, error }) => {
      console.error(`[IM Gateway] ${platform} error:`, error);
    });
  }
  return imGatewayManager;
};

const getScheduledTaskStore = () => {
  if (!scheduledTaskStore) {
    const sqliteStore = getStore();
    scheduledTaskStore = new ScheduledTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return scheduledTaskStore;
};

const getMetabotStore = () => {
  if (!metabotStore) {
    const sqliteStore = getStore();
    metabotStore = new MetabotStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  }
  return metabotStore;
};

function getIdchatPresenceService(): IdchatPresenceService {
  if (!idchatPresenceService) {
    idchatPresenceService = new IdchatPresenceService();
  }
  return idchatPresenceService;
}

function getProviderDiscoveryService(): ProviderDiscoveryService {
  if (!providerDiscoveryService) {
    providerDiscoveryService = new ProviderDiscoveryService({
      presence: getIdchatPresenceService(),
      fetchP2PPresence: () => fetchLocalPresenceSnapshot(getP2PLocalBase()),
    });
    providerDiscoveryService.subscribe((snapshot) => {
      emitProviderDiscoveryChanged(snapshot);
    });
  }
  return providerDiscoveryService;
}

function getProviderPingService(): ProviderPingService {
  if (!providerPingService) {
    providerPingService = new ProviderPingService({
      getWallet: (metabotId) => getMetabotStore().getMetabotWalletByMetabotId(metabotId),
      getLocalGlobalMetaId: (metabotId) => getMetabotStore().getMetabotById(metabotId)?.globalmetaid ?? null,
      derivePrivateKeyBuffer: (mnemonic, derivationPath) => getPrivateKeyBufferForEcdh(mnemonic, derivationPath),
      computeSharedSecretSha256: (privateKeyBuffer, peerPubkey) => computeEcdhSharedSecretSha256(privateKeyBuffer, peerPubkey),
      computeSharedSecret: (privateKeyBuffer, peerPubkey) => computeEcdhSharedSecret(privateKeyBuffer, peerPubkey),
      encrypt: (plainText, sharedSecret) => ecdhEncrypt(plainText, sharedSecret),
      decrypt: (cipherText, sharedSecret) => ecdhDecrypt(cipherText, sharedSecret),
      buildPrivateMessagePayload,
      createPin: async (metabotId, payload) => {
        await createPin(getMetabotStore(), metabotId, {
          operation: 'create',
          path: '/protocols/simplemsg',
          encryption: '0',
          version: '1.0.0',
          contentType: 'application/json',
          payload,
        });
      },
      listPendingMessages: () => listPendingPrivateMessages(),
      listRecentMessages: () => listRecentPrivateMessages(),
      syncConversationMessages: async ({ metabotId, otherGlobalMetaId, unprocessedAfterTimestampSec }) => {
        const localGlobalMetaId = toSafeString(
          getMetabotStore().getMetabotById(metabotId)?.globalmetaid,
        ).trim();
        const peerGlobalMetaId = toSafeString(otherGlobalMetaId).trim();
        if (!localGlobalMetaId || !peerGlobalMetaId) {
          return;
        }

        const messages = await getPrivateChatHistorySyncService().fetchRecentConversationMessages({
          metaId: localGlobalMetaId,
          otherMetaId: peerGlobalMetaId,
          lookback: 64,
        });

        storePrivateChatHistoryMessages({
          db: getStore().getDatabase(),
          saveDb: getStore().getSaveFunction(),
          messages,
          unprocessedAfterTimestampSec,
        });
      },
      isProviderOnline: (providerGlobalMetaId) => {
        const normalizedGlobalMetaId = toSafeString(providerGlobalMetaId).trim();
        if (!normalizedGlobalMetaId) {
          return false;
        }
        const snapshot = getProviderDiscoveryService().getDiscoverySnapshot();
        return Object.prototype.hasOwnProperty.call(snapshot.onlineBots, normalizedGlobalMetaId);
      },
    });
  }
  return providerPingService;
}

function getPrivateChatHistorySyncService(): PrivateChatHistorySyncService {
  if (!privateChatHistorySyncService) {
    privateChatHistorySyncService = new PrivateChatHistorySyncService();
  }
  return privateChatHistorySyncService;
}

const getServiceOrderStore = () => {
  if (!serviceOrderStore) {
    const sqliteStore = getStore();
    serviceOrderStore = new ServiceOrderStore(
      sqliteStore.getDatabase(),
      sqliteStore.getSaveFunction()
    );
  }
  return serviceOrderStore;
};

const getServiceOrderLifecycleService = () => {
  if (!serviceOrderLifecycleService) {
    serviceOrderLifecycleService = new ServiceOrderLifecycleService(
      getServiceOrderStore(),
      {
        resolveLocalMetabotGlobalMetaId: (localMetabotId) => {
          const metabot = getMetabotStore().getMetabotById(localMetabotId);
          return metabot?.globalmetaid ?? null;
        },
        buildRefundRequestPayload: (order) => {
          const metabot = getMetabotStore().getMetabotById(order.localMetabotId);
          if (!metabot?.globalmetaid?.trim()) {
            throw new Error(`Missing buyer globalmetaid for refund request order=${order.id}`);
          }
          const refundToAddress = getRefundAddressForOrder(metabot, order.paymentChain);
          if (!refundToAddress) {
            throw new Error(`Missing refund address for order=${order.id} chain=${order.paymentChain}`);
          }

          return buildRefundRequestPayload({
            paymentTxid: order.paymentTxid,
            servicePinId: order.servicePinId,
            serviceName: order.serviceName,
            refundAmount: order.paymentAmount,
            refundCurrency: order.paymentCurrency,
            paymentChain: order.paymentChain,
            settlementKind: order.settlementKind,
            mrc20Ticker: order.mrc20Ticker,
            mrc20Id: order.mrc20Id,
            paymentCommitTxid: order.paymentCommitTxid,
            refundToAddress,
            buyerGlobalMetaId: metabot.globalmetaid,
            sellerGlobalMetaId: order.counterpartyGlobalMetaid,
            orderMessagePinId: order.orderMessagePinId,
            failureReason: order.failureReason ?? 'delivery_timeout',
            failureDetectedAt: Math.floor((order.failedAt ?? Date.now()) / 1000),
            reasonComment: '服务超时',
            evidencePinIds: [
              order.orderMessagePinId,
              order.deliveryMessagePinId,
            ].filter(Boolean),
          });
        },
        createRefundRequestPin: async ({ order, payload }) => {
          const result = await createPin(getMetabotStore(), order.localMetabotId, {
            operation: 'create',
            path: '/protocols/service-refund-request',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
          });
          return {
            pinId: result.pinId ?? result.txids?.[0] ?? null,
            txid: result.txids?.[0] ?? null,
          };
        },
        onOrderEvent: async ({ type, order }) => {
          if (type === 'refund_requested') {
            await recoverMissingRefundPendingOrderObserverSessions().catch((error) => {
              console.warn('[ServiceOrder] Failed to recover refund observer sessions', error);
            });
          }
          publishServiceOrderEventToCowork(type, order);
        },
      }
    );
  }
  return serviceOrderLifecycleService;
};

const repairSelfDirectedServiceOrders = (): void => {
  getServiceOrderLifecycleService().repairSelfDirectedOrders();
};

async function fetchRefundRequestPinsFromIndexer(): Promise<Array<{ pinId: string; content: unknown; timestampMs?: number | null }>> {
  return fetchProtocolPinsFromIndexer(SERVICE_REFUND_REQUEST_PATH, {
    pageSize: SERVICE_REFUND_SYNC_SIZE,
    maxPages: SERVICE_REFUND_SYNC_MAX_PAGES,
    selectContent: selectProtocolPinContent,
  });
}

async function fetchRefundFinalizePinsFromIndexer(): Promise<Array<{ pinId: string; content: unknown; timestampMs?: number | null }>> {
  return fetchProtocolPinsFromIndexer(SERVICE_REFUND_FINALIZE_PATH, {
    pageSize: SERVICE_REFUND_SYNC_SIZE,
    maxPages: SERVICE_REFUND_SYNC_MAX_PAGES,
    selectContent: selectProtocolPinContent,
  });
}

const getServiceRefundSyncService = () => {
  if (!serviceRefundSyncService) {
    serviceRefundSyncService = new ServiceRefundSyncService(
      getServiceOrderStore(),
      {
        fetchRefundRequestPins: fetchRefundRequestPinsFromIndexer,
        fetchRefundFinalizePins: fetchRefundFinalizePinsFromIndexer,
        resolveLocalMetabotGlobalMetaId: (localMetabotId) => {
          const metabot = getMetabotStore().getMetabotById(localMetabotId);
          return metabot?.globalmetaid ?? null;
        },
        resolveLocalMetabotIdByGlobalMetaId: (globalMetaId) => {
          const metabot = getMetabotStore().getMetabotByGlobalMetaId(globalMetaId);
          return metabot?.id ?? null;
        },
        resolveLocalMetabotIdByServicePinId: (servicePinId) => (
          resolveGigSquareLocalServiceMetabotId(servicePinId)
        ),
        buildRefundVerificationInput: (order, payload) => {
          const metabot = getMetabotStore().getMetabotById(order.localMetabotId);
          if (!metabot) {
            throw new Error(`Missing buyer metabot for refund verification order=${order.id}`);
          }
          const recipientAddress = getRefundAddressForOrder(metabot, order.paymentChain);
          if (!recipientAddress) {
            throw new Error(`Missing refund recipient address for order=${order.id}`);
          }
          return {
            chain: order.paymentChain as 'mvc' | 'btc' | 'doge',
            txid: String(payload.refundTxid || ''),
            recipientAddress,
            expectedAmountSats: Math.floor(Number(order.paymentAmount) * 100_000_000),
          };
        },
        resolveRefundMrc20RecipientAddress: (order) => {
          const metabot = getMetabotStore().getMetabotById(order.localMetabotId);
          if (!metabot) {
            throw new Error(`Missing buyer metabot for MRC20 refund verification order=${order.id}`);
          }
          const recipientAddress = getRefundAddressForOrder(metabot, 'btc');
          if (!recipientAddress) {
            throw new Error(`Missing BTC refund recipient address for order=${order.id}`);
          }
          return recipientAddress;
        },
        verifyMrc20Transfer,
        onOrderEvent: async ({ type, order }) => {
          if (type === 'refund_requested') {
            await recoverMissingRefundPendingOrderObserverSessions().catch((error) => {
              console.warn('[ServiceOrder] Failed to recover refund observer sessions', error);
            });
          }
          publishServiceOrderEventToCowork(type, order);
        },
      }
    );
  }
  return serviceRefundSyncService;
};

const resolveTransferFeeRate = async (chain: TransferChain): Promise<number> => {
  const globalTiers = getGlobalFeeTiers()[chain];
  if (Array.isArray(globalTiers) && globalTiers.length > 0) {
    return getGlobalFeeRate(chain);
  }
  const result = await getFeeSummary(chain);
  return getDefaultFeeRate(chain, result.list);
};

const getServiceRefundSettlementService = () => {
  if (!serviceRefundSettlementService) {
    serviceRefundSettlementService = new ServiceRefundSettlementService(
      getServiceOrderStore(),
      {
        fetchRefundRequestPin: async (pinId) => {
          const data = await getPinData(pinId, true);
          return {
            pinId,
            content: selectProtocolPinContent(data),
          };
        },
        executeRefundTransfer: async (input) => {
          if (input.order.settlementKind === 'mrc20') {
            const mrc20Id = String(input.order.mrc20Id || '').trim();
            if (!mrc20Id) {
              throw new Error(`Missing mrc20Id for refund order=${input.order.id}`);
            }
            const assets = await getMetabotWalletAssets(getMetabotStore(), {
              metabotId: input.order.localMetabotId,
            });
            const asset = assets.mrc20Assets.find((candidate) => candidate.mrc20Id === mrc20Id);
            if (!asset) {
              throw new Error(`Refund MRC20 asset is unavailable in wallet for order=${input.order.id}`);
            }
            const feeRate = await resolveTransferFeeRate('btc');
            const result = await executeTokenTransferService(getMetabotStore(), {
              kind: 'mrc20',
              metabotId: input.order.localMetabotId,
              asset,
              toAddress: input.refundToAddress,
              amount: input.refundAmount,
              feeRate,
            });
            return {
              success: true,
              txId: result.revealTxId || result.txId || null,
            };
          }

          const feeRate = await resolveTransferFeeRate(input.order.paymentChain as TransferChain);
          return executeTransfer(getMetabotStore(), {
            metabotId: input.order.localMetabotId,
            chain: input.order.paymentChain as TransferChain,
            toAddress: input.refundToAddress,
            amountSpaceOrDoge: input.refundAmount,
            feeRate,
          });
        },
        createRefundFinalizePin: async ({ order, payload }) => {
          const result = await createPin(getMetabotStore(), order.localMetabotId, {
            operation: 'create',
            path: SERVICE_REFUND_FINALIZE_PATH,
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
          });
          return {
            pinId: result.pinId ?? result.txids?.[0] ?? null,
            txid: result.txids?.[0] ?? null,
          };
        },
        resolveLocalMetabotGlobalMetaId: (localMetabotId) => {
          const metabot = getMetabotStore().getMetabotById(localMetabotId);
          return metabot?.globalmetaid ?? null;
        },
        onOrderEvent: ({ type, order }) => {
          publishServiceOrderEventToCowork(type, order);
        },
      }
    );
  }
  return serviceRefundSettlementService;
};

const getGigSquareRefundsService = () => {
  if (!gigSquareRefundsService) {
    gigSquareRefundsService = new GigSquareRefundsService({
      listSellerRefundOrders: () => getServiceOrderStore().listOrdersByStatuses('seller', ['refund_pending', 'refunded']),
      listBuyerRefundOrders: () => getServiceOrderStore().listOrdersByStatuses('buyer', ['refund_pending', 'refunded']),
      resolveCounterpartyInfo: async (globalMetaId) => {
        try {
          const payload = await fetchMetaidUserInfoByGlobalMetaId(globalMetaId);
          const data = unwrapMetaidInfoRecord(payload?.data);
          return {
            name: toSafeString(data?.name).trim() || null,
            avatarUrl: toSafeString(data?.avatarUrl).trim() || null,
          };
        } catch (error) {
          console.warn('[GigSquare] Failed to hydrate refund counterparty info', globalMetaId, error);
          return {
            name: null,
            avatarUrl: null,
          };
        }
      },
      resolveCoworkSessionIdForOrder: (order) => {
        const sessions = listCoworkSessionsForOrderResolution();
        return resolveCoworkSessionIdForOrder(order as ServiceOrderRecord, sessions);
      },
      refreshRefundProtocols: () => syncServiceRefundProtocols(),
      processSellerRefundForOrderId: (orderId) => (
        getServiceRefundSettlementService().processSellerRefundForOrderId(orderId)
      ),
    });
  }
  return gigSquareRefundsService;
};

const syncServiceRefundProtocols = async (): Promise<void> => {
  const service = getServiceRefundSyncService();

  try {
    await service.syncRequestPins();
  } catch (error) {
    console.warn('[ServiceOrder] Refund request sync failed', error);
  }

  try {
    await recoverMissingRefundPendingOrderObserverSessions();
  } catch (error) {
    console.warn('[ServiceOrder] Refund session recovery scan failed', error);
  }

  try {
    await service.syncFinalizePins();
  } catch (error) {
    console.warn('[ServiceOrder] Refund finalize sync failed', error);
  }
};

const enrichCoworkSessionWithServiceOrderSummary = <T extends { id: string }>(
  session: T | null
): (T & { serviceOrderSummary?: ReturnType<ServiceOrderStore['getSessionSummary']> }) | null => {
  if (!session) return null;
  const serviceOrderSummary = getServiceOrderSummaryForSession(session.id);
  if (!serviceOrderSummary) {
    return session;
  }
  return {
    ...session,
    serviceOrderSummary,
  };
};

const buildServiceOrderSummaryFromRecord = (
  order: ServiceOrderRecord
): ReturnType<ServiceOrderStore['getSessionSummary']> => ({
  role: order.role,
  status: order.status,
  failureReason: order.failureReason,
  refundRequestPinId: order.refundRequestPinId,
  refundTxid: order.refundTxid,
});

const resolveServiceOrderForSession = (sessionId: string): ServiceOrderRecord | null => {
  const orderStore = getServiceOrderStore();
  const directMatch = orderStore.findLatestOrderBySessionId(sessionId);
  if (directMatch) {
    return directMatch;
  }

  const session = getCoworkStore().getSession(sessionId);
  if (!session || session.metabotId == null) {
    return null;
  }

  const paymentTxid = extractSessionOrderTxid(session.messages);
  if (!paymentTxid) {
    return null;
  }

  const matched = orderStore
    .listOrdersByPaymentTxid(paymentTxid)
    .find((candidate) => (
      candidate.localMetabotId === session.metabotId
      && (
        !session.peerGlobalMetaId
        || candidate.counterpartyGlobalMetaid === session.peerGlobalMetaId
      )
    ));
  if (!matched) {
    return null;
  }

  if (!matched.coworkSessionId) {
    return orderStore.setCoworkSessionId(matched.id, sessionId);
  }
  return matched;
};

const listCoworkSessionsForOrderResolution = (): NonNullable<ReturnType<CoworkStore['getSession']>>[] => {
  const coworkStore = getCoworkStore();
  return coworkStore
    .listSessions()
    .map((session) => coworkStore.getSession(session.id))
    .filter((session): session is NonNullable<ReturnType<CoworkStore['getSession']>> => Boolean(session));
};

const resolveCoworkSessionIdForOrder = (
  order: ServiceOrderRecord,
  sessions: NonNullable<ReturnType<CoworkStore['getSession']>>[],
): string | null => {
  const resolvedSessionId = resolveOrderSessionId({
    directSessionId: order.coworkSessionId,
    fallbackSessionId: findMatchingOrderSessionId(sessions, order),
  });
  if (!resolvedSessionId) {
    return null;
  }
  if (!order.coworkSessionId) {
    getServiceOrderStore().setCoworkSessionId(order.id, resolvedSessionId);
  }
  return resolvedSessionId;
};

const getServiceOrderSummaryForSession = (
  sessionId: string
): ReturnType<ServiceOrderStore['getSessionSummary']> | null => {
  const directSummary = getServiceOrderStore().getSessionSummary(sessionId);
  if (directSummary) {
    return directSummary;
  }
  const resolvedOrder = resolveServiceOrderForSession(sessionId);
  return resolvedOrder ? buildServiceOrderSummaryFromRecord(resolvedOrder) : null;
};

const getScheduler = () => {
  if (!scheduler) {
    scheduler = new Scheduler({
      scheduledTaskStore: getScheduledTaskStore(),
      coworkStore: getCoworkStore(),
      getCoworkRunner,
      getIMGatewayManager: () => {
        try { return getIMGatewayManager(); } catch { return null; }
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });
  }
  return scheduler;
};

// 获取正确的预加载脚本路径
const PRELOAD_PATH = app.isPackaged 
  ? path.join(__dirname, 'preload.js')
  : path.join(__dirname, '../dist-electron/preload.js');

// 获取应用图标路径（Windows 使用 .ico，其他平台使用 .png）
const getAppIconPath = (): string | undefined => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'tray');
  return process.platform === 'win32'
    ? path.join(basePath, 'tray-icon.ico')
    : path.join(basePath, 'tray-icon.png');
};

// 保存对主窗口的引用
let mainWindow: BrowserWindow | null = null;

onSandboxProgress((progress) => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    win.webContents.send('cowork:sandbox:downloadProgress', progress);
  });
});
let isQuitting = false;

// 存储活跃的流式请求控制器
const activeStreamControllers = new Map<string, AbortController>();
let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;

const resolveThemeFromConfig = (config?: { theme?: string }): 'light' | 'dark' => {
  if (config?.theme === 'dark') {
    return 'dark';
  }
  if (config?.theme === 'light') {
    return 'light';
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
};

const getInitialTheme = (): 'light' | 'dark' => {
  const config = getStore().get('app_config') as { theme?: string } | undefined;
  return resolveThemeFromConfig(config);
};

const getTitleBarOverlayOptions = () => {
  const config = getStore().get('app_config') as { theme?: string } | undefined;
  const theme = resolveThemeFromConfig(config);
  return {
    color: TITLEBAR_COLORS[theme].color,
    symbolColor: TITLEBAR_COLORS[theme].symbolColor,
    height: TITLEBAR_HEIGHT,
  };
};

const updateTitleBarOverlay = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isMac && !isWindows) {
    mainWindow.setTitleBarOverlay(getTitleBarOverlayOptions());
  }
  // Also update the window background color to match the theme
  const config = getStore().get('app_config') as { theme?: string } | undefined;
  const theme = resolveThemeFromConfig(config);
  mainWindow.setBackgroundColor(theme === 'dark' ? '#0F1117' : '#F8F9FB');
};

const emitWindowState = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isFullscreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
  });
};

const showSystemMenu = (position?: { x?: number; y?: number }) => {
  if (!isWindows) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isMaximized = mainWindow.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: 'Restore', enabled: isMaximized, click: () => mainWindow.restore() },
    { role: 'minimize' },
    { label: 'Maximize', enabled: !isMaximized, click: () => mainWindow.maximize() },
    { type: 'separator' },
    { role: 'close' },
  ]);

  menu.popup({
    window: mainWindow,
    x: Math.max(0, Math.round(position?.x ?? 0)),
    y: Math.max(0, Math.round(position?.y ?? 0)),
  });
};

const scheduleReload = (reason: string, webContents?: WebContents) => {
  const target = webContents ?? mainWindow?.webContents;
  if (!target || target.isDestroyed()) {
    return;
  }
  const now = Date.now();
  if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
    console.warn(`Skipping reload (${reason}); last reload was ${now - lastReloadAt}ms ago.`);
    return;
  }
  lastReloadAt = now;
  console.warn(`Reloading window due to ${reason}`);
  target.reloadIgnoringCache();
};


// 确保应用程序只有一个实例
const shouldUseSingleInstanceLock = shouldAcquireSingleInstanceLock();
const gotTheLock = shouldUseSingleInstanceLock ? app.requestSingleInstanceLock() : true;

if (!gotTheLock) {
  app.quit();
} else {
  if (shouldUseSingleInstanceLock) {
    app.on('second-instance', (_event, commandLine, workingDirectory) => {
      console.log('[Main] second-instance event', { commandLine, workingDirectory });
      // 如果尝试启动第二个实例，则聚焦到主窗口
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        if (!mainWindow.isFocused()) mainWindow.focus();
      }
    });
  } else {
    console.log('[Main] Single-instance lock disabled by runtime override');
  }

  // IPC 处理程序
  ipcMain.handle('store:get', (_event, key) => {
    return getStore().get(key);
  });

  ipcMain.handle('store:set', (_event, key, value) => {
    getStore().set(key, value);
  });

  ipcMain.handle('store:remove', (_event, key) => {
    getStore().delete(key);
  });

  // Network status change handler
  // Remove any existing listener first to avoid duplicate registrations
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);

    if (status === 'online' && imGatewayManager) {
      console.log('[Main] Network restored, reconnecting IM gateways...');
      imGatewayManager.reconnectAllDisconnected();
    }
  });

  // Log IPC handlers
  ipcMain.handle('log:getPath', () => {
    return getLogFilePath();
  });

  ipcMain.handle('log:openFolder', () => {
    const logPath = getLogFilePath();
    if (logPath) {
      shell.showItemInFolder(logPath);
    }
  });

  // Auto-launch IPC handlers
  ipcMain.handle('app:getAutoLaunch', () => {
    return { enabled: getAutoLaunchEnabled() };
  });

  ipcMain.handle('app:setAutoLaunch', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setAutoLaunchEnabled(enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set auto-launch',
      };
    }
  });

  // Window control IPC handlers
  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.on('window:showSystemMenu', (_event, position: { x?: number; y?: number } | undefined) => {
    showSystemMenu(position);
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getSystemLocale', () => app.getLocale());

  // Skills IPC handlers
  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', (_event, id: string) => {
    try {
      const skills = getSkillManager().deleteSkill(id);
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string) => {
    return getSkillManager().downloadSkill(source);
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildCoworkAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('metaapps:autoRoutingPrompt', () => {
    try {
      const prompt = getMetaAppManager().buildCoworkAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build MetaApp auto-routing prompt' };
    }
  });

  ipcMain.handle('metaapps:list', async () => {
    try {
      const apps = getMetaAppManager().listMetaApps();
      const resolvedApps = await Promise.all(apps.map((app) => resolveMetaAppVisualFields(app)));
      return { success: true, apps: resolvedApps };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list MetaApps' };
    }
  });

  ipcMain.handle('metaapps:listCommunity', async (_event, input?: { cursor?: string; size?: number }) => {
    try {
      const result = await listCommunityMetaApps({
        manager: getMetaAppManager(),
        cursor: input?.cursor,
        size: input?.size,
      });
      if (!result.success || !result.apps) {
        return result;
      }
      const apps = await Promise.all(result.apps.map((app) => resolveMetaAppVisualFields(app)));
      return { ...result, apps };
    } catch (error) {
      return { success: false, apps: [], error: error instanceof Error ? error.message : 'Failed to list community MetaApps' };
    }
  });

  ipcMain.handle('metaapps:installCommunity', async (_event, input: { sourcePinId: string }) => {
    try {
      const result = await installCommunityMetaApp({
        sourcePinId: String(input?.sourcePinId || ''),
        manager: getMetaAppManager(),
      });
      if (result.success) {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('metaapps:changed');
          }
        });
      }
      return result;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to install community MetaApp' };
    }
  });

  ipcMain.handle('metaapps:open', async (_event, input: { appId: string; targetPath?: string }) => {
    try {
      return await openMetaApp({
        appId: String(input?.appId ?? ''),
        targetPath: typeof input?.targetPath === 'string' ? input.targetPath : undefined,
        manager: getMetaAppManager(),
        ensureServerReady: ensureMetaAppServerReady,
        shellOpenExternal: shell.openExternal,
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open MetaApp' };
    }
  });

  ipcMain.handle('metaapps:resolveUrl', async (_event, input: { appId: string; targetPath?: string }) => {
    try {
      return await resolveMetaAppUrl({
        appId: String(input?.appId ?? ''),
        targetPath: typeof input?.targetPath === 'string' ? input.targetPath : undefined,
        manager: getMetaAppManager(),
        ensureServerReady: ensureMetaAppServerReady,
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve MetaApp URL' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  // Official skills sync IPC handlers (MetaWeb)
  ipcMain.handle('idbots:getOfficialSkillsStatus', async () => {
    try {
      return await getOfficialSkillsStatus();
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get official skills status' };
    }
  });

  ipcMain.handle('idbots:installOfficialSkill', async (_event, skill: {
    name: string;
    skillFileUri: string;
    remoteVersion: string;
    remoteCreator: string;
  }) => {
    try {
      const result = await installOfficialSkill(
        skill.name,
        skill.skillFileUri,
        skill.remoteVersion,
        skill.remoteCreator
      );
      if (result.success) {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('skills:changed');
          }
        });
      }
      return result;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to install skill' };
    }
  });

  ipcMain.handle('idbots:syncAllOfficialSkills', async () => {
    try {
      const result = await syncAllOfficialSkills();
      if (result.success) {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('skills:changed');
          }
        });
      }
      return result;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to sync official skills' };
    }
  });

  // MetaWebListener IPC (real WebSocket + DB; isolated from IM Gateway)
  ipcMain.handle('idbots:getListenerConfig', async () => {
    return { success: true, config: getListenerConfigFromStore() };
  });
  ipcMain.handle('idbots:getListenerStatus', async () => {
    return { success: true, running: isListenerRunning(), connected: isListenerSocketConnected() };
  });
  ipcMain.handle('idbots:toggleListener', async (_event, payload: { type: 'enabled' | 'groupChats' | 'privateChats' | 'serviceRequests' | 'respondToStrangerPrivateChats'; enabled: boolean }) => {
    const config = getListenerConfigFromStore();
    if (payload.type === 'enabled' || payload.type === 'groupChats' || payload.type === 'privateChats' || payload.type === 'serviceRequests' || payload.type === 'respondToStrangerPrivateChats') {
      const next = normalizeListenerConfig({
        ...config,
        [payload.type]: payload.enabled,
      });
      getStore().set(METAWEB_LISTENER_CONFIG_KEY, next);
      if (payload.type !== 'respondToStrangerPrivateChats') {
        if (shouldRunListener(next)) {
          await startListenerWithConfig(next);
        } else {
          stopMetaWebListener();
        }
      }
      return { success: true, config: next };
    }
    return { success: false, error: 'Invalid listener type' };
  });
  ipcMain.handle('idbots:startMetaWebListener', async () => {
    try {
      const config = getListenerConfigFromStore();
      if (!shouldRunListener(config)) {
        stopMetaWebListener();
        return { success: true };
      }
      await startListenerWithConfig(config);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start MetaWeb listener' };
    }
  });

  ipcMain.handle('idbots:assignGroupChatTask', async (_event, params: AssignGroupChatTaskParams) => {
    try {
      const db = getStore().getDatabase();
      const saveDb = getStore().getSaveFunction();
      const result = assignGroupChatTask(db, saveDb, getMetabotStore(), params);
      return result;
    } catch (error) {
      return {
        success: false,
        message: '',
        error: error instanceof Error ? error.message : 'Failed to assign group chat task',
      };
    }
  });

  // Cowork IPC handlers
  ipcMain.handle('cowork:session:start', async (_event, options: {
    prompt: string;
    cwd?: string;
    systemPrompt?: string;
    title?: string;
    activeSkillIds?: string[];
    metabotId?: number | null;
  }) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      const config = coworkStoreInstance.getConfig();
      const systemPrompt = options.systemPrompt ?? config.systemPrompt;
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();

      if (!selectedWorkspaceRoot) {
        return {
          success: false,
          error: 'Please select a task folder before submitting.',
        };
      }

      // Generate title from first line of prompt
      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const title = options.title?.trim() || fallbackTitle;
      const taskWorkingDirectory = resolveTaskWorkingDirectory(selectedWorkspaceRoot);

      const session = coworkStoreInstance.createSession(
        title,
        taskWorkingDirectory,
        systemPrompt,
        config.executionMode || 'local',
        options.activeSkillIds || [],
        options.metabotId ?? null
      );
      const runner = getCoworkRunner();

      // Update session status to 'running' before starting async task
      // This ensures the frontend receives the correct status immediately
      coworkStoreInstance.updateSession(session.id, { status: 'running' });
      coworkStoreInstance.addMessage(session.id, {
        type: 'user',
        content: options.prompt,
        metadata: options.activeSkillIds?.length ? { skillIds: options.activeSkillIds } : undefined,
      });

      // Start the session asynchronously (skip initial user message since we already added it)
      runner.startSession(session.id, options.prompt, {
        skipInitialUserMessage: true,
        skillIds: options.activeSkillIds,
        workspaceRoot: selectedWorkspaceRoot,
        confirmationMode: 'modal',
      }).catch(error => {
        console.error('Cowork session error:', error);
      });

      const sessionWithMessages = coworkStoreInstance.getSession(session.id) || {
        ...session,
        status: 'running' as const,
      };
      return { success: true, session: sessionWithMessages };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    }
  });

  ipcMain.handle('cowork:session:continue', async (_event, options: {
    sessionId: string;
    prompt: string;
    systemPrompt?: string;
    activeSkillIds?: string[];
  }) => {
    try {
      const runner = getCoworkRunner();
      const session = getCoworkStore().getSession(options.sessionId);
      const systemPrompt = resolveContinueSystemPrompt({
        persistedSystemPrompt: session?.systemPrompt,
        requestedSystemPrompt: options.systemPrompt,
        activeSkillIds: options.activeSkillIds,
      });
      runner.continueSession(options.sessionId, options.prompt, { systemPrompt, skillIds: options.activeSkillIds }).catch(error => {
        console.error('Cowork continue error:', error);
      });

      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue session',
      };
    }
  });

  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    try {
      const runner = getCoworkRunner();
      runner.stopSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop session',
      };
    }
  });

  ipcMain.handle('cowork:session:endA2APrivateChat', async (_event, sessionId: string) => {
    try {
      const coworkStoreInst = getCoworkStore();
      const result = endPrivateChatA2AConversation({
        coworkStore: coworkStoreInst,
        sessionId,
        emitToRenderer: (channel, data) => {
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              try { win.webContents.send(channel as string, data); } catch { /* ignore */ }
            }
          });
        },
      });
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to end A2A private chat' };
      }

      const session = coworkStoreInst.getSession(sessionId);
      const metabotId = session?.metabotId;
      const peerGlobalMetaId = toSafeString(result.peerGlobalMetaId || session?.peerGlobalMetaId).trim();
      let noticeSent = false;

      if (!result.alreadyEnded && typeof metabotId === 'number' && peerGlobalMetaId) {
        try {
          const metabotStoreInst = getMetabotStore();
          const metabot = metabotStoreInst.getMetabotById(metabotId);
          const wallet = metabotStoreInst.getMetabotWalletByMetabotId(metabotId);
          const localGlobalMetaId = toSafeString(metabot?.globalmetaid).trim();
          if (metabot && wallet?.mnemonic?.trim() && localGlobalMetaId) {
            const db = getStore().getDatabase();
            const latestPeerKey = db.exec(
              `SELECT from_chat_pubkey, reply_pin
               FROM private_chat_messages
               WHERE (from_global_metaid = ? OR from_metaid = ?)
                 AND (to_global_metaid = ? OR to_metaid = ?)
                 AND from_chat_pubkey IS NOT NULL
                 AND TRIM(from_chat_pubkey) != ''
               ORDER BY id DESC
               LIMIT 1`,
              [peerGlobalMetaId, peerGlobalMetaId, localGlobalMetaId, localGlobalMetaId]
            );
            const row = latestPeerKey[0]?.values?.[0] ?? [];
            let chatPubkey = toSafeString(row[0]).trim();
            const replyPin = toSafeString(row[1]).trim();
            if (!chatPubkey) {
              chatPubkey = await resolveChatPubkeyForProvider(peerGlobalMetaId) ?? '';
            }
            if (chatPubkey) {
              const privateKeyBuffer = await getPrivateKeyBufferForEcdh(
                wallet.mnemonic,
                wallet.path || "m/44'/10001'/0'/0/0"
              );
              const encrypted = ecdhEncrypt(
                'bye',
                computeEcdhSharedSecretSha256(privateKeyBuffer, chatPubkey)
              );
              const payloadStr = buildPrivateMessagePayload(peerGlobalMetaId, encrypted, replyPin);
              await createPin(metabotStoreInst, metabotId, {
                operation: 'create',
                path: '/protocols/simplemsg',
                encryption: '0',
                version: '1.0.0',
                contentType: 'application/json',
                payload: payloadStr,
              });
              noticeSent = true;
            }
          }
        } catch (sendError) {
          console.warn('[Cowork] Failed to send A2A private chat bye:', sendError);
        }
      }

      return { success: true, noticeSent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to end A2A private chat',
      };
    }
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.deleteSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete session',
      };
    }
  });

  ipcMain.handle('cowork:session:pin', async (_event, options: { sessionId: string; pinned: boolean }) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.setSessionPinned(options.sessionId, options.pinned);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update session pin',
      };
    }
  });

  ipcMain.handle('cowork:session:rename', async (_event, options: { sessionId: string; title: string }) => {
    try {
      const title = options.title.trim();
      if (!title) {
        return { success: false, error: 'Title is required' };
      }
      const coworkStoreInstance = getCoworkStore();
      coworkStoreInstance.updateSession(options.sessionId, { title });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename session',
      };
    }
  });

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      repairSelfDirectedServiceOrders();
      const session = enrichCoworkSessionWithServiceOrderSummary(
        getCoworkStore().getSession(sessionId)
      );
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session',
      };
    }
  });

  ipcMain.handle('cowork:session:list', async () => {
    try {
      repairSelfDirectedServiceOrders();
      const sessions = getCoworkStore().listSessions().map((session) =>
        enrichCoworkSessionWithServiceOrderSummary(session)
      );
      return { success: true, sessions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  ipcMain.handle('cowork:session:processServiceRefund', async (_event, sessionId: string) => {
    try {
      const order = resolveServiceOrderForSession(sessionId);
      if (!order) {
        throw new Error('Refund order not found for this session');
      }
      const result = await getServiceRefundSettlementService().processSellerRefundForOrderId(order.id);
      const session = enrichCoworkSessionWithServiceOrderSummary(
        getCoworkStore().getSession(sessionId)
      );
      return {
        success: true,
        refundTxid: result.refundTxid,
        refundFinalizePinId: result.refundFinalizePinId,
        session,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process service refund',
      };
    }
  });

  ipcMain.handle('cowork:session:readLocalImage', async (_event, options: { path: string; maxBytes?: number }) => {
    try {
      const rawPath = typeof options?.path === 'string' ? options.path.trim() : '';
      if (!rawPath) {
        return { success: false, error: 'Image path is required' };
      }

      const resolvedPath = path.resolve(rawPath);
      const extension = path.extname(resolvedPath).toLowerCase();
      const mimeType = LOCAL_IMAGE_PREVIEW_EXTENSION_MIME[extension];
      if (!mimeType) {
        return { success: false, error: 'Unsupported image file type' };
      }

      const requestedMaxBytes = Number(options?.maxBytes);
      const maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
        ? Math.min(Math.floor(requestedMaxBytes), MAX_LOCAL_IMAGE_PREVIEW_BYTES)
        : MAX_LOCAL_IMAGE_PREVIEW_BYTES;

      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) {
        return { success: false, error: 'Target path is not a file' };
      }

      if (stat.size > maxBytes) {
        return {
          success: false,
          error: `Image too large (max ${Math.floor(maxBytes / (1024 * 1024))}MB)`,
        };
      }

      const buffer = await fs.promises.readFile(resolvedPath);
      return {
        success: true,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        mimeType,
        size: buffer.length,
      };
    } catch (error) {
      const nodeCode = (error as NodeJS.ErrnoException | null)?.code;
      if (nodeCode === 'ENOENT') {
        return { success: false, error: 'Image file not found' };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read local image',
      };
    }
  });

  ipcMain.handle('cowork:session:exportResultImage', async (
    event,
    options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }
  ) => {
    try {
      const { rect, defaultFileName } = options || {};
      const captureRect = normalizeCaptureRect(rect);
      if (!captureRect) {
        return { success: false, error: 'Capture rect is required' };
      }

      const image = await event.sender.capturePage(captureRect);
      return savePngWithDialog(event.sender, image.toPNG(), defaultFileName);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  });

  ipcMain.handle('cowork:session:captureImageChunk', async (
    event,
    options: {
      rect: { x: number; y: number; width: number; height: number };
    }
  ) => {
    try {
      const captureRect = normalizeCaptureRect(options?.rect);
      if (!captureRect) {
        return { success: false, error: 'Capture rect is required' };
      }

      const image = await event.sender.capturePage(captureRect);
      const pngBuffer = image.toPNG();

      return {
        success: true,
        width: captureRect.width,
        height: captureRect.height,
        pngBase64: pngBuffer.toString('base64'),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  });

  ipcMain.handle('cowork:session:saveResultImage', async (
    event,
    options: {
      pngBase64: string;
      defaultFileName?: string;
    }
  ) => {
    try {
      const base64 = typeof options?.pngBase64 === 'string' ? options.pngBase64.trim() : '';
      if (!base64) {
        return { success: false, error: 'Image data is required' };
      }

      const pngBuffer = Buffer.from(base64, 'base64');
      if (pngBuffer.length <= 0) {
        return { success: false, error: 'Invalid image data' };
      }

      return savePngWithDialog(event.sender, pngBuffer, options?.defaultFileName);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  });

  ipcMain.handle('cowork:permission:respond', async (_event, options: {
    requestId: string;
    result: PermissionResult;
  }) => {
    try {
      const runner = getCoworkRunner();
      runner.respondToPermission(options.requestId, options.result);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to respond to permission',
      };
    }
  });

  ipcMain.handle('cowork:config:get', async () => {
    try {
      const config = getCoworkStore().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get config',
      };
    }
  });

  // --- Delegation blocking IPC handlers ---
  ipcMain.handle('cowork:isDelegationBlocking', async (_event, sessionId: string) => {
    try {
      return getCoworkStore().isDelegationBlocking(sessionId);
    } catch {
      return false;
    }
  });

  ipcMain.handle('cowork:getDelegationInfo', async (_event, sessionId: string) => {
    try {
      return getCoworkStore().getDelegationInfo(sessionId);
    } catch {
      return null;
    }
  });

  ipcMain.handle('cowork:sandbox:status', async () => {
    return getSandboxStatus();
  });
  const resolveMemoryMetabotIdFromInput = (
    backend: MemoryBackend,
    input?: { sessionId?: string; metabotId?: number }
  ): number | null => {
    if (typeof input?.metabotId === 'number' && Number.isFinite(input.metabotId) && input.metabotId > 0) {
      return Math.floor(input.metabotId);
    }
    return backend.resolveMetabotIdForMemory(input?.sessionId);
  };

  ipcMain.handle('cowork:memory:listEntries', async (_event, input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const entries = memoryBackend.listUserMemories({
        metabotId,
        scopeKind: input?.scopeKind,
        scopeKey: input?.scopeKey,
        query: input?.query?.trim() || undefined,
        status: input?.status || 'all',
        includeDeleted: Boolean(input?.includeDeleted),
        limit: input?.limit,
        offset: input?.offset,
      });
      return { success: true, entries };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list memory entries',
      };
    }
  });
  ipcMain.handle('cowork:memory:createEntry', async (_event, input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const entry = memoryBackend.createUserMemory({
        text: input.text,
        confidence: input.confidence,
        isExplicit: input?.isExplicit,
        metabotId,
        scopeKind: input?.scopeKind,
        scopeKey: input?.scopeKey,
      });
      return { success: true, entry };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:updateEntry', async (_event, input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const entry = memoryBackend.updateUserMemory({
        id: input.id,
        metabotId,
        scopeKind: input?.scopeKind,
        scopeKey: input?.scopeKey,
        text: input.text,
        confidence: input.confidence,
        status: input.status,
        isExplicit: input.isExplicit,
      });
      if (!entry) {
        return { success: false, error: 'Memory entry not found' };
      }
      return { success: true, entry };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:deleteEntry', async (_event, input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    id: string;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const success = memoryBackend.deleteUserMemory({
        id: input.id,
        metabotId,
        scopeKind: input?.scopeKind,
        scopeKey: input?.scopeKey,
      });
      return success
        ? { success: true }
        : { success: false, error: 'Memory entry not found' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete memory entry',
      };
    }
  });
  ipcMain.handle('cowork:memory:getStats', async (_event, input?: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const stats = memoryBackend.getUserMemoryStats({
        metabotId,
        scopeKind: input?.scopeKind,
        scopeKey: input?.scopeKey,
      });
      return { success: true, stats };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get memory stats',
      };
    }
  });
  ipcMain.handle('cowork:memory:getPolicy', async (_event, input?: { sessionId?: string; metabotId?: number }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      const policy = metabotId == null
        ? memoryBackend.getEffectiveMemoryPolicyForMetabot(null)
        : memoryBackend.getEffectiveMemoryPolicyForMetabot(metabotId);
      return { success: true, policy };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get memory policy',
      };
    }
  });
  ipcMain.handle('cowork:memory:setPolicy', async (_event, input: {
    metabotId: number;
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = typeof input?.metabotId === 'number' && Number.isFinite(input.metabotId) && input.metabotId > 0
        ? Math.floor(input.metabotId)
        : null;
      if (metabotId == null) {
        return { success: false, error: 'Invalid metabotId for memory policy' };
      }
      const policy = memoryBackend.setMemoryPolicyForMetabot(metabotId, {
        memoryEnabled: typeof input?.memoryEnabled === 'boolean' ? input.memoryEnabled : undefined,
        memoryImplicitUpdateEnabled:
          typeof input?.memoryImplicitUpdateEnabled === 'boolean' ? input.memoryImplicitUpdateEnabled : undefined,
        memoryLlmJudgeEnabled:
          typeof input?.memoryLlmJudgeEnabled === 'boolean' ? input.memoryLlmJudgeEnabled : undefined,
        memoryGuardLevel:
          input?.memoryGuardLevel === 'strict' || input?.memoryGuardLevel === 'standard' || input?.memoryGuardLevel === 'relaxed'
            ? input.memoryGuardLevel
            : undefined,
        memoryUserMemoriesMaxItems:
          typeof input?.memoryUserMemoriesMaxItems === 'number' && Number.isFinite(input.memoryUserMemoriesMaxItems)
            ? input.memoryUserMemoriesMaxItems
            : undefined,
      });
      return { success: true, policy };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set memory policy',
      };
    }
  });
  ipcMain.handle('cowork:sandbox:install', async () => {
    const result = await ensureSandboxReady();
    return {
      success: result.ok,
      status: getSandboxStatus(),
      error: result.ok ? undefined : ('error' in result ? result.error : undefined),
    };
  });

  ipcMain.handle('cowork:config:set', async (_event, config: {
    workingDirectory?: string;
    executionMode?: 'auto' | 'local' | 'sandbox';
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
  }) => {
    try {
      const normalizedExecutionMode =
        config.executionMode && String(config.executionMode) === 'container'
          ? 'sandbox'
          : config.executionMode;
      const normalizedMemoryEnabled = typeof config.memoryEnabled === 'boolean'
        ? config.memoryEnabled
        : undefined;
      const normalizedMemoryImplicitUpdateEnabled = typeof config.memoryImplicitUpdateEnabled === 'boolean'
        ? config.memoryImplicitUpdateEnabled
        : undefined;
      const normalizedMemoryLlmJudgeEnabled = typeof config.memoryLlmJudgeEnabled === 'boolean'
        ? config.memoryLlmJudgeEnabled
        : undefined;
      const normalizedMemoryGuardLevel = config.memoryGuardLevel === 'strict'
        || config.memoryGuardLevel === 'standard'
        || config.memoryGuardLevel === 'relaxed'
        ? config.memoryGuardLevel
        : undefined;
      const normalizedMemoryUserMemoriesMaxItems =
        typeof config.memoryUserMemoriesMaxItems === 'number' && Number.isFinite(config.memoryUserMemoriesMaxItems)
          ? Math.max(
            MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
            Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(config.memoryUserMemoriesMaxItems))
          )
        : undefined;
      const normalizedConfig = {
        ...config,
        executionMode: normalizedExecutionMode,
        memoryEnabled: normalizedMemoryEnabled,
        memoryImplicitUpdateEnabled: normalizedMemoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: normalizedMemoryLlmJudgeEnabled,
        memoryGuardLevel: normalizedMemoryGuardLevel,
        memoryUserMemoriesMaxItems: normalizedMemoryUserMemoriesMaxItems,
      };
      const previousWorkingDir = getCoworkStore().getConfig().workingDirectory;
      getCoworkStore().setConfig(normalizedConfig);
      if (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir) {
        getSkillManager().handleWorkingDirectoryChange();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set config',
      };
    }
  });

  // ==================== Scheduled Task IPC Handlers ====================

  ipcMain.handle('scheduledTask:list', async () => {
    try {
      const tasks = getScheduledTaskStore().listTasks();
      return { success: true, tasks };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list tasks' };
    }
  });

  ipcMain.handle('scheduledTask:get', async (_event, id: string) => {
    try {
      const task = getScheduledTaskStore().getTask(id);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get task' };
    }
  });

  const normalizeScheduledTaskMetabotId = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.floor(value);
  };

  ipcMain.handle('scheduledTask:create', async (_event, input: any) => {
    try {
      const coworkConfig = getCoworkStore().getConfig();
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      const candidateWorkingDirectory = typeof normalizedInput.workingDirectory === 'string' && normalizedInput.workingDirectory.trim()
        ? normalizedInput.workingDirectory
        : coworkConfig.workingDirectory;
      normalizedInput.workingDirectory = resolveExistingTaskWorkingDirectory(candidateWorkingDirectory);
      normalizedInput.metabotId = normalizeScheduledTaskMetabotId(normalizedInput.metabotId);

      const task = getScheduledTaskStore().createTask(normalizedInput);
      getScheduler().reschedule();
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create task' };
    }
  });

  ipcMain.handle('scheduledTask:update', async (_event, id: string, input: any) => {
    try {
      const scheduledTaskStore = getScheduledTaskStore();
      const existingTask = scheduledTaskStore.getTask(id);
      if (!existingTask) {
        return { success: false, error: `Task not found: ${id}` };
      }

      const coworkConfig = getCoworkStore().getConfig();
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      const candidateWorkingDirectory = typeof normalizedInput.workingDirectory === 'string'
        ? (normalizedInput.workingDirectory.trim() || existingTask.workingDirectory || coworkConfig.workingDirectory)
        : (existingTask.workingDirectory || coworkConfig.workingDirectory);
      normalizedInput.workingDirectory = resolveExistingTaskWorkingDirectory(candidateWorkingDirectory);
      if (Object.prototype.hasOwnProperty.call(normalizedInput, 'metabotId')) {
        normalizedInput.metabotId = normalizeScheduledTaskMetabotId(normalizedInput.metabotId);
      }

      const task = scheduledTaskStore.updateTask(id, normalizedInput);
      getScheduler().reschedule();
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update task' };
    }
  });

  ipcMain.handle('scheduledTask:delete', async (_event, id: string) => {
    try {
      getScheduler().stopTask(id);
      const result = getScheduledTaskStore().deleteTask(id);
      getScheduler().reschedule();
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete task' };
    }
  });

  ipcMain.handle('scheduledTask:toggle', async (_event, id: string, enabled: boolean) => {
    try {
      const { task, warning } = getScheduledTaskStore().toggleTask(id, enabled);
      getScheduler().reschedule();
      return { success: true, task, warning };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle task' };
    }
  });

  ipcMain.handle('scheduledTask:runManually', async (_event, id: string) => {
    try {
      getScheduler().runManually(id).catch((err) => {
        console.error(`[IPC] Manual run failed for ${id}:`, err);
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run task' };
    }
  });

  ipcMain.handle('scheduledTask:stop', async (_event, id: string) => {
    try {
      const result = getScheduler().stopTask(id);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop task' };
    }
  });

  ipcMain.handle('scheduledTask:listRuns', async (_event, taskId: string, limit?: number, offset?: number) => {
    try {
      const runs = getScheduledTaskStore().listRuns(taskId, limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list runs' };
    }
  });

  ipcMain.handle('scheduledTask:countRuns', async (_event, taskId: string) => {
    try {
      const count = getScheduledTaskStore().countRuns(taskId);
      return { success: true, count };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to count runs' };
    }
  });

  ipcMain.handle('scheduledTask:listAllRuns', async (_event, limit?: number, offset?: number) => {
    try {
      const runs = getScheduledTaskStore().listAllRuns(limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list all runs' };
    }
  });

  // ==================== MetaBot IPC Handlers ====================

  ipcMain.handle('idbots:getMetaBots', async () => withSqliteRecovery('idbots:getMetaBots', async () => {
    try {
      const list = getMetabotStore().getAllMetaBots();
      return { success: true, list };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get MetaBots list' };
    }
  }));

  ipcMain.handle('metabot:list', async () => withSqliteRecovery('metabot:list', async () => {
    try {
      const list = getMetabotStore().listMetabots();
      return { success: true, list };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list metabots' };
    }
  }));

  ipcMain.handle('metabot:checkNameExists', async (_event, options: { name: string; excludeId?: number }) => {
    try {
      const list = getMetabotStore().listMetabots();
      const name = (options.name || '').trim().toLowerCase();
      if (!name) return { success: true, exists: false };
      const exists = list.some(
        (m) => m.name.toLowerCase() === name && (options.excludeId == null || m.id !== options.excludeId)
      );
      return { success: true, exists };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check name', exists: false };
    }
  });

  ipcMain.handle('metabot:get', async (_event, id: number) => withSqliteRecovery('metabot:get', async () => {
    try {
      const metabot = getMetabotStore().getMetabotById(id);
      return { success: true, metabot };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get metabot' };
    }
  }));

  const requireMetabotLlmIdForCreate = (value: unknown): string => {
    const llmId = typeof value === 'string' ? value.trim() : '';
    if (!llmId) {
      throw new Error('LLM Brain is required when creating a MetaBot');
    }
    return llmId;
  };

  ipcMain.handle('metabot:create', async (_event, input: {
    name: string;
    avatar?: string | null;
    metabot_type: 'twin' | 'worker';
    role: string;
    soul: string;
    goal?: string | null;
    background?: string | null;
    boss_id?: number | null;
    boss_global_metaid?: string | null;
    llm_id?: string | null;
  }) => {
    try {
      const llmId = requireMetabotLlmIdForCreate(input.llm_id);
      const walletResult = await mockCreateWalletAndFund();
      const pushResult = await mockPushConfigToChain();
      if (!pushResult.success) {
        return { success: false, error: 'Mock push config to chain failed' };
      }
      const store = getMetabotStore();
      const wallet = store.insertMetabotWallet({
        mnemonic: walletResult.mnemonic,
      });
      const metabot = store.createMetabot({
        wallet_id: wallet.id,
        mvc_address: walletResult.mvc_address,
        btc_address: walletResult.btc_address,
        doge_address: walletResult.doge_address,
        public_key: walletResult.public_key,
        chat_public_key: walletResult.chat_public_key,
        chat_public_key_pin_id: walletResult.chat_public_key_pin_id,
        name: input.name,
        avatar: input.avatar ?? null,
        enabled: true,
        metaid: walletResult.metaid,
        globalmetaid: walletResult.globalmetaid,
        metabot_info_pinid: walletResult.metabot_info_pinid,
        metabot_type: input.metabot_type,
        created_by: 'system',
        role: input.role,
        soul: input.soul,
        goal: input.goal ?? null,
        background: input.background ?? null,
        boss_id: input.boss_id ?? null,
        boss_global_metaid: (input.boss_global_metaid ?? '').trim() || null,
        llm_id: llmId,
        tools: [],
        skills: [],
      });
      await syncP2PRuntimeConfigForCurrentMetabots();
      return { success: true, metabot };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create metabot' };
    }
  });

  ipcMain.handle('metabot:update', async (_event, id: number, input: {
    name?: string;
    avatar?: string | null;
    enabled?: boolean;
    metabot_type?: 'twin' | 'worker';
    role?: string;
    soul?: string;
    goal?: string | null;
    background?: string | null;
    boss_id?: number | null;
    boss_global_metaid?: string | null;
    llm_id?: string | null;
  }) => {
    try {
      await mockUpdateConfigOnChain();
      const store = getMetabotStore();
      const metabot = store.updateMetabot(id, {
        ...input,
        boss_global_metaid:
          input.boss_global_metaid === undefined
            ? undefined
            : ((input.boss_global_metaid ?? '').trim() || null),
      });
      return { success: true, metabot };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update metabot' };
    }
  });

  ipcMain.handle('idbots:addMetaBot', async (_event, input: {
    name: string;
    avatar?: string | null;
    role: string;
    soul: string;
    goal?: string | null;
    background?: string | null;
    boss_id?: number | null;
    boss_global_metaid?: string | null;
    llm_id?: string | null;
    metabot_type?: 'twin' | 'worker';
  }) => {
    try {
      const llmId = requireMetabotLlmIdForCreate(input.llm_id);
      const walletResult = await createMetaBotWallet({});
      const store = getMetabotStore();
      const wallet = store.insertMetabotWallet({
        mnemonic: walletResult.mnemonic,
        path: walletResult.path,
      });
      const metabotType = input.metabot_type === 'twin' ? 'twin' : 'worker';
      const metabot = store.createMetabot({
        wallet_id: wallet.id,
        mvc_address: walletResult.mvc_address,
        btc_address: walletResult.btc_address,
        doge_address: walletResult.doge_address,
        public_key: walletResult.public_key,
        chat_public_key: walletResult.chat_public_key,
        chat_public_key_pin_id: null,
        name: input.name,
        avatar: input.avatar ?? null,
        enabled: true,
        metaid: walletResult.metaid,
        globalmetaid: walletResult.globalmetaid,
        metabot_info_pinid: null,
        metabot_type: metabotType,
        created_by: '0000',
        role: input.role,
        soul: input.soul,
        goal: input.goal ?? null,
        background: input.background ?? null,
        boss_id: null,
        boss_global_metaid: (input.boss_global_metaid ?? '').trim() || null,
        llm_id: llmId,
        tools: [],
        skills: [],
      });
      const subsidyResult = await requestMvcGasSubsidy({
        mvcAddress: metabot.mvc_address,
        mnemonic: walletResult.mnemonic,
        path: walletResult.path,
      });
      await syncP2PRuntimeConfigForCurrentMetabots();
      return { success: true, metabot, subsidy: subsidyResult };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      console.error('[MetaBot] idbots:addMetaBot failed:', errMsg);
      if (errStack) console.error('[MetaBot] idbots:addMetaBot stack:', errStack);
      return { success: false, error: errMsg };
    }
  });

  // Chain-first MetaBot creation: wallet → subsidy → on-chain PINs → DB save.
  // If chain fails, DB records are rolled back. Returns metabot only on full success.
  ipcMain.handle('idbots:createMetaBotOnChain', async (_event, input: {
    name: string;
    avatar?: string | null;
    role: string;
    soul: string;
    goal?: string | null;
    background?: string | null;
    boss_id?: number | null;
    boss_global_metaid?: string | null;
    llm_id?: string | null;
    metabot_type?: 'twin' | 'worker';
  }) => {
    const store = getMetabotStore();
    let walletId: number | null = null;
    let metabotId: number | null = null;
    try {
      const llmId = requireMetabotLlmIdForCreate(input.llm_id);
      // 1. Generate wallet (in-memory)
      const walletResult = await createMetaBotWallet({});
      const metabotType = input.metabot_type === 'twin' ? 'twin' : 'worker';

      // 2. Request gas subsidy (best-effort; don't fail creation if subsidy fails)
      let subsidyResult: { success: boolean; error?: string } = { success: false };
      try {
        subsidyResult = await requestMvcGasSubsidy({
          mvcAddress: walletResult.mvc_address,
          mnemonic: walletResult.mnemonic,
          path: walletResult.path,
        });
      } catch (e) {
        subsidyResult = { success: false, error: e instanceof Error ? e.message : String(e) };
      }

      // 3. Insert wallet + metabot into DB (needed by syncMetaBotToChain which reads from DB)
      const wallet = store.insertMetabotWallet({
        mnemonic: walletResult.mnemonic,
        path: walletResult.path,
      });
      walletId = wallet.id;

      const metabot = store.createMetabot({
        wallet_id: wallet.id,
        mvc_address: walletResult.mvc_address,
        btc_address: walletResult.btc_address,
        doge_address: walletResult.doge_address,
        public_key: walletResult.public_key,
        chat_public_key: walletResult.chat_public_key,
        chat_public_key_pin_id: null,
        name: input.name,
        avatar: input.avatar ?? null,
        enabled: true,
        metaid: walletResult.metaid,
        globalmetaid: walletResult.globalmetaid,
        metabot_info_pinid: null,
        metabot_type: metabotType,
        created_by: '0000',
        role: input.role,
        soul: input.soul,
        goal: input.goal ?? null,
        background: input.background ?? null,
        boss_id: null,
        boss_global_metaid: (input.boss_global_metaid ?? '').trim() || null,
        llm_id: llmId,
        tools: [],
        skills: [],
      });
      metabotId = metabot.id;

      // 4. Publish to chain (name + avatar + chatpubkey + bio)
      const syncResult = await syncMetaBotToChain(store, metabot.id);

      if (!syncResult.success && !syncResult.canSkip) {
        // Mandatory steps (name) failed — roll back DB records
        store.deleteMetabot(metabot.id);
        return { success: false, error: syncResult.error ?? 'Chain publish failed', canSkip: false };
      }

      // 5. Chain succeeded (or partial with canSkip) — reload metabot with updated pinIds
      const updatedMetabot = store.getMetabotById(metabot.id) ?? metabot;
      await syncP2PRuntimeConfigForCurrentMetabots();
      return {
        success: true,
        metabot: updatedMetabot,
        subsidy: subsidyResult,
        chainPartial: !syncResult.success && syncResult.canSkip,
        chainError: syncResult.canSkip ? syncResult.error : undefined,
      };
    } catch (error) {
      // Roll back DB records on unexpected error
      if (metabotId != null) {
        try { store.deleteMetabot(metabotId); } catch { /* ignore */ }
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[MetaBot] idbots:createMetaBotOnChain failed:', errMsg);
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('idbots:restoreMetaBotFromMnemonic', async (_event, input: { mnemonic: string; path?: string; boss_global_metaid?: string | null }) => {
    try {
      const mnemonic = (input?.mnemonic ?? '').trim().toLowerCase();
      const pathInput = (input?.path ?? "m/44'/10001'/0'/0/0").trim();
      const path = pathInput || "m/44'/10001'/0'/0/0";
      const words = mnemonic.split(/\s+/).filter(Boolean);

      console.log('[MetaBot] restore requested', { path, wordCount: words.length });

      if (words.length !== RESTORE_MNEMONIC_WORDS) {
        return { success: false, error: 'MNEMONIC_INVALID' };
      }
      if (!bip39.validateMnemonic(mnemonic, wordlist)) {
        return { success: false, error: 'MNEMONIC_INVALID' };
      }
      if (!path) {
        return { success: false, error: 'PATH_INVALID' };
      }

      const store = getMetabotStore();
      const existingWallet = store.getMetabotWalletByMnemonicNormalized(mnemonic);
      const effectivePath = existingWallet?.path?.trim() || path;
      if (existingWallet) {
        const linked = store.getMetabotByWalletId(existingWallet.id);
        if (linked) {
          return { success: false, error: 'METABOT_WALLET_IN_USE' };
        }
        if (pathInput !== existingWallet.path?.trim()) {
          console.log('[MetaBot] restore: reusing existing wallet row; using stored derivation path', {
            storedPath: existingWallet.path,
            requestedPath: pathInput,
          });
        }
      }

      const walletResult = await createMetaBotWallet({
        mnemonic: existingWallet?.mnemonic ?? mnemonic,
        path: effectivePath,
      });
      console.log('[MetaBot] restore wallet derived', {
        mvc: walletResult.mvc_address,
        globalmetaid: walletResult.globalmetaid,
        reusedWalletRow: Boolean(existingWallet),
      });

      const profile = await fetchMetaidRestoreProfile(walletResult.mvc_address);
      const name = profile.name.trim();
      if (!name) {
        return { success: false, error: 'NAME_EMPTY' };
      }

      const exists = store.listMetabots().some((m) => m.name.trim().toLowerCase() === name.toLowerCase());
      if (exists) {
        return { success: false, error: 'NAME_DUPLICATE' };
      }

      const wallet =
        existingWallet ??
        store.insertMetabotWallet({
          mnemonic: walletResult.mnemonic,
          path: walletResult.path,
        });

      const metabot = store.createMetabot({
        wallet_id: wallet.id,
        mvc_address: walletResult.mvc_address,
        btc_address: walletResult.btc_address,
        doge_address: walletResult.doge_address,
        public_key: walletResult.public_key,
        chat_public_key: walletResult.chat_public_key,
        chat_public_key_pin_id: profile.chatpubkeyPinId ?? null,
        name,
        avatar: profile.avatarDataUrl ?? null,
        enabled: true,
        metaid: walletResult.metaid,
        globalmetaid: walletResult.globalmetaid,
        metabot_info_pinid: profile.metabotInfoPinId ?? null,
        metabot_type: 'worker',
        created_by: profile.bio.created_by || '0000',
        role: profile.bio.role || '',
        soul: profile.bio.soul || '',
        goal: profile.bio.goal ?? null,
        background: profile.bio.background ?? null,
        boss_id: profile.bio.boss_id ?? null,
        boss_global_metaid: (input?.boss_global_metaid ?? '').trim() || (profile.bio.boss_global_metaid ?? null),
        llm_id: profile.bio.llm_id ?? null,
        tools: profile.bio.tools ?? [],
        skills: profile.bio.skills ?? [],
      });

      console.log('[MetaBot] restore success', { id: metabot.id, name: metabot.name });
      await syncP2PRuntimeConfigForCurrentMetabots();
      return { success: true, metabot };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[MetaBot] restore failed:', errMsg);
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('idbots:syncMetaBot', async (_event, metabotId: number) => {
    try {
      console.log('[MetaBot] idbots:syncMetaBot requested', { metabotId });
      const store = getMetabotStore();
      const result = await syncMetaBotToChain(store, metabotId);
      console.log('[MetaBot] idbots:syncMetaBot result', {
        success: result.success,
        error: result.error,
        metabotInfoPinId: result.metabotInfoPinId,
        chatPublicKeyPinId: result.chatPublicKeyPinId,
        txidCount: result.txids?.length ?? 0,
      });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[MetaBot] idbots:syncMetaBot failed:', errMsg);
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('idbots:syncMetaBotEditChanges', async (_event, input: {
    metabotId: number;
    syncName?: boolean;
    syncAvatar?: boolean;
    syncBio?: boolean;
  }) => {
    try {
      console.log('[MetaBot] idbots:syncMetaBotEditChanges requested', input);
      const store = getMetabotStore();
      const result = await syncMetaBotEditChangesToChain(store, input);
      console.log('[MetaBot] idbots:syncMetaBotEditChanges result', {
        success: result.success,
        error: result.error,
        metabotInfoPinId: result.metabotInfoPinId,
        syncedSteps: result.syncedSteps,
        txidCount: result.txids?.length ?? 0,
      });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[MetaBot] idbots:syncMetaBotEditChanges failed:', errMsg);
      return { success: false, error: errMsg };
    }
  });

  ipcMain.handle('idbots:getMetaBotMnemonic', async (_event, metabotId: number) => {
    try {
      const store = getMetabotStore();
      const wallet = store.getMetabotWalletByMetabotId(metabotId);
      if (!wallet) return { success: false, error: 'Wallet not found for this MetaBot' };
      return { success: true, mnemonic: wallet.mnemonic };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get mnemonic' };
    }
  });

  ipcMain.handle('idbots:deleteMetaBot', async (_event, metabotId: number) => {
    try {
      const store = getMetabotStore();
      const ok = store.deleteMetabot(metabotId);
      if (ok) {
        await syncP2PRuntimeConfigForCurrentMetabots();
      }
      return { success: ok };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MetaBot' };
    }
  });


  ipcMain.handle('gigSquare:fetchServices', async () => withSqliteRecovery('gigSquare:fetchServices', async () => {
    try {
      repairSelfDirectedServiceOrders();
      const refundRiskByProvider = new Map(
        getServiceRefundSyncService()
          .listProviderRefundRiskSummaries()
          .map((summary) => [summary.providerGlobalMetaId, summary] as const)
      );
      const currentServices = listCurrentRemoteGigSquareServices();
      const list = await Promise.all(
        currentServices.map(async (item) => ({
          ...item,
          id: item.currentPinId,
          currentPinId: item.currentPinId,
          sourceServicePinId: item.sourceServicePinId,
          avatar: await resolvePinAssetSource(item.avatar ?? null),
          serviceIcon: await resolvePinAssetSource(item.serviceIcon ?? null),
          refundRisk: refundRiskByProvider.get(item.providerGlobalMetaId) ?? null,
        })),
      );
      return { success: true, list };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch services' };
    }
  }));

  ipcMain.handle('gigSquare:fetchMyServices', async (_event, params?: {
    page?: number;
    pageSize?: number;
    refresh?: boolean;
  }) => withSqliteRecovery('gigSquare:fetchMyServices', async () => {
    try {
      await syncGigSquareMyServicesData({
        refresh: Boolean(params?.refresh),
      });
      const page = normalizePositiveInteger(params?.page, 1);
      const pageSize = clampPageSize(toSafeNumber(params?.pageSize), GIG_SQUARE_MY_SERVICES_PAGE_SIZE);
      const currentMyServices = listCurrentMyGigSquareServices();
      const summaryPage = buildMyServiceSummaries({
        ownedGlobalMetaIds: listOwnedGigSquareProviderGlobalMetaIds(),
        services: currentMyServices,
        sellerOrders: getServiceOrderStore().listOrdersByStatuses('seller', ['completed', 'refunded']),
        page,
        pageSize,
      });
      const items = await Promise.all(
        summaryPage.items.map(async (item) => ({
          ...item,
          avatar: await resolvePinAssetSource(item.avatar ?? null),
          serviceIcon: await resolvePinAssetSource(item.serviceIcon ?? null),
          creatorMetabotAvatar: await resolvePinAssetSource(item.creatorMetabotAvatar ?? null),
        }))
      );
      return { success: true, page: { ...summaryPage, items } };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch my services' };
    }
  }));

  ipcMain.handle('gigSquare:fetchMyServiceOrders', async (_event, params?: {
    serviceId?: string;
    page?: number;
    pageSize?: number;
    refresh?: boolean;
  }) => withSqliteRecovery('gigSquare:fetchMyServiceOrders', async () => {
    try {
      await syncGigSquareMyServicesData({
        refresh: Boolean(params?.refresh),
      });
      const serviceId = toSafeString(params?.serviceId).trim();
      if (!serviceId) {
        return { success: false, error: 'serviceId is required' };
      }
      const currentMyServices = listCurrentMyGigSquareServices();
      const service = currentMyServices.find((item) => item.currentPinId === serviceId || item.id === serviceId);
      if (!service) {
        return { success: false, error: 'Service not found' };
      }
      const currentPinId = toSafeString(service.currentPinId ?? service.id).trim();
      if (!currentPinId) {
        return { success: false, error: 'Service not found' };
      }

      const ratingsByPaymentTxid = new Map<string, GigSquareMyServiceRating[]>();
      for (const rating of listGigSquareRatingsFromDb(currentPinId)) {
        const paymentTxid = toSafeString(rating.servicePaidTx).trim();
        if (!paymentTxid) continue;
        const list = ratingsByPaymentTxid.get(paymentTxid) ?? [];
        list.push(rating);
        ratingsByPaymentTxid.set(paymentTxid, list);
      }

      const sellerOrders = getServiceOrderStore()
        .listOrdersByStatuses('seller', ['completed', 'refunded'])
        .filter((order) => toSafeString(order.servicePinId).trim() === currentPinId);
      const page = normalizePositiveInteger(params?.page, 1);
      const pageSize = clampPageSize(toSafeNumber(params?.pageSize), GIG_SQUARE_MY_SERVICE_ORDERS_PAGE_SIZE);
      const detailPage = buildMyServiceOrderDetails({
        serviceId: currentPinId,
        sellerOrders,
        ratingsByPaymentTxid,
        page,
        pageSize,
      });
      const sellerOrderById = new Map(sellerOrders.map((order) => [order.id, order] as const));
      const coworkSessions = listCoworkSessionsForOrderResolution();
      const sessionResolvedItems = detailPage.items.map((item) => {
        if (toSafeString(item.coworkSessionId).trim()) {
          return item;
        }
        const order = sellerOrderById.get(item.id);
        if (!order) {
          return item;
        }
        const resolvedSessionId = resolveCoworkSessionIdForOrder(order, coworkSessions);
        return resolvedSessionId
          ? { ...item, coworkSessionId: resolvedSessionId }
          : item;
      });

      const counterpartyIds = [...new Set(
        sessionResolvedItems
          .map((item) => toSafeString(item.counterpartyGlobalMetaid).trim())
          .filter(Boolean),
      )];
      const counterpartyInfoById = new Map<string, { name: string | null; avatarUrl: string | null }>();
      await Promise.all(counterpartyIds.map(async (counterpartyId) => {
        try {
          const payload = await fetchMetaidUserInfoByGlobalMetaId(counterpartyId);
          const data = unwrapMetaidInfoRecord(payload?.data);
          counterpartyInfoById.set(counterpartyId, {
            name: toSafeString(data?.name).trim() || null,
            avatarUrl: toSafeString(data?.avatarUrl).trim() || null,
          });
        } catch (error) {
          console.warn('[GigSquare] Failed to hydrate counterparty info', counterpartyId, error);
        }
      }));

      const items = sessionResolvedItems.map((item) => {
        const counterpartyId = toSafeString(item.counterpartyGlobalMetaid).trim();
        const counterpartyInfo = counterpartyInfoById.get(counterpartyId);
        if (!counterpartyInfo) {
          return item;
        }
        return {
          ...item,
          counterpartyName: counterpartyInfo.name,
          counterpartyAvatar: counterpartyInfo.avatarUrl,
        };
      });
      return { success: true, page: { ...detailPage, items } };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch my service orders' };
    }
  }));

  ipcMain.handle('gigSquare:fetchRefunds', async () => withSqliteRecovery('gigSquare:fetchRefunds', async () => {
    try {
      const refunds = await getGigSquareRefundsService().listRefunds();
      return { success: true, refunds };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch refunds' };
    }
  }));

  ipcMain.handle('gigSquare:processRefundOrder', async (_event, params?: {
    orderId?: string;
  }) => {
    try {
      const orderId = toSafeString(params?.orderId).trim();
      if (!orderId) {
        return { success: false, error: 'orderId is required' };
      }
      const result = await getGigSquareRefundsService().processRefundOrder({ orderId });
      return {
        success: true,
        refundTxid: result.refundTxid,
        refundFinalizePinId: result.refundFinalizePinId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process refund order',
      };
    }
  });

  ipcMain.handle('gigSquare:syncFromRemote', async () => {
    try {
      await syncGigSquareMyServicesData({ refresh: true });
      await syncServiceRefundProtocols();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Sync failed' };
    }
  });

  ipcMain.handle('gigSquare:fetchProviderInfo', async (_event, params: {
    providerMetaId?: string;
    providerGlobalMetaId?: string;
    providerAddress?: string;
  }) => {
    try {
      const providerMetaId = typeof params?.providerMetaId === 'string' ? params.providerMetaId.trim() : '';
      const providerGlobalMetaId = typeof params?.providerGlobalMetaId === 'string' ? params.providerGlobalMetaId.trim() : '';
      const providerAddress = typeof params?.providerAddress === 'string' ? params.providerAddress.trim() : '';
      if (!providerMetaId && !providerGlobalMetaId && !providerAddress) {
        return { success: false, error: 'provider identity is required' };
      }

      let info: MetaidAddressInfo | null = null;
      const errors: string[] = [];

      const tryFetch = async (label: string, job: Promise<MetaidAddressInfo | null>) => {
        try {
          const result = await job;
          if (result) {
            info = result;
            return true;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${label}: ${message}`);
        }
        return false;
      };

      if (providerAddress) {
        await tryFetch('address', fetchMetaidInfoByAddress(providerAddress));
      }
      if (!info && providerGlobalMetaId) {
        await tryFetch('globalMetaId', fetchMetaidInfoByMetaid(providerGlobalMetaId));
      }
      if (!info && providerMetaId) {
        await tryFetch('metaid', fetchMetaidInfoByMetaid(providerMetaId));
      }

      let chatPubkey = toSafeString(info?.chatpubkey).trim();
      if (!chatPubkey) {
        const buildUrl = (metaid: string | null, size: number) => {
          const url = new URL('https://manapi.metaid.io/pin/path/list');
          url.searchParams.set('path', GIG_SQUARE_CHATPUBKEY_PATH);
          url.searchParams.set('size', String(size));
          if (metaid) {
            url.searchParams.set('metaid', metaid);
          }
          return url.toString();
        };

        const fetchList = async (url: string) => {
          const localPath = `/api/pin/path/list${new URL(url).search}`;
          const response = await fetchJsonWithFallbackOnMiss(localPath, url, isEmptyListDataPayload);
          if (!response.ok) {
            throw new Error(`Failed to fetch chat pubkey: ${response.status}`);
          }
          const json = await response.json();
          return Array.isArray(json?.data?.list) ? json.data.list : [];
        };

        const candidates = [providerMetaId, providerGlobalMetaId].filter(Boolean);
        for (const metaid of candidates) {
          const list = await fetchList(buildUrl(metaid, 20));
          chatPubkey = extractChatPubkeyFromList(list, metaid) ?? '';
          if (chatPubkey) break;
        }

        if (!chatPubkey) {
          const list = await fetchList(buildUrl(null, 200));
          const matchId = providerMetaId || providerGlobalMetaId || '';
          chatPubkey = extractChatPubkeyFromList(list, matchId) ?? '';
        }
      }

      if (!chatPubkey) {
        const detail = errors.length ? ` (${errors.join('; ')})` : '';
        return { success: false, error: `Chat pubkey not found for provider${detail}` };
      }

      const resolvedGlobalMetaId = toSafeString(info?.globalMetaId || providerGlobalMetaId || providerMetaId).trim();
      const resolvedMetaId = toSafeString(info?.metaid || providerMetaId).trim();
      const resolvedAddress = toSafeString(info?.address || providerAddress).trim();
      const resolvedName = toSafeString(info?.name).trim();
      const resolvedAvatar = toSafeString(info?.avatar).trim();
      const resolvedAvatarSource = await resolvePinAssetSource(resolvedAvatar || null);

      return {
        success: true,
        chatPubkey,
        globalMetaId: resolvedGlobalMetaId || undefined,
        metaid: resolvedMetaId || undefined,
        address: resolvedAddress || undefined,
        name: resolvedName || undefined,
        avatar: resolvedAvatarSource || resolvedAvatar || undefined,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch provider info' };
    }
  });

  ipcMain.handle('gigSquare:preflightOrder', async (_event, params: {
    metabotId: number;
    toGlobalMetaId: string;
  }) => {
    try {
      repairSelfDirectedServiceOrders();
      const metabotId = typeof params?.metabotId === 'number' ? params.metabotId : -1;
      const toGlobalMetaId = typeof params?.toGlobalMetaId === 'string' ? params.toGlobalMetaId.trim() : '';

      if (!metabotId || metabotId < 0) {
        return { success: false, error: 'metabotId is required' };
      }
      if (!toGlobalMetaId) {
        return { success: false, error: 'toGlobalMetaId is required' };
      }

      const availability = getServiceOrderLifecycleService().getBuyerOrderAvailability(
        metabotId,
        toGlobalMetaId
      );
      if (availability.allowed === false) {
        return {
          success: false,
          errorCode: availability.errorCode,
          error: availability.error,
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to preflight order',
      };
    }
  });

  ipcMain.handle('gigSquare:publishService', async (_event, params: {
    metabotId: number;
    serviceName: string;
    displayName: string;
    description: string;
    providerSkill: string;
    price: string;
    currency: string;
    mrc20Ticker?: string;
    mrc20Id?: string;
    outputType: string;
    serviceIconDataUrl?: string | null;
  }) => {
    try {
      const metabotId = typeof params?.metabotId === 'number' ? params.metabotId : -1;
      const serviceName = toSafeString(params?.serviceName).trim();
      const displayName = toSafeString(params?.displayName).trim();
      const description = toSafeString(params?.description).trim();
      const providerSkill = toSafeString(params?.providerSkill).trim();
      const price = toSafeString(params?.price).trim();
      const currencyRaw = toSafeString(params?.currency).trim().toUpperCase();
      const mrc20Ticker = toSafeString(params?.mrc20Ticker).trim();
      const mrc20Id = toSafeString(params?.mrc20Id).trim();
      const outputType = toSafeString(params?.outputType).trim().toLowerCase();
      const serviceIconDataUrl = toSafeString(params?.serviceIconDataUrl).trim();

      if (!metabotId || metabotId < 0) return { success: false, error: 'metabotId is required' };
      const draft: GigSquareModifyDraft = {
        serviceName,
        displayName,
        description,
        providerSkill,
        price,
        currency: currencyRaw,
        mrc20Ticker,
        mrc20Id,
        outputType,
      };
      const draftValidation = validateGigSquareModifyDraft(draft);
      if (!draftValidation.ok) {
        return { success: false, error: draftValidation.error, errorCode: draftValidation.errorCode };
      }
      const normalizedDraft = normalizeGigSquareModifyDraft(draft);

      let settlement;
      try {
        settlement = normalizeGigSquareSettlementDraft({
          currency: normalizedDraft.currency,
          mrc20Ticker: normalizedDraft.mrc20Ticker,
          mrc20Id: normalizedDraft.mrc20Id,
        });
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'currency is invalid',
        };
      }
      const normalizedCurrency = settlement.protocolCurrency;

      const store = getMetabotStore();
      const metabot = store.getMetabotById(metabotId);
      if (!metabot) return { success: false, error: 'MetaBot not found' };
      if (!metabot.globalmetaid) return { success: false, error: 'MetaBot GlobalMetaID missing' };

      let serviceIconUri = '';
      if (serviceIconDataUrl) {
        const parsed = parseDataUrlImage(serviceIconDataUrl);
        if (!parsed) return { success: false, error: 'serviceIcon data invalid' };
        if (!GIG_SQUARE_IMAGE_MIME_TYPES.has(parsed.mime)) {
          return { success: false, error: 'serviceIcon type invalid' };
        }
        const fileResult = await createPin(store, metabotId, {
          operation: 'create',
          path: '/file',
          encryption: '0',
          version: '1.0.0',
          contentType: parsed.mime,
          payload: parsed.buffer,
        });
        serviceIconUri = `metafile://${fileResult.pinId}`;
      }

      const paymentAddress = resolveGigSquareSettlementPaymentAddress({
        owner: metabot,
        settlement,
      });

      const payload = buildGigSquareServicePayload({
        draft: {
          ...normalizedDraft,
          currency: settlement.selectorCurrency,
          mrc20Ticker: settlement.mrc20Ticker,
          mrc20Id: settlement.mrc20Id,
          serviceIconUri: serviceIconUri || null,
        },
        providerGlobalMetaId: metabot.globalmetaid,
        paymentAddress,
      });

      const payloadJson = JSON.stringify(payload);
      const result = await createPin(store, metabotId, {
        operation: 'create',
        path: GIG_SQUARE_SERVICE_PATH,
        encryption: '0',
        version: '1.0.0',
        contentType: 'application/json',
        payload: payloadJson,
      });

      let warning: string | undefined;
      try {
        insertGigSquareServiceRow({
          id: result.pinId,
          pinId: result.pinId,
          txid: result.txids?.[0] || '',
          metabotId,
          providerGlobalMetaId: metabot.globalmetaid,
          providerSkill: normalizedDraft.providerSkill,
          serviceName: normalizedDraft.serviceName,
          displayName: normalizedDraft.displayName,
          description: normalizedDraft.description,
          serviceIcon: serviceIconUri || null,
          price: normalizedDraft.price,
          currency: normalizedCurrency,
          skillDocument: '',
          inputType: 'text',
          outputType: normalizedDraft.outputType,
          endpoint: 'simplemsg',
          payloadJson,
        });
      } catch (err) {
        warning = err instanceof Error ? err.message : 'Failed to save local record';
        console.warn('[GigSquare] Failed to save local record', warning);
      }

      // Sync remote skill services 10s after broadcast so the new pin is indexed
      setTimeout(() => {
        void syncRemoteSkillServices().catch(() => {});
      }, 10000);

      return { success: true, txids: result.txids, pinId: result.pinId, warning };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to publish service' };
    }
  });
  ipcMain.handle('gigSquare:revokeService', async (_event, params?: { serviceId?: string }) => {
    try {
      await syncGigSquareMyServicesData({ refresh: true });
      const serviceId = toSafeString(params?.serviceId).trim();
      if (!serviceId) {
        return { success: false, error: 'serviceId is required', errorCode: 'service_id_required' };
      }

      const currentService = listCurrentMyGigSquareServices().find((item) =>
        item.currentPinId === serviceId || item.id === serviceId
      );
      const validation = validateGigSquareServiceMutation({
        action: 'revoke',
        service: currentService
          ? {
            currentPinId: currentService.currentPinId,
            creatorMetabotId: currentService.creatorMetabotId,
            canModify: currentService.canModify,
            canRevoke: currentService.canRevoke,
            blockedReason: currentService.blockedReason,
          }
          : null,
      });
      if (!validation.ok || !validation.creatorMetabotId || !currentService) {
        return {
          success: false,
          error: validation.error || 'Service not found',
          errorCode: validation.errorCode || 'service_not_found',
        };
      }

      const result = await createPin(
        getMetabotStore(),
        validation.creatorMetabotId,
        buildGigSquareRevokeMetaidPayload(currentService.currentPinId),
      );
      markGigSquareLocalServiceRevoked(currentService);

      let warning: string | undefined;
      await new Promise((resolve) => setTimeout(resolve, GIG_SQUARE_MUTATION_SYNC_DELAY_MS));
      try {
        await syncGigSquareMyServicesData({ refresh: true });
      } catch {
        warning = 'Revoke broadcasted successfully, but chain sync may still be catching up';
      }

      return {
        success: true,
        txids: result.txids,
        pinId: result.pinId,
        creatorMetabotId: validation.creatorMetabotId,
        warning,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to revoke service',
      };
    }
  });

  ipcMain.handle('gigSquare:modifyService', async (_event, params?: {
    serviceId?: string;
    serviceName?: string;
    displayName?: string;
    description?: string;
    providerSkill?: string;
    price?: string;
    currency?: string;
    mrc20Ticker?: string;
    mrc20Id?: string;
    outputType?: string;
    serviceIconDataUrl?: string | null;
  }) => {
    try {
      await syncGigSquareMyServicesData({ refresh: true });
      const serviceId = toSafeString(params?.serviceId).trim();
      if (!serviceId) {
        return { success: false, error: 'serviceId is required', errorCode: 'service_id_required' };
      }

      const currentService = listCurrentMyGigSquareServices().find((item) =>
        item.currentPinId === serviceId || item.id === serviceId
      );
      const validation = validateGigSquareServiceMutation({
        action: 'modify',
        service: currentService
          ? {
            currentPinId: currentService.currentPinId,
            creatorMetabotId: currentService.creatorMetabotId,
            canModify: currentService.canModify,
            canRevoke: currentService.canRevoke,
            blockedReason: currentService.blockedReason,
          }
          : null,
      });
      if (!validation.ok || !validation.creatorMetabotId || !currentService) {
        return {
          success: false,
          error: validation.error || 'Service not found',
          errorCode: validation.errorCode || 'service_not_found',
        };
      }

      const draft: GigSquareModifyDraft = {
        serviceName: toSafeString(params?.serviceName).trim() || toSafeString(currentService.serviceName).trim(),
        displayName: toSafeString(params?.displayName).trim() || toSafeString(currentService.displayName).trim(),
        description: toSafeString(params?.description).trim() || toSafeString(currentService.description).trim(),
        providerSkill: toSafeString(params?.providerSkill).trim() || toSafeString(currentService.providerSkill).trim(),
        price: toSafeString(params?.price).trim() || toSafeString(currentService.price).trim(),
        currency: toSafeString(params?.currency).trim()
          || (toSafeString(currentService.settlementKind).trim().toLowerCase() === 'mrc20' ? 'MRC20' : toSafeString(currentService.currency).trim()),
        mrc20Ticker: toSafeString(params?.mrc20Ticker).trim() || toSafeString(currentService.mrc20Ticker).trim(),
        mrc20Id: toSafeString(params?.mrc20Id).trim() || toSafeString(currentService.mrc20Id).trim(),
        outputType: toSafeString(params?.outputType).trim() || 'text',
      };
      const draftValidation = validateGigSquareModifyDraft(draft);
      if (!draftValidation.ok) {
        return { success: false, error: draftValidation.error, errorCode: draftValidation.errorCode };
      }
      const normalizedDraft = normalizeGigSquareModifyDraft(draft);

      const store = getMetabotStore();
      const creatorMetabot = store.getMetabotById(validation.creatorMetabotId);
      if (!creatorMetabot || !creatorMetabot.globalmetaid) {
        return {
          success: false,
          error: 'Creator MetaBot not found',
          errorCode: 'gigSquareMyServicesBlockedMissingCreatorMetabot',
        };
      }

      const settlement = normalizeGigSquareSettlementDraft({
        currency: normalizedDraft.currency,
        mrc20Ticker: normalizedDraft.mrc20Ticker,
        mrc20Id: normalizedDraft.mrc20Id,
      });
      const normalizedCurrency = settlement.protocolCurrency;
      const paymentAddress = resolveGigSquareSettlementPaymentAddress({
        owner: creatorMetabot,
        settlement,
      });

      let serviceIconUri = toSafeString(currentService.serviceIcon).trim();
      const serviceIconDataUrl = toSafeString(params?.serviceIconDataUrl).trim();
      if (serviceIconDataUrl) {
        const parsed = parseDataUrlImage(serviceIconDataUrl);
        if (!parsed) {
          return { success: false, error: 'serviceIcon data invalid', errorCode: 'service_icon_invalid' };
        }
        if (!GIG_SQUARE_IMAGE_MIME_TYPES.has(parsed.mime)) {
          return { success: false, error: 'serviceIcon type invalid', errorCode: 'service_icon_type_invalid' };
        }
        const fileResult = await createPin(store, validation.creatorMetabotId, {
          operation: 'create',
          path: '/file',
          encryption: '0',
          version: '1.0.0',
          contentType: parsed.mime,
          payload: parsed.buffer,
        });
        serviceIconUri = `metafile://${fileResult.pinId}`;
      }

      const payload = buildGigSquareServicePayload({
        draft: {
          ...normalizedDraft,
          currency: settlement.selectorCurrency,
          mrc20Ticker: settlement.mrc20Ticker,
          mrc20Id: settlement.mrc20Id,
          serviceIconUri: serviceIconUri || null,
        },
        providerGlobalMetaId: creatorMetabot.globalmetaid,
        paymentAddress,
      });
      const payloadJson = JSON.stringify(payload);
      const result = await createPin(store, validation.creatorMetabotId, buildGigSquareModifyMetaidPayload({
        targetPinId: currentService.currentPinId,
        payloadJson,
      }));
      updateGigSquareLocalServiceAfterModify({
        targetService: currentService,
        currentPinId: toSafeString(result.pinId).trim() || currentService.currentPinId,
        providerSkill: normalizedDraft.providerSkill,
        serviceName: normalizedDraft.serviceName,
        displayName: normalizedDraft.displayName,
        description: normalizedDraft.description,
        serviceIcon: serviceIconUri || null,
        price: normalizedDraft.price,
        currency: normalizedCurrency,
        outputType: normalizedDraft.outputType,
        endpoint: 'simplemsg',
        payloadJson,
      });

      let warning: string | undefined;
      await new Promise((resolve) => setTimeout(resolve, GIG_SQUARE_MUTATION_SYNC_DELAY_MS));
      try {
        await syncGigSquareMyServicesData({ refresh: true });
      } catch {
        warning = 'Modify broadcasted successfully, but chain sync may still be catching up';
      }

      return {
        success: true,
        txids: result.txids,
        pinId: result.pinId,
        creatorMetabotId: validation.creatorMetabotId,
        warning,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to modify service',
      };
    }
  });

ipcMain.handle('gigSquare:sendOrder', async (_event, params: {
    metabotId: number;
    toGlobalMetaId: string;
    toChatPubkey: string;
    orderPayload: string;
    peerName?: string | null;
    peerAvatar?: string | null;
    serviceId?: string | null;
    servicePrice?: string | null;
    serviceCurrency?: string | null;
    servicePaymentChain?: string | null;
    serviceSettlementKind?: string | null;
    serviceMrc20Ticker?: string | null;
    serviceMrc20Id?: string | null;
    servicePaymentCommitTxid?: string | null;
    serviceSkill?: string | null;
    serverBotGlobalMetaId?: string | null;
    servicePaidTx?: string | null;
  }) => {
    let releaseBuyerOrderCreation: (() => void) | null = null;
    let coworkSessionId: string | null = null;
    let attemptedPaymentTxid: string | null = null;
    let isFreeServiceOrder = false;
    try {
      const metabotId = typeof params?.metabotId === 'number' ? params.metabotId : -1;
      const toGlobalMetaId = typeof params?.toGlobalMetaId === 'string' ? params.toGlobalMetaId.trim() : '';
      const toChatPubkey = typeof params?.toChatPubkey === 'string' ? params.toChatPubkey.trim() : '';
      let orderPayload = typeof params?.orderPayload === 'string' ? params.orderPayload.trim() : '';
      const peerName = typeof params?.peerName === 'string' ? params.peerName.trim() || null : null;
      const peerAvatar = typeof params?.peerAvatar === 'string' ? params.peerAvatar.trim() || null : null;
      const serviceId = typeof params?.serviceId === 'string' ? params.serviceId.trim() || null : null;
      const servicePrice = typeof params?.servicePrice === 'string' ? params.servicePrice.trim() || null : null;
      const rawServiceCurrency = typeof params?.serviceCurrency === 'string' ? params.serviceCurrency.trim() || null : null;
      const rawServicePaymentChain = typeof params?.servicePaymentChain === 'string' ? params.servicePaymentChain.trim() || null : null;
      const rawServiceSettlementKind = typeof params?.serviceSettlementKind === 'string' ? params.serviceSettlementKind.trim() || null : null;
      const rawServiceMrc20Ticker = typeof params?.serviceMrc20Ticker === 'string' ? params.serviceMrc20Ticker.trim() || null : null;
      const rawServiceMrc20Id = typeof params?.serviceMrc20Id === 'string' ? params.serviceMrc20Id.trim() || null : null;
      const rawServicePaymentCommitTxid = typeof params?.servicePaymentCommitTxid === 'string'
        ? params.servicePaymentCommitTxid.trim() || null
        : null;
      const settlement = parseGigSquareSettlementAsset({
        paymentCurrency: rawServiceCurrency || undefined,
        settlementKind: rawServiceSettlementKind || undefined,
        mrc20Ticker: rawServiceMrc20Ticker || undefined,
        mrc20Id: rawServiceMrc20Id || undefined,
      });
      const serviceCurrency = settlement.protocolCurrency || rawServiceCurrency;
      const servicePaymentChain = rawServicePaymentChain || settlement.paymentChain;
      const serviceSettlementKind = settlement.settlementKind;
      const serviceMrc20Ticker = settlement.mrc20Ticker;
      const serviceMrc20Id = settlement.mrc20Id;
      const servicePaymentCommitTxid = serviceSettlementKind === 'mrc20'
        ? rawServicePaymentCommitTxid
        : null;
      const serviceSkill = typeof params?.serviceSkill === 'string' ? params.serviceSkill.trim() || null : null;
      const serverBotGlobalMetaId = typeof params?.serverBotGlobalMetaId === 'string' ? params.serverBotGlobalMetaId.trim() || null : null;
      let servicePaidTx = typeof params?.servicePaidTx === 'string' ? params.servicePaidTx.trim() || null : null;
      isFreeServiceOrder = isFreeServicePrice(servicePrice);
      if (isFreeServiceOrder && !servicePaidTx) {
        servicePaidTx = generateSyntheticOrderTxid();
      }
      if (isFreeServiceOrder && servicePaidTx) {
        const hasTxidLine = /(?:^|\n)\s*txid\s*[:：=]/i.test(orderPayload);
        const hasOrderReferenceLine = /(?:^|\n)\s*order(?:\s+id|\s+ref(?:erence)?)\s*[:：=]/i.test(orderPayload);
        if (!hasTxidLine && !hasOrderReferenceLine) {
          orderPayload = `${orderPayload}\norder id: ${servicePaidTx}`;
        }
      }
      attemptedPaymentTxid = servicePaidTx;

      if (!metabotId || metabotId < 0) {
        return { success: false, error: 'metabotId is required' };
      }
      if (!toGlobalMetaId) {
        return { success: false, error: 'toGlobalMetaId is required' };
      }
      if (!toChatPubkey) {
        return { success: false, error: 'toChatPubkey is required' };
      }
      if (!orderPayload) {
        return { success: false, error: 'orderPayload is required' };
      }

      const rawRequest = extractOrderRawRequest(orderPayload)
        || normalizeOrderRawRequest(extractOrderRequestText(orderPayload));
      if (rawRequest.length > ORDER_RAW_REQUEST_MAX_CHARS) {
        return {
          success: false,
          errorCode: 'order_request_too_long',
          error: `Request is too long. Keep it within ${ORDER_RAW_REQUEST_MAX_CHARS} characters.`,
        };
      }

      const serviceOrderLifecycle = getServiceOrderLifecycleService();
      try {
        releaseBuyerOrderCreation = serviceOrderLifecycle.reserveBuyerOrderCreation(
          metabotId,
          toGlobalMetaId,
          servicePaidTx
        );
      } catch (error) {
        if (
          error instanceof ServiceOrderOpenOrderExistsError
          || error instanceof ServiceOrderSelfOrderNotAllowedError
        ) {
          return {
            success: false,
            errorCode: error.code,
            error: error.message,
          };
        }
        throw error;
      }

      const store = getMetabotStore();
      const wallet = store.getMetabotWalletByMetabotId(metabotId);
      if (!wallet?.mnemonic?.trim()) {
        return { success: false, error: 'MetaBot wallet mnemonic is missing' };
      }

      try {
        const observerSession = await ensureBuyerOrderObserverSession(getCoworkStore(), {
          metabotId,
          peerGlobalMetaId: toGlobalMetaId,
          peerName,
          peerAvatar,
          serviceId,
          servicePrice,
          serviceCurrency,
          servicePaymentChain,
          serviceSettlementKind,
          serviceMrc20Ticker,
          serviceMrc20Id,
          servicePaymentCommitTxid,
          serviceSkill,
          serverBotGlobalMetaId,
          servicePaidTx,
          orderPayload,
        });
        coworkSessionId = observerSession.coworkSessionId;
        if (observerSession.initialMessage) {
          emitCoworkStreamMessage(observerSession.coworkSessionId, observerSession.initialMessage);
        }
      } catch (sessionErr) {
        console.warn('[GigSquare] Failed to create buyer observer session:', sessionErr);
      }

      const privateKeyBuffer = await getPrivateKeyBufferForEcdh(
        wallet.mnemonic,
        wallet.path || "m/44'/10001'/0'/0/0"
      );
      const sharedSecret = computeEcdhSharedSecretSha256(privateKeyBuffer, toChatPubkey);
      const encrypted = ecdhEncrypt(orderPayload, sharedSecret);
      const payloadStr = buildPrivateMessagePayload(toGlobalMetaId, encrypted, '');

      const result = await createPin(store, metabotId, {
        operation: 'create',
        path: '/protocols/simplemsg',
        encryption: '0',
        version: '1.0.0',
        contentType: 'application/json',
        payload: payloadStr,
      });

      try {
        serviceOrderLifecycle.createBuyerOrder({
          localMetabotId: metabotId,
          counterpartyGlobalMetaId: toGlobalMetaId,
          servicePinId: serviceId,
          serviceName: serviceSkill || serviceId || 'Service Order',
          paymentTxid: servicePaidTx || result.txids?.[0] || result.pinId,
          paymentChain: servicePaymentChain || normalizeServiceOrderPaymentChain(serviceCurrency),
          paymentAmount: servicePrice || '0',
          paymentCurrency: serviceCurrency || 'SPACE',
          settlementKind: serviceSettlementKind,
          mrc20Ticker: serviceMrc20Ticker || undefined,
          mrc20Id: serviceMrc20Id || undefined,
          paymentCommitTxid: servicePaymentCommitTxid || undefined,
          coworkSessionId,
          orderMessagePinId: result.pinId ?? null,
        });
      } catch (error) {
        if (
          error instanceof ServiceOrderOpenOrderExistsError
          || error instanceof ServiceOrderSelfOrderNotAllowedError
        ) {
          return {
            success: false,
            errorCode: error.code,
            error: error.message,
          };
        }
        throw error;
      }

      return { success: true, txids: result.txids };
    } catch (error) {
      if (coworkSessionId) {
        const failureMessage = getCoworkStore().addMessage(coworkSessionId, {
          type: 'system',
          content: isFreeServiceOrder
            ? `系统提示：免费服务订单发送失败。订单标识：${attemptedPaymentTxid || 'unknown'}。请稍后重试。`
            : `系统提示：支付已完成，但服务订单发送失败。付款 txid：${attemptedPaymentTxid || 'unknown'}。请稍后重试或联系服务方处理退款。`,
          metadata: {
            sourceChannel: 'metaweb_order',
            refreshSessionSummary: true,
          },
        });
        emitCoworkStreamMessage(coworkSessionId, failureMessage);
      }
      return { success: false, error: error instanceof Error ? error.message : 'Failed to send order' };
    } finally {
      releaseBuyerOrderCreation?.();
    }
  });

  ipcMain.handle('gigSquare:pingProvider', async (_event, params: {
    metabotId: number;
    toGlobalMetaId: string;
    toChatPubkey: string;
    timeoutMs?: number;
  }) => {
    try {
      const metabotId = typeof params?.metabotId === 'number' ? params.metabotId : -1;
      const toGlobalMetaId = typeof params?.toGlobalMetaId === 'string' ? params.toGlobalMetaId.trim() : '';
      const toChatPubkey = typeof params?.toChatPubkey === 'string' ? params.toChatPubkey.trim() : '';
      const timeoutMs = typeof params?.timeoutMs === 'number' ? params.timeoutMs : 15000;

      if (metabotId < 0 || !toGlobalMetaId || !toChatPubkey) {
        return { success: false, error: 'Missing required params' };
      }

      const listenerReady = await ensurePrivateChatListenerReady(metabotId, Math.min(timeoutMs, 5000));
      if (!listenerReady.success) {
        return { success: false, error: listenerReady.error || 'Local MetaWeb listener is not connected' };
      }

      const pongReceived = await getProviderPingService().pingProvider({
        metabotId,
        toGlobalMetaId,
        toChatPubkey,
        timeoutMs,
        allowOnlineFallback: true,
      });
      return { success: pongReceived };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Ping failed' };
    }
  });

  // --- Provider discovery IPC handlers ---
  ipcMain.handle('providerDiscovery:getOnlineServices', async () => withSqliteRecovery('providerDiscovery:getOnlineServices', async () => {
    try {
      const services = getProviderDiscoveryService().getDiscoverySnapshot().availableServices;
      return { success: true, services };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get online services' };
    }
  }));

  ipcMain.handle('providerDiscovery:getOnlineBots', async () => withSqliteRecovery('providerDiscovery:getOnlineBots', async () => {
    try {
      const bots = getProviderDiscoveryService().getDiscoverySnapshot().onlineBots;
      return { success: true, bots };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get online bots' };
    }
  }));

  ipcMain.handle('providerDiscovery:getSnapshot', async () => withSqliteRecovery('providerDiscovery:getSnapshot', async () => {
    try {
      const snapshot = getProviderDiscoveryService().getDiscoverySnapshot();
      return { success: true, snapshot };
    } catch (error) {
      rethrowSqliteWasmBoundsError(error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get provider discovery snapshot' };
    }
  }));

  ipcMain.handle('idbots:getAddressBalance', async (_event, options: { metabotId?: number; addresses?: { btc?: string; mvc?: string; doge?: string } }) => {
    try {
      const store = getMetabotStore();
      let btcAddr: string | undefined;
      let mvcAddr: string | undefined;
      let dogeAddr: string | undefined;
      if (options.metabotId != null) {
        const m = store.getMetabotById(options.metabotId);
        if (m) {
          btcAddr = m.btc_address;
          mvcAddr = m.mvc_address;
          dogeAddr = m.doge_address;
        }
      }
      if (options.addresses) {
        btcAddr = options.addresses.btc ?? btcAddr;
        mvcAddr = options.addresses.mvc ?? mvcAddr;
        dogeAddr = options.addresses.doge ?? dogeAddr;
      }
      const results: { btc?: { value: number; unit: string }; mvc?: { value: number; unit: string }; doge?: { value: number; unit: string } } = {};
      const promises: Promise<void>[] = [];
      if (btcAddr) {
        promises.push(
          getAddressBalance('btc', btcAddr)
            .then((r) => { results.btc = { value: r.value, unit: r.unit }; })
            .catch(() => { results.btc = { value: 0, unit: 'BTC' }; })
        );
      }
      if (mvcAddr) {
        promises.push(
          getAddressBalance('mvc', mvcAddr)
            .then((r) => { results.mvc = { value: r.value, unit: r.unit }; })
            .catch(() => { results.mvc = { value: 0, unit: 'SPACE' }; })
        );
      }
      if (dogeAddr) {
        promises.push(
          getAddressBalance('doge', dogeAddr)
            .then((r) => { results.doge = { value: r.value, unit: r.unit }; })
            .catch(() => { results.doge = { value: 0, unit: 'DOGE' }; })
        );
      }
      await Promise.all(promises);
      return { success: true, balance: results };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get balance' };
    }
  });

  ipcMain.handle('idbots:getTransferFeeSummary', async (_event, chain: TransferChain) => {
    try {
      // Use global fee rate store (same as Settings > Params & Config) so transfer and Settings show same tiers/rate
      const globalTiers = getGlobalFeeTiers()[chain];
      if (Array.isArray(globalTiers) && globalTiers.length > 0) {
        const defaultRate = getGlobalFeeRate(chain);
        return { success: true, list: globalTiers, defaultFeeRate: defaultRate };
      }
      const result = await getFeeSummary(chain);
      const defaultRate = getDefaultFeeRate(chain, result.list);
      return { success: true, list: result.list, defaultFeeRate: defaultRate };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch fee summary' };
    }
  });

  ipcMain.handle(
    'idbots:buildTransferPreview',
    async (
      _event,
      params: { metabotId: number; chain: TransferChain; toAddress: string; amountSpaceOrDoge: string; feeRate: number }
    ) => {
      try {
        const store = getMetabotStore();
        const preview = await buildTransferPreview(store, params);
        return { success: true, preview };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to build preview' };
      }
    }
  );

  ipcMain.handle(
    'idbots:executeTransfer',
    async (
      _event,
      params: { metabotId: number; chain: TransferChain; toAddress: string; amountSpaceOrDoge: string; feeRate: number }
    ) => {
      try {
        const store = getMetabotStore();
        const result = await executeTransfer(store, params);
        return result;
      } catch (error) {
        const msg =
          error != null && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string'
            ? (error as Error).message
            : 'Transfer failed';
        return { success: false, error: msg };
      }
    }
  );

  registerMetabotWalletIpcHandlers({
    ipcMain,
    getMetabotStore,
    getMetabotWalletAssets,
    async getTokenTransferFeeSummary(kind) {
      const chain = getTokenTransferChain(kind);
      const globalTiers = getGlobalFeeTiers()[chain];
      if (Array.isArray(globalTiers) && globalTiers.length > 0) {
        return {
          list: globalTiers,
          defaultFeeRate: getGlobalFeeRate(chain),
        };
      }
      const summary = await getFeeSummary(chain);
      return {
        list: summary.list,
        defaultFeeRate: getDefaultFeeRate(chain, summary.list),
      };
    },
    buildTokenTransferPreview: buildTokenTransferPreviewService,
    executeTokenTransfer: executeTokenTransferService,
  });

  ipcMain.handle('metabot:setEnabled', async (_event, id: number, enabled: boolean) => {
    try {
      const store = getMetabotStore();
      const metabot = store.updateMetabot(id, { enabled });
      return { success: true, metabot };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set metabot enabled' };
    }
  });

  // ==================== Permissions IPC Handlers ====================

  ipcMain.handle('permissions:checkCalendar', async () => {
    try {
      const status = await checkCalendarPermission();
      
      // Development mode: Auto-request permission if not determined
      // This provides a better dev experience without affecting production
      if (isDev && status === 'not-determined' && process.platform === 'darwin') {
        console.log('[Permissions] Development mode: Auto-requesting calendar permission...');
        try {
          await requestCalendarPermission();
          const newStatus = await checkCalendarPermission();
          console.log('[Permissions] Development mode: Permission status after request:', newStatus);
          return { success: true, status: newStatus, autoRequested: true };
        } catch (requestError) {
          console.warn('[Permissions] Development mode: Auto-request failed:', requestError);
        }
      }
      
      return { success: true, status };
    } catch (error) {
      console.error('[Main] Error checking calendar permission:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check permission' };
    }
  });

  ipcMain.handle('permissions:requestCalendar', async () => {
    try {
      // Request permission and check status
      const granted = await requestCalendarPermission();
      const status = await checkCalendarPermission();
      return { success: true, granted, status };
    } catch (error) {
      console.error('[Main] Error requesting calendar permission:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to request permission' };
    }
  });

  // ==================== IM Gateway IPC Handlers ====================

  ipcMain.handle('im:config:get', async () => {
    try {
      const config = getIMGatewayManager().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM config',
      };
    }
  });

  ipcMain.handle('im:config:set', async (_event, config: Partial<IMGatewayConfig>) => {
    try {
      getIMGatewayManager().setConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set IM config',
      };
    }
  });

  ipcMain.handle('im:gateway:start', async (_event, platform: IMPlatform) => {
    try {
      // Persist enabled state
      const manager = getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: true } });
      await manager.startGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:stop', async (_event, platform: IMPlatform) => {
    try {
      // Persist disabled state
      const manager = getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: false } });
      await manager.stopGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:test', async (
    _event,
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ) => {
    try {
      const result = await getIMGatewayManager().testGateway(platform, configOverride);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test gateway connectivity',
      };
    }
  });

  ipcMain.handle('im:status:get', async () => {
    try {
      const status = getIMGatewayManager().getStatus();
      return { success: true, status };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM status',
      };
    }
  });

  ipcMain.handle('generate-session-title', async (_event, userInput: string | null) => {
    return generateSessionTitle(userInput);
  });

  ipcMain.handle('get-recent-cwds', async (_event, limit?: number) => {
    const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
    return getCoworkStore().listRecentCwds(boundedLimit);
  });

  ipcMain.handle('get-api-config', async () => {
    return getCurrentApiConfig();
  });

  ipcMain.handle('check-api-config', async () => {
    const { config, error } = resolveCurrentApiConfig();
    return { hasConfig: config !== null, config, error };
  });

  ipcMain.handle('save-api-config', async (_event, config: {
    apiKey: string;
    baseURL: string;
    model: string;
    apiType?: 'anthropic' | 'openai';
  }) => {
    try {
      saveCoworkApiConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save API config',
      };
    }
  });

  // Dialog handlers
  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle('dialog:selectFile', async (_event, options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: options?.title,
      filters: options?.filters,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle(
    'dialog:saveInlineFile',
    async (
      _event,
      options?: { dataBase64?: string; fileName?: string; mimeType?: string; cwd?: string }
    ) => {
      try {
        const dataBase64 = typeof options?.dataBase64 === 'string' ? options.dataBase64.trim() : '';
        if (!dataBase64) {
          return { success: false, path: null, error: 'Missing file data' };
        }

        const buffer = Buffer.from(dataBase64, 'base64');
        if (!buffer.length) {
          return { success: false, path: null, error: 'Invalid file data' };
        }
        if (buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
          return {
            success: false,
            path: null,
            error: `File too large (max ${Math.floor(MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024))}MB)`,
          };
        }

        const dir = resolveInlineAttachmentDir(options?.cwd);
        await fs.promises.mkdir(dir, { recursive: true });

        const safeFileName = sanitizeAttachmentFileName(options?.fileName);
        const extension = inferAttachmentExtension(safeFileName, options?.mimeType);
        const baseName = extension ? safeFileName.slice(0, -extension.length) : safeFileName;
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const finalName = `${baseName || 'attachment'}-${uniqueSuffix}${extension}`;
        const outputPath = path.join(dir, finalName);

        await fs.promises.writeFile(outputPath, buffer);
        return { success: true, path: outputPath };
      } catch (error) {
        return {
          success: false,
          path: null,
          error: error instanceof Error ? error.message : 'Failed to save inline file',
        };
      }
    }
  );

  // Shell handlers - 打开文件/文件夹
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      const result = await shell.openPath(normalizedPath);
      if (result) {
        // 如果返回非空字符串，表示打开失败
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      shell.showItemInFolder(normalizedPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      const trimmed = (url || '').trim();
      if (!trimmed) {
        return { success: false, error: 'URL is empty' };
      }
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: 'Only http and https URLs are allowed' };
      }
      await shell.openExternal(trimmed);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // App update download & install
  ipcMain.handle('appUpdate:download', async (event, url: string) => {
    try {
      const filePath = await downloadUpdate(url, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('appUpdate:downloadProgress', progress);
        }
      });
      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
    }
  });

  ipcMain.handle('appUpdate:cancelDownload', async () => {
    const cancelled = cancelActiveDownload();
    return { success: cancelled };
  });

  ipcMain.handle('appUpdate:install', async (_event, filePath: string) => {
    try {
      await installUpdate(filePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Installation failed' };
    }
  });

  // API 代理处理程序 - 解决 CORS 问题
  ipcMain.handle('api:fetch', async (_event, options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => {
    try {
      if (!isAllowedRemoteFetchUrl(options.url)) {
        return {
          ok: false,
          status: 400,
          statusText: 'Invalid URL',
          headers: {},
          data: null,
          error: 'Only http/https URLs are supported',
        };
      }
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });

      const contentType = response.headers.get('content-type') || '';
      let data: string | object;

      if (contentType.includes('text/event-stream')) {
        // SSE 流式响应，返回完整的文本
        data = await response.text();
      } else if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        headers: {},
        data: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // SSE 流式 API 代理
  ipcMain.handle('api:stream', async (event, options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    requestId: string;
  }) => {
    const controller = new AbortController();

    // 存储 controller 以便后续取消
    activeStreamControllers.set(options.requestId, controller);

    try {
      if (!isAllowedRemoteFetchUrl(options.url)) {
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: 400,
          statusText: 'Invalid URL',
          error: 'Only http/https URLs are supported',
        };
      }
      const response = await session.defaultSession.fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.text();
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          error: errorData,
        };
      }

      if (!response.body) {
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: response.status,
          statusText: 'No response body',
        };
      }

      // 读取流式响应并通过 IPC 发送
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const readStream = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              event.sender.send(`api:stream:${options.requestId}:done`);
              break;
            }
            const chunk = decoder.decode(value);
            event.sender.send(`api:stream:${options.requestId}:data`, chunk);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            event.sender.send(`api:stream:${options.requestId}:abort`);
          } else {
            event.sender.send(`api:stream:${options.requestId}:error`,
              error instanceof Error ? error.message : 'Stream error');
          }
        } finally {
          activeStreamControllers.delete(options.requestId);
        }
      };

      // 异步读取流，立即返回成功状态
      readStream();

      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      activeStreamControllers.delete(options.requestId);
      return {
        ok: false,
        status: 0,
        statusText: error instanceof Error ? error.message : 'Network error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // 取消流式请求
  ipcMain.handle('api:stream:cancel', (_event, requestId: string) => {
    const controller = activeStreamControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(requestId);
      return true;
    }
    return false;
  });

  // P2P indexer IPC handlers
  ipcMain.handle('p2p:getStatus', () => p2pIndexerService.getP2PStatus());

  ipcMain.handle('p2p:getConfig', () => p2pConfigService.getConfig(getStore()));

  ipcMain.handle('p2p:setConfig', async (_e: Electron.IpcMainInvokeEvent, config: unknown) => {
    const updated = p2pConfigService.setConfig(getStore(), config as Partial<import('./services/p2pConfigService').P2PConfig>);
    await syncP2PRuntimeConfigForCurrentMetabots();
    return updated;
  });

  ipcMain.handle('p2p:getPeers', async () => {
    try {
      const res = await fetch(`${getP2PLocalBase()}/api/p2p/peers`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return [];
      const payload = await res.json();
      return p2pIndexerService.unwrapPeersPayload(payload);
    } catch {
      return [];
    }
  });

  ipcMain.handle('metaid:getUserInfo', async (_e: Electron.IpcMainInvokeEvent, params: { globalMetaId: string }) => {
    return fetchMetaidUserInfoByGlobalMetaId(params.globalMetaId);
  });

  ipcMain.handle('mcp:list', () => {
    try {
      return { success: true, servers: getMcpStore().listServers() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list MCP servers' };
    }
  });

  ipcMain.handle('mcp:create', (_event, data: McpServerFormData) => {
    try {
      getMcpStore().createServer(data);
      return { success: true, servers: getMcpStore().listServers() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create MCP server' };
    }
  });

  ipcMain.handle('mcp:update', (_event, id: string, data: Partial<McpServerFormData>) => {
    try {
      const updated = getMcpStore().updateServer(id, data);
      if (!updated) {
        return { success: false, error: 'MCP server not found' };
      }
      return { success: true, servers: getMcpStore().listServers() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update MCP server' };
    }
  });

  ipcMain.handle('mcp:delete', (_event, id: string) => {
    try {
      const deleted = getMcpStore().deleteServer(id);
      if (!deleted) {
        return { success: false, error: 'MCP server not found' };
      }
      return { success: true, servers: getMcpStore().listServers() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' };
    }
  });

  ipcMain.handle('mcp:setEnabled', (_event, options: { id: string; enabled: boolean }) => {
    try {
      const updated = getMcpStore().setEnabled(options.id, options.enabled);
      if (!updated) {
        return { success: false, error: 'MCP server not found' };
      }
      return { success: true, servers: getMcpStore().listServers() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update MCP server' };
    }
  });

  // 设置 Content Security Policy
  const setContentSecurityPolicy = () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || '5175';
      const cspDirectives = [
        "default-src 'self'",
        isDev ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}` : "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: http:",
        "connect-src 'self' https: http: ws: wss:",
        "font-src 'self' data:",
        "media-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'self'"
      ];

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': cspDirectives.join('; ')
        }
      });
    });
  };

  // 创建主窗口
  const createWindow = () => {
    // 如果窗口已经存在，就不再创建新窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: APP_NAME,
      icon: getAppIconPath(),
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 12, y: 20 },
          }
        : isWindows
          ? {
              frame: false,
              titleBarStyle: 'hidden' as const,
            }
          : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: getTitleBarOverlayOptions(),
          }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: PRELOAD_PATH,
        backgroundThrottling: false,
        devTools: isDev,
        spellcheck: false,
        enableWebSQL: false,
        autoplayPolicy: 'document-user-activation-required',
        disableDialogs: true,
        navigateOnDragDrop: false
      },
      backgroundColor: getInitialTheme() === 'dark' ? '#0F1117' : '#F8F9FB',
      show: false,
      autoHideMenuBar: true,
      enableLargerThanScreen: false
    });

    // 设置 macOS Dock 图标（开发模式下 Electron 默认图标不是应用 Logo）
    if (isMac && isDev) {
      const iconPath = path.join(__dirname, '../build/icons/png/512x512.png');
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      }
    }

    // 禁用窗口菜单
    mainWindow.setMenu(null);

    // 设置窗口的最小尺寸
    mainWindow.setMinimumSize(800, 600);

    // 设置窗口加载超时
    const loadTimeout = setTimeout(() => {
      if (mainWindow && mainWindow.webContents.isLoadingMainFrame()) {
        console.log('Window load timed out, attempting to reload...');
        scheduleReload('load-timeout');
      }
    }, 30000);

    // 清除超时
    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(loadTimeout);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      emitWindowState();
    });
    if (isDev) {
      mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        console.log(`[Renderer:${level}] ${sourceId}:${line} ${message}`);
      });
    }

    // [关键代码] 显式告诉 Electron 使用系统的代理配置
    // 这会涵盖绝大多数 VPN（如 Clash, V2Ray 等开启了"系统代理"模式的情况）
    void applySystemProxyWithLoopbackBypass(mainWindow.webContents.session, 'window session').catch((error) => {
      console.error('Failed to apply system proxy to window session:', error);
    });

    // Block unexpected window popups/navigation; only allow explicit external links.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (url === 'about:blank') {
        return;
      }
      try {
        const parsed = new URL(url);
        const isAppFile = parsed.protocol === 'file:';
        const devOrigin = new URL(DEV_SERVER_URL).origin;
        const isDevSameOrigin = isDev && parsed.origin === devOrigin;
        if (isAppFile || isDevSameOrigin) {
          return;
        }
      } catch {
        // Treat malformed URLs as blocked.
      }

      event.preventDefault();
      if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url);
      }
    });

    // 处理窗口关闭
    mainWindow.on('close', (e) => {
      // In development, close should actually quit so `npm run electron:dev`
      // restarts from a clean process. In production we keep tray behavior.
      if (mainWindow && !isQuitting && !isDev) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    // 处理渲染进程崩溃或退出
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Window render process gone:', details);
      scheduleReload('webContents-crashed');
    });

    if (isDev) {
      // 开发环境
      const maxRetries = 3;
      let retryCount = 0;

      const tryLoadURL = () => {
        mainWindow?.loadURL(DEV_SERVER_URL).catch((err) => {
          console.error('Failed to load URL:', err);
          retryCount++;
          
          if (retryCount < maxRetries) {
            console.log(`Retrying to load URL (${retryCount}/${maxRetries})...`);
            setTimeout(tryLoadURL, 3000);
          } else {
            console.error('Failed to load URL after maximum retries');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadFile(path.join(__dirname, '../resources/error.html'));
            }
          }
        });
      };

      tryLoadURL();
      
      // 打开开发者工具
      mainWindow.webContents.openDevTools();
    } else {
      // 生产环境
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // 添加错误处理
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Page failed to load:', errorCode, errorDescription);
      // 如果加载失败，尝试重新加载
      if (isDev) {
        setTimeout(() => {
          scheduleReload('did-fail-load');
        }, 3000);
      }
    });

    // 当窗口关闭时，清除引用
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    const forwardWindowState = () => emitWindowState();
    mainWindow.on('maximize', forwardWindowState);
    mainWindow.on('unmaximize', forwardWindowState);
    mainWindow.on('enter-full-screen', forwardWindowState);
    mainWindow.on('leave-full-screen', forwardWindowState);
    mainWindow.on('focus', forwardWindowState);
    mainWindow.on('blur', forwardWindowState);

    // 等待内容加载完成后再显示窗口
    mainWindow.once('ready-to-show', () => {
      emitWindowState();
      // 开机自启时不显示窗口，仅显示托盘图标
      if (!isAutoLaunched()) {
        mainWindow?.show();
      }
      // 窗口就绪后创建系统托盘
      createTray(() => mainWindow, getStore());

      // Start the scheduler
      getScheduler().start();
    });
  };

  let isCleanupFinished = false;
  let isCleanupInProgress = false;

  const runAppCleanup = async (): Promise<void> => {
    await stopMetaAppServer().catch((error) => {
      console.error('[metaapps] Failed to stop local server during cleanup:', error);
    });
    await runSharedAppCleanup({
      destroyTray,
      stopSkillWatching: () => {
        skillManager?.stopWatching();
        metaAppManager?.stopWatching();
      },
      closeMetaidRpcServer: () => {
        if (metaidRpcServer) {
          metaidRpcServer.close();
          metaidRpcServer = null;
        }
      },
      stopCoworkSessions: () => {
        if (coworkRunner) {
          console.log('[Main] Stopping cowork sessions...');
          coworkRunner.stopAllSessions();
        }
      },
      stopOpenAICompatProxy: () => stopCoworkOpenAICompatProxy(),
      stopSkillServices: async () => {
        const skillServices = getSkillServiceManager();
        await skillServices.stopAll();
      },
      stopIMGateways: async () => {
        if (imGatewayManager) {
          await imGatewayManager.stopAll();
        }
      },
      stopScheduler: () => {
        if (scheduler) {
          scheduler.stop();
        }
      },
      stopCognitiveOrchestrator,
      stopP2P: () => p2pIndexerService.stop(),
      stopProviderDiscovery: () => {
        if (providerDiscoveryService) {
          providerDiscoveryService.dispose();
          providerDiscoveryService = null;
        }
        idchatPresenceService = null;
      },
      deactivateGroupChatTasks: () => {
        try {
          const db = getStore().getDatabase();
          db.run('UPDATE group_chat_tasks SET is_active = 0');
          getStore().getSaveFunction()();
          console.log('[Main] Deactivated all group_chat_tasks (is_active = 0)');
        } catch (err) {
          console.error('[Main] Failed to deactivate group_chat_tasks:', err);
        }
      },
      log: (message) => console.log(message),
      error: (message, error) => console.error(message, error),
    });
  };

  app.on('before-quit', (e) => {
    if (isCleanupFinished) return;

    e.preventDefault();
    if (isCleanupInProgress) {
      return;
    }

    isCleanupInProgress = true;
    isQuitting = true;

    void runAppCleanup()
      .catch((error) => {
        console.error('[Main] Cleanup error:', error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  });

  const handleTerminationSignal = (signal: NodeJS.Signals) => {
    if (isCleanupFinished || isCleanupInProgress) {
      return;
    }
    console.log(`[Main] Received ${signal}, running cleanup before exit...`);
    isCleanupInProgress = true;
    isQuitting = true;
    void runAppCleanup()
      .catch((error) => {
        console.error(`[Main] Cleanup error during ${signal}:`, error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  };

  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

  // 初始化应用
  const initApp = async () => {
    await app.whenReady();

    migrateLegacyUserData();

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), 'idbots', 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }

    store = await initStore();

    // Start man-p2p local indexer (non-fatal if binary not present)
    try {
      const dataDir = path.join(app.getPath('userData'), 'man-p2p');
      const configPath = path.join(app.getPath('userData'), 'man-p2p-config.json');
      fs.mkdirSync(dataDir, { recursive: true });
      await syncP2PRuntimeConfigForCurrentMetabots();
      await p2pIndexerService.start(dataDir, configPath);
      console.log('[p2p] man-p2p started');
    } catch (err) {
      console.warn('[p2p] man-p2p failed to start, continuing without local indexer:', err);
    }

    const listenerConfig = getListenerConfigFromStore();
    if (shouldRunListener(listenerConfig)) {
      startListenerWithConfig(listenerConfig).catch((error) => {
        console.error('[MetaWebListener] auto-start failed:', error);
      });
    }

    // Global fee rate store: must init after store is ready
    const { initFeeRateStore } = require('./services/feeRateStore') as typeof import('./services/feeRateStore');
    initFeeRateStore(getStore()).catch((e: unknown) => console.error('[FeeRateStore] init failed:', e));

    metaidRpcServer = startMetaidRpcServer(getMetabotStore, getStore);
    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    // Inject store getter into claudeSettings
    setStoreGetter(() => store);
    const manager = getSkillManager();
    manager.syncBundledSkillsToUserData();
    manager.startWatching();
    const metaAppMgr = getMetaAppManager();
    metaAppMgr.syncBundledMetaAppsToUserData();
    metaAppMgr.startWatching();

    // Start skill services
    const skillServices = getSkillServiceManager();
    await skillServices.startAll();

    // [关键代码] 显式告诉 Electron 使用系统的代理配置
    // 这会涵盖绝大多数 VPN（如 Clash, V2Ray 等开启了"系统代理"模式的情况）
    await applySystemProxyWithLoopbackBypass(session.defaultSession, 'default session');

    await startCoworkOpenAICompatProxy().catch((error) => {
      console.error('Failed to start OpenAI compatibility proxy:', error);
    });

    // Inject scheduled task dependencies into the proxy server
    setScheduledTaskDeps({ getScheduledTaskStore, getScheduler });

    // 设置安全策略
    setContentSecurityPolicy();

    // 创建窗口
    createWindow();

    // Service Square: sync remote skill services on startup and every 10 minutes
    void syncGigSquareRemoteData().catch((e) => console.warn('[GigSquare] Initial sync failed', e));
    setInterval(() => {
      void syncGigSquareRemoteData().catch((e) => console.warn('[GigSquare] Periodic sync failed', e));
    }, 10 * 60 * 1000);

    // Start idchat-backed provider discovery for online service availability
    try {
      getProviderDiscoveryService().startPolling(() => {
        try {
          return listCurrentRemoteGigSquareServices();
        } catch { return []; }
      });
    } catch (e) { console.warn('[ProviderDiscovery] Failed to start polling:', e); }

    // Start Cognitive Orchestrator daemon (group chat mission control; tick every 10s)
    // Local skills (Cowork / Read-Bash) only when trigger is Boss (supervisor or metabot owner GlobalMetaID).
    const skillMgr = getSkillManager();
    startCognitiveOrchestrator(
      getStore().getDatabase(),
      getStore().getSaveFunction(),
      (id: number) => {
        const m = getMetabotStore().getMetabotById(id);
        return m
          ? {
              id: m.id,
              name: m.name,
              role: m.role ?? '',
              soul: m.soul ?? '',
              llm_id: m.llm_id ?? null,
              globalmetaid: m.globalmetaid ?? null,
              metaid: m.metaid,
              boss_global_metaid: m.boss_global_metaid ?? null,
            }
          : null;
      },
      performChatCompletionForOrchestrator,
      async (metabotId: number, groupId: string, nickName: string, content: string) => {
        const encryptedContent = encryptGroupMessageECB(content, groupId);
        const payload = {
          groupId,
          nickName,
          content: encryptedContent,
          contentType: 'text/plain',
          encryption: 'aes',
          timestamp: Date.now(),
        };
        await createPin(getMetabotStore(), metabotId, {
          operation: 'create',
          path: '/protocols/simplegroupchat',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
        });
      },
      {
        getSkillsPromptForIds: (_ids: string[]) =>
          skillMgr.buildAutoRoutingPromptForSkillIds(skillMgr.listSkills().map((s) => s.id)),
        skillsRoots: skillMgr.getAllSkillRoots(),
        runSkillTurnViaCowork: (params) =>
          runOrchestratorSkillTurn(getCoworkRunner(), getCoworkStore(), params),
      }
    );

    // Start Private Chat Daemon (ECDH decrypt, ping/pong intercept, LLM reply + broadcast)
    startPrivateChatDaemon(
      getStore().getDatabase(),
      getStore().getSaveFunction(),
      getCoworkStore(),
      getMetabotStore(),
      getCoworkRunner(),
      createPin,
      (msg) => console.log(msg),
      getServiceOrderLifecycleService(),
      async ({ skillId, skillName }) => skillMgr.buildAutoRoutingPromptForOrderSkill({ skillId, skillName }),
      (channel, data) => {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            try { win.webContents.send(channel as string, data); } catch { /* ignore */ }
          }
        });
      },
      getListenerConfigFromStore
    );

    void getServiceOrderLifecycleService().scanTimedOutOrders().catch((error) => {
      console.warn('[ServiceOrder] Initial timeout scan failed', error);
    });
    setInterval(() => {
      void getServiceOrderLifecycleService().scanTimedOutOrders().catch((error) => {
        console.warn('[ServiceOrder] Periodic timeout scan failed', error);
      });
    }, SERVICE_ORDER_TIMEOUT_SCAN_INTERVAL_MS);
    void syncServiceRefundProtocols();
    setInterval(() => {
      void syncServiceRefundProtocols();
    }, SERVICE_ORDER_REFUND_SYNC_INTERVAL_MS);

    // Auto-reconnect IM bots that were enabled before restart
    getIMGatewayManager().startAllEnabled().catch((error) => {
      console.error('[IM] Failed to auto-start enabled gateways:', error);
    });

    // 首次启动时默认开启开机自启动（先写标记再设置，避免崩溃后重复设置）
    if (!getStore().get('auto_launch_initialized')) {
      getStore().set('auto_launch_initialized', true);
      setAutoLaunchEnabled(true);
    }

    let lastLanguage = getStore().get<{ language?: string }>('app_config')?.language;
    getStore().onDidChange('app_config', () => {
      updateTitleBarOverlay();
      // 仅在语言变更时刷新托盘菜单文本
      const currentLanguage = getStore().get<{ language?: string }>('app_config')?.language;
      if (currentLanguage !== lastLanguage) {
        lastLanguage = currentLanguage;
        updateTrayMenu(() => mainWindow, getStore());
      }
    });

    // 在 macOS 上，当点击 dock 图标时显示已有窗口或重新创建
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (!mainWindow.isFocused()) mainWindow.focus();
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  };

  // 启动应用
  initApp().catch(console.error);

  // 当所有窗口关闭时退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
} 
