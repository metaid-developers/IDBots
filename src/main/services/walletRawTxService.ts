import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { mvc } from 'meta-contract';
import type { MetabotStore } from '../metabotStore';
import { resolveElectronExecutablePath } from '../libs/runtimePaths';

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

async function runWorker(workerBasename: string, payload: unknown, env: NodeJS.ProcessEnv): Promise<WorkerTransferResult> {
  const appPath = app.getAppPath();
  const candidatePaths = [
    path.join(__dirname, '..', 'libs', workerBasename),
    path.join(appPath, 'dist-electron', 'libs', workerBasename),
    path.join(appPath, 'libs', workerBasename),
  ];
  const workerPath = candidatePaths.find((entry) => fs.existsSync(entry)) ?? candidatePaths[0];
  if (!fs.existsSync(workerPath)) {
    throw new Error(`Worker not found: ${workerBasename}`);
  }

  const electronExe = resolveElectronExecutablePath();
  if (!electronExe || !fs.existsSync(electronExe)) {
    throw new Error('Electron executable not found');
  }

  const baseEnv = { ...process.env };
  delete baseEnv.ELECTRON_NO_ATTACH_CONSOLE;
  delete baseEnv.NODE_PATH;

  return await new Promise<WorkerTransferResult>((resolve, reject) => {
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
        resolve(parsed);
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
