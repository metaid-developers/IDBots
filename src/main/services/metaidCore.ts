/**
 * MetaID Core Service: create Pin via worker subprocess.
 * Spawns src/main/libs/createPinWorker (compiled to dist-electron) with ELECTRON_RUN_AS_NODE
 * to avoid meta-contract "instanceof" issues in the main process. Uses app.getPath('exe') on
 * Electron so the correct executable path is used on Windows and macOS (avoids process.execPath
 * returning wrong name e.g. "lDBots.exe" on Windows).
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { MetabotStore } from '../metabotStore';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';

const MANAPI_BASE = 'https://manapi.metaid.io';

const METAID_RPC_LOG = 'metaid-rpc.log';

function appendMetaidLog(level: string, message: string, details?: object): void {
  try {
    const { app } = require('electron');
    const logDir = app.getPath('userData');
    const logPath = path.join(logDir, METAID_RPC_LOG);
    const line = `[${new Date().toISOString()}] [${level}] ${message}${details ? '\n' + JSON.stringify(details, null, 2) : ''}\n`;
    fs.appendFileSync(logPath, line);
  } catch {
    // Ignore if app not ready
  }
}

export type Operation = 'init' | 'create' | 'modify' | 'revoke';

/** MetaID 7-tuple payload (SDD format). */
export interface MetaidDataPayload {
  operation: Operation;
  path?: string;
  encryption?: '0' | '1' | '2';
  version?: string;
  contentType?: string;
  /** Payload as string or Buffer. When Buffer, will be sent as base64 with encoding. */
  payload: string | Buffer;
  /** Encoding for string payload: 'utf-8' (default) or 'base64' (for binary). */
  encoding?: 'utf-8' | 'base64';
}

/** Supported network for createPin. Default 'mvc' for backward compatibility. */
export type CreatePinNetwork = 'mvc' | 'doge' | 'btc';

/**
 * Create Pin for a MetaBot: spawn skill worker with mnemonic, returns txids.
 * @param options.network - Target network: 'mvc' (default), 'doge', 'btc'. Omit or empty defaults to 'mvc'.
 */
export async function createPin(
  metabotStore: MetabotStore,
  metabot_id: number,
  metaidData: MetaidDataPayload,
  options?: { feeRate?: number; network?: CreatePinNetwork | string }
): Promise<{ txids: string[]; pinId: string; totalCost: number }> {
  const wallet = metabotStore.getMetabotWalletByMetabotId(metabot_id);
  if (!wallet) {
    throw new Error(`MetaBot ${metabot_id} has no wallet`);
  }
  const mnemonic = wallet.mnemonic?.trim();
  if (!mnemonic) {
    throw new Error(`MetaBot ${metabot_id} wallet mnemonic is empty`);
  }

  // Worker: dist-electron/libs/createPinWorker.js when main runs from dist-electron; fallback for packaged/dev edge cases
  const appPath = app.getAppPath();
  const candidatePaths = [
    path.join(__dirname, '..', 'libs', 'createPinWorker.js'),
    path.join(appPath, 'dist-electron', 'libs', 'createPinWorker.js'),
    path.join(appPath, 'libs', 'createPinWorker.js'),
  ];
  const workerPathResolved = candidatePaths.find((p) => fs.existsSync(p)) ?? candidatePaths[0];
  if (!fs.existsSync(workerPathResolved)) {
    appendMetaidLog('ERROR', 'createPinWorker.js not found', { candidatePaths });
    throw new Error(
      `createPinWorker.js not found. Tried: ${candidatePaths.join(', ')}. Run "npm run compile:electron" and ensure IDBots is started from project root.`
    );
  }
  const workerPath = path.isAbsolute(workerPathResolved) ? workerPathResolved : path.resolve(appPath, workerPathResolved);

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    IDBOTS_METABOT_MNEMONIC: mnemonic,
    IDBOTS_METABOT_PATH: wallet.path || "m/44'/10001'/0'/0/0",
  };

  const serializedPayload =
    typeof metaidData.payload === 'string'
      ? metaidData.payload
      : Buffer.isBuffer(metaidData.payload)
        ? metaidData.payload.toString('base64')
        : String(metaidData.payload);
  const encoding: 'utf-8' | 'base64' =
    Buffer.isBuffer(metaidData.payload) ? 'base64' : (metaidData.encoding ?? 'utf-8');

  const network = (
    (options?.network != null && String(options.network).trim() !== '')
      ? String(options.network).toLowerCase().trim()
      : 'mvc'
  ) as CreatePinNetwork;
  const FALLBACK_FEE_RATES: Record<string, number> = { mvc: 1, btc: 2, doge: 5000000 };
  const payloadStr = JSON.stringify({
    feeRate: options?.feeRate ?? FALLBACK_FEE_RATES[network] ?? 1,
    network,
    metaidData: {
      ...metaidData,
      payload: serializedPayload,
      encoding,
    },
  });

  // Use robust Electron executable resolution; some Windows installs can report
  // inconsistent process/app paths during first-run/update windows.
  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    appendMetaidLog('ERROR', 'Electron executable not found for createPin worker', {
      electronExe,
      appExe: (() => {
        try {
          return app.getPath('exe');
        } catch {
          return null;
        }
      })(),
      processExecPath: process.execPath,
    });
    throw new Error(`Electron executable not found: ${electronExe || '(empty)'}`);
  }

  // Never use app.getAppPath() as cwd in packaged mode (it may be app.asar file).
  // A file cwd makes spawn fail with ENOENT/ENOTDIR on Windows first-run paths.
  const spawnCwd = app.getPath('userData');
  return new Promise((resolve, reject) => {
    const child = spawn(electronExe, [workerPath], {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.stdin?.write(payloadStr, () => child.stdin?.end());
    child.on('error', (err) => {
      appendMetaidLog('ERROR', 'Worker spawn failed', { error: String(err) });
      reject(err);
    });
    child.on('close', (code) => {
      const output = stdout.trim() || stderr.trim();
      try {
        const result = JSON.parse(output);
        if (result.success && result.txids) {
          const pinId = result.pinId ?? `${result.txids[0]}i0`;
          appendMetaidLog('INFO', 'createPin success', { txid: result.txids[0], pinId });
          resolve({
            txids: result.txids,
            pinId,
            totalCost: result.totalCost ?? 0,
          });
        } else {
          appendMetaidLog('ERROR', 'Worker returned error', { error: result.error, stderr, stdout });
          reject(new Error(result.error || 'Worker failed'));
        }
      } catch {
        appendMetaidLog('ERROR', 'Worker output parse failed', {
          exitCode: code,
          stderr,
          stdout,
          message: stderr || stdout || `Worker exited with code ${code}`,
        });
        reject(new Error(stderr || stdout || `Worker exited with code ${code}`));
      }
    });
  });
}

/** Sleep for ms milliseconds. Used between sequential chain ops to avoid UTXO double-spend. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract MIME type and raw base64 from data URL or return null. */
function parseDataUrlAvatar(avatar: string | null | undefined): { mime: string; base64: string; buffer: Buffer } | null {
  if (!avatar || typeof avatar !== 'string') return null;
  const match = /^data:([^;]+);base64,(.+)$/.exec(avatar);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  const base64 = match[2];
  if (!base64) return null;
  try {
    const buffer = Buffer.from(base64, 'base64');
    return { mime, base64, buffer };
  } catch {
    return null;
  }
}

export interface SyncMetaBotResult {
  success: boolean;
  error?: string;
  /** True when name pin succeeded but at least one of avatar/chatpubkey/bio failed; caller may allow skip. */
  canSkip?: boolean;
  /** PinID for /info/bio (metabot_info_pinid) */
  metabotInfoPinId?: string;
  /** PinID for /info/chatpubkey (chat_public_key_pin_id) */
  chatPublicKeyPinId?: string;
  /** TXIDs in order: name, avatar, chatpubkey, bio */
  txids?: string[];
}

export type SyncMetaBotEditStep = 'name' | 'avatar' | 'bio';

export interface SyncMetaBotEditChangesInput {
  metabotId: number;
  syncName?: boolean;
  syncAvatar?: boolean;
  syncBio?: boolean;
}

export interface SyncMetaBotEditChangesResult {
  success: boolean;
  error?: string;
  metabotInfoPinId?: string;
  txids?: string[];
  syncedSteps?: SyncMetaBotEditStep[];
}

/**
 * Sync MetaBot basic info to chain: Name, Avatar, ChatPubKey, Bio.
 * Sequential execution with sleep between steps to avoid UTXO double-spend (indexer delay).
 * On success, updates metabot_info_pinid and chat_public_key_pin_id in SQLite.
 */
export async function syncMetaBotToChain(
  metabotStore: MetabotStore,
  metabot_id: number
): Promise<SyncMetaBotResult> {
  const log = (msg: string, data?: object) => {
    console.log(`[syncMetaBot] metabot_id=${metabot_id} ${msg}`, data ?? '');
  };
  const logErr = (msg: string, data?: object) => {
    console.error(`[syncMetaBot] metabot_id=${metabot_id} ERROR ${msg}`, data ?? '');
  };

  log('Starting syncMetaBotToChain');

  const metabot = metabotStore.getMetabotById(metabot_id);
  if (!metabot) {
    logErr('MetaBot not found');
    return { success: false, error: `MetaBot ${metabot_id} not found` };
  }

  log('MetaBot loaded', {
    name: metabot.name,
    hasAvatar: !!metabot.avatar,
    hasChatPublicKey: !!metabot.chat_public_key,
    role: metabot.role?.slice(0, 50),
  });

  const txids: string[] = [];
  let chatPublicKeyPinId: string | null = null;
  let metabotInfoPinId: string | null = null;
  let someStepFailed = false;
  let lastError = '';

  // Step 1: Name (mandatory; on failure do not set canSkip)
  log('Step 1: Pinning name to /info/name');
  try {
    const nameResult = await createPin(metabotStore, metabot_id, {
      operation: 'create',
      path: '/info/name',
      contentType: 'text/plain',
      payload: metabot.name || 'MetaBot',
    });
    const nameTxid = nameResult.txids[0];
    if (!nameTxid) {
      logErr('Name pin: no txid returned');
      return { success: false, error: 'Name pin failed: no txid', canSkip: false };
    }
    txids.push(nameTxid);
    log('Name pin success', { txid: nameTxid, pinId: nameResult.pinId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr('Chain sync failed at name step', { error: msg });
    return { success: false, error: msg, canSkip: false };
  }

  log('Waiting 3s for indexer before next step');
  await sleep(3000);

  // Step 2: Avatar (optional on failure: continue and set canSkip later)
  log('Step 2: Pinning avatar to /info/avatar');
  const avatarData = parseDataUrlAvatar(metabot.avatar);
  if (avatarData) {
    try {
      const { mime, buffer } = avatarData;
      const contentType = `${mime};binary`;
      log('Avatar parsed', { mime, sizeBytes: buffer.length });
      const avatarResult = await createPin(metabotStore, metabot_id, {
        operation: 'create',
        path: '/info/avatar',
        contentType,
        payload: buffer,
        encoding: 'base64',
      });
      const avatarTxid = avatarResult.txids[0];
      if (!avatarTxid) {
        logErr('Avatar pin: no txid returned (skipped)');
        someStepFailed = true;
        lastError = 'Avatar pin failed: no txid';
      } else {
        txids.push(avatarTxid);
        log('Avatar pin success', { txid: avatarTxid, pinId: avatarResult.pinId });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr('Avatar pin failed (skipped)', { error: msg });
      someStepFailed = true;
      lastError = msg;
    }
  } else {
    log('No avatar data (skip avatar pin)');
  }

  log('Waiting 3s for indexer before next step');
  await sleep(3000);

  // Step 3: ChatPubKey (optional on failure)
  log('Step 3: Pinning chatpubkey to /info/chatpubkey');
  const chatPubKey = metabot.chat_public_key?.trim();
  if (chatPubKey) {
    try {
      const chatResult = await createPin(metabotStore, metabot_id, {
        operation: 'create',
        path: '/info/chatpubkey',
        contentType: 'text/plain',
        payload: chatPubKey,
      });
      const chatTxid = chatResult.txids[0];
      if (!chatTxid) {
        logErr('ChatPubKey pin: no txid returned (skipped)');
        someStepFailed = true;
        lastError = 'ChatPubKey pin failed: no txid';
      } else {
        txids.push(chatTxid);
        chatPublicKeyPinId = chatResult.pinId ?? `${chatTxid}i0`;
        log('ChatPubKey pin success', { txid: chatTxid, pinId: chatPublicKeyPinId });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr('ChatPubKey pin failed (skipped)', { error: msg });
      someStepFailed = true;
      lastError = msg;
    }
  } else {
    logErr('chat_public_key is empty (skipped)');
    someStepFailed = true;
    lastError = 'Chat public key is empty';
  }

  log('Waiting 3s for indexer before next step');
  await sleep(3000);

  // Step 4: Bio (optional on failure)
  log('Step 4: Pinning bio to /info/bio');
  try {
    const bioObject = {
      role: metabot.role || '',
      soul: metabot.soul || '',
      goal: metabot.goal || '',
      background: metabot.background || '',
      llm: metabot.llm_id || '',
      tools: metabot.tools ?? [],
      skills: metabot.skills ?? [],
      boss_id: String(metabot.boss_id ?? '0000'),
      boss_global_metaid: metabot.boss_global_metaid || '',
      createdBy: metabot.created_by || '0000',
    };
    const bioJson = JSON.stringify(bioObject);
    log('Bio payload prepared', { length: bioJson.length, keys: Object.keys(bioObject) });

    const bioResult = await createPin(metabotStore, metabot_id, {
      operation: 'create',
      path: '/info/bio',
      contentType: 'application/json',
      payload: bioJson,
    });
    const bioTxid = bioResult.txids[0];
    if (!bioTxid) {
      logErr('Bio pin: no txid returned (skipped)');
      someStepFailed = true;
      lastError = 'Bio pin failed: no txid';
    } else {
      txids.push(bioTxid);
      metabotInfoPinId = bioResult.pinId ?? `${bioTxid}i0`;
      log('Bio pin success', { txid: bioTxid, pinId: metabotInfoPinId });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr('Bio pin failed (skipped)', { error: msg });
    someStepFailed = true;
    lastError = msg;
  }

  if (someStepFailed) {
    log('Some steps failed; updating DB with partial results and returning canSkip=true');
    try {
      const updateInput: { chat_public_key_pin_id?: string | null; metabot_info_pinid?: string | null } = {};
      if (chatPublicKeyPinId) updateInput.chat_public_key_pin_id = chatPublicKeyPinId;
      if (metabotInfoPinId) updateInput.metabot_info_pinid = metabotInfoPinId;
      log('DB update payload', updateInput);
      metabotStore.updateMetabot(metabot_id, updateInput);
    } catch (dbErr) {
      logErr('Database update failed on partial sync', { error: String(dbErr) });
    }
    return {
      success: false,
      error: lastError,
      canSkip: true,
      txids,
      metabotInfoPinId: metabotInfoPinId ?? undefined,
      chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
    };
  }

  // Database update
  log('Updating database with PinIDs');
  try {
    const updateInput: { chat_public_key_pin_id?: string | null; metabot_info_pinid?: string | null } = {};
    if (chatPublicKeyPinId) updateInput.chat_public_key_pin_id = chatPublicKeyPinId;
    if (metabotInfoPinId) updateInput.metabot_info_pinid = metabotInfoPinId;

    log('DB update payload', updateInput);

    const updated = metabotStore.updateMetabot(metabot_id, updateInput);
    if (!updated) {
      logErr('updateMetabot returned null');
      return {
        success: false,
        error: 'Chain sync succeeded but database update failed',
        metabotInfoPinId: metabotInfoPinId ?? undefined,
        chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
        txids,
      };
    }
    log('Database updated successfully', {
      chat_public_key_pin_id: updated.chat_public_key_pin_id,
      metabot_info_pinid: updated.metabot_info_pinid,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr('Database update failed', { error: msg });
    return {
      success: false,
      error: `Chain sync succeeded but database update failed: ${msg}`,
      metabotInfoPinId: metabotInfoPinId ?? undefined,
      chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
      txids,
    };
  }

  log('syncMetaBotToChain completed successfully');
  return {
    success: true,
    metabotInfoPinId: metabotInfoPinId ?? undefined,
    chatPublicKeyPinId: chatPublicKeyPinId ?? undefined,
    txids,
  };
}

function resolveFirstTwinBossId(metabotStore: MetabotStore): string {
  const firstTwin = metabotStore
    .listMetabots()
    .filter((item) => item.metabot_type === 'twin')
    .sort((a, b) => a.id - b.id)[0];
  return firstTwin ? String(firstTwin.id) : '0000';
}

export async function syncMetaBotEditChangesToChain(
  metabotStore: MetabotStore,
  input: SyncMetaBotEditChangesInput
): Promise<SyncMetaBotEditChangesResult> {
  const metabotId = Number(input.metabotId);
  const syncName = input.syncName === true;
  const syncAvatar = input.syncAvatar === true;
  const syncBio = input.syncBio === true;
  const plannedSteps: SyncMetaBotEditStep[] = [];
  if (syncName) plannedSteps.push('name');
  if (syncAvatar) plannedSteps.push('avatar');
  if (syncBio) plannedSteps.push('bio');

  const log = (msg: string, data?: object) => {
    console.log(`[syncMetaBotEdit] metabot_id=${metabotId} ${msg}`, data ?? '');
  };
  const logErr = (msg: string, data?: object) => {
    console.error(`[syncMetaBotEdit] metabot_id=${metabotId} ERROR ${msg}`, data ?? '');
  };

  if (!metabotId || !Number.isFinite(metabotId)) {
    logErr('Invalid metabot id', { metabotId: input.metabotId });
    return { success: false, error: 'Invalid metabot id' };
  }
  if (plannedSteps.length === 0) {
    log('No requested steps, skip sync');
    return { success: true, txids: [], syncedSteps: [] };
  }

  const metabot = metabotStore.getMetabotById(metabotId);
  if (!metabot) {
    logErr('MetaBot not found');
    return { success: false, error: `MetaBot ${metabotId} not found` };
  }

  log('Starting edit sync', { plannedSteps });

  const txids: string[] = [];
  const syncedSteps: SyncMetaBotEditStep[] = [];
  let metabotInfoPinId: string | null = null;

  for (let i = 0; i < plannedSteps.length; i += 1) {
    const step = plannedSteps[i];
    try {
      if (step === 'name') {
        log('Pinning name to /info/name');
        const nameResult = await createPin(metabotStore, metabotId, {
          operation: 'create',
          path: '/info/name',
          contentType: 'text/plain',
          payload: metabot.name || 'MetaBot',
        });
        const nameTxid = nameResult.txids[0];
        if (!nameTxid) {
          logErr('Name pin returned no txid');
          return { success: false, error: 'Name pin failed: no txid', txids, syncedSteps };
        }
        txids.push(nameTxid);
        syncedSteps.push('name');
        log('Name pin success', { txid: nameTxid, pinId: nameResult.pinId });
      } else if (step === 'avatar') {
        log('Pinning avatar to /info/avatar');
        const avatarData = parseDataUrlAvatar(metabot.avatar);
        if (!avatarData) {
          logErr('Avatar data invalid for chain sync', { avatarType: typeof metabot.avatar });
          return { success: false, error: 'Avatar sync failed: invalid data URL', txids, syncedSteps };
        }
        const avatarResult = await createPin(metabotStore, metabotId, {
          operation: 'create',
          path: '/info/avatar',
          contentType: `${avatarData.mime};binary`,
          payload: avatarData.buffer,
          encoding: 'base64',
        });
        const avatarTxid = avatarResult.txids[0];
        if (!avatarTxid) {
          logErr('Avatar pin returned no txid');
          return { success: false, error: 'Avatar pin failed: no txid', txids, syncedSteps };
        }
        txids.push(avatarTxid);
        syncedSteps.push('avatar');
        log('Avatar pin success', {
          txid: avatarTxid,
          pinId: avatarResult.pinId,
          sizeBytes: avatarData.buffer.length,
          mime: avatarData.mime,
        });
      } else if (step === 'bio') {
        const bossId = resolveFirstTwinBossId(metabotStore);
        const bioObject = {
          role: metabot.role || '',
          soul: metabot.soul || '',
          goal: metabot.goal || '',
          background: metabot.background || '',
          llm: metabot.llm_id || '',
          tools: metabot.tools ?? [],
          skills: metabot.skills ?? [],
          boss_id: bossId,
          createdBy: metabot.created_by || '0000',
        };
        const bioJson = JSON.stringify(bioObject);
        log('Pinning bio to /info/bio', { bossId, payloadLength: bioJson.length });
        const bioResult = await createPin(metabotStore, metabotId, {
          operation: 'create',
          path: '/info/bio',
          contentType: 'application/json',
          payload: bioJson,
        });
        const bioTxid = bioResult.txids[0];
        if (!bioTxid) {
          logErr('Bio pin returned no txid');
          return { success: false, error: 'Bio pin failed: no txid', txids, syncedSteps };
        }
        txids.push(bioTxid);
        syncedSteps.push('bio');
        metabotInfoPinId = bioResult.pinId ?? `${bioTxid}i0`;
        log('Bio pin success', { txid: bioTxid, pinId: metabotInfoPinId, bossId });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr(`Step failed: ${step}`, { error: msg, plannedSteps, syncedSteps, txids });
      return { success: false, error: msg, txids, syncedSteps, metabotInfoPinId: metabotInfoPinId ?? undefined };
    }

    if (i < plannedSteps.length - 1) {
      log('Waiting 3s for indexer before next step');
      await sleep(3000);
    }
  }

  if (metabotInfoPinId) {
    try {
      const updated = metabotStore.updateMetabot(metabotId, {
        metabot_info_pinid: metabotInfoPinId,
      });
      if (!updated) {
        logErr('Failed to update metabot_info_pinid after bio sync');
        return {
          success: false,
          error: 'Bio sync succeeded but failed to update metabot_info_pinid',
          txids,
          syncedSteps,
          metabotInfoPinId,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logErr('Database update failed after bio sync', { error: msg });
      return {
        success: false,
        error: `Bio sync succeeded but database update failed: ${msg}`,
        txids,
        syncedSteps,
        metabotInfoPinId,
      };
    }
  }

  log('Edit sync completed successfully', { plannedSteps, syncedSteps, txidCount: txids.length });
  return {
    success: true,
    txids,
    syncedSteps,
    metabotInfoPinId: metabotInfoPinId ?? undefined,
  };
}

/** Raw PIN data from manapi.metaid.io (subset used for persist). */
type PinDataRow = Record<string, unknown>;

function toSqlBool(v: unknown): number {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  return 0;
}

function toSqlText(v: unknown): string | null {
  if (v == null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' || Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function toSqlInt(v: unknown): number | null {
  if (v == null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

let storeGetter: (() => SqliteStore | null) | null = null;

export function setMetaidCoreStore(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

function rowToPinData(columns: string[], row: unknown[]): PinDataRow {
  const obj: PinDataRow = {};
  const boolKeys = new Set(['isTransfered', 'blocked', 'is_recommended']);
  const jsonKeys = new Set(['mrc20MintId', 'modify_history']);
  columns.forEach((col, i) => {
    const v = row[i];
    if (boolKeys.has(col)) {
      obj[col] = v === 1 || v === '1' || v === true;
    } else if (jsonKeys.has(col) && typeof v === 'string' && v) {
      try {
        obj[col] = JSON.parse(v);
      } catch {
        obj[col] = v;
      }
    } else {
      obj[col] = v ?? null;
    }
  });
  return obj;
}

/**
 * Fetch PIN data: prefer local SQLite, fallback to manapi.metaid.io.
 * If local hit: return from DB. If miss: fetch remote, persist when persist=true, then return.
 */
export async function getPinData(pinId: string, persist: boolean): Promise<PinDataRow> {
  const store = storeGetter?.() ?? null;
  if (store) {
    const db = store.getDatabase();
    const result = db.exec('SELECT * FROM metaid_pins WHERE id = ?', [pinId]);
    if (result[0]?.values?.[0]) {
      const columns = result[0].columns as string[];
      const row = result[0].values[0] as unknown[];
      return rowToPinData(columns, row);
    }
  }

  const url = `${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`manapi fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { code?: number; message?: string; data?: PinDataRow };
  const data = json?.data;
  if (!data || typeof data !== 'object') {
    throw new Error(json?.message ?? 'No data in manapi response');
  }

  if (persist && store) {
    const db = store.getDatabase();
    const id = (data.id != null ? String(data.id) : pinId) || pinId;
    const cols = [
      'id', 'number', 'metaid', 'address', 'creator', 'createMetaId', 'globalMetaId', 'initialOwner',
      'output', 'outputValue', 'timestamp', 'genesisFee', 'genesisHeight', 'genesisTransaction',
      'txIndex', 'txInIndex', '"offset"', 'location', 'operation', 'path', 'parentPath', 'originalPath',
      'encryption', 'version', 'contentType', 'contentTypeDetect', 'contentBody', 'contentLength',
      'contentSummary', 'originalContentBody', 'originalContentSummary', 'status', 'originalId',
      'isTransfered', 'preview', 'content', 'pop', 'popLv', 'popScore', 'popScoreV1', 'chainName',
      'dataValue', 'mrc20MintId', 'host', 'blocked', 'is_recommended', 'modify_history',
    ];
    const values = [
      id,
      toSqlInt(data.number),
      toSqlText(data.metaid),
      toSqlText(data.address),
      toSqlText(data.creator),
      toSqlText(data.createMetaId),
      toSqlText(data.globalMetaId),
      toSqlText(data.initialOwner),
      toSqlText(data.output),
      toSqlInt(data.outputValue),
      toSqlInt(data.timestamp),
      toSqlInt(data.genesisFee),
      toSqlInt(data.genesisHeight),
      toSqlText(data.genesisTransaction),
      toSqlInt(data.txIndex),
      toSqlInt(data.txInIndex),
      toSqlInt(data.offset),
      toSqlText(data.location),
      toSqlText(data.operation),
      toSqlText(data.path),
      toSqlText(data.parentPath),
      toSqlText(data.originalPath),
      toSqlText(data.encryption),
      toSqlText(data.version),
      toSqlText(data.contentType),
      toSqlText(data.contentTypeDetect),
      toSqlText(data.contentBody),
      toSqlInt(data.contentLength),
      toSqlText(data.contentSummary),
      toSqlText(data.originalContentBody),
      toSqlText(data.originalContentSummary),
      toSqlInt(data.status),
      toSqlText(data.originalId),
      toSqlBool(data.isTransfered),
      toSqlText(data.preview),
      toSqlText(data.content),
      toSqlText(data.pop),
      toSqlInt(data.popLv),
      toSqlText(data.popScore),
      toSqlText(data.popScoreV1),
      toSqlText(data.chainName),
      toSqlInt(data.dataValue),
      toSqlText(data.mrc20MintId),
      toSqlText(data.host),
      toSqlBool(data.blocked),
      toSqlBool(data.is_recommended),
      toSqlText(data.modify_history),
    ];
    const placeholders = cols.map(() => '?').join(',');
    db.run(
      `INSERT OR REPLACE INTO metaid_pins (${cols.join(',')}) VALUES (${placeholders})`,
      values
    );
    store.getSaveFunction()();
  }

  return data as PinDataRow;
}
