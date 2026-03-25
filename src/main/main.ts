import { app, BrowserWindow, ipcMain, session, nativeTheme, dialog, shell, nativeImage, systemPreferences, Menu } from 'electron';
import type { WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import os from 'os';
import { SqliteStore } from './sqliteStore';
import { CoworkStore } from './coworkStore';
import type { MemoryBackend } from './memory/memoryBackend';
import { CoworkRunner } from './libs/coworkRunner';
import { SkillManager } from './skillManager';
import { MetaAppManager } from './metaAppManager';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { getCurrentApiConfig, resolveCurrentApiConfig, setStoreGetter } from './libs/claudeSettings';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
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
import {
  getFeeSummary,
  getDefaultFeeRate,
  buildTransferPreview,
  executeTransfer,
  type TransferChain,
} from './services/transferService';
import { getRate as getGlobalFeeRate, getAllTiers as getGlobalFeeTiers } from './services/feeRateStore';
import { startMetaidRpcServer } from './services/metaidRpcServer';
import { syncMetaBotEditChangesToChain, syncMetaBotToChain } from './services/metaidCore';
import { getOfficialSkillsStatus, installOfficialSkill, syncAllOfficialSkills } from './services/skillSyncService';
import {
  startMetaWebListener,
  isListenerRunning,
  stopMetaWebListener,
  type ListenerConfig,
} from './services/metaWebListenerService';
import { startOrchestrator as startCognitiveOrchestrator, stopOrchestrator as stopCognitiveOrchestrator } from './services/cognitiveOrchestrator';
import { startPrivateChatDaemon, stopPrivateChatDaemon } from './services/privateChatDaemon';
import { performChatCompletionForOrchestrator } from './services/cognitiveChatCompletion';
import { runOrchestratorSkillTurn } from './services/orchestratorCoworkBridge';
import { createPin } from './services/metaidCore';
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
import { getP2PLocalBase } from './services/p2pLocalEndpoint';
import { getMetaidRpcBase } from './services/metaidRpcEndpoint';
import { isSemanticallyEmptyMetaidInfoPayload } from './services/metabotRestoreService';
import {
  ServiceOrderLifecycleService,
  ServiceOrderOpenOrderExistsError,
} from './services/serviceOrderLifecycleService';
import { ServiceRefundSyncService } from './services/serviceRefundSyncService';
import { buildRefundRequestPayload } from './services/serviceOrderProtocols.js';

// 设置应用程序名称
app.name = APP_NAME;
app.setName(APP_NAME);

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
const SERVICE_REFUND_FINALIZE_PATH = '/protocols/service-refund-finalize';
const SERVICE_REFUND_SYNC_SIZE = 200;
const SERVICE_REFUND_SYNC_MAX_PAGES = 10;

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

const buildServiceOrderEventMessage = (
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderRecord
): string => {
  if (type === 'refund_requested') {
    if (order.role === 'seller') {
      const pinId = order.refundRequestPinId ? ` 申请凭证：${order.refundRequestPinId}` : '';
      return `系统提示：买家已发起全额退款申请，请人工处理。${pinId}`.trim();
    }
    const pinId = order.refundRequestPinId ? ` 申请凭证：${order.refundRequestPinId}` : '';
    return `系统提示：服务订单已超时，已自动发起全额退款申请。${pinId}`.trim();
  }

  const refundTxid = order.refundTxid ? ` 退款 txid：${order.refundTxid}` : '';
  return `系统提示：退款已处理完成。${refundTxid}`.trim();
};

const publishServiceOrderEventToCowork = (
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderRecord
): void => {
  if (!order.coworkSessionId) return;
  const message = getCoworkStore().addMessage(order.coworkSessionId, {
    type: 'system',
    content: buildServiceOrderEventMessage(type, order),
    metadata: {
      sourceChannel: 'metaweb_order',
      refreshSessionSummary: true,
      serviceOrderEvent: type,
      paymentTxid: order.paymentTxid,
      refundRequestPinId: order.refundRequestPinId,
      refundTxid: order.refundTxid,
    },
  });
  emitCoworkStreamMessage(order.coworkSessionId, message);
};


const GIG_SQUARE_SERVICE_PATH = '/protocols/skill-service';
const GIG_SQUARE_CHATPUBKEY_PATH = '/info/chatpubkey';
const GIG_SQUARE_SERVICE_LIMIT = 10;
const GIG_SQUARE_SYNC_SIZE = 200;
const GIG_SQUARE_ALLOWED_CURRENCIES = new Set(['BTC', 'MVC', 'DOGE', 'SPACE']);
const GIG_SQUARE_ALLOWED_OUTPUT_TYPES = new Set(['text', 'image', 'video', 'other']);
const GIG_SQUARE_PRICE_LIMITS: Record<string, number> = {
  BTC: 1,
  MVC: 100000,
  DOGE: 10000,
  SPACE: 100000,
};
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
  serviceName: string;
  displayName: string;
  description: string;
  price: string;
  currency: string;
  providerMetaId: string;
  providerGlobalMetaId: string;
  providerAddress: string;
  avatar?: string | null;
  serviceIcon?: string | null;
  providerSkill?: string | null;
  refundRisk?: {
    hasUnresolvedRefund: boolean;
    unresolvedRefundAgeHours: number;
    hidden?: boolean;
  } | null;
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

const parseGigSquareContentSummary = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
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

const parseGigSquareService = (item: Record<string, unknown>): GigSquareService | null => {
  const summary = parseGigSquareContentSummary(item.contentSummary);
  if (!summary) return null;
  const serviceName = toSafeString(summary.serviceName).trim();
  const displayName = toSafeString(summary.displayName).trim() || serviceName || 'Service';
  const description = toSafeString(summary.description).trim();
  const price = toSafeString(summary.price).trim() || '0';
  const currency = toSafeString(summary.currency || summary.priceUnit).trim();
  const providerMetaId = toSafeString(item.metaid || item.createMetaId).trim();
  const providerGlobalMetaId = toSafeString(item.globalMetaId).trim();
  const paymentAddress = toSafeString(summary.paymentAddress).trim();
  const providerAddress = paymentAddress || toSafeString(item.address || item.addres).trim();
  const avatar = typeof summary.avatar === 'string' ? summary.avatar : null;
  const serviceIcon = typeof summary.serviceIcon === 'string' ? summary.serviceIcon.trim() || null : null;
  if (!serviceName || !providerMetaId || !providerAddress) return null;
  return {
    id: toSafeString(item.id).trim() || serviceName,
    serviceName,
    displayName,
    description,
    price,
    currency,
    providerMetaId,
    providerGlobalMetaId,
    providerAddress,
    avatar,
    serviceIcon,
  };
};

const sanitizeDbParams = (params: unknown[]): (string | number | null)[] => {
  return params.map((value) => (
    value == null || (typeof value === 'number' && Number.isNaN(value)) ? null : (value as string | number | null)
  ));
};

const normalizeGigSquareCurrency = (currency: string): string => {
  const normalized = currency.toUpperCase();
  return normalized === 'MVC' ? 'SPACE' : normalized;
};

const getGigSquarePriceLimit = (currency: string): number => {
  const normalized = normalizeGigSquareCurrency(currency);
  return normalized in GIG_SQUARE_PRICE_LIMITS ? GIG_SQUARE_PRICE_LIMITS[normalized] : GIG_SQUARE_PRICE_LIMITS.MVC;
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gig_square_services_metabot
    ON gig_square_services(metabot_id, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_gig_square_services_service_name
    ON gig_square_services(service_name);
  `);
  sqliteStore.getSaveFunction()();
  gigSquareSchemaReady = true;
};

const insertGigSquareServiceRow = (input: {
  id: string;
  pinId: string;
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
}): void => {
  ensureGigSquareSchema();
  const sqliteStore = getStore();
  const db = sqliteStore.getDatabase();
  const now = Date.now();
  db.run(
    `
      INSERT INTO gig_square_services (
        id, pin_id, txid, metabot_id, provider_global_metaid, provider_skill,
        service_name, display_name, description, service_icon, price, currency,
        skill_document, input_type, output_type, endpoint, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pin_id = excluded.pin_id,
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
        updated_at = excluded.updated_at
    `,
    sanitizeDbParams([
      input.id,
      input.pinId,
      input.txid,
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
      now,
      now,
    ])
  );
  sqliteStore.getSaveFunction()();
};

let gigSquareSyncInProgress = false;

async function syncRemoteSkillServices(): Promise<void> {
  if (gigSquareSyncInProgress) return;
  gigSquareSyncInProgress = true;
  try {
    const url = new URL('https://manapi.metaid.io/pin/path/list');
    url.searchParams.set('path', GIG_SQUARE_SERVICE_PATH);
    url.searchParams.set('size', String(GIG_SQUARE_SYNC_SIZE));
    const localPath = `/api/pin/path/list${url.search}`;
    const response = await fetchJsonWithFallbackOnMiss(localPath, url.toString(), isEmptyListDataPayload);
    if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
    const json = await response.json();
    const list = Array.isArray(json?.data?.list) ? json.data.list : [];
    const sqliteStore = getStore();
    const db = sqliteStore.getDatabase();
    const now = Date.now();
    for (const item of list as Record<string, unknown>[]) {
      const parsed = parseGigSquareService(item);
      if (!parsed) continue;
      const summary = parseGigSquareContentSummary(item.contentSummary);
      const contentSummaryJson = summary ? JSON.stringify(summary) : '';
      const providerMetaBot = summary ? toSafeString((summary as Record<string, unknown>).providerMetaBot).trim() : '';
      const providerSkill = summary ? toSafeString((summary as Record<string, unknown>).providerSkill).trim() : '';
      const skillDocument = summary ? toSafeString((summary as Record<string, unknown>).skillDocument).trim() : '';
      const inputType = summary ? toSafeString((summary as Record<string, unknown>).inputType).trim() : '';
      const outputType = summary ? toSafeString((summary as Record<string, unknown>).outputType).trim() : '';
      const endpoint = summary ? toSafeString((summary as Record<string, unknown>).endpoint).trim() : '';
      const itemTimestamp = typeof item.timestamp === 'number' && item.timestamp > 0
        ? item.timestamp
        : now;
      const params = sanitizeDbParams([
        parsed.id,
        parsed.providerMetaId,
        parsed.providerGlobalMetaId,
        parsed.providerAddress,
        parsed.serviceName,
        parsed.displayName,
        parsed.description,
        parsed.price,
        parsed.currency,
        parsed.avatar,
        parsed.serviceIcon,
        providerMetaBot || null,
        providerSkill || null,
        skillDocument || null,
        inputType || null,
        outputType || null,
        endpoint || null,
        contentSummaryJson || null,
        parsed.providerAddress,
        itemTimestamp,
      ]);
      db.run(
        `INSERT INTO remote_skill_service (
          id, metaid, global_metaid, address, service_name, display_name, description,
          price, currency, avatar, service_icon, provider_meta_bot, provider_skill,
          skill_document, input_type, output_type, endpoint, content_summary_json, payment_address, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          metaid = excluded.metaid,
          global_metaid = excluded.global_metaid,
          address = excluded.address,
          service_name = excluded.service_name,
          display_name = excluded.display_name,
          description = excluded.description,
          price = excluded.price,
          currency = excluded.currency,
          avatar = excluded.avatar,
          service_icon = excluded.service_icon,
          provider_meta_bot = excluded.provider_meta_bot,
          provider_skill = excluded.provider_skill,
          skill_document = excluded.skill_document,
          input_type = excluded.input_type,
          output_type = excluded.output_type,
          endpoint = excluded.endpoint,
          content_summary_json = excluded.content_summary_json,
          payment_address = excluded.payment_address,
          updated_at = excluded.updated_at`,
        params
      );
    }
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

  // Helper: read/write kv
  const kvGet = (key: string): string | null => {
    const r = db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!r.length || !r[0].values.length) return null;
    return String(r[0].values[0][0]);
  };
  const kvSet = (key: string, value: string) => {
    db.run('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, value, Date.now()]);
  };

  const latestPinId = kvGet(GIG_SQUARE_RATING_LATEST_PIN_KEY);

  // Accumulate deltas: serviceID -> { count, sum }
  const deltas = new Map<string, { count: number; sum: number }>();

  const now = Date.now();
  const processItem = (item: Record<string, unknown>) => {
    const itemId = typeof item.id === 'string' ? item.id.trim() : String(item.id || '').trim();
    if (!itemId) return;
    const rawSummary = item.contentSummary;
    let summary: Record<string, unknown> | null = null;
    if (typeof rawSummary === 'string') {
      try { summary = JSON.parse(rawSummary); } catch { return; }
    } else if (rawSummary && typeof rawSummary === 'object') {
      summary = rawSummary as Record<string, unknown>;
    }
    if (!summary) return;
    const serviceID = typeof summary.serviceID === 'string' ? summary.serviceID.trim() : '';
    const rateRaw = summary.rate;
    const rate = typeof rateRaw === 'string' ? parseFloat(rateRaw) : typeof rateRaw === 'number' ? rateRaw : NaN;
    if (!serviceID || isNaN(rate) || rate < 1 || rate > 5) return;

    db.run(
      'INSERT OR IGNORE INTO remote_skill_service_rating_seen (pin_id, service_id, rate, created_at) VALUES (?, ?, ?, ?)',
      [itemId, serviceID, rate, now]
    );
    if ((db.getRowsModified?.() || 0) <= 0) return;

    const d = deltas.get(serviceID) || { count: 0, sum: 0 };
    d.count += 1;
    d.sum += rate;
    deltas.set(serviceID, d);
  };

  // --- Incremental sync (newest first) ---
  let newLatestPinId: string | null = null;
  let cursor: string | undefined;
  let lastIncrementalNextCursor: string | undefined;
  let hitLatest = false;

  for (let page = 0; page < GIG_SQUARE_RATING_MAX_PAGES; page++) {
    const url = new URL('https://manapi.metaid.io/pin/path/list');
    url.searchParams.set('path', GIG_SQUARE_RATING_PATH);
    url.searchParams.set('size', String(GIG_SQUARE_RATING_SYNC_SIZE));
    if (cursor) url.searchParams.set('cursor', cursor);

    let json: Record<string, unknown>;
    try {
      const resp = await fetchJsonWithFallbackOnMiss(`/api/pin/path/list${url.search}`, url.toString(), isEmptyListDataPayload);
      if (!resp.ok) { console.warn('[GigSquare Rating] fetch failed', resp.status); break; }
      json = await resp.json() as Record<string, unknown>;
    } catch (e) {
      console.warn('[GigSquare Rating] fetch error', e);
      break;
    }

    const data = json?.data as Record<string, unknown> | undefined;
    const list = Array.isArray(data?.list) ? data!.list as Record<string, unknown>[] : [];
    const nextCursor = typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : undefined;

    if (page === 0 && list.length > 0) {
      newLatestPinId = String(list[0].id ?? '');
    }
    lastIncrementalNextCursor = nextCursor;

    for (const item of list) {
      const itemId = String(item.id ?? '');
      if (latestPinId && itemId === latestPinId) {
        hitLatest = true;
        break;
      }
      processItem(item);
    }

    if (hitLatest || !nextCursor) break;
    cursor = nextCursor;
  }

  const processedCount = Array.from(deltas.values()).reduce((s, d) => s + d.count, 0);
  console.debug(`[GigSquare Rating] incremental: processed ${processedCount} ratings, hitLatest=${hitLatest}`);

  // --- Backfill: 1 extra page of older records per sync ---
  let backfillCursor = kvGet(GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY);
  // Seed backfill cursor from last incremental page's nextCursor if not yet set
  if (!backfillCursor && lastIncrementalNextCursor) {
    backfillCursor = lastIncrementalNextCursor;
  }
  if (backfillCursor) {
    const url = new URL('https://manapi.metaid.io/pin/path/list');
    url.searchParams.set('path', GIG_SQUARE_RATING_PATH);
    url.searchParams.set('size', String(GIG_SQUARE_RATING_SYNC_SIZE));
    url.searchParams.set('cursor', backfillCursor);
    try {
      const resp = await fetchJsonWithFallbackOnMiss(`/api/pin/path/list${url.search}`, url.toString(), isEmptyListDataPayload);
      if (resp.ok) {
        const json = await resp.json() as Record<string, unknown>;
        const data = json?.data as Record<string, unknown> | undefined;
        const list = Array.isArray(data?.list) ? data!.list as Record<string, unknown>[] : [];
        const nextCursor = typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
        for (const item of list) processItem(item);
        console.debug(`[GigSquare Rating] backfill: processed ${list.length} items, nextCursor=${nextCursor ?? 'done'}`);
        if (nextCursor) {
          kvSet(GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY, nextCursor);
        } else {
          db.run('DELETE FROM kv WHERE key = ?', [GIG_SQUARE_RATING_BACKFILL_CURSOR_KEY]);
        }
      }
    } catch (e) {
      console.warn('[GigSquare Rating] backfill error', e);
    }
  }

  // --- Apply deltas to DB ---
  const affectedServices = deltas.size;
  for (const [serviceID, delta] of deltas) {
    db.run(
      `UPDATE remote_skill_service
       SET rating_avg = (rating_avg * rating_count + ?) / (rating_count + ?),
           rating_count = rating_count + ?
       WHERE id = ?`,
      [delta.sum, delta.count, delta.count, serviceID]
    );
  }
  console.debug(`[GigSquare Rating] updated ${affectedServices} services`);

  if (newLatestPinId) {
    kvSet(GIG_SQUARE_RATING_LATEST_PIN_KEY, newLatestPinId);
  }

  sqliteStore.getSaveFunction()();
}

function listRemoteSkillServicesFromDb(): GigSquareService[] {
  const db = getStore().getDatabase();
  const result = db.exec(`
    SELECT id, metaid, global_metaid, address, payment_address, service_name, display_name, description,
           price, currency, avatar, service_icon, provider_skill, updated_at, rating_count
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
    const getVal = (col: string): string => {
      const i = columns.indexOf(col);
      if (i < 0) return '';
      const v = row[i];
      return v != null ? String(v) : '';
    };
    return {
      id: getVal('id'),
      serviceName: getVal('service_name'),
      displayName: getVal('display_name'),
      description: getVal('description'),
      price: getVal('price'),
      currency: getVal('currency'),
      providerMetaId: getVal('metaid'),
      providerGlobalMetaId: getVal('global_metaid'),
      providerAddress: getVal('payment_address') || getVal('address'),
      avatar: getVal('avatar') || undefined,
      serviceIcon: getVal('service_icon') || undefined,
      providerSkill: getVal('provider_skill') || undefined,
      ratingCount: (() => { const i = columns.indexOf('rating_count'); return i >= 0 && row[i] != null ? Number(row[i]) : 0; })(),
      updatedAt: (() => { const i = columns.indexOf('updated_at'); return i >= 0 && row[i] != null ? Number(row[i]) : 0; })(),
    } as GigSquareService;
  });
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
let coworkRunner: CoworkRunner | null = null;
let skillManager: SkillManager | null = null;
let metaAppManager: MetaAppManager | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let scheduledTaskStore: ScheduledTaskStore | null = null;
let metabotStore: MetabotStore | null = null;
let serviceOrderStore: ServiceOrderStore | null = null;
let serviceOrderLifecycleService: ServiceOrderLifecycleService | null = null;
let serviceRefundSyncService: ServiceRefundSyncService | null = null;
let gigSquareSchemaReady = false;
let scheduler: Scheduler | null = null;
let metaidRpcServer: ReturnType<typeof startMetaidRpcServer> | null = null;
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
        const normalizedSkillIds = new Set(
          skillIds
            .map((id) => String(id || '').trim())
            .filter(Boolean)
            .flatMap((id) => [id, id.replace(/_/g, '-'), id.replace(/-/g, '_')])
        );
        // Inject MetaBot wallet when on-chain skills are selected, or when no skills selected (default, e.g. orchestrator)
        const shouldInject =
          skillIds.length === 0 ||
          normalizedSkillIds.has('metabot-basic') ||
          normalizedSkillIds.has('metabot-post-buzz') ||
          normalizedSkillIds.has('metabot-omni-caster') ||
          normalizedSkillIds.has('metabot-post-skillservice') ||
          normalizedSkillIds.has('metabot-chat-privatechat') ||
          normalizedSkillIds.has('metabot-check-payment');
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
        if (!shouldInject && Object.keys(overrides).length === 0) return overrides;
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
        onOrderEvent: ({ type, order }) => {
          publishServiceOrderEventToCowork(type, order);
        },
      }
    );
  }
  return serviceOrderLifecycleService;
};

async function fetchRefundFinalizePinsFromIndexer(): Promise<Array<{ pinId: string; content: unknown }>> {
  const pins: Array<{ pinId: string; content: unknown }> = [];
  let cursor: string | undefined;

  for (let page = 0; page < SERVICE_REFUND_SYNC_MAX_PAGES; page++) {
    const url = new URL('https://manapi.metaid.io/pin/path/list');
    url.searchParams.set('path', SERVICE_REFUND_FINALIZE_PATH);
    url.searchParams.set('size', String(SERVICE_REFUND_SYNC_SIZE));
    if (cursor) url.searchParams.set('cursor', cursor);

    const resp = await fetchJsonWithFallbackOnMiss(
      `/api/pin/path/list${url.search}`,
      url.toString(),
      isEmptyListDataPayload
    );
    if (!resp.ok) break;

    const json = await resp.json() as Record<string, unknown>;
    const data = json?.data as Record<string, unknown> | undefined;
    const list = Array.isArray(data?.list) ? data.list as Record<string, unknown>[] : [];
    for (const item of list) {
      const pinId = typeof item.id === 'string' ? item.id.trim() : String(item.id || '').trim();
      if (!pinId) continue;
      const content = item.contentSummary ?? item.content ?? null;
      pins.push({ pinId, content });
    }

    const nextCursor =
      typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : undefined;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return pins;
}

const getServiceRefundSyncService = () => {
  if (!serviceRefundSyncService) {
    serviceRefundSyncService = new ServiceRefundSyncService(
      getServiceOrderStore(),
      {
        fetchRefundFinalizePins: fetchRefundFinalizePinsFromIndexer,
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
        onOrderEvent: ({ type, order }) => {
          publishServiceOrderEventToCowork(type, order);
        },
      }
    );
  }
  return serviceRefundSyncService;
};

const enrichCoworkSessionWithServiceOrderSummary = <T extends { id: string }>(
  session: T | null
): (T & { serviceOrderSummary?: ReturnType<ServiceOrderStore['getSessionSummary']> }) | null => {
  if (!session) return null;
  const serviceOrderSummary = getServiceOrderStore().getSessionSummary(session.id);
  if (!serviceOrderSummary) {
    return session;
  }
  return {
    ...session,
    serviceOrderSummary,
  };
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
  const METAWEB_LISTENER_CONFIG_KEY = 'metaweb_listener_config';
  const normalizeListenerConfig = (stored?: Partial<ListenerConfig>): ListenerConfig => ({
    enabled: stored?.enabled !== undefined ? stored.enabled : true,
    groupChats: stored?.groupChats !== undefined ? stored.groupChats : false,
    privateChats: stored?.privateChats !== undefined ? stored.privateChats : true,
    serviceRequests: stored?.serviceRequests !== undefined ? stored.serviceRequests : false,
  });
  const getListenerConfigFromStore = (): ListenerConfig => {
    const stored = getStore().get<ListenerConfig>(METAWEB_LISTENER_CONFIG_KEY);
    return normalizeListenerConfig(stored);
  };
  const shouldRunListener = (config: ListenerConfig): boolean =>
    config.enabled && (config.groupChats || config.privateChats || config.serviceRequests);

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

  ipcMain.handle('idbots:getListenerConfig', async () => {
    return { success: true, config: getListenerConfigFromStore() };
  });
  ipcMain.handle('idbots:getListenerStatus', async () => {
    return { success: true, running: isListenerRunning() };
  });
  ipcMain.handle('idbots:toggleListener', async (_event, payload: { type: 'enabled' | 'groupChats' | 'privateChats' | 'serviceRequests'; enabled: boolean }) => {
    const config = getListenerConfigFromStore();
    if (payload.type === 'enabled' || payload.type === 'groupChats' || payload.type === 'privateChats' || payload.type === 'serviceRequests') {
      const next = normalizeListenerConfig({
        ...config,
        [payload.type]: payload.enabled,
      });
      getStore().set(METAWEB_LISTENER_CONFIG_KEY, next);
      if (shouldRunListener(next)) {
        await startListenerWithConfig(next);
      } else {
        stopMetaWebListener();
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
      runner.continueSession(options.sessionId, options.prompt, { systemPrompt: options.systemPrompt, skillIds: options.activeSkillIds }).catch(error => {
        console.error('Cowork continue error:', error);
      });

      const session = getCoworkStore().getSession(options.sessionId);
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
    id: string;
  }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const success = memoryBackend.deleteUserMemory(input.id, metabotId);
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
  ipcMain.handle('cowork:memory:getStats', async (_event, input?: { sessionId?: string; metabotId?: number }) => {
    try {
      const store = getCoworkStore();
      const memoryBackend = store.getMemoryBackend();
      const metabotId = resolveMemoryMetabotIdFromInput(memoryBackend, input);
      if (metabotId == null) {
        return { success: false, error: 'No MetaBot available for memory' };
      }
      const stats = memoryBackend.getUserMemoryStats(metabotId);
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

  ipcMain.handle('idbots:getMetaBots', async () => {
    try {
      const list = getMetabotStore().getAllMetaBots();
      return { success: true, list };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get MetaBots list' };
    }
  });

  ipcMain.handle('metabot:list', async () => {
    try {
      const list = getMetabotStore().listMetabots();
      return { success: true, list };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list metabots' };
    }
  });

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

  ipcMain.handle('metabot:get', async (_event, id: number) => {
    try {
      const metabot = getMetabotStore().getMetabotById(id);
      return { success: true, metabot };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get metabot' };
    }
  });

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
      return { success: ok };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MetaBot' };
    }
  });


  ipcMain.handle('gigSquare:fetchServices', async () => {
    try {
      const refundRiskByProvider = new Map(
        getServiceRefundSyncService()
          .listProviderRefundRiskSummaries()
          .map((summary) => [summary.providerGlobalMetaId, summary] as const)
      );
      const list = await Promise.all(
        listRemoteSkillServicesFromDb().map(async (item) => ({
          ...item,
          avatar: await resolvePinAssetSource(item.avatar ?? null),
          serviceIcon: await resolvePinAssetSource(item.serviceIcon ?? null),
          refundRisk: refundRiskByProvider.get(item.providerGlobalMetaId) ?? null,
        })),
      );
      return { success: true, list };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch services' };
    }
  });

  ipcMain.handle('gigSquare:syncFromRemote', async () => {
    try {
      await syncRemoteSkillServices();
      await syncRemoteSkillServiceRatings();
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
    outputType: string;
    serviceIconDataUrl?: string | null;
  }) => {
    let releaseBuyerOrderCreation: (() => void) | null = null;
    try {
      const metabotId = typeof params?.metabotId === 'number' ? params.metabotId : -1;
      const serviceName = toSafeString(params?.serviceName).trim();
      const displayName = toSafeString(params?.displayName).trim();
      const description = toSafeString(params?.description).trim();
      const providerSkill = toSafeString(params?.providerSkill).trim();
      const price = toSafeString(params?.price).trim();
      const currencyRaw = toSafeString(params?.currency).trim().toUpperCase();
      const outputType = toSafeString(params?.outputType).trim().toLowerCase();
      const serviceIconDataUrl = toSafeString(params?.serviceIconDataUrl).trim();

      if (!metabotId || metabotId < 0) return { success: false, error: 'metabotId is required' };
      if (!serviceName) return { success: false, error: 'serviceName is required' };
      if (!displayName) return { success: false, error: 'displayName is required' };
      if (!description) return { success: false, error: 'description is required' };
      if (!providerSkill) return { success: false, error: 'providerSkill is required' };
      if (!price) return { success: false, error: 'price is required' };
      if (!GIG_SQUARE_ALLOWED_CURRENCIES.has(currencyRaw)) {
        return { success: false, error: 'currency is invalid' };
      }
      if (!GIG_SQUARE_ALLOWED_OUTPUT_TYPES.has(outputType)) {
        return { success: false, error: 'outputType is invalid' };
      }
      if (!/^\d+(\.\d+)?$/.test(price)) {
        return { success: false, error: 'price is invalid' };
      }
      const priceNumber = Number(price);
      if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
        return { success: false, error: 'price is invalid' };
      }
      const normalizedCurrency = normalizeGigSquareCurrency(currencyRaw);
      const priceLimit = getGigSquarePriceLimit(normalizedCurrency);
      if (priceNumber > priceLimit) {
        return { success: false, error: 'price exceeds limit' };
      }

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

      const paymentAddress = (() => {
        if (normalizedCurrency === 'BTC') return metabot.btc_address || '';
        if (normalizedCurrency === 'DOGE') return metabot.doge_address || '';
        return metabot.mvc_address || '';
      })();

      const payload = {
        serviceName,
        displayName,
        description,
        serviceIcon: serviceIconUri || '',
        providerMetaBot: metabot.globalmetaid,
        providerSkill,
        price,
        currency: normalizedCurrency,
        skillDocument: '',
        inputType: 'text',
        outputType,
        endpoint: 'simplemsg',
        paymentAddress,
      };

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
          providerSkill,
          serviceName,
          displayName,
          description,
          serviceIcon: serviceIconUri || null,
          price,
          currency: normalizedCurrency,
          skillDocument: '',
          inputType: 'text',
          outputType,
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
    serviceSkill?: string | null;
    serverBotGlobalMetaId?: string | null;
    servicePaidTx?: string | null;
  }) => {
    let releaseBuyerOrderCreation: (() => void) | null = null;
    try {
      const metabotId = typeof params?.metabotId === 'number' ? params.metabotId : -1;
      const toGlobalMetaId = typeof params?.toGlobalMetaId === 'string' ? params.toGlobalMetaId.trim() : '';
      const toChatPubkey = typeof params?.toChatPubkey === 'string' ? params.toChatPubkey.trim() : '';
      const orderPayload = typeof params?.orderPayload === 'string' ? params.orderPayload.trim() : '';
      const peerName = typeof params?.peerName === 'string' ? params.peerName.trim() || null : null;
      const peerAvatar = typeof params?.peerAvatar === 'string' ? params.peerAvatar.trim() || null : null;
      const serviceId = typeof params?.serviceId === 'string' ? params.serviceId.trim() || null : null;
      const servicePrice = typeof params?.servicePrice === 'string' ? params.servicePrice.trim() || null : null;
      const serviceCurrency = typeof params?.serviceCurrency === 'string' ? params.serviceCurrency.trim() || null : null;
      const serviceSkill = typeof params?.serviceSkill === 'string' ? params.serviceSkill.trim() || null : null;
      const serverBotGlobalMetaId = typeof params?.serverBotGlobalMetaId === 'string' ? params.serverBotGlobalMetaId.trim() || null : null;
      const servicePaidTx = typeof params?.servicePaidTx === 'string' ? params.servicePaidTx.trim() || null : null;

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

      const serviceOrderLifecycle = getServiceOrderLifecycleService();
      try {
        releaseBuyerOrderCreation = serviceOrderLifecycle.reserveBuyerOrderCreation(
          metabotId,
          toGlobalMetaId
        );
      } catch (error) {
        if (error instanceof ServiceOrderOpenOrderExistsError) {
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

      // Create buyer-side observer session so MetaBot A can watch the conversation.
      // Each order gets its own session (keyed by txid so retries don't duplicate).
      let coworkSessionId: string | null = null;
      try {
        const coworkStoreInst = getCoworkStore();
        const txidForKey = (result.txids?.[0] || '').slice(0, 16) || String(Date.now());
        const externalConversationId = `metaweb_order:buyer:${metabotId}:${toGlobalMetaId}:${txidForKey}`;
        const existing = coworkStoreInst.getConversationMapping('metaweb_order', externalConversationId, metabotId);
        if (!existing) {
          const config = coworkStoreInst.getConfig();
          const fallbackTitle = orderPayload.split('\n')[0].slice(0, 50)
            || `Order-${(peerName || toGlobalMetaId).slice(0, 20)}`;
          const generatedTitle = await generateSessionTitle(orderPayload).catch(() => null);
          const sessionTitle = generatedTitle?.trim() || fallbackTitle;
          const session = coworkStoreInst.createSession(
            sessionTitle,
            config.workingDirectory,
            '',
            'local',
            [],
            metabotId,
            'a2a',
            toGlobalMetaId,
            peerName,
            peerAvatar
          );
          coworkStoreInst.upsertConversationMapping({
            channel: 'metaweb_order',
            externalConversationId,
            metabotId,
            coworkSessionId: session.id,
            metadataJson: JSON.stringify({
              role: 'buyer',
              peerGlobalMetaId: toGlobalMetaId,
              peerName,
              peerAvatar,
              serviceId,
              servicePrice,
              serviceCurrency,
              serviceSkill,
              serverBotGlobalMetaId,
              servicePaidTx: servicePaidTx || null,
            }),
          });
          // Add the order message as the first message — direction:'outgoing' so it shows on the right.
          // Do NOT set senderName/senderAvatar here: those fields identify the *peer* sender.
          // The local MetaBot's name/avatar come from the session's metabotName/metabotAvatar.
          const initialMessage = coworkStoreInst.addMessage(session.id, {
            type: 'user',
            content: orderPayload,
            metadata: {
              sourceChannel: 'metaweb_order',
              externalConversationId,
              direction: 'outgoing',
            },
          });
          // Notify renderer immediately so the session appears without restart
          const safeMsg = sanitizeCoworkMessageForIpc(initialMessage);
          BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) {
              try { win.webContents.send('cowork:stream:message', { sessionId: session.id, message: safeMsg }); } catch { /* ignore */ }
            }
          });
          coworkSessionId = session.id;
        } else {
          coworkSessionId = existing.coworkSessionId;
        }
      } catch (sessionErr) {
        console.warn('[GigSquare] Failed to create buyer observer session:', sessionErr);
      }

      try {
        serviceOrderLifecycle.createBuyerOrder({
          localMetabotId: metabotId,
          counterpartyGlobalMetaId: toGlobalMetaId,
          servicePinId: serviceId,
          serviceName: serviceSkill || serviceId || 'Service Order',
          paymentTxid: servicePaidTx || result.txids?.[0] || result.pinId,
          paymentChain: normalizeServiceOrderPaymentChain(serviceCurrency),
          paymentAmount: servicePrice || '0',
          paymentCurrency: serviceCurrency || 'SPACE',
          coworkSessionId,
          orderMessagePinId: result.pinId ?? null,
        });
      } catch (error) {
        if (error instanceof ServiceOrderOpenOrderExistsError) {
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

      // Ensure private chat listener is running
      const config = getListenerConfigFromStore();
      if (!config.privateChats || !shouldRunListener(config)) {
        const next = normalizeListenerConfig({ ...config, enabled: true, privateChats: true });
        getStore().set(METAWEB_LISTENER_CONFIG_KEY, next);
        await startListenerWithConfig(next);
      }

      // Send encrypted ping
      const store = getMetabotStore();
      const wallet = store.getMetabotWalletByMetabotId(metabotId);
      if (!wallet?.mnemonic?.trim()) {
        return { success: false, error: 'MetaBot wallet mnemonic is missing' };
      }
      const privateKeyBuffer = await getPrivateKeyBufferForEcdh(
        wallet.mnemonic,
        wallet.path || "m/44'/10001'/0'/0/0"
      );
      const sharedSecret = computeEcdhSharedSecretSha256(privateKeyBuffer, toChatPubkey);
      const encryptedPing = ecdhEncrypt('ping', sharedSecret);
      const pingPayload = buildPrivateMessagePayload(toGlobalMetaId, encryptedPing, '');
      await createPin(store, metabotId, {
        operation: 'create',
        path: '/protocols/simplemsg',
        encryption: '0',
        version: '1.0.0',
        contentType: 'application/json',
        payload: pingPayload,
      });

      // Poll SQLite for pong reply from provider (max timeoutMs)
      const db = getStore().getDatabase();
      const deadline = Date.now() + timeoutMs;
      const normalizeWord = (v: string) => v.toLowerCase().replace(/[^a-z]/g, '');
      const myMetabot = store.getMetabotById(metabotId);
      const myGlobalMetaId = myMetabot?.globalmetaid?.trim() ?? '';

      const waitForPong = (): Promise<boolean> =>
        new Promise((resolve) => {
          const check = () => {
            try {
              // Look for unprocessed messages from the provider addressed to our metabot
              const result = db.exec(
                `SELECT id, from_global_metaid, from_metaid, to_global_metaid, content, encryption, from_chat_pubkey
                 FROM private_chat_messages
                 WHERE is_processed = 0
                 ORDER BY id DESC
                 LIMIT 50`
              );
              if (result[0]?.values?.length) {
                const cols = result[0].columns as string[];
                for (const row of result[0].values as unknown[][]) {
                  const r = cols.reduce((acc: Record<string, unknown>, c, i) => { acc[c] = row[i]; return acc; }, {});
                  const fromGlobal = ((r.from_global_metaid as string) || (r.from_metaid as string) || '').trim();
                  const toGlobal = ((r.to_global_metaid as string) || '').trim();
                  // Must be from the provider, to our metabot
                  if (fromGlobal !== toGlobalMetaId) continue;
                  if (myGlobalMetaId && toGlobal && toGlobal !== myGlobalMetaId) continue;
                  // Try to decrypt
                  const cipherText = (r.content as string) || '';
                  const peerPubkey = (r.from_chat_pubkey as string) || toChatPubkey;
                  try {
                    const peerShared = computeEcdhSharedSecretSha256(privateKeyBuffer, peerPubkey);
                    const plain = ecdhDecrypt(cipherText, peerShared);
                    if (plain && normalizeWord(plain.trim()) === 'pong') {
                      resolve(true);
                      return;
                    }
                  } catch { /* try raw */ }
                  try {
                    const peerSharedRaw = computeEcdhSharedSecret(privateKeyBuffer, peerPubkey);
                    const plain = ecdhDecrypt(cipherText, peerSharedRaw);
                    if (plain && normalizeWord(plain.trim()) === 'pong') {
                      resolve(true);
                      return;
                    }
                  } catch { /* ignore */ }
                }
              }
            } catch { /* ignore db errors */ }
            if (Date.now() >= deadline) {
              resolve(false);
            } else {
              setTimeout(check, 1000);
            }
          };
          check();
        });

      const pongReceived = await waitForPong();
      return { success: pongReceived };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Ping failed' };
    }
  });

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
      console.log('[IPC] idbots:executeTransfer', JSON.stringify(params));
      try {
        const store = getMetabotStore();
        const result = await executeTransfer(store, params);
        console.log('[IPC] idbots:executeTransfer result', result?.success ? 'success' : 'failed', result?.txId ?? result?.error);
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
    const configPath = path.join(app.getPath('userData'), 'man-p2p-config.json');
    const ownAddresses = p2pConfigService.collectOwnAddresses(getMetabotStore().listMetabots());
    const runtimeConfig = p2pConfigService.buildRuntimeConfig(updated, ownAddresses);
    p2pConfigService.writeConfigFile(runtimeConfig, configPath);
    await p2pConfigService.reloadConfig();
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
    const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(params.globalMetaId)}`;
    const fallbackUrl = `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/${encodeURIComponent(params.globalMetaId)}`;
    const res = await fetchJsonWithFallbackOnMiss(localPath, fallbackUrl, isSemanticallyEmptyMetaidInfoPayload);
    const payload = await res.json() as { data?: Record<string, unknown> };
    if (payload?.data && typeof payload.data === 'object') {
      const avatarUrl = await resolveMetaidAvatarSource(payload.data);
      if (avatarUrl) {
        payload.data.avatarUrl = avatarUrl;
      }
    }
    return payload;
  });

  // MCP is currently suspended and not exposed to renderer.

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

    // [关键代码] 显式告诉 Electron 使用系统的代理配置
    // 这会涵盖绝大多数 VPN（如 Clash, V2Ray 等开启了"系统代理"模式的情况）
    mainWindow.webContents.session.setProxy({ mode: 'system' }).then(() => {
      console.log('已设置为跟随系统代理');
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
      const p2pConfig = p2pConfigService.getConfig(getStore());
      const dataDir = path.join(app.getPath('userData'), 'man-p2p');
      const configPath = path.join(app.getPath('userData'), 'man-p2p-config.json');
      const ownAddresses = p2pConfigService.collectOwnAddresses(getMetabotStore().listMetabots());
      const runtimeConfig = p2pConfigService.buildRuntimeConfig(p2pConfig, ownAddresses);
      fs.mkdirSync(dataDir, { recursive: true });
      p2pConfigService.writeConfigFile(runtimeConfig, configPath);
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
    await session.defaultSession.setProxy({ mode: 'system' });
    console.log('已设置为跟随系统代理');

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
    void syncRemoteSkillServices().catch((e) => console.warn('[GigSquare] Initial sync failed', e));
    void syncRemoteSkillServiceRatings().catch((e) => console.warn('[GigSquare Rating] Initial sync failed', e));
    setInterval(() => {
      void syncRemoteSkillServices().catch((e) => console.warn('[GigSquare] Periodic sync failed', e));
      void syncRemoteSkillServiceRatings().catch((e) => console.warn('[GigSquare Rating] Periodic sync failed', e));
    }, 10 * 60 * 1000);

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
      async () => skillMgr.buildAutoRoutingPrompt(),
      (channel, data) => {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            try { win.webContents.send(channel as string, data); } catch { /* ignore */ }
          }
        });
      }
    );

    void getServiceOrderLifecycleService().scanTimedOutOrders().catch((error) => {
      console.warn('[ServiceOrder] Initial timeout scan failed', error);
    });
    setInterval(() => {
      void getServiceOrderLifecycleService().scanTimedOutOrders().catch((error) => {
        console.warn('[ServiceOrder] Periodic timeout scan failed', error);
      });
    }, SERVICE_ORDER_TIMEOUT_SCAN_INTERVAL_MS);
    void getServiceRefundSyncService().syncFinalizePins().catch((error) => {
      console.warn('[ServiceOrder] Initial refund finalize sync failed', error);
    });
    setInterval(() => {
      void getServiceRefundSyncService().syncFinalizePins().catch((error) => {
        console.warn('[ServiceOrder] Periodic refund finalize sync failed', error);
      });
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
