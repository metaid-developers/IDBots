import { spawn } from 'child_process';
import fs from 'fs';
import { app } from 'electron';
import { mvc } from 'meta-contract';
import type { MetabotStore } from '../metabotStore';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';
import { getMainWorkerCandidatePaths, resolveMainWorkerPath } from './workerPathResolver';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

export interface BuildMvcTransferRawTxParams {
  metabotId: number;
  toAddress: string;
  amountSats: number;
  feeRate: number;
  excludeOutpoints?: string[];
}

export interface BuildMvcFtToken {
  symbol?: string;
  tokenID?: string;
  genesisHash: string;
  codeHash: string;
  decimal?: number;
}

export interface BuildMvcFtTransferRawTxParams {
  metabotId: number;
  token: BuildMvcFtToken;
  toAddress: string;
  amount: string;
  feeRate: number;
  excludeOutpoints?: string[];
  fundingRawTx?: string;
  fundingOutpoint?: string;
}

export interface BuildMvcOrderedRawTxBundleFunding {
  stepIndex: number;
  useOutput?: 'change';
}

export interface BuildMvcOrderedRawTxBundleMvcStep {
  kind: 'mvc_transfer';
  toAddress: string;
  amountSats: number;
  feeRate: number;
  excludeOutpoints?: string[];
}

export interface BuildMvcOrderedRawTxBundleMvcFtStep {
  kind: 'mvc_ft_transfer';
  token: BuildMvcFtToken;
  toAddress: string;
  amount: string;
  feeRate: number;
  excludeOutpoints?: string[];
  funding?: BuildMvcOrderedRawTxBundleFunding;
}

export type BuildMvcOrderedRawTxBundleStep =
  | BuildMvcOrderedRawTxBundleMvcStep
  | BuildMvcOrderedRawTxBundleMvcFtStep;

export interface BuildMvcOrderedRawTxBundleParams {
  metabotId: number;
  steps: BuildMvcOrderedRawTxBundleStep[];
}

interface WorkerTransferResult {
  txHex: string;
  txid?: string;
  outputIndex?: number;
  spentOutpoints?: string[];
  changeOutpoint?: string | null;
  amountCheckRawTx?: string;
}

/** Result of the sell/cancelSell/buy worker: two chained raw txs. */
interface WorkerTradeResult extends WorkerTransferResult {
  fundingTxHex: string;
  fundingTxid?: string;
  fundingSpentOutpoints?: string[];
}

interface WalletRawTxServiceDeps {
  runMvcTransferRawTxWorker?: (params: {
    mnemonic: string;
    path: string;
    toAddress: string;
    amountSats: number;
    feeRate: number;
    excludeOutpoints: string[];
  }) => Promise<WorkerTransferResult>;
  runMvcFtTransferRawTxWorker?: (params: {
    mnemonic: string;
    path: string;
    token: BuildMvcFtToken;
    toAddress: string;
    amount: string;
    feeRate: number;
    excludeOutpoints: string[];
    fundingRawTx?: string;
    fundingOutpoint?: string;
  }) => Promise<WorkerTransferResult>;
  runMvcNftTransferRawTxWorker?: (params: {
    mnemonic: string;
    path: string;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    toAddress: string;
    feeRate: number;
    excludeOutpoints: string[];
  }) => Promise<WorkerTransferResult>;
  runMvcNftSellRawTxWorker?: (params: BuildMvcNftSellRawTxParams & {
    mnemonic: string;
    path: string;
    excludeOutpoints: string[];
  }) => Promise<WorkerTradeResult>;
  runMvcNftCancelSellRawTxWorker?: (params: BuildMvcNftCancelSellRawTxParams & {
    mnemonic: string;
    path: string;
    excludeOutpoints: string[];
  }) => Promise<WorkerTradeResult>;
  runMvcNftBuyRawTxWorker?: (params: BuildMvcNftBuyRawTxParams & {
    mnemonic: string;
    path: string;
    excludeOutpoints: string[];
  }) => Promise<WorkerTradeResult>;
  runMvcTokenSellRawTxWorker?: (params: BuildMvcTokenSellTradeParams & {
    mnemonic: string;
    path: string;
    excludeOutpoints: string[];
  }) => Promise<WorkerTokenSellResult>;
}

// ---------------------------------------------------------------------------
// FT TokenSell (LIST / take / cancel=self-take) — mirrors the NFT trade
// surface; the worker never broadcasts, the parent stages the fundingTxs in
// order before the final tx (see mvcTokenSellService).
// ---------------------------------------------------------------------------

/** Listing four-tuple + seed pointer carried off-chain between counterparties. */
export interface MvcTokenSellListingRef {
  sell_txid: string;
  sell_output_index: number;
  sell_price_sats: number;
  seller_address: string;
  seed_txid?: string;
  seed_vout?: number;
  token_txid?: string;
  token_vout?: number;
  prev_token_txid?: string;
  token_genesis?: string;
  token_codehash?: string;
}

export interface BuildMvcTokenSellTradeParams {
  metabotId: number;
  action: 'sell' | 'take' | 'cancel' | 'transfer';
  feeRate: number;
  excludeOutpoints?: string[];
  /** sell / transfer */
  genesis?: string;
  codehash?: string;
  tokenTxid?: string;
  tokenVout?: number;
  /** full-utxo listing only; omit to list the whole utxo (amount gates apply) */
  tokenAmount?: string;
  priceSats?: number;
  seedSats?: number;
  checkerSats?: number;
  /** take / cancel only */
  listing?: MvcTokenSellListingRef;
  /** take / transfer only */
  receiverAddress?: string;
  prevTokenInputIndex?: number;
}

export interface MvcTokenSellListing {
  sell_txid: string;
  sell_output_index: number;
  seller_address: string;
  sell_price_sats: number;
  seed_txid: string;
  seed_vout: number;
  seed_sats: number;
  token_amount: string;
  token_genesis?: string;
  token_codehash?: string;
}

/** Result of the TokenSell worker: ordered funding txs + the final tx + listing. */
export interface WorkerTokenSellResult {
  txHex: string;
  txid?: string;
  success?: boolean;
  action?: string;
  fundingTxs?: Array<{ name: string; txid: string; txHex: string }>;
  listing?: MvcTokenSellListing;
  priceSats?: number;
  tokenAmount?: string;
  receiverAddress?: string;
  fee?: number;
  size?: number;
  spentOutpoints?: string[];
}

export interface BuildMvcTokenSellRawTxResult {
  /** Funding txs in broadcast order (checker mint → seed for sell; checker mint for take). */
  funding_txs: Array<{ name: string; txid: string; raw_tx: string }>;
  funding_txids: string[];
  /** Final tx carrying the on-chain state change. */
  raw_tx: string;
  txid: string;
  listing?: MvcTokenSellListing;
  spent_outpoints: string[];
}

export interface BuildMvcNftTransferRawTxParams {
  metabotId: number;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  toAddress: string;
  feeRate: number;
  excludeOutpoints?: string[];
}

/** Chain-side sell order reference, straight from wallet-api sell utxo rows. */
export interface MvcNftSellUtxoRef {
  txId: string;
  outputIndex: number;
  sellerAddress?: string;
  price?: number;
}

export interface BuildMvcNftSellRawTxParams {
  metabotId: number;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  /** Ask price in satoshis; NftManager enforces a 22000 sat minimum. */
  priceSats: number;
  feeRate: number;
  excludeOutpoints?: string[];
}

export interface BuildMvcNftCancelSellRawTxParams {
  metabotId: number;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  /** Optional: when omitted the NftManager resolves the sell utxo on-chain. */
  sellUtxo?: MvcNftSellUtxoRef;
  feeRate: number;
  excludeOutpoints?: string[];
}

export interface BuildMvcNftBuyRawTxParams {
  metabotId: number;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  /** Optional: when omitted the NftManager resolves the sell utxo on-chain. */
  sellUtxo?: MvcNftSellUtxoRef;
  feeRate: number;
  excludeOutpoints?: string[];
}

interface BuildMvcTransferRawTxResult {
  raw_tx: string;
  txid: string;
  output_index: number;
  spent_outpoints: string[];
  change_outpoint: string | null;
}

interface BuildMvcFtTransferRawTxResult {
  raw_tx: string;
  txid: string;
  output_index: number;
  amount_check_raw_tx: string;
  spent_outpoints: string[];
  change_outpoint: string | null;
}

interface BuildMvcNftTransferRawTxResult {
  raw_tx: string;
  txid: string;
  spent_outpoints: string[];
}

interface BuildMvcNftTradeRawTxResult {
  /** Stage-1 tx (sell: contract funding; cancel/buy: unlock check). */
  funding_raw_tx: string;
  funding_txid: string;
  /** Stage-2 tx carrying the final on-chain state. */
  raw_tx: string;
  txid: string;
  /** Wallet inputs consumed by the stage-1 tx (safe to exclude on rebuild). */
  funding_spent_outpoints: string[];
  spent_outpoints: string[];
}

interface BuildMvcOrderedRawTxBundleResultStepBase {
  index: number;
  kind: BuildMvcOrderedRawTxBundleStep['kind'];
  raw_tx: string;
  txid: string;
  output_index: number;
  spent_outpoints: string[];
  change_outpoint: string | null;
}

type BuildMvcOrderedRawTxBundleResultStep =
  | (BuildMvcOrderedRawTxBundleResultStepBase & {
      kind: 'mvc_transfer';
    })
  | (BuildMvcOrderedRawTxBundleResultStepBase & {
      kind: 'mvc_ft_transfer';
      amount_check_raw_tx: string;
      resolved_funding_outpoint?: string;
    });

function getErrorMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

function validateExcludeOutpoints(excludeOutpoints: unknown): string[] {
  if (excludeOutpoints == null) return [];
  if (!Array.isArray(excludeOutpoints)) {
    throw new Error('exclude_outpoints must be an array of "txid:vout" strings');
  }
  const result: string[] = [];
  for (const value of excludeOutpoints) {
    const text = String(value || '').trim();
    if (!/^[0-9a-fA-F]{64}:\d+$/.test(text)) {
      throw new Error('exclude_outpoints must be an array of "txid:vout" strings');
    }
    result.push(text.toLowerCase());
  }
  return result;
}

function validateCommonTransferFields(params: {
  metabotId: number;
  toAddress: string;
  feeRate: number;
  excludeOutpoints?: string[];
}): string[] {
  if (!Number.isInteger(params.metabotId) || params.metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }
  if (typeof params.toAddress !== 'string' || !params.toAddress.trim()) {
    throw new Error('to_address is required');
  }
  if (!Number.isFinite(params.feeRate) || params.feeRate <= 0) {
    throw new Error('fee_rate must be a positive number');
  }
  return validateExcludeOutpoints(params.excludeOutpoints);
}

function resolveFtGenesis(token: BuildMvcFtToken): string {
  return String(token?.tokenID || token?.genesisHash || '').trim();
}

function validateOptionalOutpoint(value: unknown, fieldName: string): string | undefined {
  if (value == null || value === '') return undefined;
  const text = String(value).trim();
  if (!/^[0-9a-fA-F]{64}:\d+$/.test(text)) {
    throw new Error(`${fieldName} must be a "txid:vout" string`);
  }
  return text.toLowerCase();
}

function normalizeOutpoint(txidRaw: unknown, outputIndexRaw: unknown): string {
  const txid = String(txidRaw || '').trim();
  const outputIndex = Number(outputIndexRaw);
  return `${txid}:${outputIndex}`;
}

function parseTx(txHex: string): InstanceType<typeof mvc.Transaction> {
  if (!txHex || typeof txHex !== 'string') throw new Error('raw_tx is required');
  return new mvc.Transaction(txHex);
}

function extractSpentOutpoints(tx: InstanceType<typeof mvc.Transaction>): string[] {
  return tx.inputs.map((input) => normalizeOutpoint((input as any).prevTxId?.toString?.('hex'), (input as any).outputIndex));
}

function mergeOutpointLists(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      merged.add(String(item).toLowerCase());
    }
  }
  return merged.size > 0 ? Array.from(merged) : undefined;
}

export function summarizeMvcTransferTx(params: {
  txHex: string;
  amountSats: number;
  toAddress?: string;
}): {
  txid: string;
  outputIndex: number;
  spentOutpoints: string[];
  changeOutpoint: string | null;
} {
  const tx = parseTx(params.txHex);
  const txid = tx.id;
  const outputs = tx.outputs ?? [];

  let outputIndex = -1;
  for (let i = 0; i < outputs.length; i += 1) {
    const output = outputs[i] as any;
    if (Number(output.satoshis) !== Number(params.amountSats)) continue;
    if (!params.toAddress) {
      outputIndex = i;
      break;
    }
    try {
      const address = output.script.toAddress('livenet').toString();
      if (address === params.toAddress) {
        outputIndex = i;
        break;
      }
    } catch {
      continue;
    }
  }
  if (outputIndex < 0) {
    throw new Error('Failed to resolve recipient output index from raw_tx');
  }

  const changeIndex = outputs.findIndex((output: any, index: number) => index !== outputIndex && Number(output.satoshis) > 0);

  return {
    txid,
    outputIndex,
    spentOutpoints: extractSpentOutpoints(tx),
    changeOutpoint: changeIndex >= 0 ? `${txid}:${changeIndex}` : null,
  };
}

async function runWorker<T extends WorkerTransferResult = WorkerTransferResult>(workerBasename: string, payload: unknown, env: NodeJS.ProcessEnv): Promise<T> {
  const appPath = app.getAppPath();
  const candidatePaths = getMainWorkerCandidatePaths({
    moduleDir: __dirname,
    appPath,
    workerBasename,
  });
  const workerPath = resolveMainWorkerPath({
    moduleDir: __dirname,
    appPath,
    workerBasename,
    exists: fs.existsSync,
  });
  if (!workerPath) {
    throw new Error(`Worker not found: ${workerBasename}. Tried: ${candidatePaths.join(', ')}`);
  }

  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    throw new Error('Electron executable not found');
  }

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;

  return await new Promise<T>((resolve, reject) => {
    const child = spawn(electronExe, [workerPath], {
      cwd: app.getPath('userData'),
      env: {
        ...baseEnv,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', (err) => {
      reject(new Error(getErrorMessage(err)));
    });

    child.once('close', () => {
      const output = stdout.trim() || stderr.trim();
      if (!output) {
        reject(new Error('Worker returned empty output'));
        return;
      }

      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      try {
        const parsed = JSON.parse(last) as { success?: boolean; error?: string } & WorkerTransferResult;
        if (!parsed.success) {
          reject(new Error(parsed.error || 'Worker failed'));
          return;
        }
        if (!parsed.txHex || typeof parsed.txHex !== 'string') {
          reject(new Error('Worker did not return txHex'));
          return;
        }
        resolve(parsed as T);
      } catch {
        reject(new Error(output));
      }
    });

    child.stdin?.write(JSON.stringify(payload), () => {
      child.stdin?.end();
    });
  });
}

async function runMvcTransferRawTxWorker(params: {
  mnemonic: string;
  path: string;
  toAddress: string;
  amountSats: number;
  feeRate: number;
  excludeOutpoints: string[];
}): Promise<WorkerTransferResult> {
  return await runWorker(
    'buildMvcTransferRawTxWorker.js',
    {
      toAddress: params.toAddress,
      amountSats: params.amountSats,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

async function runMvcFtTransferRawTxWorker(params: {
  mnemonic: string;
  path: string;
  token: BuildMvcFtToken;
  toAddress: string;
  amount: string;
  feeRate: number;
  excludeOutpoints: string[];
  fundingRawTx?: string;
  fundingOutpoint?: string;
}): Promise<WorkerTransferResult> {
  return await runWorker(
    'buildMvcFtTransferRawTxWorker.js',
    {
      token: params.token,
      toAddress: params.toAddress,
      amount: params.amount,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
      fundingRawTx: params.fundingRawTx,
      fundingOutpoint: params.fundingOutpoint,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

async function runMvcNftTransferRawTxWorker(params: {
  mnemonic: string;
  path: string;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  toAddress: string;
  feeRate: number;
  excludeOutpoints: string[];
}): Promise<WorkerTransferResult> {
  return await runWorker(
    'buildMvcNftTransferRawTxWorker.js',
    {
      genesis: params.genesis,
      codehash: params.codehash,
      tokenIndex: params.tokenIndex,
      toAddress: params.toAddress,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

export async function buildMvcTransferRawTx(
  store: MetabotStore,
  params: BuildMvcTransferRawTxParams,
  deps: WalletRawTxServiceDeps = {},
): Promise<BuildMvcTransferRawTxResult> {
  const excludeOutpoints = validateCommonTransferFields(params);
  if (!Number.isInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error('amount_sats must be a positive integer');
  }

  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error('MetaBot wallet not found');
  }

  const runner = deps.runMvcTransferRawTxWorker ?? runMvcTransferRawTxWorker;
  const workerResult = await runner({
    mnemonic: wallet.mnemonic,
    path: wallet.path || DEFAULT_PATH,
    toAddress: params.toAddress.trim(),
    amountSats: params.amountSats,
    feeRate: params.feeRate,
    excludeOutpoints,
  });
  const summary = summarizeMvcTransferTx({
    txHex: workerResult.txHex,
    amountSats: params.amountSats,
    toAddress: params.toAddress.trim(),
  });

  return {
    raw_tx: workerResult.txHex,
    txid: workerResult.txid || summary.txid,
    output_index: summary.outputIndex,
    spent_outpoints: summary.spentOutpoints,
    change_outpoint: summary.changeOutpoint,
  };
}

export async function buildMvcFtTransferRawTx(
  store: MetabotStore,
  params: BuildMvcFtTransferRawTxParams,
  deps: WalletRawTxServiceDeps = {},
): Promise<BuildMvcFtTransferRawTxResult> {
  const excludeOutpoints = validateCommonTransferFields(params);
  if (!params.token || typeof params.token !== 'object') {
    throw new Error('token is required');
  }
  const tokenGenesis = resolveFtGenesis(params.token);
  if (!tokenGenesis || !params.token.codeHash) {
    throw new Error('token.tokenID or token.genesisHash, and token.codeHash are required');
  }
  if (typeof params.amount !== 'string' || !/^\d+$/.test(params.amount) || params.amount === '0') {
    throw new Error('amount must be a positive integer string');
  }
  const fundingRawTx =
    typeof params.fundingRawTx === 'string' && params.fundingRawTx.trim()
      ? params.fundingRawTx.trim()
      : undefined;
  const fundingOutpoint = validateOptionalOutpoint(params.fundingOutpoint, 'funding_outpoint');
  if ((fundingRawTx && !fundingOutpoint) || (!fundingRawTx && fundingOutpoint)) {
    throw new Error('funding_raw_tx and funding_outpoint must be provided together');
  }

  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error('MetaBot wallet not found');
  }

  const runner = deps.runMvcFtTransferRawTxWorker ?? runMvcFtTransferRawTxWorker;
  const workerResult = await runner({
    mnemonic: wallet.mnemonic,
    path: wallet.path || DEFAULT_PATH,
    token: {
      ...params.token,
      genesisHash: tokenGenesis,
    },
    toAddress: params.toAddress.trim(),
    amount: params.amount,
    feeRate: params.feeRate,
    excludeOutpoints,
    fundingRawTx,
    fundingOutpoint,
  });

  if (!workerResult.amountCheckRawTx || typeof workerResult.amountCheckRawTx !== 'string') {
    throw new Error('Worker did not return amountCheckRawTx');
  }
  const tx = parseTx(workerResult.txHex);
  const txid = tx.id;
  const outputIndex = Number.isInteger(workerResult.outputIndex) ? Number(workerResult.outputIndex) : 0;
  const changeOutpoint =
    typeof workerResult.changeOutpoint === 'string'
      ? workerResult.changeOutpoint
      : tx.outputs.length > outputIndex + 1
      ? `${txid}:${tx.outputs.length - 1}`
      : null;

  return {
    raw_tx: workerResult.txHex,
    txid,
    output_index: outputIndex,
    amount_check_raw_tx: workerResult.amountCheckRawTx,
    spent_outpoints: workerResult.spentOutpoints ?? extractSpentOutpoints(tx),
    change_outpoint: changeOutpoint,
  };
}

export async function buildMvcNftTransferRawTx(
  store: MetabotStore,
  params: BuildMvcNftTransferRawTxParams,
  deps: WalletRawTxServiceDeps = {},
): Promise<BuildMvcNftTransferRawTxResult> {
  const excludeOutpoints = validateCommonTransferFields(params);
  const tokenIndex = String(params.tokenIndex ?? '').trim();
  if (!/^\d+$/.test(tokenIndex)) {
    throw new Error('tokenIndex must be a positive integer string');
  }
  if (!params.genesis?.trim() || !params.codehash?.trim()) {
    throw new Error('genesis and codehash are required');
  }
  if (!Number.isFinite(params.feeRate) || params.feeRate <= 0) {
    throw new Error('feeRate must be positive');
  }

  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error('MetaBot wallet not found');
  }

  const runner = deps.runMvcNftTransferRawTxWorker ?? runMvcNftTransferRawTxWorker;
  const workerResult = await runner({
    mnemonic: wallet.mnemonic,
    path: wallet.path || DEFAULT_PATH,
    genesis: params.genesis.trim(),
    codehash: params.codehash.trim(),
    tokenIndex,
    toAddress: params.toAddress.trim(),
    feeRate: params.feeRate,
    excludeOutpoints,
  });

  const tx = parseTx(workerResult.txHex);
  return {
    raw_tx: workerResult.txHex,
    txid: workerResult.txid || tx.id,
    spent_outpoints: workerResult.spentOutpoints ?? extractSpentOutpoints(tx),
  };
}

async function runMvcNftSellRawTxWorker(params: BuildMvcNftSellRawTxParams & {
  mnemonic: string;
  path: string;
  excludeOutpoints: string[];
}): Promise<WorkerTradeResult> {
  // The trade worker contract extends the transfer one with the funding tx
  // fields; summarizeNftTradeWorkerResult re-checks them at runtime.
  return await runWorker<WorkerTradeResult>(
    'buildMvcNftTradeRawTxWorker.js',
    {
      action: 'sell',
      genesis: params.genesis,
      codehash: params.codehash,
      tokenIndex: params.tokenIndex,
      price: params.priceSats,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

async function runMvcNftCancelSellRawTxWorker(params: BuildMvcNftCancelSellRawTxParams & {
  mnemonic: string;
  path: string;
  excludeOutpoints: string[];
}): Promise<WorkerTradeResult> {
  return await runWorker<WorkerTradeResult>(
    'buildMvcNftTradeRawTxWorker.js',
    {
      action: 'cancelSell',
      genesis: params.genesis,
      codehash: params.codehash,
      tokenIndex: params.tokenIndex,
      sellUtxo: params.sellUtxo,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

async function runMvcNftBuyRawTxWorker(params: BuildMvcNftBuyRawTxParams & {
  mnemonic: string;
  path: string;
  excludeOutpoints: string[];
}): Promise<WorkerTradeResult> {
  return await runWorker<WorkerTradeResult>(
    'buildMvcNftTradeRawTxWorker.js',
    {
      action: 'buy',
      genesis: params.genesis,
      codehash: params.codehash,
      tokenIndex: params.tokenIndex,
      sellUtxo: params.sellUtxo,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

function summarizeNftTradeWorkerResult(workerResult: WorkerTradeResult): BuildMvcNftTradeRawTxResult {
  if (!workerResult.fundingTxHex || typeof workerResult.fundingTxHex !== 'string') {
    throw new Error('Worker did not return fundingTxHex');
  }
  const tx = parseTx(workerResult.txHex);
  const txid = workerResult.txid || tx.id;
  const fundingTxid = workerResult.fundingTxid || parseTx(workerResult.fundingTxHex).id;
  return {
    funding_raw_tx: workerResult.fundingTxHex,
    funding_txid: fundingTxid,
    raw_tx: workerResult.txHex,
    txid,
    funding_spent_outpoints: workerResult.fundingSpentOutpoints ?? extractSpentOutpoints(parseTx(workerResult.fundingTxHex)),
    spent_outpoints: workerResult.spentOutpoints ?? extractSpentOutpoints(tx),
  };
}

/**
 * Shared builder for the NftManager trade operations (sell/cancelSell/buy):
 * the worker emits two chained raw txs and the caller broadcasts stage 1 then
 * stage 2 (see executeMvcNftTrade in mvcNftService).
 */
export async function buildMvcNftTradeRawTx(
  store: MetabotStore,
  params: Omit<BuildMvcNftSellRawTxParams | BuildMvcNftCancelSellRawTxParams | BuildMvcNftBuyRawTxParams, 'priceSats' | 'sellUtxo'> & {
    action: 'sell' | 'cancelSell' | 'buy';
    priceSats?: number;
    sellUtxo?: MvcNftSellUtxoRef;
  },
  deps: WalletRawTxServiceDeps = {},
): Promise<BuildMvcNftTradeRawTxResult> {
  // No toAddress on trade operations, so the common transfer validation is
  // replaced by the metabotId + exclusion-list checks it would have covered.
  if (!Number.isInteger(params.metabotId) || params.metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }
  const excludeOutpoints = validateExcludeOutpoints(params.excludeOutpoints);
  const tokenIndex = String(params.tokenIndex ?? '').trim();
  if (!/^\d+$/.test(tokenIndex)) {
    throw new Error('tokenIndex must be a positive integer string');
  }
  if (!params.genesis?.trim() || !params.codehash?.trim()) {
    throw new Error('genesis and codehash are required');
  }
  if (!Number.isFinite(params.feeRate) || params.feeRate <= 0) {
    throw new Error('feeRate must be positive');
  }
  if (params.action === 'sell' && (!Number.isInteger(params.priceSats) || (params.priceSats as number) <= 0)) {
    throw new Error('priceSats must be a positive integer for sell');
  }

  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error('MetaBot wallet not found');
  }

  const runners = {
    sell: deps.runMvcNftSellRawTxWorker ?? runMvcNftSellRawTxWorker,
    cancelSell: deps.runMvcNftCancelSellRawTxWorker ?? runMvcNftCancelSellRawTxWorker,
    buy: deps.runMvcNftBuyRawTxWorker ?? runMvcNftBuyRawTxWorker,
  };
  const base = {
    metabotId: params.metabotId,
    mnemonic: wallet.mnemonic,
    path: wallet.path || DEFAULT_PATH,
    genesis: params.genesis.trim(),
    codehash: params.codehash.trim(),
    tokenIndex,
    feeRate: params.feeRate,
    excludeOutpoints,
  };
  let workerResult: WorkerTradeResult;
  if (params.action === 'sell') {
    workerResult = await runners.sell({ ...base, priceSats: params.priceSats as number });
  } else {
    const sellUtxo = params.sellUtxo;
    if (sellUtxo != null) {
      if (!/^[0-9a-fA-F]{64}$/.test(String(sellUtxo.txId || '').trim()) || !Number.isInteger(Number(sellUtxo.outputIndex)) || Number(sellUtxo.outputIndex) < 0) {
        throw new Error('sellUtxo.txId (64 hex) and sellUtxo.outputIndex (integer) are required');
      }
    }
    workerResult = params.action === 'cancelSell'
      ? await runners.cancelSell({ ...base, sellUtxo })
      : await runners.buy({ ...base, sellUtxo });
  }
  return summarizeNftTradeWorkerResult(workerResult);
}

function resolveBundleFunding(params: {
  results: BuildMvcOrderedRawTxBundleResultStep[];
  funding?: BuildMvcOrderedRawTxBundleFunding;
  stepIndex: number;
}): { rawTx: string; outpoint: string } | undefined {
  const funding = params.funding;
  if (!funding) return undefined;

  const referencedStepIndex = Number(funding.stepIndex);
  if (!Number.isInteger(referencedStepIndex) || referencedStepIndex < 0 || referencedStepIndex >= params.stepIndex) {
    throw new Error(`steps[${params.stepIndex}].funding.stepIndex must reference an earlier step`);
  }
  const useOutput = funding.useOutput ?? 'change';
  if (useOutput !== 'change') {
    throw new Error(`steps[${params.stepIndex}].funding.useOutput must be "change"`);
  }

  const sourceStep = params.results[referencedStepIndex];
  if (!sourceStep?.change_outpoint) {
    throw new Error('Previous bundle task did not produce a change output for the next task.');
  }

  return {
    rawTx: sourceStep.raw_tx,
    outpoint: sourceStep.change_outpoint,
  };
}

// ---------------------------------------------------------------------------
// FT TokenSell builders (worker spawn + validation; see buildMvcTokenSellRawTxWorker)
// ---------------------------------------------------------------------------

async function runMvcTokenSellRawTxWorker(params: BuildMvcTokenSellTradeParams & {
  mnemonic: string;
  path: string;
  excludeOutpoints: string[];
}): Promise<WorkerTokenSellResult> {
  return await runWorker<WorkerTokenSellResult>(
    'buildMvcTokenSellRawTxWorker.js',
    {
      action: params.action,
      genesis: params.genesis,
      codehash: params.codehash,
      tokenTxid: params.tokenTxid,
      tokenVout: params.tokenVout,
      tokenAmount: params.tokenAmount,
      sellPriceSats: params.priceSats,
      seedSats: params.seedSats,
      checkerSats: params.checkerSats,
      listing: params.listing,
      receiverAddress: params.receiverAddress,
      prevTokenInputIndex: params.prevTokenInputIndex,
      feeRate: params.feeRate,
      excludeOutpoints: params.excludeOutpoints,
    },
    {
      IDBOTS_METABOT_MNEMONIC: params.mnemonic,
      IDBOTS_METABOT_PATH: params.path,
    },
  );
}

export async function buildMvcTokenSellRawTx(
  store: MetabotStore,
  params: BuildMvcTokenSellTradeParams,
  deps: WalletRawTxServiceDeps = {},
): Promise<BuildMvcTokenSellRawTxResult> {
  if (!Number.isInteger(params.metabotId) || params.metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }
  const excludeOutpoints = validateExcludeOutpoints(params.excludeOutpoints);
  if (!Number.isFinite(params.feeRate) || params.feeRate <= 0) {
    throw new Error('feeRate must be positive');
  }
  if (params.action === 'sell') {
    if (!/^[0-9a-fA-F]{64}$/.test(String(params.genesis || '').trim())) throw new Error('genesis (64 hex) is required for sell');
    if (!/^[0-9a-fA-F]{40}$/.test(String(params.codehash || '').trim())) throw new Error('codehash (40 hex) is required for sell');
    if (!Number.isSafeInteger(params.priceSats) || (params.priceSats as number) <= 0) {
      throw new Error('priceSats must be a positive integer (sats; 1 SPACE = 1e8 sats)');
    }
  } else if (params.action === 'take' || params.action === 'cancel') {
    const listing = params.listing;
    if (!listing || !/^[0-9a-fA-F]{64}$/.test(String(listing.sell_txid || ''))) {
      throw new Error('listing.sell_txid (64 hex) is required for take/cancel');
    }
    if (!Number.isSafeInteger(listing.sell_price_sats) || listing.sell_price_sats <= 0) {
      throw new Error('listing.sell_price_sats must be a positive integer (sats)');
    }
    if (!String(listing.seller_address || '').trim()) throw new Error('listing.seller_address is required');
    if (params.action === 'take' && !String(params.receiverAddress || '').trim()) {
      throw new Error('receiverAddress is required for take');
    }
  } else if (params.action === 'transfer') {
    if (!/^[0-9a-fA-F]{64}$/.test(String(params.genesis || '').trim())) throw new Error('genesis (64 hex) is required for transfer');
    if (!/^[0-9a-fA-F]{40}$/.test(String(params.codehash || '').trim())) throw new Error('codehash (40 hex) is required for transfer');
    if (!String(params.receiverAddress || '').trim()) {
      throw new Error('receiverAddress is required for transfer (raw MVC address)');
    }
  } else {
    throw new Error('action must be sell, take, cancel, or transfer');
  }

  const wallet = store.getMetabotWalletByMetabotId(params.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error('MetaBot wallet not found');
  }

  const runner = deps.runMvcTokenSellRawTxWorker ?? runMvcTokenSellRawTxWorker;
  const workerResult = await runner({
    ...params,
    mnemonic: wallet.mnemonic,
    path: wallet.path || DEFAULT_PATH,
    excludeOutpoints,
  });

  const fundingTxs = Array.isArray(workerResult.fundingTxs) ? workerResult.fundingTxs : [];
  if (!fundingTxs.length) throw new Error('Worker did not return fundingTxs');
  for (const funding of fundingTxs) {
    if (!funding?.txHex || !/^[0-9a-f]+$/i.test(funding.txHex)) {
      throw new Error(`Funding tx ${funding?.name ?? '?'} malformed`);
    }
  }
  const tx = parseTx(workerResult.txHex);
  const txid = workerResult.txid || tx.id;
  return {
    funding_txs: fundingTxs.map((f) => ({ name: f.name, txid: f.txid || parseTx(f.txHex).id, raw_tx: f.txHex })),
    funding_txids: fundingTxs.map((f) => f.txid || parseTx(f.txHex).id),
    raw_tx: workerResult.txHex,
    txid,
    listing: workerResult.listing,
    spent_outpoints: workerResult.spentOutpoints ?? extractSpentOutpoints(tx),
  };
}

export async function buildMvcOrderedRawTxBundle(
  store: MetabotStore,
  params: BuildMvcOrderedRawTxBundleParams,
  deps: WalletRawTxServiceDeps = {},
): Promise<{ steps: BuildMvcOrderedRawTxBundleResultStep[] }> {
  if (!Number.isInteger(params.metabotId) || params.metabotId <= 0) {
    throw new Error('metabot_id must be a positive integer');
  }
  if (!Array.isArray(params.steps) || params.steps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }

  const steps: BuildMvcOrderedRawTxBundleResultStep[] = [];
  const spentOutpoints = new Set<string>();

  for (let index = 0; index < params.steps.length; index += 1) {
    const step = params.steps[index];
    if (!step || typeof step !== 'object') {
      throw new Error(`steps[${index}] must be an object`);
    }

    const inheritedExcludeOutpoints = spentOutpoints.size > 0 ? Array.from(spentOutpoints) : undefined;
    if (step.kind === 'mvc_transfer') {
      const result = await buildMvcTransferRawTx(
        store,
        {
          metabotId: params.metabotId,
          toAddress: step.toAddress,
          amountSats: step.amountSats,
          feeRate: step.feeRate,
          excludeOutpoints: mergeOutpointLists(step.excludeOutpoints, inheritedExcludeOutpoints),
        },
        deps,
      );
      result.spent_outpoints.forEach((outpoint) => spentOutpoints.add(outpoint.toLowerCase()));
      steps.push({
        index,
        kind: step.kind,
        ...result,
      });
      continue;
    }

    if (step.kind === 'mvc_ft_transfer') {
      const resolvedFunding = resolveBundleFunding({
        results: steps,
        funding: step.funding,
        stepIndex: index,
      });
      const result = await buildMvcFtTransferRawTx(
        store,
        {
          metabotId: params.metabotId,
          token: step.token,
          toAddress: step.toAddress,
          amount: step.amount,
          feeRate: step.feeRate,
          excludeOutpoints: mergeOutpointLists(step.excludeOutpoints, inheritedExcludeOutpoints),
          fundingRawTx: resolvedFunding?.rawTx,
          fundingOutpoint: resolvedFunding?.outpoint,
        },
        deps,
      );
      result.spent_outpoints.forEach((outpoint) => spentOutpoints.add(outpoint.toLowerCase()));
      steps.push({
        index,
        kind: step.kind,
        ...result,
        resolved_funding_outpoint: resolvedFunding?.outpoint,
      });
      continue;
    }

    throw new Error(`Unsupported step kind at steps[${index}]`);
  }

  return { steps };
}
