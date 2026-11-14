/**
 * MetaID Core RPC Gateway: local HTTP service for create-pin and read operations.
 * Binds to 127.0.0.1 only for security.
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import {
  AddressType,
  BtcWallet,
  CoinType,
  SignType,
} from '@metalet/utxo-wallet-service';
import type { SqliteStore } from '../sqliteStore';
import type { MetabotStore } from '../metabotStore';
import type { MemoryBackend } from '../memory/memoryBackend';
import { handleMemoryCreateRoute, handleMemoryListRoute } from './memoryGatewayRoutes';
import {
  createPin,
  getPinData,
  setMetaidCoreStore,
  syncMetaBotEditChangesToChain,
  type MetaidDataPayload,
} from './metaidCore';
import {
  assignGroupChatTask,
  resolveMetabotIdByName,
  type AssignGroupChatTaskParams,
} from './assignGroupChatTaskService';
import {
  createGroupTask,
  proposeGroupTaskStaffing,
  listGroupTasks,
  getGroupTask,
  getGroupTaskChairMetabotId,
  postGroupTaskMessage,
  joinGroupTaskMemberWithSession,
  joinGroupTaskMember,
  kickGroupTaskMember,
  closeGroupTask,
  deleteGroupTaskDeliverable,
  getGroupTaskMemberStatus,
  setGroupTaskMemberStatus,
  reworkGroupTask,
  superviseGroupTask,
  exportGroupTask,
  listGroupChatMessagesForGateway,
} from './groupTaskService';
import { gateChairDrivingSend, gateExternalChairSend, DEFAULT_DRIVER_GRACE_MS } from './groupTaskDaemon';
import { resolveTwinSourceSessionFallback, GROUP_TASK_SOURCE_SESSION_TYPES } from './groupTaskSourceSession';
import { GroupTaskStaffingError } from './groupTaskStaffing';
import { inviteRemoteBot, searchRemoteCandidates } from './openTeamService';
import {
  searchGroupTaskSeatCandidates,
  GROUP_TASK_STAFFING_PREFERENCES,
  type GroupTaskStaffingPreference,
} from './groupTaskCandidateSearch';
import { buildMetabotDirectory } from './metabotDirectoryService';
import type { GroupTaskStatus, GroupTaskMemberStatus } from '../groupTaskStore';
import { getAddressBalance } from './addressBalanceService';
import {
  getMetabotWalletBalances,
  getWalletBalanceSnapshot,
  normalizeWalletQueryChain,
  WALLET_QUERY_CHAINS,
  type WalletQueryChain,
} from './walletQueryService';
import { executeWalletMvcTransfer } from './walletTransferService';
import { BotWalletTransferStore } from './botWalletTransferStore';
import { getRate as getGlobalFeeRate, getAllTiers as getGlobalFeeTiers, resolveCreatePinFeeRate } from './feeRateStore';
import { listenWithPortFallback, listenWithRetry } from './httpListenWithRetry';
import {
  DEFAULT_METAID_RPC_HOST,
  METAID_RPC_PORT_ENV,
  getMetaidRpcBase,
  getMetaidRpcToken,
  isAllowedMetaidRpcOrigin,
  isMetaidRpcTokenAuthorized,
  resolveMetaidRpcPort,
  setActiveMetaidRpcPort,
  writeMetaidRpcPortFile,
  writeMetaidRpcTokenFile,
} from './metaidRpcEndpoint';
import { getMetabotAccountSummary } from './metabotAccountService';
import {
  handleGroupHistoryRoute,
  handlePrivateHistoryRoute,
  handlePrivateSendRoute,
} from './chatGatewayRoutes';
import { sendBotBrowserOpenUri } from './botBrowserOpenUriService';
import { uploadMetaFile } from './metaFileUploadService';
import { buildMvc721SellPartialTx, buildMvcFtTransferRawTx, buildMvcOrderedRawTxBundle, buildMvcTransferRawTx, completeMvc721BuyTx, type BuildMvcTransferRawTxParams } from './walletRawTxService';
import { getMvcSpendSessionSnapshot } from './mvcSpendSessionState';
import {
  buyMrc721Listing,
  mrc721SellOrdersFromSqlite,
  sellMrc721Item,
  verifyMrc721Listing,
} from './mrc721Service';
import { executeTransfer } from './transferService';
import { parseAddressIndexFromPath } from './metabotWalletService';
import { executeMrc20Transfer } from './mrc20Service';
import { buildMetaappHomepage } from './metabotHomepage';
import { METAAPP_PIN_ID_PATTERN } from './metaAppProtocol';
import { readRpcJsonObjectBody } from './rpcJsonObjectBody';
import type {
  BotBrowserTabAction,
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
} from './botBrowserTabBridge';
import type {
  BotBrowserPreviewActAction,
  BotBrowserPreviewActOutcome,
  BotBrowserPreviewActRequest,
} from './botBrowserPreviewAct';

const RPC_HOST = DEFAULT_METAID_RPC_HOST;

const PIN_ROUTE_PREFIX = '/api/metaid/pin/';
const ASSIGN_GROUP_CHAT_TASK_PATH = '/api/idbots/assign-group-chat-task';
const RESOLVE_METABOT_ID_PATH = '/api/idbots/resolve-metabot-id';
const METABOT_ACCOUNT_SUMMARY_PATH = '/api/idbots/metabot/account-summary';
const ADDRESS_BALANCE_PATH = '/api/idbots/address/balance';
const FEE_RATE_SUMMARY_PATH = '/api/idbots/fee-rate-summary';
const BUILD_MVC_TRANSFER_RAW_TX_PATH = '/api/idbots/wallet/mvc/build-transfer-rawtx';
const BUILD_MRC721_SELL_PARTIAL_TX_PATH = '/api/idbots/wallet/mvc/build-mrc721-sell-partial-tx';
const COMPLETE_MRC721_BUY_TX_PATH = '/api/idbots/wallet/mvc/complete-mrc721-buy-tx';
const VERIFY_MRC721_LISTING_PATH = '/api/idbots/wallet/mvc/verify-mrc721-listing';
const BUILD_MVC_FT_TRANSFER_RAW_TX_PATH = '/api/idbots/wallet/mvc-ft/build-transfer-rawtx';
const BUILD_MVC_RAW_TX_BUNDLE_PATH = '/api/idbots/wallet/mvc/build-rawtx-bundle';
const EXECUTE_MRC20_TRANSFER_PATH = '/api/idbots/wallet/mrc20/transfer';
const SIGN_BTC_MESSAGE_PATH = '/api/idbots/wallet/btc/sign-message';
const SIGN_BTC_PSBT_PATH = '/api/idbots/wallet/btc/sign-psbt';
const UPLOAD_LARGEFILE_PATH = '/api/idbots/files/upload-largefile';
const EXECUTE_TRANSFER_PATH = '/api/idbots/wallet/transfer';
const WALLET_BALANCE_PATH = '/api/idbots/wallet/balance';
const WALLET_MVC_TRANSFER_PATH = '/api/idbots/wallet/mvc/transfer';
const WALLET_TRANSFER_RECORDS_PATH = '/api/idbots/wallet/transfer/records';
const BOT_BROWSER_OPEN_PATH = '/api/idbots/bot-browser/open';
const BOT_BROWSER_TABS_PATH = '/api/idbots/bot-browser/tabs';
const BOT_BROWSER_ACT_PATH = '/api/idbots/bot-browser/act';
const SET_METABOT_HOMEPAGE_METAAPP_PATH = '/api/idbots/metabot/homepage/set-metaapp';
const GROUP_TASK_CREATE_PATH = '/api/idbots/group-task/create';
const GROUP_TASK_PROPOSE_STAFFING_PATH = '/api/idbots/group-task/propose-staffing';
const GROUP_TASK_LIST_PATH = '/api/idbots/group-task/list';
const GROUP_TASK_SHOW_PATH = '/api/idbots/group-task/show';
const GROUP_TASK_SEND_PATH = '/api/idbots/group-task/send';
const GROUP_TASK_INVITE_PATH = '/api/idbots/group-task/invite';
/** Agent-Game bot channel (owner directive 2026-09-24): params mirror
 *  browser.app.session.* (docs/09 §4) but reach the host from bot sessions
 *  via RPC instead of the MetaApp browser bridge. Local-bot actors are
 *  auto-approved host-side (no authorization card); third-party actors keep
 *  the card on the browser bridge path. */
const AGENT_GAME_SESSION_PATH = '/api/idbots/agent-game/session';
const GROUP_TASK_KICK_MEMBER_PATH = '/api/idbots/group-task/kick-member';
const GROUP_TASK_CLOSE_PATH = '/api/idbots/group-task/close';
const GROUP_TASK_MEMBER_STATUS_PATH = '/api/idbots/group-task/member-status';
const GROUP_TASK_DELIVERABLE_DELETE_PATH = '/api/idbots/group-task/deliverable-delete';
const GROUP_TASK_SET_MEMBER_STATUS_PATH = '/api/idbots/group-task/set-member-status';
const GROUP_TASK_REWORK_PATH = '/api/idbots/group-task/rework';
const GROUP_TASK_SUPERVISE_PATH = '/api/idbots/group-task/supervise';
const GROUP_TASK_EXPORT_PATH = '/api/idbots/group-task/export';
const GROUP_TASK_SEARCH_REMOTE_PATH = '/api/idbots/group-task/search-remote-candidates';
const GROUP_TASK_SEARCH_CANDIDATES_PATH = '/api/idbots/group-task/search-candidates';
const GROUP_TASK_INVITE_REMOTE_PATH = '/api/idbots/group-task/invite-remote';
const LIST_METABOTS_PATH = '/api/idbots/list-metabots';
const PRIVATE_SEND_PATH = '/api/idbots/chat/private-send';
const PRIVATE_HISTORY_PATH = '/api/idbots/chat/private-history';
const GROUP_HISTORY_PATH = '/api/idbots/chat/group-history';
const MEMORY_LIST_PATH = '/api/idbots/memory/list';
const MEMORY_CREATE_PATH = '/api/idbots/memory/create';
const BOT_BROWSER_URI_SCHEMES = new Set(['metaid', 'pin', 'metaapp', 'map', 'metafile']);

/**
 * Field contract for POST /api/idbots/wallet/transfer.
 *
 * Callers reach this route through the local RPC gateway, so the response body
 * is the only place they can learn which field names and units are accepted.
 * Every 400 from this route therefore echoes the contract, and names any keys
 * the caller sent that this route does not read: a bare "amount must be
 * positive" after a caller sent `amount_sats` (a field this route never
 * accepts, because `amount` is already denominated in SPACE/DOGE) is
 * indistinguishable from a genuinely bad value and costs a blind retry.
 */
const WALLET_TRANSFER_FIELDS: Record<string, string> = {
  metabot_id: 'positive integer (required)',
  chain: '"mvc" | "btc" | "doge" (required; "space" is an alias of "mvc")',
  to_address: 'recipient address string (required)',
  amount: 'number > 0 (required; unit SPACE on mvc and DOGE on doge, never sats)',
  fee_rate: 'number > 0 in sats per byte (optional; defaults to the chain fee tier)',
};

function walletTransferRejection(
  message: string,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const accepted = Object.keys(WALLET_TRANSFER_FIELDS);
  const unrecognized = Object.keys(requestBody).filter((key) => !accepted.includes(key));
  return {
    success: false,
    error: unrecognized.length
      ? `${message}; unrecognized field(s): ${unrecognized.join(', ')} — accepted fields: ${accepted.join(', ')}`
      : message,
    contract: {
      path: EXECUTE_TRANSFER_PATH,
      fields: WALLET_TRANSFER_FIELDS,
    },
  };
}

export type BotBrowserRpcOpenRequest = {
  uri: string;
  actorId: string | null;
};

export type MetaidRpcServerOptions = {
  openBotBrowserUri?: (input: BotBrowserRpcOpenRequest) => Promise<void> | void;
  controlBotBrowserTabs?: (
    command: BotBrowserTabCommand,
  ) => Promise<BotBrowserTabCommandResult> | BotBrowserTabCommandResult;
  /** Gesture-free act executor for the active tab's MetaApp preview frame
   *  (botBrowserPreviewAct). Backs POST /api/idbots/bot-browser/act for local
   *  bot sessions, mirroring the tabs route. */
  controlBotBrowserAct?: (input: BotBrowserPreviewActRequest) => Promise<BotBrowserPreviewActOutcome>;
  /** Agent-Game bot channel backend: dispatch a browser.app.session.*-aligned
   *  method (docs/09 §4) for a local bot actor. Returns the same envelope
   *  shape as the agentGame:session IPC entry ({ __error } on failure). */
  agentGameSession?: (input: {
    method: string;
    payload: unknown;
    actorId: string;
    resourceUri?: string;
  }) => Promise<unknown>;
};

const BOT_BROWSER_TAB_ACTIONS = new Set<BotBrowserTabAction>([
  'open-tab',
  'close-tab',
  'switch-tab',
  'get-tabs',
  'get-active-tab',
  'get-content',
  'get-tab-info',
]);

function normalizeBotBrowserTabCommand(value: unknown): BotBrowserTabCommand {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const action = String(input.action || '').trim() as BotBrowserTabAction;
  if (!BOT_BROWSER_TAB_ACTIONS.has(action)) {
    throw new Error('action must be a supported Bot Browser tab action');
  }

  if (action === 'open-tab') {
    const uri = String(input.uri || '').trim();
    return uri ? { action, uri: normalizeBotBrowserUri(uri) } : { action };
  }

  if (action === 'close-tab' || action === 'switch-tab') {
    const tabId = Number(input.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error('tabId must be a positive integer');
    }
    return { action, tabId };
  }

  return { action };
}

const BOT_BROWSER_ACT_ACTIONS = new Set<BotBrowserPreviewActAction>(['click', 'read', 'state']);

function normalizeBotBrowserActRequest(value: unknown): BotBrowserPreviewActRequest {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const action = String(input.action || '').trim() as BotBrowserPreviewActAction;
  if (!BOT_BROWSER_ACT_ACTIONS.has(action)) {
    throw new Error('action must be one of: click, read, state');
  }
  const tabIdRaw = input.tabId;
  const tabId = tabIdRaw === undefined || tabIdRaw === null
    ? undefined
    : Number(tabIdRaw);
  if (tabId !== undefined && (!Number.isInteger(tabId) || tabId <= 0)) {
    throw new Error('tabId must be a positive integer');
  }
  const selectorRaw = input.selector;
  if (selectorRaw !== undefined && selectorRaw !== null) {
    const selector = String(selectorRaw).trim();
    if (!selector) {
      throw new Error('selector must be a non-empty CSS selector when provided');
    }
    return { action, selector, tabId };
  }
  if (action === 'click') {
    throw new Error('action "click" requires a CSS selector');
  }
  return { action, tabId };
}

function normalizeBotBrowserUri(value: unknown): string {
  const uri = String(value || '').trim();
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(uri);
  if (!match) {
    throw new Error('uri must be a supported Bot Browser URI');
  }

  const scheme = match[1].toLowerCase();
  if (!BOT_BROWSER_URI_SCHEMES.has(scheme)) {
    throw new Error(`unsupported Bot Browser URI scheme: ${scheme}`);
  }

  if (!match[2].trim() || /\s/.test(match[2])) {
    throw new Error('uri must not contain whitespace');
  }

  return `${scheme}://${match[2].trim()}`;
}

function normalizeOptionalActorId(value: unknown): string | null {
  const actorId = String(value || '').trim();
  return actorId || null;
}

function normalizeRequiredMetabotId(value: unknown): number {
  const metabotId = Number(value);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('metabot_id is required');
  }
  return metabotId;
}

function normalizeMetaappPinId(value: unknown): string {
  let pinId = String(value || '').trim();
  if (/^metaapp:\/\//i.test(pinId)) {
    pinId = pinId.slice('metaapp://'.length).trim();
  }
  if (!METAAPP_PIN_ID_PATTERN.test(pinId)) {
    throw new Error('pin_id must be a MetaApp pin id');
  }
  return pinId.toLowerCase();
}

function defaultOpenBotBrowserUri(input: BotBrowserRpcOpenRequest): void {
  sendBotBrowserOpenUri(input);
}

function createMetabotBtcWallet(store: MetabotStore, metabotId: number): BtcWallet {
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('metabot_id is required');
  }

  const walletRecord = store.getMetabotWalletByMetabotId(metabotId);
  if (!walletRecord?.mnemonic?.trim()) {
    throw new Error(`MetaBot wallet not found: ${metabotId}`);
  }

  const addressIndex = parseAddressIndexFromPath(walletRecord.path || '');
  return new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex,
    network: 'livenet',
    mnemonic: walletRecord.mnemonic,
  });
}

// Simple in-memory throttle for failed auth attempts. Binding is loopback-only,
// so this only guards against a local process hammering the server; the bearer
// token is the primary control.
const RPC_AUTH_FAILURE_WINDOW_MS = 60_000;
const RPC_AUTH_FAILURE_MAX = 30;
let rpcAuthFailures: Array<{ at: number; origin: string }> = [];

function recordRpcAuthFailure(origin: string | undefined): boolean {
  const now = Date.now();
  rpcAuthFailures = rpcAuthFailures.filter((entry) => now - entry.at < RPC_AUTH_FAILURE_WINDOW_MS);
  rpcAuthFailures.push({ at: now, origin: origin ?? '' });
  return rpcAuthFailures.length > RPC_AUTH_FAILURE_MAX;
}

export function startMetaidRpcServer(
  getMetabotStore: () => MetabotStore,
  getStore: () => SqliteStore,
  getMemoryBackend: () => MemoryBackend,
  options: MetaidRpcServerOptions = {}
): http.Server {
  setMetaidCoreStore(getStore);
  const openBotBrowserUri = options.openBotBrowserUri ?? defaultOpenBotBrowserUri;
  const controlBotBrowserTabs = options.controlBotBrowserTabs;
  const controlBotBrowserAct = options.controlBotBrowserAct;

  // Audit ledger for wallet transfers; created lazily once per server so the
  // idempotent schema ensure does not run on every request.
  let walletTransferStoreCache: BotWalletTransferStore | undefined;
  const getWalletTransferStore = (): BotWalletTransferStore => {
    walletTransferStoreCache ??= new BotWalletTransferStore(
      getStore().getDatabase(),
      getStore().getSaveFunction(),
    );
    return walletTransferStoreCache;
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // S1 hardening: the local RPC server must not be callable by arbitrary
    // web pages (localhost CSRF/SSRF). Two controls, no protocol change:
    //   1. Origin allowlist — browser-originated requests must come from an
    //      app-owned origin (dev server / file://). Native host-spawned
    //      clients send no Origin and are admitted by the token below.
    //   2. Per-launch bearer token — every endpoint requires
    //      `Authorization: Bearer <IDBOTS_RPC_TOKEN>`, which browsers cannot
    //      set cross-origin. The host passes the token to subprocesses via the
    //      IDBOTS_RPC_TOKEN env var next to IDBOTS_RPC_URL.
    const requestOrigin = typeof req.headers.origin === 'string'
      ? req.headers.origin
      : undefined;
    const originAllowed = isAllowedMetaidRpcOrigin(requestOrigin);

    if (requestOrigin && !originAllowed) {
      res.writeHead(403);
      res.end(JSON.stringify({ success: false, error: 'Origin not allowed' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      // Preflight only succeeds for allowlisted origins; browsers that cannot
      // preflight cannot attach the Authorization header to the real request.
      if (!originAllowed) {
        res.writeHead(403);
        res.end(JSON.stringify({ success: false, error: 'Origin not allowed' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', requestOrigin as string);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return;
    }

    if (!isMetaidRpcTokenAuthorized(req.headers.authorization, getMetaidRpcToken())) {
      if (recordRpcAuthFailure(requestOrigin)) {
        res.writeHead(429);
        res.end(JSON.stringify({ success: false, error: 'Too many unauthorized attempts' }));
      } else {
        res.writeHead(401);
        // Guide callers (usually bots that bypassed the skill script entry)
        // toward the supported auth channels instead of letting them guess at
        // app settings toggles. Never leak the token itself here.
        res.end(JSON.stringify({
          success: false,
          error: 'Unauthorized',
          hint: 'This local IDBots RPC gateway requires "Authorization: Bearer <token>". Bot skill scripts obtain the token automatically from the IDBOTS_RPC_TOKEN env var or the token file at IDBOTS_RPC_AUTHFILE — invoke skills through their standard scripts entry instead of calling this gateway directly. Do not ask the user to change settings; report the auth failure to the user instead.',
        }));
      }
      return;
    }

    // Echo the allowlisted origin only (never `*`) so a browser client gets
    // readable responses; native clients (no Origin) are unaffected.
    if (requestOrigin && originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
    }

    const url = req.url ?? '';
    const [pathname, search] = url.split('?');
    const persist = new URLSearchParams(search || '').get('persist') === 'true';

    if (req.method === 'POST' && pathname === BOT_BROWSER_OPEN_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }

      let parsed: { uri?: unknown; actorId?: unknown };
      try {
        parsed = JSON.parse(body || '{}') as { uri?: unknown; actorId?: unknown };
        const openRequest = {
          uri: normalizeBotBrowserUri(parsed.uri),
          actorId: normalizeOptionalActorId(parsed.actorId),
        };
        await openBotBrowserUri(openRequest);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...openRequest }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BOT_BROWSER_TABS_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }

      try {
        if (!controlBotBrowserTabs) {
          throw new Error('Bot Browser tab control is unavailable');
        }
        const parsed = JSON.parse(body || '{}') as unknown;
        const command = normalizeBotBrowserTabCommand(parsed);
        const result = await controlBotBrowserTabs(command);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BOT_BROWSER_ACT_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }

      try {
        if (!controlBotBrowserAct) {
          throw new Error('Bot Browser preview act is unavailable');
        }
        const parsed = JSON.parse(body || '{}') as unknown;
        const request = normalizeBotBrowserActRequest(parsed);
        const result = await controlBotBrowserAct(request);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === SET_METABOT_HOMEPAGE_METAAPP_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }

      let parsed: { metabot_id?: unknown; pin_id?: unknown; sync?: unknown };
      try {
        parsed = JSON.parse(body || '{}') as { metabot_id?: unknown; pin_id?: unknown; sync?: unknown };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const metabotId = normalizeRequiredMetabotId(parsed.metabot_id);
        const pinId = normalizeMetaappPinId(parsed.pin_id);
        const syncRequested = parsed.sync !== false;
        const store = getMetabotStore();
        const metabot = store.getMetabotById(metabotId);
        if (!metabot) {
          throw new Error(`MetaBot ${metabotId} not found`);
        }

        const homepage = buildMetaappHomepage(pinId);
        const homepageJson = JSON.stringify(homepage);
        const updated = store.updateMetabot(metabotId, {
          homepage: homepageJson,
        });
        if (!updated) {
          throw new Error(`Failed to update MetaBot ${metabotId}`);
        }

        let syncResult = {
          success: true,
          txids: [] as string[],
          syncedSteps: [] as string[],
        };
        if (syncRequested) {
          const result = await syncMetaBotEditChangesToChain(store, {
            metabotId,
            syncHomepage: true,
          });
          if (!result.success) {
            res.writeHead(200);
            res.end(JSON.stringify({
              success: false,
              error: `Bot homepage was saved locally, but /info/homepage sync failed: ${result.error || 'Unknown error'}`,
              metabot_id: metabotId,
              pin_id: pinId,
              homepage,
              homepage_json: homepageJson,
              saved_homepage: true,
              sync_requested: true,
              sync_result: result,
            }));
            return;
          }
          syncResult = {
            success: true,
            txids: Array.isArray(result.txids) ? result.txids : [],
            syncedSteps: Array.isArray(result.syncedSteps) ? result.syncedSteps : [],
          };
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          metabot_id: metabotId,
          pin_id: pinId,
          homepage,
          homepage_json: homepageJson,
          sync_requested: syncRequested,
          sync_result: syncResult,
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === SIGN_BTC_MESSAGE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }

      let parsed: { metabot_id?: number; message?: string; encoding?: BufferEncoding };
      try {
        parsed = JSON.parse(body) as { metabot_id?: number; message?: string; encoding?: BufferEncoding };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      const message = String(parsed.message || '');
      if (!message) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'message is required' }));
        return;
      }

      try {
        const store = getMetabotStore();
        const btcWallet = createMetabotBtcWallet(store, Number(parsed.metabot_id));
        const signature = btcWallet.signMessage(message, parsed.encoding);
        const publicKeyRaw = btcWallet.getPublicKey?.();
        const publicKey = Buffer.isBuffer(publicKeyRaw)
          ? publicKeyRaw.toString('hex')
          : String(publicKeyRaw || '');

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          signature,
          public_key: publicKey,
          address: btcWallet.getAddress(),
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === SIGN_BTC_PSBT_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }

      let parsed: {
        metabot_id?: number;
        psbt_hex?: string;
        auto_finalized?: boolean;
        to_sign_inputs?: Array<{ index?: number; sighash_types?: number[] }>;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          psbt_hex?: string;
          auto_finalized?: boolean;
          to_sign_inputs?: Array<{ index?: number; sighash_types?: number[] }>;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      const psbtHex = String(parsed.psbt_hex || '').trim();
      if (!psbtHex) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'psbt_hex is required' }));
        return;
      }

      try {
        const btcWallet = createMetabotBtcWallet(getMetabotStore(), Number(parsed.metabot_id));
        const toSignInputs = Array.isArray(parsed.to_sign_inputs)
          ? parsed.to_sign_inputs.map((item) => {
              const index = Number(item?.index);
              if (!Number.isInteger(index) || index < 0) {
                throw new Error('to_sign_inputs[].index must be a non-negative integer');
              }
              const sighashTypes = Array.isArray(item?.sighash_types)
                ? item.sighash_types
                    .map((value) => Number(value))
                    .filter((value) => Number.isInteger(value) && value >= 0)
                : [];
              if (sighashTypes.length === 0) {
                throw new Error('to_sign_inputs[].sighash_types must include at least one integer');
              }
              return { index, sighashTypes };
            })
          : undefined;

        const result = btcWallet.signTx(SignType.SIGN_PSBT, {
          psbtHex,
          autoFinalized: parsed.auto_finalized !== false,
          ...(toSignInputs ? { toSignInputs } : {}),
        });

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          raw_tx: result.rawTx,
          txid: result.txId,
          psbt_hex: result.psbtHex,
          fee: result.fee,
          tx_inputs: result.txInputs,
          tx_outputs: result.txOutputs,
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === EXECUTE_MRC20_TRANSFER_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }

      let parsed: {
        metabot_id?: number;
        mrc20_id?: string;
        symbol?: string;
        decimal?: number;
        to_address?: string;
        amount?: string | number;
        fee_rate?: number;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          mrc20_id?: string;
          symbol?: string;
          decimal?: number;
          to_address?: string;
          amount?: string | number;
          fee_rate?: number;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      const metabotId = Number(parsed.metabot_id);
      const mrc20Id = String(parsed.mrc20_id || '').trim();
      const symbol = String(parsed.symbol || '').trim().toUpperCase();
      const toAddress = String(parsed.to_address || '').trim();
      const amount = typeof parsed.amount === 'number' ? String(parsed.amount) : String(parsed.amount || '').trim();
      const decimal = Number(parsed.decimal);
      const feeRate = Number(parsed.fee_rate);

      if (!Number.isInteger(metabotId) || metabotId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'metabot_id is required' }));
        return;
      }
      if (!mrc20Id) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'mrc20_id is required' }));
        return;
      }
      if (!symbol) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'symbol is required' }));
        return;
      }
      if (!Number.isInteger(decimal) || decimal < 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'decimal must be a non-negative integer' }));
        return;
      }
      if (!toAddress) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'to_address is required' }));
        return;
      }
      if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'amount must be positive' }));
        return;
      }
      if (!Number.isFinite(feeRate) || feeRate <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'fee_rate must be positive' }));
        return;
      }

      try {
        const summary = getMetabotAccountSummary(getMetabotStore(), metabotId);
        const result = await executeMrc20Transfer(getMetabotStore(), {
          metabotId,
          asset: {
            mrc20Id,
            decimal,
            address: summary.btc_address,
            symbol,
          },
          toAddress,
          amount,
          feeRate,
        });
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          commit_txid: result.commitTxId,
          reveal_txid: result.revealTxId,
          total_fee_sats: result.totalFeeSats,
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === RESOLVE_METABOT_ID_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { name?: string };
      try {
        parsed = JSON.parse(body) as { name?: string };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (!name) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'name is required' }));
        return;
      }
      try {
        const store = getMetabotStore();
        const metabotId = resolveMetabotIdByName(store, name);
        if (metabotId == null) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: false, error: 'MetaBot not found' }));
          return;
        }
        const m = store.getMetabotById(metabotId);
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            metabot_id: metabotId,
            display_name: m?.name?.trim() ?? name,
          })
        );
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === ASSIGN_GROUP_CHAT_TASK_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let params: AssignGroupChatTaskParams;
      try {
        params = JSON.parse(body) as AssignGroupChatTaskParams;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      try {
        const db = getStore().getDatabase();
        const saveDb = getStore().getSaveFunction();
        const result = assignGroupChatTask(db, saveDb, getMetabotStore(), params);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, message: '', error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === METABOT_ACCOUNT_SUMMARY_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { metabot_id?: number };
      try {
        parsed = JSON.parse(body) as { metabot_id?: number };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const summary = getMetabotAccountSummary(getMetabotStore(), Number(parsed.metabot_id));
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...summary }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === ADDRESS_BALANCE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }

      let parsed: { metabot_id?: number; addresses?: { mvc?: string; btc?: string; doge?: string } };
      try {
        parsed = JSON.parse(body) as { metabot_id?: number; addresses?: { mvc?: string; btc?: string; doge?: string } };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const providedAddresses = parsed.addresses ?? {};
        const hasAddressPayload = parsed.addresses != null && typeof parsed.addresses === 'object';
        const normalizedAddresses: { mvc?: string; btc?: string; doge?: string } = {
          mvc: typeof providedAddresses.mvc === 'string' ? providedAddresses.mvc.trim() : '',
          btc: typeof providedAddresses.btc === 'string' ? providedAddresses.btc.trim() : '',
          doge: typeof providedAddresses.doge === 'string' ? providedAddresses.doge.trim() : '',
        };

        if (Number.isInteger(parsed.metabot_id) && Number(parsed.metabot_id) > 0) {
          const summary = getMetabotAccountSummary(getMetabotStore(), Number(parsed.metabot_id));
          if (!normalizedAddresses.mvc) normalizedAddresses.mvc = summary.mvc_address;
          if (hasAddressPayload && !normalizedAddresses.btc) normalizedAddresses.btc = summary.btc_address;
          if (hasAddressPayload && !normalizedAddresses.doge) normalizedAddresses.doge = summary.doge_address;
        }

        if (!normalizedAddresses.mvc && !normalizedAddresses.btc && !normalizedAddresses.doge) {
          throw new Error('Either metabot_id or addresses is required');
        }

        const balance: Record<string, { value: number; unit: string; satoshis: number; address: string }> = {};
        if (normalizedAddresses.mvc) {
          const mvcBalance = await getAddressBalance('mvc', normalizedAddresses.mvc);
          balance.mvc = {
            value: mvcBalance.value,
            unit: mvcBalance.unit,
            satoshis: mvcBalance.satoshis,
            address: mvcBalance.address,
          };
        }
        if (normalizedAddresses.btc) {
          const btcBalance = await getAddressBalance('btc', normalizedAddresses.btc);
          balance.btc = {
            value: btcBalance.value,
            unit: btcBalance.unit,
            satoshis: btcBalance.satoshis,
            address: btcBalance.address,
          };
        }
        if (normalizedAddresses.doge) {
          const dogeBalance = await getAddressBalance('doge', normalizedAddresses.doge);
          balance.doge = {
            value: dogeBalance.value,
            unit: dogeBalance.unit,
            satoshis: dogeBalance.satoshis,
            address: dogeBalance.address,
          };
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, balance }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === FEE_RATE_SUMMARY_PATH) {
      const query = new URLSearchParams(search || '');
      const chainRaw = (query.get('chain') || 'mvc').toLowerCase();
      const chain = chainRaw === 'btc' || chainRaw === 'doge' ? chainRaw : 'mvc';
      const tiers = getGlobalFeeTiers();
      const list = Array.isArray((tiers as Record<string, unknown[]>)[chain]) ? (tiers as Record<string, unknown[]>)[chain] : [];
      res.writeHead(200);
      res.end(
        JSON.stringify({
          success: true,
          list,
          defaultFeeRate: getGlobalFeeRate(chain),
        }),
      );
      return;
    }

    if (req.method === 'POST' && pathname === EXECUTE_TRANSFER_PATH) {
      // Deliberately left on its own inline read: the wallet-transfer
      // field-contract change owns this route's body handling (including its
      // non-object rejection and per-route contract), so routing it through the
      // shared guard here would duplicate that work in a conflicting hunk.
      // Moving it onto `readRpcJsonObjectBody` is a drop-in follow-up once that
      // change lands.
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: {
        metabot_id?: number;
        chain?: string;
        to_address?: string;
        amount?: string | number;
        fee_rate?: number;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          chain?: string;
          to_address?: string;
          amount?: string | number;
          fee_rate?: number;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection('Invalid JSON body: expected a JSON object', {})));
        return;
      }

      // `JSON.parse` accepts a literal `null`, and every field read below would
      // then throw inside this async handler: the caller gets no response at all
      // (the request hangs until it times out) and the process sees an
      // unhandled rejection. Reject a non-object body the same way malformed
      // JSON is rejected.
      if (parsed === null || typeof (parsed as unknown) !== 'object') {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection('Invalid JSON body: expected a JSON object', {})));
        return;
      }

      const chainRaw = String(parsed.chain || '').toLowerCase().trim();
      if (!chainRaw) {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection('chain is required', parsed)));
        return;
      }
      const chain = chainRaw === 'space' ? 'mvc' : chainRaw;
      if (chain !== 'mvc' && chain !== 'btc' && chain !== 'doge') {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection(`Unsupported chain "${chainRaw}"`, parsed)));
        return;
      }
      const metabotId = Number(parsed.metabot_id);
      if (!Number.isFinite(metabotId) || metabotId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection('metabot_id is required', parsed)));
        return;
      }
      const toAddress = String(parsed.to_address || '').trim();
      if (!toAddress) {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection('to_address is required', parsed)));
        return;
      }
      const amountRaw = parsed.amount ?? '';
      const amount = typeof amountRaw === 'number' ? String(amountRaw) : String(amountRaw || '').trim();
      const amountValue = Number(amount);
      if (!amount || !Number.isFinite(amountValue) || amountValue <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection('amount must be positive', parsed)));
        return;
      }
      let feeRate: number;
      if (parsed.fee_rate != null) {
        const feeRateValue = Number(parsed.fee_rate);
        if (!Number.isFinite(feeRateValue) || feeRateValue <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify(walletTransferRejection('fee_rate must be positive', parsed)));
          return;
        }
        feeRate = feeRateValue;
      } else {
        feeRate = getGlobalFeeRate(chain);
      }

      try {
        const result = await executeTransfer(getMetabotStore(), {
          metabotId,
          chain,
          toAddress,
          amountSpaceOrDoge: amount,
          feeRate,
        });
        if (!result.success) {
          res.writeHead(400);
          res.end(JSON.stringify(walletTransferRejection(result.error || 'Transfer failed', parsed)));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, txid: result.txId }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify(walletTransferRejection(String((err as Error)?.message || err), parsed)));
      }
      return;
    }

    if (req.method === 'POST' && pathname === WALLET_BALANCE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: {
        metabot_id?: number;
        metabot_ids?: unknown;
        address?: string;
        chain?: string;
      };
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      const chainParam = parsed.chain == null || String(parsed.chain).trim() === ''
        ? null
        : normalizeWalletQueryChain(parsed.chain);
      if (parsed.chain != null && String(parsed.chain).trim() !== '' && !chainParam) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'chain must be one of mvc | btc | doge' }));
        return;
      }
      const chains: WalletQueryChain[] = chainParam ? [chainParam] : WALLET_QUERY_CHAINS;

      const metabotIds: number[] = [];
      const single = Number(parsed.metabot_id);
      if (Number.isInteger(single) && single > 0) metabotIds.push(single);
      if (Array.isArray(parsed.metabot_ids)) {
        for (const raw of parsed.metabot_ids) {
          const id = Number(raw);
          if (!Number.isInteger(id) || id <= 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'metabot_ids must contain positive integers' }));
            return;
          }
          if (!metabotIds.includes(id)) metabotIds.push(id);
        }
      }
      const rawAddress = typeof parsed.address === 'string' ? parsed.address.trim() : '';
      if (metabotIds.length === 0 && !rawAddress) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'metabot_id, metabot_ids, or address is required' }));
        return;
      }

      try {
        const results: unknown[] = [];
        if (metabotIds.length > 0) {
          const batch = await getMetabotWalletBalances(getMetabotStore(), { metabotIds, chains });
          results.push(...batch.entries);
        }
        if (rawAddress) {
          const balances: Record<string, unknown> = {};
          const errors: Record<string, string> = {};
          await Promise.all(
            chains.map(async (chain) => {
              try {
                balances[chain] = await getWalletBalanceSnapshot(chain, rawAddress);
              } catch (error) {
                errors[chain] = error instanceof Error ? error.message : String(error);
              }
            }),
          );
          results.push({ address: rawAddress, balances, errors });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, queried_at: new Date().toISOString(), results }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === WALLET_MVC_TRANSFER_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: {
        metabot_id?: number;
        to?: string;
        amount_sats?: number;
        memo?: string;
        external_confirmed?: boolean;
        fee_rate?: number;
      };
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await executeWalletMvcTransfer(
          {
            metabotStore: getMetabotStore(),
            transferStore: getWalletTransferStore(),
            settingsReader: getStore(),
            getFeeRate: () => getGlobalFeeRate('mvc'),
          },
          {
            metabotId: Number(parsed.metabot_id),
            to: String(parsed.to || '').trim(),
            amountSats: Number(parsed.amount_sats),
            memo: typeof parsed.memo === 'string' ? parsed.memo : undefined,
            externalConfirmed: parsed.external_confirmed === true,
            feeRate: Number.isFinite(Number(parsed.fee_rate)) && Number(parsed.fee_rate) > 0
              ? Number(parsed.fee_rate)
              : undefined,
            origin: 'rpc:wallet/mvc/transfer',
          },
        );
        if (result.success) {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            txid: result.txid,
            fee_sats: result.fee_sats,
            channel: result.channel,
            to_metabot_id: result.to_metabot_id,
            audit_id: result.audit_id,
          }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === WALLET_TRANSFER_RECORDS_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: { limit?: number; metabot_id?: number };
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      try {
        const limit = Number.isFinite(Number(parsed.limit)) && Number(parsed.limit) > 0
          ? Math.floor(Number(parsed.limit))
          : 50;
        const metabotId = Number.isInteger(Number(parsed.metabot_id)) && Number(parsed.metabot_id) > 0
          ? Number(parsed.metabot_id)
          : undefined;
        const records = getWalletTransferStore().list(limit, metabotId);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, records }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === UPLOAD_LARGEFILE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }

      let parsed: {
        metabot_id?: number;
        file_path?: string;
        content_type?: string;
        network?: string;
        verify?: boolean;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          file_path?: string;
          content_type?: string;
          network?: string;
          verify?: boolean;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await uploadMetaFile(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          filePath: String(parsed.file_path || '').trim(),
          contentType: typeof parsed.content_type === 'string' ? parsed.content_type : undefined,
          network: typeof parsed.network === 'string' ? parsed.network : undefined,
          verify: parsed.verify === true,
        });
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        const errObj = err && typeof err === 'object' ? (err as { code?: unknown; reason?: unknown; stage?: unknown; data?: { feeAssist?: unknown } }) : null;
        res.writeHead(400);
        res.end(JSON.stringify({
          success: false,
          error: String((err as Error)?.message || err),
          ...(typeof errObj?.code === 'string' && errObj.code ? { code: errObj.code } : {}),
          ...(typeof errObj?.reason === 'string' && errObj.reason ? { reason: errObj.reason } : {}),
          ...(typeof errObj?.stage === 'string' && errObj.stage ? { stage: errObj.stage } : {}),
          ...(errObj?.data?.feeAssist ? { feeAssist: errObj.data.feeAssist } : {}),
        }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MRC721_SELL_PARTIAL_TX_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body) as {
          metabot_id?: number;
          item_pin_id?: string;
          buyer_address?: string;
          price_sats?: number;
          fee_rate?: number;
        };
        const feeRate = parsed.fee_rate != null ? Number(parsed.fee_rate) : getGlobalFeeRate('mvc');
        const listing = await sellMrc721Item(
          { buildPartialTx: (store, params) => buildMvc721SellPartialTx(store, params) },
          {
            store: getMetabotStore(),
            metabotId: Number(parsed.metabot_id),
            itemPinId: String(parsed.item_pin_id || ''),
            buyerAddress: String(parsed.buyer_address || ''),
            priceSats: Number(parsed.price_sats),
            feeRate,
            orders: mrc721SellOrdersFromSqlite(getStore()),
          },
        );
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, listing }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === COMPLETE_MRC721_BUY_TX_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body) as {
          metabot_id?: number;
          listing?: unknown;
          fee_rate?: number;
        };
        const feeRate = parsed.fee_rate != null ? Number(parsed.fee_rate) : getGlobalFeeRate('mvc');
        const result = await buyMrc721Listing(
          { completeBuy: (store, params) => completeMvc721BuyTx(store, params) },
          {
            store: getMetabotStore(),
            metabotId: Number(parsed.metabot_id),
            listing: parsed.listing,
            feeRate,
          },
        );
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === VERIFY_MRC721_LISTING_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body) as { listing?: unknown; metabot_id?: number };
        const metabotId = Number(parsed.metabot_id);
        const excludedOutpoints = Number.isInteger(metabotId) && metabotId > 0
          ? new Set(getMvcSpendSessionSnapshot(metabotId).excludeOutpoints)
          : undefined;
        const result = await verifyMrc721Listing(parsed.listing, { excludedOutpoints });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, listing: result.listing }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_TRANSFER_RAW_TX_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        metabot_id?: number;
        to_address?: string;
        amount_sats?: number;
        fee_rate?: number;
        exclude_outpoints?: string[];
        include_outpoints?: Array<{ txid?: string; vout?: number; satoshis?: number }>;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          to_address?: string;
          amount_sats?: number;
          fee_rate?: number;
          exclude_outpoints?: string[];
          include_outpoints?: Array<{ txid?: string; vout?: number; satoshis?: number }>;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await buildMvcTransferRawTx(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          toAddress: String(parsed.to_address || '').trim(),
          amountSats: Number(parsed.amount_sats),
          feeRate: Number(parsed.fee_rate),
          excludeOutpoints: parsed.exclude_outpoints,
          // Optional force-spend (MRC-721 transfers); shape-validated inside
          // buildMvcTransferRawTx (validateIncludeOutpoints). Omitted from the
          // params entirely when absent — callers diff the params contract.
          ...(parsed.include_outpoints
            ? { includeOutpoints: parsed.include_outpoints as BuildMvcTransferRawTxParams['includeOutpoints'] }
            : {}),
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_FT_TRANSFER_RAW_TX_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
        let parsed: {
          metabot_id?: number;
          token?: {
            symbol?: string;
            tokenID?: string;
            genesisHash?: string;
            codeHash?: string;
            decimal?: number;
          };
          to_address?: string;
          amount?: string;
          fee_rate?: number;
          exclude_outpoints?: string[];
          funding_raw_tx?: string;
          funding_outpoint?: string;
        };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          token?: {
            symbol?: string;
            tokenID?: string;
            genesisHash?: string;
            codeHash?: string;
            decimal?: number;
          };
          to_address?: string;
          amount?: string;
          fee_rate?: number;
          exclude_outpoints?: string[];
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await buildMvcFtTransferRawTx(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          token: {
            symbol: parsed.token?.symbol,
            tokenID: parsed.token?.tokenID,
            genesisHash: String(parsed.token?.genesisHash || ''),
            codeHash: String(parsed.token?.codeHash || ''),
            decimal: parsed.token?.decimal,
          },
          toAddress: String(parsed.to_address || '').trim(),
          amount: String(parsed.amount || ''),
          feeRate: Number(parsed.fee_rate),
          excludeOutpoints: parsed.exclude_outpoints,
          fundingRawTx: typeof parsed.funding_raw_tx === 'string' ? parsed.funding_raw_tx : undefined,
          fundingOutpoint: typeof parsed.funding_outpoint === 'string' ? parsed.funding_outpoint : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_RAW_TX_BUNDLE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        metabot_id?: number;
        steps?: Array<{
          kind?: string;
          to_address?: string;
          amount_sats?: number;
          amount?: string;
          fee_rate?: number;
          exclude_outpoints?: string[];
          token?: {
            symbol?: string;
            tokenID?: string;
            genesisHash?: string;
            codeHash?: string;
            decimal?: number;
          };
          funding?: {
            step_index?: number;
            use_output?: string;
          };
        }>;
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          steps?: Array<{
            kind?: string;
            to_address?: string;
            amount_sats?: number;
            amount?: string;
            fee_rate?: number;
            exclude_outpoints?: string[];
            token?: {
              symbol?: string;
              tokenID?: string;
              genesisHash?: string;
              codeHash?: string;
              decimal?: number;
            };
            funding?: {
              step_index?: number;
              use_output?: string;
            };
          }>;
        };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await buildMvcOrderedRawTxBundle(getMetabotStore(), {
          metabotId: Number(parsed.metabot_id),
          steps: Array.isArray(parsed.steps)
            ? parsed.steps.map((step) => {
                const kind = String(step?.kind || '').trim();
                if (kind === 'mvc_transfer') {
                return {
                  kind: 'mvc_transfer' as const,
                  toAddress: String(step?.to_address || '').trim(),
                  amountSats: Number(step?.amount_sats),
                  feeRate: Number(step?.fee_rate),
                  ...(Array.isArray(step?.exclude_outpoints) ? { excludeOutpoints: step.exclude_outpoints } : {}),
                };
              }
              return {
                  kind: 'mvc_ft_transfer' as const,
                  token: {
                    symbol: step?.token?.symbol,
                    tokenID: step?.token?.tokenID,
                    genesisHash: String(step?.token?.genesisHash || ''),
                    codeHash: String(step?.token?.codeHash || ''),
                    decimal: step?.token?.decimal,
                  },
                  toAddress: String(step?.to_address || '').trim(),
                  amount: String(step?.amount || ''),
                  feeRate: Number(step?.fee_rate),
                  ...(Array.isArray(step?.exclude_outpoints) ? { excludeOutpoints: step.exclude_outpoints } : {}),
                  funding: step?.funding
                    ? {
                        stepIndex: Number(step.funding.step_index),
                        useOutput: step.funding.use_output === 'change' ? 'change' : undefined,
                      }
                    : undefined,
                };
              })
            : [],
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'GET' && pathname.startsWith(PIN_ROUTE_PREFIX)) {
      const pinId = pathname.slice(PIN_ROUTE_PREFIX.length).trim();
      if (!pinId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'pinId required' }));
        return;
      }
      try {
        const data = await getPinData(pinId, persist);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data }));
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? String((err as Error).message)
            : String(err);
        try {
          const { appendMetaidLogLine } = require('./metaidLog');
          const logPath = path.join(app.getPath('userData'), 'metaid-rpc.log');
          const line = `[${new Date().toISOString()}] [ERROR] get-pin: ${message}\n`;
          appendMetaidLogLine(logPath, line);
        } catch {
          /* ignore */
        }
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_PROPOSE_STAFFING_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        title?: string;
        goal?: string;
        acceptance_criteria?: string;
        plan?: unknown;
        source_session_id?: unknown;
        language?: string;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      // Symmetric R2 gate: the proposal records where owner confirmation
      // happens, so it must point at a real standard/browser session too.
      // Without this, a browser source passes propose and then fails create —
      // the gap that pushed the bot to substitute another session id.
      if (parsed.source_session_id != null) {
        const candidate = String(parsed.source_session_id).trim();
        if (candidate) {
          const sessionRow = getStore()
            .getDatabase()
            .exec('SELECT session_type FROM cowork_sessions WHERE id = ?', [candidate])[0];
          const sessionType = sessionRow?.values?.[0]?.[0];
          if (!GROUP_TASK_SOURCE_SESSION_TYPES.has(String(sessionType))) {
            res.writeHead(400);
            res.end(JSON.stringify({
              success: false,
              error: sessionType == null
                ? 'source_session_id does not refer to an existing CoWork session'
                : `source_session_id must be a standard or browser CoWork session (got ${String(sessionType)})`,
            }));
            return;
          }
        }
      }
      try {
        const result = proposeGroupTaskStaffing({
          title: String(parsed.title ?? '').trim(),
          goal: String(parsed.goal ?? '').trim(),
          acceptanceCriteria: typeof parsed.acceptance_criteria === 'string' ? parsed.acceptance_criteria : undefined,
          plan: parsed.plan,
          sourceSessionId: parsed.source_session_id != null ? String(parsed.source_session_id).trim() : undefined,
          language: parsed.language === 'en' ? 'en' : parsed.language === 'zh' ? 'zh' : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        const staffing = err instanceof GroupTaskStaffingError ? err : null;
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(staffing ? 400 : 500);
        res.end(JSON.stringify({
          success: false,
          error: message,
          ...(staffing ? { code: staffing.code } : {}),
        }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_CREATE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        title?: string;
        goal?: string;
        acceptance_criteria?: string;
        member_metabot_ids?: unknown[];
        member_names?: unknown[];
        created_by?: string;
        observer_roles?: Record<string, unknown>;
        active_member_names?: unknown[];
        source_session_id?: unknown;
        proposal_id?: unknown;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const title = String(parsed.title ?? '').trim();
      const goal = String(parsed.goal ?? '').trim();
      if (!title || !goal) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'title and goal are required' }));
        return;
      }
      // R2: validate the originating CoWork session before recording it as the
      // relay target. Hotfix: browser sessions are also accepted — since the
      // bot-internet composer they are a first-class human conversation
      // surface ("where the human started this" includes the Bot Internet
      // room), and the relay pipe already delivers to browser targets. a2a /
      // group_task sessions remain rejected.
      let sourceSessionId: string | undefined;
      if (parsed.source_session_id != null) {
        const candidate = String(parsed.source_session_id).trim();
        if (candidate) {
          const sessionRow = getStore()
            .getDatabase()
            .exec('SELECT session_type FROM cowork_sessions WHERE id = ?', [candidate])[0];
          const sessionType = sessionRow?.values?.[0]?.[0];
          if (!GROUP_TASK_SOURCE_SESSION_TYPES.has(String(sessionType))) {
            res.writeHead(400);
            res.end(JSON.stringify({
              success: false,
              error: sessionType == null
                ? 'source_session_id does not refer to an existing CoWork session'
                : `source_session_id must be a standard or browser CoWork session (got ${String(sessionType)})`,
            }));
            return;
          }
          sourceSessionId = candidate;
        }
      }
      // P1/P4 (v1.1): twin-created tasks historically arrived without
      // source_session_id (task #21: the linkage was NULL, so the R2
      // acceptance relay silently skipped and the close-out never reached the
      // originating session). Best-effort UNAMBIGUOUS fallback: exactly one
      // standard session of the Twin updated within the last 15 minutes is
      // the originating session (the create call itself runs inside that
      // session's turn, so it is by definition the freshest). Zero or
      // multiple candidates → leave unset (relay degrades exactly as before)
      // — never guess wrong-session attribution.
      if (!sourceSessionId && parsed.created_by === 'twinbot') {
        try {
          const twin = getMetabotStore().getTwinWallet();
          if (twin) {
            const fallback = resolveTwinSourceSessionFallback(
              (sql, params) => getStore().getDatabase().exec(sql, params),
              twin.id,
              Date.now(),
            );
            if (fallback && 'sessionId' in fallback) {
              sourceSessionId = fallback.sessionId;
              console.log(
                `[GroupTask RPC] source session resolved by twin fallback: ${sourceSessionId}`,
              );
            } else if (fallback && 'ambiguous' in fallback) {
              console.warn(
                `[GroupTask RPC] ambiguous source session (${fallback.ambiguous} recent Twin sessions); source_session_id left unset`,
              );
            }
          }
        } catch (error) {
          console.warn(
            `[GroupTask RPC] source session fallback failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const memberMetabotIds: number[] = [];
      if (Array.isArray(parsed.member_metabot_ids)) {
        for (const raw of parsed.member_metabot_ids) {
          const id = Number(raw);
          if (!Number.isInteger(id) || id <= 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'member_metabot_ids must contain positive integers' }));
            return;
          }
          memberMetabotIds.push(id);
        }
      }
      if (Array.isArray(parsed.member_names)) {
        for (const raw of parsed.member_names) {
          const name = String(raw ?? '').trim();
          if (!name) continue;
          const id = resolveMetabotIdByName(getMetabotStore(), name);
          if (id == null) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: `MetaBot not found: ${name}` }));
            return;
          }
          memberMetabotIds.push(id);
        }
      }
      try {
        const proposalId = Number(parsed.proposal_id);
        // P0-6: observer expectations for listed-but-unassigned members.
        const observerRoles: Record<string, string> = {};
        if (parsed.observer_roles && typeof parsed.observer_roles === 'object' && !Array.isArray(parsed.observer_roles)) {
          for (const [name, value] of Object.entries(parsed.observer_roles)) {
            const text = String(value ?? '').trim();
            if (name.trim() && text) observerRoles[name.trim()] = text;
          }
        }
        const activeMemberNames = Array.isArray(parsed.active_member_names)
          ? parsed.active_member_names.map((raw) => String(raw ?? '').trim()).filter(Boolean)
          : undefined;
        const task = await createGroupTask({
          title,
          goal,
          acceptanceCriteria: typeof parsed.acceptance_criteria === 'string' ? parsed.acceptance_criteria : undefined,
          memberMetabotIds,
          createdBy: parsed.created_by === 'twinbot' ? 'twinbot' : 'user',
          proposalId: Number.isInteger(proposalId) && proposalId > 0 ? proposalId : undefined,
          observerRoles: Object.keys(observerRoles).length > 0 ? observerRoles : undefined,
          activeMemberNames,
          sourceSessionId,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, task }));
      } catch (err) {
        const staffing = err instanceof GroupTaskStaffingError ? err : null;
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(staffing ? 400 : 500);
        res.end(JSON.stringify({
          success: false,
          error: message,
          ...(staffing ? { code: staffing.code } : {}),
        }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_LIST_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: { status?: string };
      try {
        parsed = JSON.parse(body || '{}') as { status?: string };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const status = typeof parsed.status === 'string' ? parsed.status.trim() : '';
      const VALID_STATUSES: GroupTaskStatus[] = ['planning', 'executing', 'review', 'done', 'cancelled'];
      if (status && !VALID_STATUSES.includes(status as GroupTaskStatus)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: `status must be one of: ${VALID_STATUSES.join(', ')}` }));
        return;
      }
      try {
        const tasks = await listGroupTasks(status ? { status: status as GroupTaskStatus } : undefined);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, tasks }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_SHOW_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number; view?: string; before_id?: number; limit?: number };
      try {
        parsed = JSON.parse(body) as { task_id?: number; view?: string; before_id?: number; limit?: number };
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      // Optional message pagination: before_id pages the transcript backwards;
      // limit overrides the view default page size (store clamps to 1..200).
      let beforeId: number | undefined;
      if (parsed.before_id !== undefined) {
        const candidate = Number(parsed.before_id);
        if (!Number.isInteger(candidate) || candidate <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'before_id must be a positive integer' }));
          return;
        }
        beforeId = candidate;
      }
      let messageLimit: number | undefined;
      if (parsed.limit !== undefined) {
        const candidate = Number(parsed.limit);
        if (!Number.isInteger(candidate) || candidate < 1 || candidate > 200) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'limit must be an integer between 1 and 200' }));
          return;
        }
        messageLimit = candidate;
      }
      // Round-4: view=summary (default: status + members incl. last speak time
      // + deliverables + last 5 messages) or view=full (everything).
      const view = parsed.view === 'full' ? 'full' : 'summary';
      try {
        const task = await getGroupTask(taskId, { view, beforeId, messageLimit });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, task, view }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_SEND_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        task_id?: number;
        metabot_id?: number;
        metabot_name?: string;
        content?: string;
        reply_pin?: string;
        mention?: unknown[];
        driver_id?: string;
        /** P2 (v1.1): explicit escape hatch for a manual chair-identity send. */
        confirm_chair?: boolean;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      const content = String(parsed.content ?? '').trim();
      if (!content) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'content is required' }));
        return;
      }
      try {
        // Round-4 attribution: group messages MUST carry an explicit sender
        // identity (metabot_id or metabot_name). The old "default to the task
        // chair" fallback silently signed non-chair messages with the chair's
        // identity — the exact misattribution observed in #7 (Lucy's promotion
        // recorded under the chair because she did not specify an identity).
        // The chain signature is the ONLY identity source: no identity, no send.
        let metabotId = Number(parsed.metabot_id);
        if (!Number.isInteger(metabotId) || metabotId <= 0) {
          const name = typeof parsed.metabot_name === 'string' ? parsed.metabot_name.trim() : '';
          if (name) {
            const resolved = resolveMetabotIdByName(getMetabotStore(), name);
            if (resolved == null) {
              res.writeHead(400);
              res.end(JSON.stringify({ success: false, error: `MetaBot not found: ${name}` }));
              return;
            }
            metabotId = resolved;
          } else {
            // C-2: restore the documented chair default. When the caller omits
            // an explicit sender (SKILL.md documents "default = chair"), speak
            // as the task chair instead of failing — explicit identity remains
            // fully supported and takes precedence.
            metabotId = getGroupTaskChairMetabotId(taskId);
          }
        }
        // F2 (GT#11): session-level driving mutex. A CHAIR-identity send
        // (plan / dispatch / status switch) participates in the driver claim:
        // it is rejected with a readable error while another session (e.g. the
        // daemon auto-driver) holds a FRESH claim — otherwise the same logical
        // step could be driven twice (duplicate publish, contradictory
        // instructions). On success the claim is taken by this manual session,
        // so the daemon yields its ticks while the manual session drives.
        // Worker / owner sends are never driving and always pass.
        try {
          const chairMetabotId = getGroupTaskChairMetabotId(taskId);
          // P2 (v1.1): impersonation guard FIRST — an external chair-identity
          // send without the explicit confirm_chair escape hatch is refused
          // outright (403), BEFORE the F2 mutex. In #21 the Twin source
          // session retried around the mutex (the daemon's claim goes stale
          // mid-long-turn) and posted a contradictory "chair ruling"; the F2
          // retry window alone cannot prevent that.
          const impersonationGate = gateExternalChairSend({
            taskId,
            senderMetabotId: metabotId,
            chairMetabotId,
            confirmChair: parsed.confirm_chair === true,
          });
          if ('error' in impersonationGate) {
            res.writeHead(403);
            res.end(JSON.stringify({
              success: false,
              code: impersonationGate.code,
              error: impersonationGate.error,
            }));
            return;
          }
          const gateResult = gateChairDrivingSend({
            kv: getStore(),
            taskId,
            senderMetabotId: metabotId,
            chairMetabotId,
            driverId: typeof parsed.driver_id === 'string' ? parsed.driver_id.trim() : undefined,
            graceMs: DEFAULT_DRIVER_GRACE_MS,
            nowMs: Date.now(),
          });
          if ('error' in gateResult) {
            res.writeHead(409);
            res.end(JSON.stringify({
              success: false,
              error: gateResult.error,
              retryAfterMs: gateResult.retryAfterMs,
              driver: gateResult.driverId,
            }));
            return;
          }
        } catch {
          // Unknown task etc.: let the underlying post fail with its own error.
        }
        const mention = Array.isArray(parsed.mention)
          ? parsed.mention.map((m) => String(m ?? '').trim()).filter(Boolean)
          : undefined;
        const result = await postGroupTaskMessage(taskId, metabotId, content, {
          replyPin: typeof parsed.reply_pin === 'string' && parsed.reply_pin.trim() ? parsed.reply_pin.trim() : undefined,
          mention,
        });
        // P0-1: warn-and-deliver — validation issues are returned to the caller
        // but never block the chain write.
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, pinId: result.pinId, deliverableValidation: result.deliverableValidation }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_INVITE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number; metabot_id?: number; metabot_name?: string };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      let metabotId = Number(parsed.metabot_id);
      if (!Number.isInteger(metabotId) || metabotId <= 0) {
        const name = typeof parsed.metabot_name === 'string' ? parsed.metabot_name.trim() : '';
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'metabot_id or metabot_name is required' }));
          return;
        }
        const resolved = resolveMetabotIdByName(getMetabotStore(), name);
        if (resolved == null) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `MetaBot not found: ${name}` }));
          return;
        }
        metabotId = resolved;
      }
      try {
        // P1-3: the invite response carries the worker-session creation status
        // (created/ready/failed) — the chair can tell "invited & awake" from
        // "invited but the session could not be prepared" immediately.
        const result = await joinGroupTaskMemberWithSession(taskId, metabotId);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          member: result.member,
          sessionStatus: result.sessionStatus,
        }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_MEMBER_STATUS_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      try {
        // P1-4: host-computed member work status (idle/working/error) — the
        // chair queries instead of guessing whether a worker is alive.
        const members = await getGroupTaskMemberStatus(taskId);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, members }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === AGENT_GAME_SESSION_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        method?: string;
        payload?: unknown;
        actor_id?: string;
        metabot_id?: number;
        metabot_name?: string;
        resource_uri?: string;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const method = String(parsed.method ?? '').trim();
      if (!method) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'method is required' }));
        return;
      }
      // Actor resolution: explicit actor_id (globalMetaId) wins; metabot_id /
      // metabot_name resolve against the local roster. The channel is for
      // LOCAL bot sessions — a non-local actor is refused here (its card-
      // gated path is the browser bridge, docs/09 §4.1 phase 1).
      const store = getMetabotStore();
      let actorId = String(parsed.actor_id ?? '').trim();
      if (!actorId) {
        const metabotId = Number(parsed.metabot_id);
        let bot = Number.isInteger(metabotId) && metabotId > 0
          ? store.getMetabotById(metabotId)
          : null;
        if (!bot && parsed.metabot_name) {
          const resolvedId = resolveMetabotIdByName(store, String(parsed.metabot_name).trim());
          bot = resolvedId != null ? store.getMetabotById(resolvedId) : null;
        }
        actorId = bot?.globalmetaid ?? '';
      }
      if (!actorId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'actor_id (globalMetaId), metabot_id or metabot_name is required' }));
        return;
      }
      if (!store.getMetabotByGlobalMetaId(actorId)) {
        res.writeHead(403);
        res.end(JSON.stringify({ success: false, error: `actor is not a local MetaBot: ${actorId}` }));
        return;
      }
      if (!options.agentGameSession) {
        res.writeHead(501);
        res.end(JSON.stringify({ success: false, error: 'agent-game session backend not wired' }));
        return;
      }
      try {
        const result = await options.agentGameSession({
          method,
          payload: parsed.payload ?? null,
          actorId,
          resourceUri: String(parsed.resource_uri ?? '').trim() || `rpc://agent-game/${actorId}`,
        });
        // Same envelope contract as the agentGame:session IPC entry: the
        // handler returns { __error: true, code, message } on failure and the
        // method result otherwise — always HTTP 200 so bot callers can branch
        // on __error exactly like the page bridge does.
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, result }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_KICK_MEMBER_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number; metabot_id?: number; metabot_name?: string; globalmetaid?: string; reason?: string };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      // Local member: metabot_id (or metabot_name); remote member: globalmetaid.
      let metabotId: number | undefined;
      const globalmetaid = typeof parsed.globalmetaid === 'string' ? parsed.globalmetaid.trim() : '';
      if (parsed.metabot_id !== undefined && parsed.metabot_id !== null) {
        const parsedId = Number(parsed.metabot_id);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'metabot_id must be a positive integer' }));
          return;
        }
        metabotId = parsedId;
      } else if (!globalmetaid) {
        const name = typeof parsed.metabot_name === 'string' ? parsed.metabot_name.trim() : '';
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'metabot_id, metabot_name or globalmetaid is required' }));
          return;
        }
        const resolved = resolveMetabotIdByName(getMetabotStore(), name);
        if (resolved == null) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `MetaBot not found: ${name}` }));
          return;
        }
        metabotId = resolved;
      }
      try {
        const member = await kickGroupTaskMember({
          taskId,
          metabotId,
          globalmetaid: metabotId == null ? globalmetaid : undefined,
          reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, member }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_SEARCH_CANDIDATES_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: {
        query?: string;
        role_hint?: string;
        domain_label?: string;
        skills?: unknown;
        limit?: number;
        staffing_preference?: unknown;
      };
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const limit = parsed.limit === undefined || parsed.limit === null ? undefined : Number(parsed.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'limit must be a positive integer' }));
        return;
      }
      let staffingPreference: GroupTaskStaffingPreference | undefined;
      if (parsed.staffing_preference !== undefined && parsed.staffing_preference !== null) {
        const value = String(parsed.staffing_preference).trim();
        if (!(GROUP_TASK_STAFFING_PREFERENCES as readonly string[]).includes(value)) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            error: `staffing_preference must be one of: ${GROUP_TASK_STAFFING_PREFERENCES.join(', ')}`,
          }));
          return;
        }
        staffingPreference = value as GroupTaskStaffingPreference;
      }
      const skills = Array.isArray(parsed.skills)
        ? parsed.skills.map((item) => String(item ?? '').trim()).filter(Boolean)
        : undefined;
      try {
        const result = await searchGroupTaskSeatCandidates({
          query: typeof parsed.query === 'string' ? parsed.query : undefined,
          roleHint: typeof parsed.role_hint === 'string' ? parsed.role_hint : undefined,
          domainLabel: typeof parsed.domain_label === 'string' ? parsed.domain_label : undefined,
          skills,
          limit,
          staffingPreference,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_SEARCH_REMOTE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: { query?: string; skill?: string; limit?: number };
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const limit = parsed.limit === undefined || parsed.limit === null ? undefined : Number(parsed.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'limit must be a positive integer' }));
        return;
      }
      try {
        const candidates = await searchRemoteCandidates({
          keyword: typeof parsed.query === 'string' ? parsed.query : undefined,
          skill: typeof parsed.skill === 'string' ? parsed.skill : undefined,
          limit,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, candidates }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_INVITE_REMOTE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number; globalmetaid?: string; name?: string; required_skills?: unknown[]; allow_reinvite?: unknown };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      const globalmetaid = typeof parsed.globalmetaid === 'string' ? parsed.globalmetaid.trim() : '';
      if (!globalmetaid) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'globalmetaid is required' }));
        return;
      }
      let requiredSkills: string[] | undefined;
      if (parsed.required_skills !== undefined) {
        if (!Array.isArray(parsed.required_skills)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'required_skills must be an array of strings' }));
          return;
        }
        requiredSkills = parsed.required_skills.map((s) => String(s ?? '').trim()).filter(Boolean);
      }
      try {
        const result = await inviteRemoteBot({
          taskId,
          inviteeGlobalMetaId: globalmetaid,
          inviteeName: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined,
          requiredSkills,
          allowReinvite: parsed.allow_reinvite === true,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_CLOSE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        task_id?: number;
        status?: string;
        reason?: string;
        closure_note?: string;
        external_deliveries?: Array<{ uri?: string; kind?: string; note?: string }>;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      const status = String(parsed.status ?? '').trim();
      if (status !== 'done' && status !== 'cancelled') {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: "status must be 'done' or 'cancelled'" }));
        return;
      }
      // P1-4 (task #39): external_deliveries + closure_note let the chair
      // close a task whose remaining work was finished via Twin direct
      // delegation with the real artifacts in the ledger.
      const externalDeliveries = Array.isArray(parsed.external_deliveries)
        ? parsed.external_deliveries
          .filter((entry) => entry && typeof entry === 'object' && typeof entry.uri === 'string' && entry.uri.trim())
          .slice(0, 10)
          .map((entry) => ({
            uri: entry.uri,
            kind: typeof entry.kind === 'string' ? entry.kind : undefined,
            note: typeof entry.note === 'string' ? entry.note : undefined,
          }))
        : undefined;
      try {
        // The RPC close is performed by the Twin (chair) on the owner's
        // behalf — recorded as the chair actor on the status event (P1-5).
        const task = await closeGroupTask(taskId, {
          status,
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          actor: { kind: 'chair' },
          externalDeliveries,
          closureNote: typeof parsed.closure_note === 'string' ? parsed.closure_note : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, task }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_DELIVERABLE_DELETE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number; deliverable_id?: number };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      const deliverableId = Number(parsed.deliverable_id);
      if (!Number.isInteger(deliverableId) || deliverableId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'deliverable_id is required' }));
        return;
      }
      try {
        const deleted = await deleteGroupTaskDeliverable(taskId, deliverableId);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, deleted }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_SET_MEMBER_STATUS_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        task_id?: number;
        metabot_id?: number;
        globalmetaid?: string;
        status?: string;
        actor_metabot_id?: number;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      const status = String(parsed.status ?? '').trim();
      if (!status) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'status is required' }));
        return;
      }
      const targetMetabotId = Number(parsed.metabot_id);
      const targetGlobalMetaId = typeof parsed.globalmetaid === 'string' && parsed.globalmetaid.trim()
        ? parsed.globalmetaid.trim()
        : undefined;
      if ((!Number.isInteger(targetMetabotId) || targetMetabotId <= 0) && !targetGlobalMetaId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'metabot_id or globalmetaid is required' }));
        return;
      }
      const actorMetabotIdRaw = Number(parsed.actor_metabot_id);
      const actorMetabotId = Number.isInteger(actorMetabotIdRaw) && actorMetabotIdRaw > 0
        ? actorMetabotIdRaw
        : (Number.isInteger(targetMetabotId) && targetMetabotId > 0 ? targetMetabotId : null);
      try {
        const member = await setGroupTaskMemberStatus(
          taskId,
          Number.isInteger(targetMetabotId) && targetMetabotId > 0 ? targetMetabotId : null,
          status as GroupTaskMemberStatus,
          { actorMetabotId, targetGlobalMetaId },
        );
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, member }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_REWORK_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        task_id?: number;
        reason?: string;
        actor_metabot_id?: number;
        actor_metabot_name?: string;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      let actorMetabotId: number | null = null;
      let actorName: string | null = null;
      const rawActorId = Number(parsed.actor_metabot_id);
      if (Number.isInteger(rawActorId) && rawActorId > 0) {
        actorMetabotId = rawActorId;
      } else if (typeof parsed.actor_metabot_name === 'string' && parsed.actor_metabot_name.trim()) {
        actorName = parsed.actor_metabot_name.trim();
        const resolved = resolveMetabotIdByName(getMetabotStore(), actorName);
        if (resolved == null) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `MetaBot not found: ${actorName}` }));
          return;
        }
        actorMetabotId = resolved;
      }
      try {
        const task = await reworkGroupTask(taskId, {
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          actorMetabotId,
          actorName,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, task }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_SUPERVISE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname);
      if (body === null) {
        return;
      }
      let parsed: {
        task_id?: number;
        signal?: string;
        note?: string;
        target?: string;
        confirm_owner?: boolean;
        created_by?: string;
      };
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      // The supervise verb rides `signal` — the outer `action: "supervise"` is
      // the skill's routing key and stays in the forwarded body untouched.
      const signal = String(parsed.signal ?? '').trim();
      const note = typeof parsed.note === 'string' ? parsed.note : '';
      if (!note.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'note is required (what to check / flag / why pause or resume)' }));
        return;
      }
      try {
        const result = await superviseGroupTask({
          taskId,
          action: signal as 'nudge' | 'flag' | 'pause' | 'resume',
          note,
          target: typeof parsed.target === 'string' ? parsed.target : null,
          confirmOwner: parsed.confirm_owner === true,
          createdBy: typeof parsed.created_by === 'string' ? parsed.created_by : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          signal: result.signal,
          dispatch_paused_at: result.dispatchPausedAt,
        }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        // Validation/semantic refusals (resume without owner confirm, unknown
        // task, already paused) are 4xx — the caller can distinguish them from
        // transport failures.
        res.writeHead(/required|not found|already|not paused|must be one of/.test(message) ? 400 : 500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_EXPORT_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      let parsed: { task_id?: number; message_limit?: number };
      try {
        parsed = JSON.parse(body || '{}') as typeof parsed;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }
      const taskId = Number(parsed.task_id);
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'task_id is required' }));
        return;
      }
      try {
        const exported = await exportGroupTask(taskId, {
          messageLimit: Number.isInteger(Number(parsed.message_limit)) && Number(parsed.message_limit) > 0
            ? Number(parsed.message_limit)
            : undefined,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, task: exported }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === LIST_METABOTS_PATH) {
      // This route reads no field, but it still speaks the gateway's body
      // contract: reject a body that is not a JSON object instead of ignoring
      // whatever arrived, so a caller's malformed request cannot look like a
      // successful one.
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      try {
        const metabots = buildMetabotDirectory(getMetabotStore());
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, metabots }));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    // Mega-Phase M4 (R-M4.1): encrypted private messaging + history via the
    // gateway so an external harness (botos-runner / DSH) can act as the bot.
    // The wallet mnemonic is fetched internally and never appears in a response.
    const chatGatewayDeps = {
      getWalletMnemonic: (id: number) => getMetabotStore().getMetabotWalletByMetabotId(id)?.mnemonic ?? '',
      resolvePeerChatPubkey: async (peer: string): Promise<string> => {
        const db = getStore().getDatabase();
        try {
          const local = db.exec(
            `SELECT from_chat_pubkey FROM private_chat_messages
             WHERE from_global_metaid = ? AND from_chat_pubkey IS NOT NULL AND from_chat_pubkey != ''
             ORDER BY id DESC LIMIT 1`,
            [peer]
          );
          const row = local[0]?.values?.[0];
          if (typeof row?.[0] === 'string' && row[0].trim()) return row[0].trim();
        } catch {
          /* local lookup unavailable — fall through to the chain API */
        }
        try {
          const res = await fetch(
            `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/${encodeURIComponent(peer)}`,
            { headers: { Accept: 'application/json' } }
          );
          if (!res.ok) return '';
          const json = (await res.json()) as Record<string, unknown>;
          const data = (json.data && typeof json.data === 'object' ? json.data : json) as Record<string, unknown>;
          for (const candidate of [data.chatpubkey, data.chatPubkey, data.chatPublicKey, data.pubkey]) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
          }
        } catch {
          /* chain API unavailable */
        }
        return '';
      },
      createSimplemsgPin: (id: number, payload: MetaidDataPayload) =>
        createPin(getMetabotStore(), id, payload, { network: 'mvc', feeRate: getGlobalFeeRate('mvc') }),
      readHistory: async (id: number, peer: string, limit: number) => {
        const bot = getMetabotStore().getMetabotById(id)?.globalmetaid ?? '';
        const db = getStore().getDatabase();
        const rows = db.exec(
          `SELECT id, from_global_metaid, to_global_metaid, content, chain_timestamp
           FROM private_chat_messages
           WHERE (from_global_metaid = ? AND to_global_metaid = ?) OR (from_global_metaid = ? AND to_global_metaid = ?)
           ORDER BY id DESC LIMIT ?`,
          [peer, bot, bot, peer, limit]
        );
        const values = rows[0]?.values ?? [];
        return values.reverse().map((v) => ({
          id: Number(v[0] ?? 0),
          direction: (String(v[1] ?? '') === peer ? 'in' : 'out') as 'in' | 'out',
          content: String(v[3] ?? ''),
          timestamp: Number(v[4] ?? 0),
        }));
      },
      listGroupChatMessages: (groupId: string, opts?: { beforeId?: number; limit?: number }) => {
        // Same transcript reader the UI uses (main.ts listRecentGroupMessages);
        // no wallet, no chain write.
        return listGroupChatMessagesForGateway(groupId, opts);
      },
    };

    if (req.method === 'POST' && pathname === PRIVATE_SEND_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      try {
        const result = await handlePrivateSendRoute(chatGatewayDeps, body);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === PRIVATE_HISTORY_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      try {
        const result = await handlePrivateHistoryRoute(chatGatewayDeps, body);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_HISTORY_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      try {
        const result = await handleGroupHistoryRoute(chatGatewayDeps, body);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.body));
      } catch (err) {
        const message = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    // Phase 4 (SDD R4.1): scoped `user_memories` read/write over the HTTP
    // gateway, so the DSH engine can read and write a MetaBot's long-term
    // memory. The validation + mapping logic lives in memoryGatewayRoutes.ts
    // (pure functions, unit-testable without Electron); these handlers only
    // collect the body, delegate, and write back the result.
    if (req.method === 'POST' && pathname === MEMORY_LIST_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      const result = handleMemoryListRoute(getMemoryBackend, body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    if (req.method === 'POST' && pathname === MEMORY_CREATE_PATH) {
      const body = await readRpcJsonObjectBody(req, res, pathname, { emptyBody: 'object' });
      if (body === null) {
        return;
      }
      const result = handleMemoryCreateRoute(getMemoryBackend, body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    if (req.method !== 'POST' || pathname !== '/api/metaid/create-pin') {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    const body = await readRpcJsonObjectBody(req, res, pathname);
    if (body === null) {
      return;
    }

    let payload: { metabot_id: number; metaidData: MetaidDataPayload; network?: string; fee_rate?: number };
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
      return;
    }

    const { metabot_id, metaidData, network: networkRaw } = payload;
    if (
      typeof metabot_id !== 'number' ||
      !metaidData ||
      typeof metaidData !== 'object'
    ) {
      res.writeHead(400);
      res.end(
        JSON.stringify({ success: false, error: 'metabot_id and metaidData required' })
      );
      return;
    }

    const network = (networkRaw != null && String(networkRaw).trim() !== '')
      ? String(networkRaw).toLowerCase().trim()
      : 'mvc';

    let feeRate: number;
    if (payload.fee_rate != null) {
      const feeRateValue = Number(payload.fee_rate);
      if (!Number.isFinite(feeRateValue) || feeRateValue <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'fee_rate must be positive' }));
        return;
      }
      feeRate = feeRateValue;
    } else {
      feeRate = resolveCreatePinFeeRate(network);
    }

    try {
      const store = getMetabotStore();
      const result = await createPin(store, metabot_id, metaidData as MetaidDataPayload, {
        network: network as 'mvc' | 'doge' | 'btc',
        feeRate,
        origin: 'rpc',
      });
      res.writeHead(200);
      const txid = result.txids[0];
      const pinId = result.pinId ?? `${txid}i0`;
      res.end(
        JSON.stringify({
          success: true,
          txids: result.txids,
          txid,
          pinId,
          totalCost: result.totalCost,
          ...(result.feeAssist ? { feeAssist: result.feeAssist } : {}),
        })
      );
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as Error).message)
          : String(err);
      const errObj = err && typeof err === 'object' ? (err as { code?: unknown; reason?: unknown; stage?: unknown; data?: { feeAssist?: unknown } }) : null;
      try {
        const { appendMetaidLogLine } = require('./metaidLog');
        const logPath = path.join(app.getPath('userData'), 'metaid-rpc.log');
        const line = `[${new Date().toISOString()}] [ERROR] create-pin: ${message}\n`;
        appendMetaidLogLine(logPath, line);
      } catch {
        /* ignore */
      }
      res.writeHead(500);
      res.end(JSON.stringify({
        success: false,
        error: message,
        ...(typeof errObj?.code === 'string' && errObj.code ? { code: errObj.code } : {}),
        ...(typeof errObj?.reason === 'string' && errObj.reason ? { reason: errObj.reason } : {}),
        ...(typeof errObj?.stage === 'string' && errObj.stage ? { stage: errObj.stage } : {}),
        ...(errObj?.data?.feeAssist ? { feeAssist: errObj.data.feeAssist } : {}),
      }));
    }
  });

  const rpcPort = resolveMetaidRpcPort();
  // Layer 2 (DSH skill RPC 401): mirror the bearer token into userData so
  // SKILL scripts can read it via IDBOTS_RPC_AUTHFILE when the DSH bash tool
  // scrubs the IDBOTS_RPC_TOKEN env name from their environment. The token is
  // stable per userData dir: an existing mirror from a previous launch (or a
  // sibling instance currently owning the port) is adopted, never rotated out
  // from under live clients.
  if (!writeMetaidRpcTokenFile(app.getPath('userData'))) {
    console.warn('[MetaID RPC] Failed to write the token mirror file; DSH SKILL RPC keeps env-only token injection');
  }
  // An env-pinned port is a contract with external integrations: hold it with
  // the indefinite rebind semantics rather than stepping to a spare port.
  // The default port carries no such contract, so when another app instance
  // with a DIFFERENT userData holds it (production app vs dev-fresh/e2e),
  // binding a fallback port keeps this instance's session env pointing at
  // its own gateway instead of silently driving the other instance's —
  // that cross-instance blend shipped an OpenTeam test into the production
  // app's database and sessions (2026-10-27). A same-userData sibling is
  // unaffected either way: it shares this token file, so RPC into either
  // instance's gateway hits the same data.
  if (process.env[METAID_RPC_PORT_ENV]?.trim()) {
    listenWithRetry(server, rpcPort, RPC_HOST, {
      // Never give up for good: a port conflict (sibling dev instance, zombie
      // process) can clear at any time, and every local skill RPC channel stays
      // dead until we bind. Fast retries for ~2 minutes, then a slow background
      // rebind until the port frees up or the app quits.
      rebindDelayMs: 15_000,
      onListening: () => {
        console.log(`[MetaID RPC] Gateway listening on ${getMetaidRpcBase()}`);
      },
    });
  } else {
    listenWithPortFallback(server, rpcPort, RPC_HOST, {
      fallbackPortSpan: 64,
      onPortSelected: (port) => {
        setActiveMetaidRpcPort(port);
        writeMetaidRpcPortFile(app.getPath('userData'), port);
      },
      onListening: () => {
        console.log(`[MetaID RPC] Gateway listening on ${getMetaidRpcBase()}`);
      },
    });
  }

  return server;
}
