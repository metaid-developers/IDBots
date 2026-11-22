import { API_NET, mvc } from 'meta-contract';

export const METALET_WALLET_API_HOST = 'https://www.metalet.space';
export const MVC_OPEN_API_HOST = 'https://api.microvisionchain.com/open-api-mvc';
export const MVC_WALLET_API_NET = 'livenet';

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 12_000;
export const DEFAULT_UPSTREAM_MAX_ATTEMPTS = 2;
export const DEFAULT_UPSTREAM_RETRY_DELAY_MS = 300;
export const DEFAULT_MAX_UTXO_PAGES = 50;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MvcNftUpstreamOptions {
  fetchImpl?: FetchLike;
  metaletHost?: string;
  openApiHost?: string;
  net?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxPages?: number;
  logStep?: (message: string, details?: Record<string, unknown>) => void;
}

export interface MvcFundingUtxoRow {
  txid: string;
  outIndex: number;
  value: number;
  height: number;
}

export interface MvcNftUnspentDetail {
  txId: string;
  outputIndex: number;
  tokenAddress: string;
  tokenIndex: string;
  metaTxId: string;
  metaOutputIndex: number;
}

export interface MvcNftSellUtxoDetail {
  codehash: string;
  genesis: string;
  tokenIndex: string;
  txId: string;
  outputIndex: number;
  sellerAddress: string;
  contractAddress?: string;
  satoshisPrice: number;
  price: number;
}

interface RawMetaletNftUtxoRow {
  address?: string;
  txId?: string;
  txIndex?: number | string;
  codeHash?: string;
  genesis?: string;
  tokenIndex?: number | string;
  metaTxId?: string;
  metaOutputIndex?: number | string;
  flag?: string;
}

interface RawOpenApiNftUtxoRow {
  address?: string;
  txid?: string;
  txId?: string;
  txIndex?: number | string;
  tokenIndex?: number | string;
  metaTxid?: string;
  metaTxId?: string;
  metaOutputIndex?: number | string;
}

interface RawOpenApiSellUtxoRow {
  txid?: string;
  txId?: string;
  txIndex?: number | string;
  address?: string;
  contractAddress?: string;
  price?: number | string;
  isReady?: boolean | number | string;
}

function getErrorMessage(error: unknown): string {
  if (error != null && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    const base = (error as Error).message;
    const cause = 'cause' in error && (error as { cause?: unknown }).cause
      ? ` (${getErrorMessage((error as { cause?: unknown }).cause)})`
      : '';
    return `${base}${cause}`;
  }
  return String(error ?? '');
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableMvcUpstreamError(errorOrMessage: unknown): boolean {
  const raw = typeof errorOrMessage === 'string' ? errorOrMessage : getErrorMessage(errorOrMessage);
  const normalized = raw.toLowerCase();
  if (!normalized) return false;

  if (
    normalized.includes('insufficient balance')
    || normalized.includes('not enough balance')
    || normalized.includes('invalid payload')
    || normalized.includes('should be the nft owner')
    || normalized.includes('not for sale')
    || normalized.includes('no spendable mvc utxos')
  ) {
    return false;
  }

  return (
    normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('abort')
    || normalized.includes('etimedout')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('eai_again')
    || normalized.includes('enotfound')
    || normalized.includes('epipe')
    || normalized.includes('ehostunreach')
    || normalized.includes('enetunreach')
    || normalized.includes('fetch failed')
    || normalized.includes('network error')
    || normalized.includes('networkerror')
    || normalized.includes('socket hang up')
    || normalized.includes('bad gateway')
    || normalized.includes('service unavailable')
    || normalized.includes('gateway timeout')
    || normalized.includes('too many requests')
    || /\bhttp\s*(429|500|502|503|504)\b/.test(normalized)
    || /\bstatu?scode\s*:\s*(429|500|502|503|504)\b/.test(normalized)
  );
}

function buildTimeoutSignal(timeoutMs: number, callerSignal?: AbortSignal | null): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  return timeoutSignal;
}

export async function fetchWithTimeoutAndRetry(
  url: string,
  init: RequestInit | undefined,
  options: MvcNftUpstreamOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_UPSTREAM_MAX_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_UPSTREAM_RETRY_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init?.headers ?? {}),
        },
        signal: buildTimeoutSignal(timeoutMs, init?.signal),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim() + ` from ${url}`);
      }
      return response;
    } catch (err) {
      lastError = err;
      const message = getErrorMessage(err);
      if (attempt < maxAttempts && isRetryableMvcUpstreamError(message)) {
        options.logStep?.('Retrying transient MVC upstream request', {
          url,
          attempt,
          maxAttempts,
          error: message,
        });
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`MVC upstream request failed (${url}): ${message}`);
    }
  }

  throw new Error(`MVC upstream request failed (${url}): ${getErrorMessage(lastError)}`);
}

export async function fetchMvcFundingUtxos(
  address: string,
  options: MvcNftUpstreamOptions = {},
): Promise<MvcFundingUtxoRow[]> {
  const metaletHost = options.metaletHost ?? METALET_WALLET_API_HOST;
  const net = options.net ?? MVC_WALLET_API_NET;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_UTXO_PAGES);
  const all: MvcFundingUtxoRow[] = [];
  let flag: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ address, net });
    if (flag) params.set('flag', flag);
    const previousFlag = flag;
    const url = `${metaletHost}/wallet-api/v4/mvc/address/utxo-list?${params}`;
    const res = await fetchWithTimeoutAndRetry(url, undefined, options);
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: {
        list?: Array<{
          txid?: string;
          outIndex?: number | string;
          value?: number | string;
          height?: number | string;
          flag?: string;
        }>;
      };
    };
    if (json?.code !== undefined && json.code !== 0) {
      throw new Error(json.message || `Metalet MVC UTXO API error (code=${String(json.code)})`);
    }
    const list = Array.isArray(json?.data?.list) ? json.data.list : [];
    if (!list.length) break;

    for (const row of list) {
      const txid = String(row.txid ?? '').trim();
      const outIndex = Number(row.outIndex);
      const value = Number(row.value);
      const height = Number(row.height ?? 0);
      if (/^[0-9a-f]{64}$/i.test(txid) && Number.isInteger(outIndex) && outIndex >= 0 && Number.isFinite(value) && value >= 600) {
        all.push({
          txid,
          outIndex,
          value,
          height: Number.isFinite(height) ? height : 0,
        });
      }
    }

    const lastFlag = list[list.length - 1]?.flag;
    const nextFlag = typeof lastFlag === 'string' ? lastFlag.trim() : undefined;
    if (!nextFlag || nextFlag === '0' || nextFlag === previousFlag) break;
    flag = nextFlag;
  }

  return all;
}

/**
 * Find one unspent NFT UTXO at `holderAddress` via Metalet Wallet API v4.
 *
 * IMPORTANT: Do NOT pass `codeHash` or `genesis` query parameters to
 * `/wallet-api/v4/mvc/address/contract/nft/utxo-list` — Metalet v4 returns
 * an empty list when those query params are supplied. Filter client-side per
 * page and short-circuit as soon as the target token is matched.
 */
export async function findHeldNftUtxoViaMetalet(
  holderAddress: string,
  target: { codehash: string; genesis: string; tokenIndex: string },
  options: MvcNftUpstreamOptions = {},
): Promise<MvcNftUnspentDetail | null> {
  const cleanAddress = String(holderAddress || '').trim();
  if (!cleanAddress) return null;

  const metaletHost = options.metaletHost ?? METALET_WALLET_API_HOST;
  const net = options.net ?? MVC_WALLET_API_NET;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_UTXO_PAGES);
  const wantedCodehash = String(target.codehash || '').trim().toLowerCase();
  const wantedGenesis = String(target.genesis || '').trim().toLowerCase();
  const wantedTokenIndex = String(target.tokenIndex || '').trim();

  let flag: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ net, address: cleanAddress });
    if (flag) params.set('flag', flag);
    const previousFlag = flag;
    const url = `${metaletHost}/wallet-api/v4/mvc/address/contract/nft/utxo-list?${params}`;
    const res = await fetchWithTimeoutAndRetry(url, undefined, options);
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { list?: RawMetaletNftUtxoRow[] };
    };
    if (json?.code !== undefined && json.code !== 0) {
      throw new Error(json.message || `Metalet NFT UTXO API error (code=${String(json.code)})`);
    }
    const list = Array.isArray(json?.data?.list) ? json.data.list : [];
    if (!list.length) break;

    for (const row of list) {
      const rowCodeHash = String(row.codeHash ?? '').trim().toLowerCase();
      const rowGenesis = String(row.genesis ?? '').trim().toLowerCase();
      const rowTokenIndex = String(row.tokenIndex ?? '').trim();
      if (rowCodeHash !== wantedCodehash || rowGenesis !== wantedGenesis || rowTokenIndex !== wantedTokenIndex) {
        continue;
      }
      const txId = String(row.txId ?? '').trim();
      const outputIndex = Number(row.txIndex);
      if (!/^[0-9a-f]{64}$/i.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0) {
        continue;
      }
      const rawMetaOut = Number(row.metaOutputIndex);
      return {
        txId,
        outputIndex,
        tokenAddress: String(row.address || cleanAddress).trim() || cleanAddress,
        tokenIndex: wantedTokenIndex,
        metaTxId: String(row.metaTxId ?? '').trim(),
        metaOutputIndex: Number.isInteger(rawMetaOut) && rawMetaOut >= 0 ? rawMetaOut : 0,
      };
    }

    const lastFlag = list[list.length - 1]?.flag;
    const nextFlag = typeof lastFlag === 'string' ? lastFlag.trim() : undefined;
    if (!nextFlag || nextFlag === '0' || nextFlag === previousFlag) break;
    flag = nextFlag;
  }

  return null;
}

export async function fetchNftUtxoDetailViaOpenApi(
  target: { codehash: string; genesis: string; tokenIndex: string },
  options: MvcNftUpstreamOptions = {},
): Promise<MvcNftUnspentDetail | null> {
  const openApiHost = options.openApiHost ?? MVC_OPEN_API_HOST;
  const codehash = String(target.codehash || '').trim();
  const genesis = String(target.genesis || '').trim();
  const tokenIndex = String(target.tokenIndex || '').trim();
  const url = `${openApiHost}/contract/nft/genesis/${encodeURIComponent(codehash)}/${encodeURIComponent(genesis)}/utxo?tokenIndex=${encodeURIComponent(tokenIndex)}`;
  const res = await fetchWithTimeoutAndRetry(url, undefined, options);
  const json = (await res.json()) as RawOpenApiNftUtxoRow[] | { list?: RawOpenApiNftUtxoRow[]; data?: RawOpenApiNftUtxoRow[] };
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(json?.list)
      ? json.list
      : Array.isArray(json?.data)
        ? json.data
        : [];

  for (const row of rows) {
    const txId = String(row.txid ?? row.txId ?? '').trim();
    const outputIndex = Number(row.txIndex);
    const tokenAddress = String(row.address ?? '').trim();
    if (!/^[0-9a-f]{64}$/i.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0 || !tokenAddress) {
      continue;
    }
    const rawMetaOut = Number(row.metaOutputIndex);
    return {
      txId,
      outputIndex,
      tokenAddress,
      tokenIndex: String(row.tokenIndex ?? tokenIndex).trim() || tokenIndex,
      metaTxId: String(row.metaTxid ?? row.metaTxId ?? '').trim(),
      metaOutputIndex: Number.isInteger(rawMetaOut) && rawMetaOut >= 0 ? rawMetaOut : 0,
    };
  }

  return null;
}

function normalizeRawTxHex(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed.length < 20 || trimmed.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export async function fetchMvcRawTxHex(
  txid: string,
  options: MvcNftUpstreamOptions & { cache?: Map<string, string> } = {},
): Promise<string> {
  const cleanTxid = String(txid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleanTxid)) {
    throw new Error(`Invalid MVC txid for raw tx lookup: ${String(txid)}`);
  }

  const cached = options.cache?.get(cleanTxid);
  if (cached) return cached;

  const metaletHost = options.metaletHost ?? METALET_WALLET_API_HOST;
  const openApiHost = options.openApiHost ?? MVC_OPEN_API_HOST;
  const net = options.net ?? MVC_WALLET_API_NET;

  let metaletError: unknown = null;
  try {
    const metaletUrl = `${metaletHost}/wallet-api/v4/mvc/tx/raw?net=${encodeURIComponent(net)}&txId=${encodeURIComponent(cleanTxid)}`;
    const res = await fetchWithTimeoutAndRetry(metaletUrl, undefined, options);
    const json = (await res.json()) as {
      code?: number;
      message?: string;
      data?: string | { hex?: string };
      hex?: string;
    };
    if (json?.code !== undefined && json.code !== 0) {
      throw new Error(json.message || `Metalet tx/raw error (code=${String(json.code)})`);
    }
    const hex = normalizeRawTxHex(
      typeof json?.data === 'string'
        ? json.data
        : json?.data?.hex ?? json?.hex,
    );
    if (!hex) {
      throw new Error(`Metalet tx/raw returned empty hex for ${cleanTxid}`);
    }
    options.cache?.set(cleanTxid, hex);
    return hex;
  } catch (err) {
    metaletError = err;
    options.logStep?.('Metalet tx/raw lookup failed; falling back to open-api-mvc', {
      txid: cleanTxid,
      error: getErrorMessage(err),
    });
  }

  try {
    const openApiUrl = `${openApiHost}/tx/${encodeURIComponent(cleanTxid)}/raw`;
    const res = await fetchWithTimeoutAndRetry(openApiUrl, undefined, options);
    const bodyText = (await res.text()).trim();
    let hex = normalizeRawTxHex(bodyText);
    if (!hex && bodyText.startsWith('{')) {
      const parsed = JSON.parse(bodyText) as { hex?: string; data?: string | { hex?: string } };
      hex = normalizeRawTxHex(
        typeof parsed.data === 'string' ? parsed.data : parsed.data?.hex ?? parsed.hex,
      );
    }
    if (!hex) {
      throw new Error(`open-api-mvc tx/raw returned invalid hex for ${cleanTxid}`);
    }
    options.cache?.set(cleanTxid, hex);
    return hex;
  } catch (fallbackErr) {
    throw new Error(
      `Failed to fetch raw tx ${cleanTxid} via Metalet (${getErrorMessage(metaletError)}) and open-api-mvc (${getErrorMessage(fallbackErr)})`,
    );
  }
}

export function deriveSellContractHolderAddress(
  sellTxHex: string,
  outputIndex: number,
  network: string = API_NET.MAIN,
): string | null {
  try {
    const tx = new mvc.Transaction(sellTxHex);
    const output = tx.outputs?.[outputIndex];
    if (!output?.script) return null;
    const scriptBuf = output.script.toBuffer();
    const hashBuf = Buffer.from(mvc.crypto.Hash.sha256ripemd160(scriptBuf));
    return new mvc.Address(hashBuf, network).toString();
  } catch {
    return null;
  }
}

export async function fetchNftSellUtxoViaOpenApi(
  target: { codehash: string; genesis: string; tokenIndex: string; includesNotReady?: boolean },
  options: MvcNftUpstreamOptions = {},
): Promise<MvcNftSellUtxoDetail | undefined> {
  const openApiHost = options.openApiHost ?? MVC_OPEN_API_HOST;
  const codehash = String(target.codehash || '').trim();
  const genesis = String(target.genesis || '').trim();
  const tokenIndex = String(target.tokenIndex || '').trim();
  const url = `${openApiHost}/contract/nft/sell/genesis/${encodeURIComponent(codehash)}/${encodeURIComponent(genesis)}/utxo?tokenIndex=${encodeURIComponent(tokenIndex)}`;
  const res = await fetchWithTimeoutAndRetry(url, undefined, options);
  const json = (await res.json()) as RawOpenApiSellUtxoRow[] | { list?: RawOpenApiSellUtxoRow[] };
  const rows = Array.isArray(json) ? json : Array.isArray(json?.list) ? json.list : [];

  for (const row of rows) {
    const ready = row.isReady === true || row.isReady === 1 || String(row.isReady ?? '').toLowerCase() === 'true';
    if (!target.includesNotReady && !ready) continue;
    const txId = String(row.txid ?? row.txId ?? '').trim();
    const outputIndex = Number(row.txIndex);
    const price = Number(row.price);
    if (!/^[0-9a-f]{64}$/i.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0 || !Number.isFinite(price)) {
      continue;
    }
    return {
      codehash,
      genesis,
      tokenIndex,
      txId,
      outputIndex,
      sellerAddress: String(row.address ?? '').trim(),
      contractAddress: String(row.contractAddress ?? '').trim() || undefined,
      satoshisPrice: price,
      price,
    };
  }

  return undefined;
}

export interface ResilientMvcNftApiConfig extends MvcNftUpstreamOptions {
  holderAddress?: string;
  sellUtxo?: {
    txId: string;
    outputIndex: number;
  };
  network?: string;
}

export function createResilientMvcNftApiMethods(config: ResilientMvcNftApiConfig = {}) {
  const rawTxCache = new Map<string, string>();
  const network = config.network ?? API_NET.MAIN;

  const getRawTxData = async (txid: string): Promise<string> => {
    return await fetchMvcRawTxHex(txid, {
      ...config,
      cache: rawTxCache,
    });
  };

  const getNftSellUtxo = async (
    codehash: string,
    genesis: string,
    tokenIndex: string,
    includesNotReady?: boolean,
  ): Promise<MvcNftSellUtxoDetail | undefined> => {
    return await fetchNftSellUtxoViaOpenApi(
      { codehash, genesis, tokenIndex, includesNotReady },
      config,
    );
  };

  const getNonFungibleTokenUnspentDetail = async (
    codehash: string,
    genesis: string,
    tokenIndex: string,
  ): Promise<MvcNftUnspentDetail> => {
    const candidateAddresses: string[] = [];
    const seenAddresses = new Set<string>();
    const pushCandidate = (addr: string | null | undefined) => {
      const trimmed = String(addr ?? '').trim();
      if (!trimmed || seenAddresses.has(trimmed)) return;
      seenAddresses.add(trimmed);
      candidateAddresses.push(trimmed);
    };

    if (config.sellUtxo?.txId && Number.isInteger(config.sellUtxo.outputIndex) && config.sellUtxo.outputIndex >= 0) {
      try {
        const sellTxHex = await getRawTxData(config.sellUtxo.txId);
        pushCandidate(deriveSellContractHolderAddress(sellTxHex, config.sellUtxo.outputIndex, network));
      } catch (err) {
        config.logStep?.('Failed to pre-derive sell contract holder address; continuing lookup', {
          sellTxId: config.sellUtxo.txId,
          error: getErrorMessage(err),
        });
      }
    }

    pushCandidate(config.holderAddress);

    let metaletError: unknown = null;
    for (const candidateAddress of candidateAddresses) {
      try {
        const found = await findHeldNftUtxoViaMetalet(
          candidateAddress,
          { codehash, genesis, tokenIndex },
          config,
        );
        if (found) {
          config.logStep?.('Resolved MVC NFT UTXO via Metalet v4', {
            tokenIndex: String(tokenIndex),
            txId: found.txId,
            outputIndex: found.outputIndex,
            tokenAddress: found.tokenAddress,
          });
          return found;
        }
      } catch (err) {
        metaletError = err;
        config.logStep?.('Metalet v4 NFT UTXO lookup failed; trying next candidate or open-api-mvc', {
          candidateAddress,
          tokenIndex: String(tokenIndex),
          error: getErrorMessage(err),
        });
      }
    }

    try {
      const openApiDetail = await fetchNftUtxoDetailViaOpenApi(
        { codehash, genesis, tokenIndex: String(tokenIndex) },
        config,
      );
      if (openApiDetail) {
        config.logStep?.('Resolved MVC NFT UTXO via open-api-mvc fallback', {
          tokenIndex: String(tokenIndex),
          txId: openApiDetail.txId,
          outputIndex: openApiDetail.outputIndex,
          tokenAddress: openApiDetail.tokenAddress,
        });
        return openApiDetail;
      }
    } catch (fallbackErr) {
      const metaletSuffix = metaletError ? `; Metalet error: ${getErrorMessage(metaletError)}` : '';
      throw new Error(
        `Failed to resolve MVC NFT UTXO (${codehash}/${genesis} #${String(tokenIndex)})${metaletSuffix}; open-api-mvc error: ${getErrorMessage(fallbackErr)}`,
      );
    }

    if (metaletError) {
      throw new Error(
        `MVC NFT UTXO not found (${codehash}/${genesis} #${String(tokenIndex)}) after Metalet error: ${getErrorMessage(metaletError)}`,
      );
    }

    throw new Error(`MVC NFT UTXO not found on chain (${codehash}/${genesis} #${String(tokenIndex)})`);
  };

  return {
    rawTxCache,
    getRawTxData,
    getNonFungibleTokenUnspentDetail,
    getNftSellUtxo,
  };
}

export function attachResilientMvcNftApi(
  nftManager: { api?: object },
  config: ResilientMvcNftApiConfig = {},
) {
  const methods = createResilientMvcNftApiMethods(config);
  if (nftManager && nftManager.api && typeof nftManager.api === 'object') {
    const apiTarget = nftManager.api as Record<string, unknown>;
    apiTarget.getRawTxData = methods.getRawTxData;
    apiTarget.getNonFungibleTokenUnspentDetail = methods.getNonFungibleTokenUnspentDetail;
    apiTarget.getNftSellUtxo = methods.getNftSellUtxo;
  }
  return methods;
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;

export function stripWorkerAnsiCodes(text: string): string {
  return String(text || '').replace(ANSI_ESCAPE_RE, '');
}

/**
 * Parse structured `{ success: boolean, ... }` JSON from subprocess worker
 * output. Third-party libraries (notably `meta-contract`'s `ServerNet`) print
 * non-JSON diagnostic lines with ANSI escape codes to `stdout`, while worker
 * `catch` handlers may write `{ success: false, error }` to `stderr`.
 * Scan `stdout` then `stderr` from bottom to top for the last structured JSON
 * payload before falling back to sanitized text.
 */
export function parseWorkerProcessOutput<T extends { txHex?: string } = { txHex: string }>(
  stdout: string,
  stderr: string,
  options?: { requireTxHex?: boolean },
): T {
  const cleanStdout = stripWorkerAnsiCodes(stdout).trim();
  const cleanStderr = stripWorkerAnsiCodes(stderr).trim();
  if (!cleanStdout && !cleanStderr) {
    throw new Error('Worker returned empty output');
  }

  const findStructuredResult = (streamText: string): ({ success: boolean; error?: string; txHex?: string }) | null => {
    if (!streamText) return null;
    const lines = streamText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && typeof parsed.success === 'boolean') {
          return parsed as { success: boolean; error?: string; txHex?: string };
        }
      } catch {
        continue;
      }
    }
    return null;
  };

  const structured = findStructuredResult(cleanStdout) ?? findStructuredResult(cleanStderr);
  if (structured) {
    if (!structured.success) {
      const errMsg = stripWorkerAnsiCodes(String(structured.error || '')).trim();
      throw new Error(errMsg || 'Worker failed');
    }
    if (options?.requireTxHex !== false && (!structured.txHex || typeof structured.txHex !== 'string')) {
      throw new Error('Worker did not return txHex');
    }
    return structured as unknown as T;
  }

  throw new Error(cleanStderr || cleanStdout);
}
