/**
 * MetaID Core Service: create Pin via skill worker subprocess.
 * Spawns SKILLs/metabot-basic/scripts/createPinRpcWorker.ts to avoid meta-contract
 * "instanceof" issues in the main process.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { Database } from 'sql.js';
import type { MetabotStore } from '../metabotStore';
import { getSkillsRoot } from '../libs/coworkUtil';

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
  payload: string | Buffer;
}

/**
 * Create Pin for a MetaBot: spawn skill worker with mnemonic, returns txids.
 */
export async function createPin(
  metabotStore: MetabotStore,
  metabot_id: number,
  metaidData: MetaidDataPayload,
  options?: { feeRate?: number }
): Promise<{ txids: string[]; totalCost: number }> {
  const wallet = metabotStore.getMetabotWalletByMetabotId(metabot_id);
  if (!wallet) {
    throw new Error(`MetaBot ${metabot_id} has no wallet`);
  }
  const mnemonic = wallet.mnemonic?.trim();
  if (!mnemonic) {
    throw new Error(`MetaBot ${metabot_id} wallet mnemonic is empty`);
  }

  const skillsRoot = getSkillsRoot();
  const workerPath = path.join(skillsRoot, 'metabot-basic', 'scripts', 'createPinRpcWorker.ts');
  const skillCwd = path.join(skillsRoot, 'metabot-basic');

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;
  const env = {
    ...baseEnv,
    IDBOTS_TWIN_MNEMONIC: mnemonic,
    IDBOTS_TWIN_PATH: wallet.path || "m/44'/10001'/0'/0/0",
  };

  const payloadStr = JSON.stringify({
    metaidData: {
      ...metaidData,
      payload:
        typeof metaidData.payload === 'string'
          ? metaidData.payload
          : Buffer.isBuffer(metaidData.payload)
            ? metaidData.payload.toString('utf-8')
            : String(metaidData.payload),
    },
  });

  return new Promise((resolve, reject) => {
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxBin, ['ts-node', workerPath], {
      cwd: skillCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
          appendMetaidLog('INFO', 'createPin success', { txid: result.txids[0] });
          resolve({
            txids: result.txids,
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

/**
 * Fetch PIN data from manapi.metaid.io and optionally persist to SQLite.
 * When persist is true, db and save must be provided.
 */
export async function getPinData(
  pinId: string,
  persist: boolean,
  db?: Database,
  save?: () => void
): Promise<PinDataRow> {
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

  if (persist && db && save) {
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
    save();
  }

  return data as PinDataRow;
}
