/**
 * MVC FT TokenSell worker (sell=LIST / take=op=2 UNLOCK / cancel=self-take /
 * transfer=op=1 non-trade full-utxo move): runs in a subprocess via
 * ELECTRON_RUN_AS_NODE (same pattern as buildMvcNftTradeRawTxWorker) so the
 * meta-contract scrypt engine never meets the Electron main process.
 *
 * The worker NEVER broadcasts. It returns the fully-signed raw txs in
 * broadcast order so the parent service can stage them (NFT-trade posture):
 *   sell: [TxC checker mint (when auto-minted), TxA seed, TxB listing]
 *   take: [TxC checker mint (when auto-minted), TxB taker tx]
 *   transfer: [TxC checker mint (auto-minted), TxB transfer tx]
 *
 * Signing layers are the live-fire-validated ones ported into
 * mvcTokenSellAssembly (see docs/token-sell-protocol.md for the tx anchors):
 *   - stage2b final fix: verbatim SDK input0 proof + prevTokenInputIndex=0
 *     + original 112B header (15-cell EQVERIFY green on the live pair).
 *   - OCS short-domain checker preimage; deterministic fee estimate so the
 *     dry-run and real signatures converge to one structure.
 *   - v10 consensus txid (scriptSig-committed) — mvc-lib Transaction.id.
 *
 * Hard gates enforced before any assembly (mvcTokenSellCore):
 *   - sell: price in integer sats (1 SPACE = 1e8 sats), ≥ dust floor;
 *     full-utxo listing only — partial-quantity listings are rejected
 *     (they break the checker conservation invariant);
 *     seed / checker denominations ≥ dust.
 *   - transfer: full-utxo move only (checker conservation), checker ≥ dust;
 *     receiver must be a raw MVC address — no price, no seed, no listing.
 *
 * Keys: the mnemonic arrives via env (IDBOTS_METABOT_MNEMONIC /
 * IDBOTS_METABOT_PATH), is used in-process only, and is never echoed into
 * logs, results or errors.
 */

import { readFileSync } from 'fs';
import { getMvcWalletFromPath } from '../services/metabotWalletService';
import {
  assertTokenSellAmountGates,
  assertTokenTransferAmountGates,
  buildTokenSellSeedLock,
  decodeTokenSellSeedLock,
  DEFAULT_SEED_SATS,
  DUST_SATS,
} from './mvcTokenSellCore';
import {
  buildCheckerMintTx,
  buildListTxB,
  buildSeedTx,
  buildTakeTx,
  buildTransferCheckLock,
  buildTransferTxB,
  buildUnlockCheckLock,
  CheckerCast,
  getOptimumCheckerType,
  getTokenCodeHashHex,
  getTokenIdHex,
  makeDryTokenSellKeypair,
  parseTokenDataPart,
  signerFromWif,
  TokenSellSigner,
} from './mvcTokenSellAssembly';

const METALET_HOST = (process.env.IDBOTS_METALET_HOST || 'https://www.metalet.space').replace(/\/+$/, '');
const APIMVC_HOST = (process.env.IDBOTS_MVC_API_HOST || 'https://api.microvisionchain.com/open-api-mvc').replace(/\/+$/, '');
const NET = 'mainnet'; // APIMVC ft endpoints use mainnet; wallet-api uses livenet param
const DEFAULT_CHECKER_SATS = 3000n;
// Live-fire scale: LIST tx is ~16.7KB; fund the seed change with headroom.
const MIN_TXB_FEE_BUDGET = 20000n;

interface WorkerFundingUtxo {
  txid: string;
  vout: number;
  sats: bigint;
}

interface RawMvcUtxoRow {
  txid?: string;
  outIndex?: number | string;
  value?: number | string;
  height?: number | string;
  flag?: string;
}

interface FtUtxoRow {
  txid?: string;
  txIndex?: number | string;
  valueString?: string;
  codeHash?: string;
  genesis?: string;
}

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[buildMvcTokenSellRawTxWorker] ${message}${suffix}\n`);
  } catch {
    // ignore logging failures
  }
}

function fail(error: string): never {
  console.log(JSON.stringify({ success: false, error }));
  process.exit(1);
}

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url.slice(0, 120)} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRawTx(txid: string, hintHex?: string): Promise<string> {
  const normalizedTxid = String(txid || '').trim().toLowerCase();
  const normalizedHint = String(hintHex || '').trim().toLowerCase();
  if (normalizedHint && /^[0-9a-f]+$/.test(normalizedHint)) {
    try {
      if (new mvc.Transaction(normalizedHint).id === normalizedTxid) {
        return normalizedHint;
      }
    } catch {
      // fall through to network fetch
    }
  }
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const json = await fetchJson<{ data?: { hex?: string } }>(
        `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?txId=${normalizedTxid}&net=mainnet`,
      );
      const hex = json?.data?.hex;
      if (hex) return hex.toLowerCase();
      lastErr = new Error(`no raw tx from metalet: ${normalizedTxid}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 3) await sleep(350 * attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(`no raw tx from metalet: ${normalizedTxid}`);
}

async function fetchP2pkhUtxos(
  address: string,
  preferredFundingUtxos?: Array<{ txId?: string; outputIndex?: number; satoshis?: number }>,
): Promise<WorkerFundingUtxo[]> {
  const all: RawMvcUtxoRow[] = [];
  try {
    let flag: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams({ address, net: 'livenet', ...(flag ? { flag } : {}) });
      const json = await fetchJson<{ data?: { list?: RawMvcUtxoRow[] } }>(
        `${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`,
      );
      const list = json?.data?.list ?? [];
      if (!list.length) break;
      all.push(...list);
      const nextFlag = typeof list[list.length - 1]?.flag === 'string' ? String(list[list.length - 1].flag) : undefined;
      if (!nextFlag || nextFlag === '0' || nextFlag === flag) break;
      flag = nextFlag;
    }
  } catch (err) {
    if (!Array.isArray(preferredFundingUtxos) || preferredFundingUtxos.length === 0) {
      throw err;
    }
  }
  const byOutpoint = new Map<string, WorkerFundingUtxo>();
  for (const pref of Array.isArray(preferredFundingUtxos) ? preferredFundingUtxos : []) {
    const txid = String(pref?.txId || '').trim().toLowerCase();
    const vout = Number(pref?.outputIndex);
    const sats = BigInt(Math.round(Number(pref?.satoshis || 0)));
    if (/^[0-9a-f]{64}$/.test(txid) && Number.isInteger(vout) && vout >= 0 && sats >= 600n) {
      byOutpoint.set(`${txid}:${vout}`, { txid, vout, sats });
    }
  }
  for (const row of all) {
    const txid = String(row.txid || '').trim().toLowerCase();
    const vout = Number(row.outIndex);
    const sats = BigInt(Math.round(Number(row.value || 0)));
    if (/^[0-9a-f]{64}$/.test(txid) && Number.isInteger(vout) && vout >= 0 && sats >= 600n) {
      byOutpoint.set(`${txid}:${vout}`, { txid, vout, sats });
    }
  }
  return Array.from(byOutpoint.values());
}

interface MetaletFtUtxoRow {
  txid?: string;
  txId?: string;
  outputIndex?: number | string;
  outIndex?: number | string;
  txIndex?: number | string;
  amount?: string | number;
  valueString?: string | number;
  tokenAmount?: string | number;
}

async function fetchFtUtxos(address: string, codeHash: string, genesis: string): Promise<FtUtxoRow[]> {
  try {
    const rows = await fetchJson<FtUtxoRow[]>(
      `${APIMVC_HOST}/contract/ft/address/${encodeURIComponent(address)}/utxo?codeHash=${codeHash}&genesis=${genesis}`,
    );
    if (Array.isArray(rows) && rows.length > 0) return rows;
  } catch {
    // Fall back to Metalet FT UTXO endpoint
  }
  try {
    const params = new URLSearchParams({
      address,
      codeHash,
      genesis,
      net: 'livenet',
    });
    const json = await fetchJson<{ data?: MetaletFtUtxoRow[] | { list?: MetaletFtUtxoRow[] } }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/ft/utxo-list?${params}`,
    );
    const rawList = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.data?.list)
        ? json.data.list
        : [];
    return rawList.map((r) => ({
      txid: String(r.txid || r.txId || '').trim().toLowerCase(),
      txIndex: Number(r.txIndex ?? r.outputIndex ?? r.outIndex ?? -1),
      valueString: String(r.valueString ?? r.tokenAmount ?? r.amount ?? '0'),
      codeHash,
      genesis,
    }));
  } catch {
    return [];
  }
}

function isValidHexGenesis(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
}

function extractMintChangeUtxo(mint: { tc: any; txid: string }): WorkerFundingUtxo | null {
  try {
    const outputs = mint.tc.getTx().outputs as Array<{ satoshis: number; script: { toBuffer: () => Buffer } }>;
    for (let idx = 0; idx < outputs.length; idx += 1) {
      const buf = outputs[idx].script.toBuffer();
      if (buf.length === 25 && buf[0] === 0x76) {
        const sats = BigInt(Math.round(Number(outputs[idx].satoshis || 0)));
        if (sats >= 600n) {
          return { txid: mint.txid.toLowerCase(), vout: idx, sats };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveVerifiedFtUtxo(params: {
  walletAddress: string;
  walletH160Hex: string;
  codehash: string;
  genesis: string;
  tokenTxid?: string;
  tokenVout?: number;
  tokenTxHexHint?: string;
}): Promise<{
  tokenTxid: string;
  tokenVout: number;
  tokenTxHex: string;
  tokenTx: any;
  tokenScriptBuf: Buffer;
  utxoAmount: bigint;
}> {
  const { walletAddress, walletH160Hex } = params;
  const codehashLower = params.codehash.toLowerCase();
  const genesisLower = params.genesis.toLowerCase();
  let tokenTxid = String(params.tokenTxid || '').trim().toLowerCase();
  let tokenVout = Number(params.tokenVout);

  // Fast 0-conf direct tx inspection when tokenTxid is explicitly provided
  if (tokenTxid && /^[0-9a-f]{64}$/.test(tokenTxid)) {
    const tokenTxHex = await fetchRawTx(tokenTxid, params.tokenTxHexHint);
    const tokenTx = new mvc.Transaction(tokenTxHex);
    if (tokenTx.id !== tokenTxid) {
      fail(`token raw consensus id ${tokenTx.id} != ${tokenTxid}`);
    }
    const candidateIndices =
      Number.isInteger(tokenVout) && tokenVout >= 0 && tokenVout < tokenTx.outputs.length
        ? [tokenVout]
        : tokenTx.outputs.map((_: unknown, idx: number) => idx);

    for (const idx of candidateIndices) {
      try {
        const scriptBuf = tokenTx.outputs[idx].script.toBuffer();
        const dp = parseTokenDataPart(scriptBuf);
        const ownerHex = Buffer.from(String(dp.tokenAddress || ''), 'hex').toString('hex');
        const scriptCodeHash = getTokenCodeHashHex(scriptBuf).toLowerCase();
        const scriptTokenId = getTokenIdHex(scriptBuf).toLowerCase();
        const utxoAmount = BigInt(String(dp.tokenAmount || '0'));
        if (ownerHex !== walletH160Hex) continue;
        if (scriptCodeHash !== codehashLower) continue;
        if (genesisLower.length === 40 && scriptTokenId !== genesisLower) continue;
        if (utxoAmount <= 0n) continue;
        return {
          tokenTxid,
          tokenVout: idx,
          tokenTxHex,
          tokenTx,
          tokenScriptBuf: scriptBuf,
          utxoAmount,
        };
      } catch {
        // non-FT output; keep scanning
      }
    }
    fail(
      `token utxo ${tokenTxid}${Number.isInteger(tokenVout) && tokenVout >= 0 ? ':' + tokenVout : ''} not held by ${walletAddress} for codehash ${codehashLower}`,
    );
  }

  // Otherwise discover single held FT UTXO via indexer
  const ftRows = await fetchFtUtxos(walletAddress, params.codehash, params.genesis);
  if (!ftRows.length) fail(`no FT utxos for genesis ${params.genesis} at ${walletAddress}`);
  const rows = ftRows
    .map((r) => ({
      txid: String(r.txid || '').toLowerCase(),
      vout: Number(r.txIndex),
      amount: BigInt(String(r.valueString || '0')),
    }))
    .filter((r) => /^[0-9a-f]{64}$/.test(r.txid) && Number.isInteger(r.vout) && r.vout >= 0 && r.amount > 0n);
  if (!rows.length) fail('FT utxo rows unparsable');
  if (rows.length !== 1) {
    fail(`address holds ${rows.length} FT utxos for this genesis — pass token_txid (and token_vout) or amount to split/pick one`);
  }
  tokenTxid = rows[0].txid;
  tokenVout = rows[0].vout;
  const tokenTxHex = await fetchRawTx(tokenTxid);
  const tokenTx = new mvc.Transaction(tokenTxHex);
  if (tokenTx.id !== tokenTxid) fail(`token raw consensus id ${tokenTx.id} != ${tokenTxid}`);
  const tokenScriptBuf = tokenTx.outputs[tokenVout].script.toBuffer();
  const dp = parseTokenDataPart(tokenScriptBuf);
  const ownerHex = Buffer.from(String(dp.tokenAddress || ''), 'hex').toString('hex');
  if (ownerHex !== walletH160Hex) {
    fail(`token utxo owner ${ownerHex} != session wallet ${walletH160Hex} (token not in this wallet)`);
  }
  const utxoAmount = BigInt(String(dp.tokenAmount));
  return { tokenTxid, tokenVout, tokenTxHex, tokenTx, tokenScriptBuf, utxoAmount };
}

function spentOutpointsOfTxHex(txHex: string, mvc: typeof import('meta-contract').mvc): string[] {
  const tx = new mvc.Transaction(txHex);
  return tx.inputs.map((input: any) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`);
}

const { mvc } = require('meta-contract');
const tokenSellDesc = require('meta-contract/dist/mcp02/contract-desc/tokenSell_desc.json');

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || "m/44'/10001'/0'/0/0").trim();
  if (!mnemonic) fail('IDBOTS_METABOT_MNEMONIC required');

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
    action: 'sell' | 'take' | 'cancel' | 'transfer';
    // sell / transfer
    genesis?: string;
    codehash?: string;
    tokenTxid?: string;
    tokenVout?: number;
    tokenTxHex?: string;
    tokenAmount?: string;
    // sell
    sellPriceSats?: number;
    seedSats?: number;
    checkerSats?: number;
    // take / cancel
    listing?: {
      sell_txid: string;
      sell_output_index: number;
      sell_price_sats: number;
      seller_address: string;
      seed_txid?: string;
      seed_vout?: number;
      token_txid?: string;
      token_vout?: number;
      prev_token_txid?: string;
    };
    // take / transfer
    receiverAddress?: string;
    prevTokenInputIndex?: number;
    excludeOutpoints?: string[];
    preferredFundingUtxos?: Array<{ txId?: string; outputIndex?: number; satoshis?: number }>;
    feeRate?: number;
  };

  const action = String(payload.action || '').trim();
  if (action !== 'sell' && action !== 'take' && action !== 'cancel' && action !== 'transfer') {
    fail('action must be sell, take, cancel (cancel = self-take of your own listing), or transfer (op=1 non-trade full-utxo move)');
  }
  const excludeOutpoints = new Set(
    (Array.isArray(payload.excludeOutpoints) ? payload.excludeOutpoints : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
  const feeRate = Number.isFinite(Number(payload.feeRate)) && Number(payload.feeRate) > 0 ? Number(payload.feeRate) : 1;

  // Path-aware derivation (parity with buildMvcTransferRawTxWorker): a legacy
  // 236-segment issuer bot must derive its own address, not the 10001 default.
  const mvcWallet = await getMvcWalletFromPath(mnemonic, pathStr);
  const signer: TokenSellSigner = signerFromWif(mvcWallet.getPrivateKey(), 'real');
  const sellerAddress = mvcWallet.getAddress();
  logStep('wallet resolved', { action, address: sellerAddress });

  // ---------------------------------------------------------------- sell (LIST)
  if (action === 'sell') {
    const genesis = String(payload.genesis || '').trim();
    const codehash = String(payload.codehash || '').trim();
    if (!isValidHexGenesis(genesis) || !/^[0-9a-f]{40}$/i.test(codehash)) {
      fail('sell requires genesis (40 or 64 hex) and codehash (40 hex)');
    }
    const priceSats = Number(payload.sellPriceSats);
    if (!Number.isSafeInteger(priceSats) || priceSats <= 0) {
      fail('sellPriceSats must be a positive integer (sats; 1 SPACE = 1e8 sats)');
    }
    const seedSats = payload.seedSats !== undefined ? BigInt(payload.seedSats) : DEFAULT_SEED_SATS;
    const checkerSats = payload.checkerSats !== undefined ? BigInt(payload.checkerSats) : DEFAULT_CHECKER_SATS;

    // -- token utxo discovery / verification (0-conf split-safe)
    const sellerH160Hex = mvc.crypto.Hash.sha256ripemd160(Buffer.from(signer.pubHex, 'hex')).toString('hex');
    const resolvedUtxo = await resolveVerifiedFtUtxo({
      walletAddress: sellerAddress,
      walletH160Hex: sellerH160Hex,
      codehash,
      genesis,
      tokenTxid: payload.tokenTxid,
      tokenVout: payload.tokenVout,
      tokenTxHexHint: payload.tokenTxHex,
    });
    const { tokenTxid, tokenVout, tokenTxHex, tokenTx, tokenScriptBuf, utxoAmount } = resolvedUtxo;
    const listedAmount = payload.tokenAmount !== undefined ? BigInt(String(payload.tokenAmount)) : utxoAmount;

    // -- HARD AMOUNT GATES (full-utxo listing; conservation pairing)
    try {
      assertTokenSellAmountGates({
        priceSats,
        listedTokenAmount: listedAmount,
        utxoTokenAmount: utxoAmount,
        seedSats,
        checkerSats,
      });
    } catch (err) {
      fail(getMessage(err));
    }

    // -- lineage: direct parent of the token leg (default slot 0)
    const prevTokenInputIndex = Number(payload.prevTokenInputIndex) >= 0 ? Number(payload.prevTokenInputIndex) : 0;
    const parentBuf = Buffer.from(tokenTx.inputs[prevTokenInputIndex].prevTxId);
    const candA = parentBuf.toString('hex');
    const candB = Buffer.from(parentBuf).reverse().toString('hex');
    let prevTokenTxHex: string | null = null;
    for (const cand of [candA, candB]) {
      try {
        const raw = await fetchRawTx(cand);
        if (new mvc.Transaction(raw).id === cand) {
          prevTokenTxHex = raw;
          break;
        }
      } catch {
        // try the other byte order
      }
    }
    if (!prevTokenTxHex) fail(`cannot resolve prev token tx raw (tried ${candA} / ${candB})`);

    // -- funding: distinct P2PKH utxos for checker mint and TxA (chains off checkerMint change when only 1 UTXO exists)
    const fundingPool = (await fetchP2pkhUtxos(sellerAddress, payload.preferredFundingUtxos))
      .filter((u) => !excludeOutpoints.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => (a.sats > b.sats ? -1 : a.sats < b.sats ? 1 : 0));
    const taken = new Set<string>();
    const takeUtxo = (minSats: bigint, purpose: string, fallback?: WorkerFundingUtxo | null): WorkerFundingUtxo => {
      const hit = fundingPool.find((u) => u.sats >= minSats && !taken.has(`${u.txid}:${u.vout}`));
      if (hit) {
        taken.add(`${hit.txid}:${hit.vout}`);
        return hit;
      }
      if (fallback && fallback.sats >= minSats && !taken.has(`${fallback.txid}:${fallback.vout}`)) {
        taken.add(`${fallback.txid}:${fallback.vout}`);
        return fallback;
      }
      fail(`no P2PKH utxo >= ${minSats} sats left for ${purpose}`);
    };

    // -- checker cast (op=1 family; receiver = seed lock hash160, amount = listed)
    const seedLock = buildTokenSellSeedLock(tokenSellDesc, sellerAddress, priceSats);
    const seedAddrH = mvc.crypto.Hash.sha256ripemd160(seedLock);
    const tokenCodeHashHex = getTokenCodeHashHex(tokenScriptBuf);
    const tokenIdHex = getTokenIdHex(tokenScriptBuf);
    const checkerType = getOptimumCheckerType(1, 3);
    const checkerLock = buildTransferCheckLock({
      type: checkerType,
      tokenCodeHashHex,
      tokenIdHex,
      receiverHash160Buf: seedAddrH,
      tokenAmount: listedAmount,
    });
    const mintFunding = takeUtxo(checkerSats + DUST_SATS + 250n, 'checker mint');
    const mint = buildCheckerMintTx({ checkerLock, checkerSats, funding: mintFunding, signer });
    const checker: CheckerCast = {
      scriptBuf: checkerLock,
      sats: checkerSats,
      type: checkerType,
      txid: mint.txid,
      vout: mint.outIdx,
      txHex: mint.txHex,
    };

    // -- TxA seed (uses independent UTXO when available, else chains off checkerMint P2PKH change)
    const txaFunding = takeUtxo(
      seedSats + DUST_SATS + MIN_TXB_FEE_BUDGET,
      'TxA seed',
      extractMintChangeUtxo(mint),
    );
    const txa = buildSeedTx({ seedLock, seedSats, funding: txaFunding, signer });

    // -- TxB listing
    const list = buildListTxB({
      tokenTxHex,
      tokenVout,
      tokenTxid,
      prevTokenTxHex,
      prevTokenInputIndex,
      tokenAmount: listedAmount,
      checker,
      txaTxid: txa.txid,
      txaChangeIdx: txa.changeIdx,
      txaChangeSat: BigInt(txa.tc.getOutput(txa.changeIdx).satoshis),
      seedLock,
      sellerSigner: signer,
      feeRate,
    });

    if (list.verdicts.token.cls !== 'PASS' || list.verdicts.checker.cls !== 'PASS') {
      fail(
        `LIST local verify not fully PASS (token=${list.verdicts.token.cls}:${list.verdicts.token.detail.slice(0, 120)}; ` +
          `checker=${list.verdicts.checker.cls}:${list.verdicts.checker.detail.slice(0, 120)}) — refusing to hand out txs`,
      );
    }

    const spent = Array.from(
      new Set([
        ...spentOutpointsOfTxHex(mint.txHex, mvc),
        ...spentOutpointsOfTxHex(txa.txHex, mvc),
        ...spentOutpointsOfTxHex(list.txHex, mvc),
      ]),
    );
    console.log(
      JSON.stringify({
        success: true,
        action,
        // broadcast order: checker mint → seed → listing
        fundingTxs: [
          { name: 'checkerMint', txid: mint.txid, txHex: mint.txHex },
          { name: 'seed', txid: txa.txid, txHex: txa.txHex },
        ],
        txHex: list.txHex,
        txid: list.txid,
        listing: {
          sell_txid: list.txid,
          sell_output_index: list.outIdx.token,
          seller_address: sellerAddress,
          sell_price_sats: priceSats,
          seed_txid: txa.txid,
          seed_vout: txa.seedIdx,
          seed_sats: Number(seedSats),
          token_amount: listedAmount.toString(),
          token_genesis: tokenIdHex,
          token_codehash: tokenCodeHashHex,
        },
        fee: Number(list.fee),
        size: list.size,
        spentOutpoints: spent,
      }),
    );
    logStep('Built TokenSell LIST raw txs locally', { mint: mint.txid, seed: txa.txid, list: list.txid });
    return;
  }

  // ------------------------------------------------ transfer (op=1, non-trade full-utxo move)
  if (action === 'transfer') {
    const genesis = String(payload.genesis || '').trim();
    const codehash = String(payload.codehash || '').trim();
    if (!isValidHexGenesis(genesis) || !/^[0-9a-f]{40}$/i.test(codehash)) {
      fail('transfer requires genesis (40 or 64 hex) and codehash (40 hex)');
    }
    const receiverAddress = String(payload.receiverAddress || '').trim();
    if (!receiverAddress) fail('receiverAddress required for transfer (raw MVC address receiving the tokens)');
    let receiverH160: string;
    try {
      receiverH160 = mvc.crypto.Hash.sha256ripemd160(
        Buffer.from(mvc.Address.fromString(receiverAddress, 'livenet').hashBuffer),
      ).toString('hex');
    } catch (err) {
      fail(`receiverAddress is not a valid MVC address: ${getMessage(err)}`);
    }
    const checkerSats = payload.checkerSats !== undefined ? BigInt(payload.checkerSats) : DEFAULT_CHECKER_SATS;

    // -- token utxo discovery / verification (same posture as sell)
    const senderH160Hex = mvc.crypto.Hash.sha256ripemd160(Buffer.from(signer.pubHex, 'hex')).toString('hex');
    const resolvedUtxo = await resolveVerifiedFtUtxo({
      walletAddress: sellerAddress,
      walletH160Hex: senderH160Hex,
      codehash,
      genesis,
      tokenTxid: payload.tokenTxid,
      tokenVout: payload.tokenVout,
      tokenTxHexHint: payload.tokenTxHex,
    });
    const { tokenTxid, tokenVout, tokenTxHex, tokenTx, tokenScriptBuf, utxoAmount } = resolvedUtxo;

    // -- HARD AMOUNT GATES (full-utxo move; checker conservation)
    if (payload.tokenAmount !== undefined && BigInt(String(payload.tokenAmount)) !== utxoAmount) {
      fail(`partial transfer rejected: requested ${payload.tokenAmount} != utxo ${utxoAmount} (op=1 TRANSFER moves the token utxo in full)`);
    }
    try {
      assertTokenTransferAmountGates({
        transferTokenAmount: utxoAmount,
        utxoTokenAmount: utxoAmount,
        checkerSats,
      });
    } catch (err) {
      fail(getMessage(err));
    }

    // -- lineage: direct parent of the token leg (default slot 0)
    const prevTokenInputIndex = Number(payload.prevTokenInputIndex) >= 0 ? Number(payload.prevTokenInputIndex) : 0;
    const parentBuf = Buffer.from(tokenTx.inputs[prevTokenInputIndex].prevTxId);
    const candA = parentBuf.toString('hex');
    const candB = Buffer.from(parentBuf).reverse().toString('hex');
    let prevTokenTxHex: string | null = null;
    for (const cand of [candA, candB]) {
      try {
        const raw = await fetchRawTx(cand);
        if (new mvc.Transaction(raw).id === cand) {
          prevTokenTxHex = raw;
          break;
        }
      } catch {
        // try the other byte order
      }
    }
    if (!prevTokenTxHex) fail(`cannot resolve prev token tx raw (tried ${candA} / ${candB})`);

    // -- funding: distinct P2PKH utxos for checker mint and the transfer tx
    const fundingPool = (await fetchP2pkhUtxos(sellerAddress, payload.preferredFundingUtxos))
      .filter((u) => !excludeOutpoints.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => (a.sats > b.sats ? -1 : a.sats < b.sats ? 1 : 0));
    const taken = new Set<string>();
    const takeUtxo = (minSats: bigint, purpose: string, fallback?: WorkerFundingUtxo | null): WorkerFundingUtxo => {
      const hit = fundingPool.find((u) => u.sats >= minSats && !taken.has(`${u.txid}:${u.vout}`));
      if (hit) {
        taken.add(`${hit.txid}:${hit.vout}`);
        return hit;
      }
      if (fallback && fallback.sats >= minSats && !taken.has(`${fallback.txid}:${fallback.vout}`)) {
        taken.add(`${fallback.txid}:${fallback.vout}`);
        return fallback;
      }
      fail(`no P2PKH utxo >= ${minSats} sats left for ${purpose}`);
    };

    // -- checker cast (op=1 family; receiver = RAW receiver hash160, amount = full utxo)
    const tokenCodeHashHex = getTokenCodeHashHex(tokenScriptBuf);
    const tokenIdHex = getTokenIdHex(tokenScriptBuf);
    const checkerType = getOptimumCheckerType(1, 3);
    const checkerLock = buildTransferCheckLock({
      type: checkerType,
      tokenCodeHashHex,
      tokenIdHex,
      receiverHash160Buf: Buffer.from(receiverH160, 'hex'),
      tokenAmount: utxoAmount,
    });
    const mintFunding = takeUtxo(checkerSats + DUST_SATS + 250n, 'checker mint');
    const mint = buildCheckerMintTx({ checkerLock, checkerSats, funding: mintFunding, signer });
    const checker: CheckerCast = {
      scriptBuf: checkerLock,
      sats: checkerSats,
      type: checkerType,
      txid: mint.txid,
      vout: mint.outIdx,
      txHex: mint.txHex,
    };

    // -- TxB transfer (fee budget only — no seed leg in a non-trade move)
    const txFunding = takeUtxo(
      MIN_TXB_FEE_BUDGET + DUST_SATS,
      'transfer tx (fee budget + dust change)',
      extractMintChangeUtxo(mint),
    );
    const transfer = buildTransferTxB({
      tokenTxHex,
      tokenVout,
      tokenTxid,
      prevTokenTxHex,
      prevTokenInputIndex,
      tokenAmount: utxoAmount,
      receiverH160Buf: Buffer.from(receiverH160, 'hex'),
      checker,
      funding: txFunding,
      signer,
      feeRate,
    });

    if (transfer.verdicts.token.cls !== 'PASS' || transfer.verdicts.checker.cls !== 'PASS') {
      fail(
        `TRANSFER local verify not fully PASS (token=${transfer.verdicts.token.cls}:${transfer.verdicts.token.detail.slice(0, 120)}; ` +
          `checker=${transfer.verdicts.checker.cls}:${transfer.verdicts.checker.detail.slice(0, 120)}) — refusing to hand out txs`,
      );
    }

    const spent = Array.from(
      new Set([
        ...spentOutpointsOfTxHex(mint.txHex, mvc),
        ...spentOutpointsOfTxHex(transfer.txHex, mvc),
      ]),
    );
    console.log(
      JSON.stringify({
        success: true,
        action,
        // broadcast order: checker mint → transfer
        fundingTxs: [{ name: 'checkerMint', txid: mint.txid, txHex: mint.txHex }],
        txHex: transfer.txHex,
        txid: transfer.txid,
        tokenAmount: utxoAmount.toString(),
        receiverAddress,
        fee: Number(transfer.fee),
        size: transfer.size,
        spentOutpoints: spent,
      }),
    );
    logStep('Built TokenTransfer raw txs locally', { mint: mint.txid, transfer: transfer.txid });
    return;
  }

  // ------------------------------------------------- take / cancel (op=2, cancel = self-take)
  const listing = payload.listing;
  if (!listing || !/^[0-9a-f]{64}$/i.test(String(listing.sell_txid || ''))) {
    fail('take/cancel requires listing.sell_txid (64 hex) — get it from the seller (wallet_token_sell output)');
  }
  const isCancel = action === 'cancel';
  const receiverAddress = String(payload.receiverAddress || '').trim() || (isCancel ? sellerAddress : '');
  if (!receiverAddress) fail('receiverAddress required for take (the address receiving the tokens)');
  const receiverH160 = mvc.crypto.Hash.sha256ripemd160(Buffer.from(mvc.Address.fromString(receiverAddress, 'livenet').hashBuffer)).toString('hex');
  const sellerH160Hex = mvc.crypto.Hash.sha256ripemd160(Buffer.from(mvc.Address.fromString(String(listing.seller_address || ''), 'livenet').hashBuffer)).toString('hex');

  const listTxHex = await fetchRawTx(listing.sell_txid);
  const listTx = new mvc.Transaction(listTxHex);
  if (listTx.id !== listing.sell_txid) fail(`LIST raw consensus id ${listTx.id} != sell_txid`);
  const tokenTxid = String(listing.token_txid || listing.sell_txid).toLowerCase();
  const tokenVout = Number.isInteger(Number(listing.token_vout)) ? Number(listing.token_vout) : Number(listing.sell_output_index);
  const saleScriptBuf = listTx.outputs[tokenVout].script.toBuffer();
  const saleDp = parseTokenDataPart(saleScriptBuf);
  const tokenAmount = BigInt(String(saleDp.tokenAmount));

  // seed: same-tx shape unless the listing says otherwise
  const seedTxid = String(listing.seed_txid || tokenTxid).toLowerCase();
  const seedVout = Number.isInteger(Number(listing.seed_vout)) ? Number(listing.seed_vout) : 0;
  const seedTxHex = seedTxid === tokenTxid ? listTxHex : await fetchRawTx(seedTxid);
  const seedTx = new mvc.Transaction(seedTxHex);
  if (seedTx.id !== seedTxid) fail(`seed raw consensus id ${seedTx.id} != seed_txid`);
  const seedLockBuf = seedTx.outputs[seedVout].script.toBuffer();

  // -- cross-check the listing claims against the on-chain seed lock (do not
  //    trust the counterparty's price): decode (seller, price) from the lock.
  let decodedSeller: string;
  let decodedPrice: bigint;
  try {
    const decoded = decodeTokenSellSeedLock(seedLockBuf, tokenSellDesc);
    decodedSeller = decoded.sellerHash160Hex;
    decodedPrice = decoded.priceSats;
  } catch (err) {
    fail(`seed output is not a TokenSell lock (vout ${seedVout}): ${getMessage(err)}`);
  }
  const claimedPrice = BigInt(Number(listing.sell_price_sats));
  if (decodedPrice !== claimedPrice) {
    fail(`listing price mismatch: seed lock encodes ${decodedPrice} sats, listing claims ${claimedPrice}`);
  }
  if (decodedSeller !== sellerH160Hex) {
    fail(`listing seller mismatch: seed lock encodes ${decodedSeller}, listing claims ${sellerH160Hex}`);
  }
  if (isCancel && decodedSeller !== mvc.crypto.Hash.sha256ripemd160(Buffer.from(signer.pubHex, 'hex')).toString('hex')) {
    fail('cancel (self-take) requires the session wallet to be the seller');
  }

  const priceSats = decodedPrice;
  const prevTokenInputIndex = Number(payload.prevTokenInputIndex) >= 0 ? Number(payload.prevTokenInputIndex) : 0;
  // direct parent of the LIST token leg (backtrace adjacency lock)
  const parentBuf2 = Buffer.from(listTx.inputs[prevTokenInputIndex].prevTxId);
  const candA2 = parentBuf2.toString('hex');
  const candB2 = Buffer.from(parentBuf2).reverse().toString('hex');
  let prevTokenTxHex: string | null = null;
  if (listing.prev_token_txid && /^[0-9a-f]{64}$/i.test(listing.prev_token_txid)) {
    prevTokenTxHex = await fetchRawTx(listing.prev_token_txid.toLowerCase());
  } else {
    for (const cand of [candA2, candB2]) {
      try {
        const raw = await fetchRawTx(cand);
        if (new mvc.Transaction(raw).id === cand) {
          prevTokenTxHex = raw;
          break;
        }
      } catch {
        // try the other byte order
      }
    }
  }
  if (!prevTokenTxHex) fail(`cannot resolve prev token tx raw (tried ${candA2} / ${candB2})`);

  // -- funding + op=2 checker cast (receiver = taker's own address)
  const checkerSats = payload.checkerSats !== undefined ? BigInt(payload.checkerSats) : DEFAULT_CHECKER_SATS;
  const fundingPool = (await fetchP2pkhUtxos(sellerAddress))
    .filter((utxo) => !excludeOutpoints.has(`${utxo.txid}:${utxo.vout}`))
    .sort((a, b) => (a.sats > b.sats ? -1 : a.sats < b.sats ? 1 : 0));
  const taken = new Set<string>();
  const takeUtxo = (minSats: bigint, purpose: string): WorkerFundingUtxo => {
    const hit = fundingPool.find((utxo) => utxo.sats >= minSats && !taken.has(`${utxo.txid}:${utxo.vout}`));
    if (!hit) fail(`no P2PKH utxo >= ${minSats} sats left for ${purpose}`);
    taken.add(`${hit.txid}:${hit.vout}`);
    return hit;
  };

  const tokenCodeHashHex = getTokenCodeHashHex(saleScriptBuf);
  const tokenIdHex = getTokenIdHex(saleScriptBuf);
  const checkerType = getOptimumCheckerType(1, 3);
  const { lockBuf: op2Lock, dataPartObj } = buildUnlockCheckLock({
    type: checkerType,
    tokenCodeHashHex,
    tokenIdHex,
    receiverHash160Buf: Buffer.from(receiverH160, 'hex'),
    tokenAmount,
  });
  const mintFunding = takeUtxo(checkerSats + DUST_SATS + 250n, 'checker mint');
  const mint = buildCheckerMintTx({ checkerLock: op2Lock, checkerSats, funding: mintFunding, signer });
  const checker: CheckerCast = {
    scriptBuf: op2Lock,
    sats: checkerSats,
    type: checkerType,
    txid: mint.txid,
    vout: mint.outIdx,
    txHex: mint.txHex,
    dataPartObj,
  };

  const minFunding = priceSats + DUST_SATS + 20000n;
  const txFunding = takeUtxo(minFunding, 'taker tx (price + dust + fee budget)');

  // -- HARD AMOUNT GATES on the take side too (price/conservation sanity)
  try {
    assertTokenSellAmountGates({
      priceSats,
      listedTokenAmount: tokenAmount,
      utxoTokenAmount: tokenAmount,
      seedSats: BigInt(seedTx.outputs[seedVout].satoshis),
      checkerSats,
    });
  } catch (err) {
    fail(getMessage(err));
  }

  const take = buildTakeTx({
    listTxHex,
    tokenTxid,
    tokenVout,
    seedTxHex,
    seedTxid,
    seedVout,
    sellPriceSats: priceSats,
    sellerH160Buf: Buffer.from(sellerH160Hex, 'hex'),
    prevTokenTxHex,
    prevTokenInputIndex,
    tokenAmount,
    receiverH160Buf: Buffer.from(receiverH160, 'hex'),
    changeH160Buf: Buffer.from(signer.h160Hex, 'hex'),
    checker,
    funding: txFunding,
    takerSigner: signer,
    feeRate,
  });

  const legs = [take.verdicts.token, take.verdicts.checker, take.verdicts.seed].filter(Boolean);
  if (legs.some((v) => v!.cls !== 'PASS') || !take.sigSingleOk) {
    fail(
      `take local verify not fully PASS (token=${take.verdicts.token.cls}; checker=${take.verdicts.checker ? take.verdicts.checker.cls : 'n/a'}; ` +
        `seed=${take.verdicts.seed.cls}; sigSingle=${take.sigSingleOk}) — refusing to hand out txs`,
    );
  }

  const spent = Array.from(new Set([...spentOutpointsOfTxHex(mint.txHex, mvc), ...spentOutpointsOfTxHex(take.txHex, mvc)]));
  console.log(
    JSON.stringify({
      success: true,
      action,
      fundingTxs: [{ name: 'checkerMint', txid: mint.txid, txHex: mint.txHex }],
      txHex: take.txHex,
      txid: take.txid,
      priceSats: Number(priceSats),
      tokenAmount: tokenAmount.toString(),
      receiverAddress,
      fee: Number(take.fee),
      size: take.size,
      spentOutpoints: spent,
    }),
  );
  logStep('Built TokenSell take raw txs locally', { mint: mint.txid, take: take.txid, cancel: isCancel });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.log(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
