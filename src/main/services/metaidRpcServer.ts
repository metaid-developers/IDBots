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
  exportGroupTask,
} from './groupTaskService';
import { gateChairDrivingSend, gateExternalChairSend, DEFAULT_DRIVER_GRACE_MS } from './groupTaskDaemon';
import { resolveTwinSourceSessionFallback } from './groupTaskSourceSession';
import { GroupTaskStaffingError } from './groupTaskStaffing';
import { inviteRemoteBot, searchRemoteCandidates } from './openTeamService';
import { searchGroupTaskSeatCandidates } from './groupTaskCandidateSearch';
import { buildMetabotDirectory } from './metabotDirectoryService';
import type { GroupTaskStatus, GroupTaskMemberStatus } from '../groupTaskStore';
import { getAddressBalance } from './addressBalanceService';
import { getRate as getGlobalFeeRate, getAllTiers as getGlobalFeeTiers, resolveCreatePinFeeRate } from './feeRateStore';
import { listenWithRetry } from './httpListenWithRetry';
import {
  DEFAULT_METAID_RPC_HOST,
  getMetaidRpcBase,
  getMetaidRpcToken,
  isAllowedMetaidRpcOrigin,
  isMetaidRpcTokenAuthorized,
  resolveMetaidRpcPort,
  writeMetaidRpcTokenFile,
} from './metaidRpcEndpoint';
import { getMetabotAccountSummary } from './metabotAccountService';
import { sendBotBrowserOpenUri } from './botBrowserOpenUriService';
import { uploadMetaFile } from './metaFileUploadService';
import { buildMvcFtTransferRawTx, buildMvcOrderedRawTxBundle, buildMvcTransferRawTx } from './walletRawTxService';
import { executeTransfer } from './transferService';
import { parseAddressIndexFromPath } from './metabotWalletService';
import { executeMrc20Transfer } from './mrc20Service';
import { buildMetaappHomepage } from './metabotHomepage';
import { METAAPP_PIN_ID_PATTERN } from './metaAppProtocol';
import type {
  BotBrowserTabAction,
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
} from './botBrowserTabBridge';

const RPC_HOST = DEFAULT_METAID_RPC_HOST;

const PIN_ROUTE_PREFIX = '/api/metaid/pin/';
const ASSIGN_GROUP_CHAT_TASK_PATH = '/api/idbots/assign-group-chat-task';
const RESOLVE_METABOT_ID_PATH = '/api/idbots/resolve-metabot-id';
const METABOT_ACCOUNT_SUMMARY_PATH = '/api/idbots/metabot/account-summary';
const ADDRESS_BALANCE_PATH = '/api/idbots/address/balance';
const FEE_RATE_SUMMARY_PATH = '/api/idbots/fee-rate-summary';
const BUILD_MVC_TRANSFER_RAW_TX_PATH = '/api/idbots/wallet/mvc/build-transfer-rawtx';
const BUILD_MVC_FT_TRANSFER_RAW_TX_PATH = '/api/idbots/wallet/mvc-ft/build-transfer-rawtx';
const BUILD_MVC_RAW_TX_BUNDLE_PATH = '/api/idbots/wallet/mvc/build-rawtx-bundle';
const EXECUTE_MRC20_TRANSFER_PATH = '/api/idbots/wallet/mrc20/transfer';
const SIGN_BTC_MESSAGE_PATH = '/api/idbots/wallet/btc/sign-message';
const SIGN_BTC_PSBT_PATH = '/api/idbots/wallet/btc/sign-psbt';
const UPLOAD_LARGEFILE_PATH = '/api/idbots/files/upload-largefile';
const EXECUTE_TRANSFER_PATH = '/api/idbots/wallet/transfer';
const BOT_BROWSER_OPEN_PATH = '/api/idbots/bot-browser/open';
const BOT_BROWSER_TABS_PATH = '/api/idbots/bot-browser/tabs';
const SET_METABOT_HOMEPAGE_METAAPP_PATH = '/api/idbots/metabot/homepage/set-metaapp';
const GROUP_TASK_CREATE_PATH = '/api/idbots/group-task/create';
const GROUP_TASK_PROPOSE_STAFFING_PATH = '/api/idbots/group-task/propose-staffing';
const GROUP_TASK_LIST_PATH = '/api/idbots/group-task/list';
const GROUP_TASK_SHOW_PATH = '/api/idbots/group-task/show';
const GROUP_TASK_SEND_PATH = '/api/idbots/group-task/send';
const GROUP_TASK_INVITE_PATH = '/api/idbots/group-task/invite';
const GROUP_TASK_KICK_MEMBER_PATH = '/api/idbots/group-task/kick-member';
const GROUP_TASK_CLOSE_PATH = '/api/idbots/group-task/close';
const GROUP_TASK_MEMBER_STATUS_PATH = '/api/idbots/group-task/member-status';
const GROUP_TASK_DELIVERABLE_DELETE_PATH = '/api/idbots/group-task/deliverable-delete';
const GROUP_TASK_SET_MEMBER_STATUS_PATH = '/api/idbots/group-task/set-member-status';
const GROUP_TASK_REWORK_PATH = '/api/idbots/group-task/rework';
const GROUP_TASK_EXPORT_PATH = '/api/idbots/group-task/export';
const GROUP_TASK_SEARCH_REMOTE_PATH = '/api/idbots/group-task/search-remote-candidates';
const GROUP_TASK_SEARCH_CANDIDATES_PATH = '/api/idbots/group-task/search-candidates';
const GROUP_TASK_INVITE_REMOTE_PATH = '/api/idbots/group-task/invite-remote';
const LIST_METABOTS_PATH = '/api/idbots/list-metabots';
const MEMORY_LIST_PATH = '/api/idbots/memory/list';
const MEMORY_CREATE_PATH = '/api/idbots/memory/create';
const BOT_BROWSER_URI_SCHEMES = new Set(['metaid', 'pin', 'metaapp', 'map', 'metafile']);

export type BotBrowserRpcOpenRequest = {
  uri: string;
  actorId: string | null;
};

export type MetaidRpcServerOptions = {
  openBotBrowserUri?: (input: BotBrowserRpcOpenRequest) => Promise<void> | void;
  controlBotBrowserTabs?: (
    command: BotBrowserTabCommand,
  ) => Promise<BotBrowserTabCommandResult> | BotBrowserTabCommandResult;
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
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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

    if (req.method === 'POST' && pathname === SET_METABOT_HOMEPAGE_METAAPP_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
        return;
      }

      const chainRaw = String(parsed.chain || '').toLowerCase().trim();
      if (!chainRaw) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'chain is required' }));
        return;
      }
      const chain = chainRaw === 'space' ? 'mvc' : chainRaw;
      if (chain !== 'mvc' && chain !== 'btc' && chain !== 'doge') {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Unsupported chain' }));
        return;
      }
      const metabotId = Number(parsed.metabot_id);
      if (!Number.isFinite(metabotId) || metabotId <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'metabot_id is required' }));
        return;
      }
      const toAddress = String(parsed.to_address || '').trim();
      if (!toAddress) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'to_address is required' }));
        return;
      }
      const amountRaw = parsed.amount ?? '';
      const amount = typeof amountRaw === 'number' ? String(amountRaw) : String(amountRaw || '').trim();
      const amountValue = Number(amount);
      if (!amount || !Number.isFinite(amountValue) || amountValue <= 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'amount must be positive' }));
        return;
      }
      let feeRate: number;
      if (parsed.fee_rate != null) {
        const feeRateValue = Number(parsed.fee_rate);
        if (!Number.isFinite(feeRateValue) || feeRateValue <= 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'fee_rate must be positive' }));
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
          res.end(JSON.stringify({ success: false, error: result.error || 'Transfer failed' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, txid: result.txId }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === UPLOAD_LARGEFILE_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: String((err as Error)?.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === BUILD_MVC_TRANSFER_RAW_TX_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: {
        metabot_id?: number;
        to_address?: string;
        amount_sats?: number;
        fee_rate?: number;
        exclude_outpoints?: string[];
      };
      try {
        parsed = JSON.parse(body) as {
          metabot_id?: number;
          to_address?: string;
          amount_sats?: number;
          fee_rate?: number;
          exclude_outpoints?: string[];
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
          const logPath = path.join(app.getPath('userData'), 'metaid-rpc.log');
          const line = `[${new Date().toISOString()}] [ERROR] get-pin: ${message}\n`;
          fs.appendFileSync(logPath, line);
        } catch {
          /* ignore */
        }
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === GROUP_TASK_PROPOSE_STAFFING_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      // relay target. Only a real, non-A2A standard session is acceptable —
      // a2a/browser/group_task sessions are not "where the human started this".
      let sourceSessionId: string | undefined;
      if (parsed.source_session_id != null) {
        const candidate = String(parsed.source_session_id).trim();
        if (candidate) {
          const sessionRow = getStore()
            .getDatabase()
            .exec('SELECT session_type FROM cowork_sessions WHERE id = ?', [candidate])[0];
          const sessionType = sessionRow?.values?.[0]?.[0];
          if (sessionType !== 'standard') {
            res.writeHead(400);
            res.end(JSON.stringify({
              success: false,
              error: sessionType == null
                ? 'source_session_id does not refer to an existing CoWork session'
                : `source_session_id must be a standard CoWork session (got ${String(sessionType)})`,
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: { task_id?: number; view?: string };
      try {
        parsed = JSON.parse(body) as { task_id?: number; view?: string };
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
      // Round-4: view=summary (default: status + members incl. last speak time
      // + deliverables + last 5 messages) or view=full (everything).
      const view = parsed.view === 'full' ? 'full' : 'summary';
      try {
        const task = await getGroupTask(taskId, { view });
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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

    if (req.method === 'POST' && pathname === GROUP_TASK_KICK_MEMBER_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: {
        query?: string;
        role_hint?: string;
        domain_label?: string;
        skills?: unknown;
        limit?: number;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      let parsed: { task_id?: number; status?: string; reason?: string };
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
      try {
        // The RPC close is performed by the Twin (chair) on the owner's
        // behalf — recorded as the chair actor on the status event (P1-5).
        const task = await closeGroupTask(taskId, {
          status,
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          actor: { kind: 'chair' },
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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

    if (req.method === 'POST' && pathname === GROUP_TASK_EXPORT_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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

    // Phase 4 (SDD R4.1): scoped `user_memories` read/write over the HTTP
    // gateway, so the DSH engine can read and write a MetaBot's long-term
    // memory. The validation + mapping logic lives in memoryGatewayRoutes.ts
    // (pure functions, unit-testable without Electron); these handlers only
    // collect the body, delegate, and write back the result.
    if (req.method === 'POST' && pathname === MEMORY_LIST_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const result = handleMemoryListRoute(getMemoryBackend, body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    if (req.method === 'POST' && pathname === MEMORY_CREATE_PATH) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
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

    let body = '';
    for await (const chunk of req) {
      body += chunk;
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
        })
      );
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as Error).message)
          : String(err);
      try {
        const logPath = path.join(app.getPath('userData'), 'metaid-rpc.log');
        const line = `[${new Date().toISOString()}] [ERROR] create-pin: ${message}\n`;
        fs.appendFileSync(logPath, line);
      } catch {
        /* ignore */
      }
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: message }));
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

  return server;
}
