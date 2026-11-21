/**
 * PayBuzz Service (/protocols/paybuzz v1.0)
 *
 * Handles:
 * - Publishing encrypted articles (`/protocols/paybuzz`, auto-uploading >16 KB ciphertext via `metafile://`)
 * - Recovering author content key deterministically from mnemonic + `keySaltHex` (plainSha256)
 * - Fetching `/protocols/paybuzz` item metadata (MetaSo `/api/paybuzz/info` -> chain Pin fallback -> local store)
 * - Dual-track reader unlock orchestration (Cache -> Track A VIP MRC-721 -> Track B FT Micropayment)
 * - Decrypting and caching unlocked articles in `paybuzz_unlocked_cache`
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import { normalizeFtAssetKey } from './ftMandateGateService';
import { createPin, getPinData, type MetaidDataPayload } from './metaidCore';
import { uploadMetaFile } from './metaFileUploadService';
import { fetchContentWithFallback, fetchFromLocalOrFallback } from './localIndexerProxy';
import { fetchMrc721AddressItems, getMetasoApiBase, type Mrc721ItemSummary } from './mrc721Service';
import { readMetawebPin } from './metawebPinService';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { buildMvcFtTransferRawTx } from './walletRawTxService';
import { broadcastMvcFtTransferBundle } from './mvcFtService';
import { resolveBroadcastTxResult } from '../libs/mvcSpend';
import { executeMrc20Transfer } from './mrc20Service';
import {
  decryptPaybuzzContent,
  derivePaybuzzAuthorMasterSeed,
  derivePaybuzzContentKey,
  encryptPaybuzzContent,
  signPaybuzzVipChallenge,
} from './paybuzzCryptoService';
import {
  getPaybuzzAuthoredItem,
  getPaybuzzUnlockedCache,
  upsertPaybuzzAuthoredItem,
  upsertPaybuzzUnlockedCache,
  type PaybuzzUnlockedCacheRecord,
} from './paybuzzStore';
import { formatPayReadWireMessage } from './payReadWireProtocol';

export const PAYBUZZ_INLINE_CIPHERTEXT_THRESHOLD_BYTES = 16 * 1024;
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';
const METAID_FILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const METALET_HOST = 'https://www.metalet.space';

export interface PaybuzzTokenPriceRule {
  assetKey: string;
  chain: 'btc' | 'mvc';
  standard: 'mrc20' | 'metacontract-ft';
  mrc20Id?: string;
  codehash?: string;
  genesis?: string;
  symbol: string;
  decimals: number;
  amountBase: string;
  amountDisplay: string;
  receiveAddress: string;
}

export interface PaybuzzVipCollectionRule {
  collectionPinId: string;
  collectionName: string;
}

export interface PaybuzzUnlockRules {
  mePriceMilli?: number;
  tokenPrices: PaybuzzTokenPriceRule[];
  vipMrc721Collections: PaybuzzVipCollectionRule[];
}

export interface PaybuzzEncryptionMeta {
  algo: 'AES-256-GCM';
  ivHex: string;
  authTagHex: string;
  cipherSha256: string;
  keySaltHex: string;
  ciphertextPinOrBase64: string;
}

export interface PaybuzzPinPayload {
  title: string;
  preview: string;
  contentType: 'text/markdown';
  wordCount: number;
  encryption: PaybuzzEncryptionMeta;
  authorMetaId: string;
  authorMvcAddress: string;
  unlockRules: PaybuzzUnlockRules;
  createdAt: number;
}

export interface PaybuzzItemRecord extends PaybuzzPinPayload {
  paybuzzPinId: string;
  authorName?: string;
  shopMetaAppPinId?: string;
}

export interface PublishPaybuzzArticleInput {
  metabotId: number;
  title: string;
  markdown: string;
  preview?: string;
  wordCount?: number;
  unlockRules?: Partial<PaybuzzUnlockRules>;
  network?: 'mvc' | 'btc' | 'doge';
}

export interface PublishPaybuzzArticleResult {
  paybuzzPinId: string;
  txids: string[];
  payload: PaybuzzPinPayload;
  paybuzzCardFence: string;
}

export interface PaybuzzServiceDeps {
  getDb: () => Database;
  saveDb?: () => void;
  getMetabotStore: () => MetabotStore;
  uploadEncryptedAttachment?: (input: {
    metabotId: number;
    data: Buffer;
    fileName: string;
  }) => Promise<{ pinId: string }>;
  createChainPin?: (
    metabotId: number,
    payload: MetaidDataPayload,
  ) => Promise<{ txids: string[]; pinId: string }>;
  fetchFromMetaso?: (pinId: string) => Promise<Record<string, unknown> | null>;
  fetchChainPin?: (pinId: string) => Promise<Record<string, unknown> | null>;
  fetchCiphertextBytes?: (pinId: string) => Promise<Buffer | null>;
  fetchMrc721ItemsForAddress?: (params: {
    address: string;
    collectionPinId: string;
  }) => Promise<Mrc721ItemSummary[]>;
  sendEncryptedPrivateMessage?: (
    fromMetabotId: number,
    toGlobalMetaId: string,
    plaintext: string,
  ) => Promise<{ pinId?: string } | void>;
  transferMvcFt?: (input: {
    metabotId: number;
    codehash: string;
    genesis: string;
    toAddress: string;
    amountBase: string;
  }) => Promise<{ txId: string }>;
  transferBtcMrc20?: (input: {
    metabotId: number;
    mrc20Id: string;
    decimal: number;
    symbol: string;
    fromAddress: string;
    toAddress: string;
    amountBase: string;
    amountDisplay: string;
  }) => Promise<{ revealTxId: string; commitTxId?: string }>;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  nowMs?: () => number;
}

function defaultBroadcastMvcRawTx(rawTx: string): Promise<string> {
  return fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: 'livenet', rawTx }),
  })
    .then((res) => res.json() as Promise<{ code?: number; message?: string; data?: string }>)
    .then((json) => resolveBroadcastTxResult(rawTx, json));
}

function buildDefaultPreview(markdown: string): string {
  const plain = markdown
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 300);
}

function countWords(markdown: string): number {
  const trimmed = markdown.trim();
  if (!trimmed) return 0;
  const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = trimmed
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

export function normalizePaybuzzUnlockRules(
  raw: Partial<PaybuzzUnlockRules> | null | undefined,
): PaybuzzUnlockRules {
  const tokenPrices: PaybuzzTokenPriceRule[] = [];
  if (Array.isArray(raw?.tokenPrices)) {
    for (const item of raw.tokenPrices) {
      if (!item || typeof item !== 'object') continue;
      const assetKey = normalizeFtAssetKey(item.assetKey);
      const chain: 'btc' | 'mvc' = item.chain === 'btc' || assetKey.startsWith('mrc20:') ? 'btc' : 'mvc';
      const standard: 'mrc20' | 'metacontract-ft' = chain === 'btc' ? 'mrc20' : 'metacontract-ft';
      const amountBase = String(item.amountBase ?? '').trim();
      if (!/^[1-9]\d*$/.test(amountBase)) {
        throw new Error(`tokenPrices amountBase must be a positive integer string for ${assetKey}`);
      }
      const receiveAddress = String(item.receiveAddress ?? '').trim();
      if (!receiveAddress) {
        throw new Error(`tokenPrices receiveAddress is required for ${assetKey}`);
      }
      const symbol = String(item.symbol ?? 'TOKEN').trim() || 'TOKEN';
      const decimals = Number.isInteger(Number(item.decimals)) ? Math.max(0, Number(item.decimals)) : 8;
      const amountDisplay = String(item.amountDisplay ?? '').trim() || amountBase;

      let mrc20Id = typeof item.mrc20Id === 'string' ? item.mrc20Id.trim().toLowerCase() : undefined;
      let codehash = typeof item.codehash === 'string' ? item.codehash.trim().toLowerCase() : undefined;
      let genesis = typeof item.genesis === 'string' ? item.genesis.trim().toLowerCase() : undefined;

      if (assetKey.startsWith('mrc20:') && !mrc20Id) {
        mrc20Id = assetKey.slice('mrc20:'.length);
      } else if (assetKey.startsWith('mvc-ft:')) {
        const [, ch, gen] = assetKey.split(':');
        if (!codehash) codehash = ch;
        if (!genesis) genesis = gen;
      }

      tokenPrices.push({
        assetKey,
        chain,
        standard,
        ...(mrc20Id ? { mrc20Id } : {}),
        ...(codehash ? { codehash } : {}),
        ...(genesis ? { genesis } : {}),
        symbol,
        decimals,
        amountBase,
        amountDisplay,
        receiveAddress,
      });
    }
  }

  const vipMrc721Collections: PaybuzzVipCollectionRule[] = [];
  if (Array.isArray(raw?.vipMrc721Collections)) {
    for (const col of raw.vipMrc721Collections) {
      if (!col || typeof col !== 'object') continue;
      const collectionPinId = String(col.collectionPinId ?? '').trim().toLowerCase();
      if (!collectionPinId) continue;
      vipMrc721Collections.push({
        collectionPinId,
        collectionName: String(col.collectionName ?? 'VIP Member Card').trim() || 'VIP Member Card',
      });
    }
  }

  const mePriceMilli =
    raw?.mePriceMilli != null && Number.isFinite(Number(raw.mePriceMilli)) && Number(raw.mePriceMilli) > 0
      ? Math.trunc(Number(raw.mePriceMilli))
      : undefined;

  return {
    ...(mePriceMilli !== undefined ? { mePriceMilli } : {}),
    tokenPrices,
    vipMrc721Collections,
  };
}

export async function publishPaybuzzArticle(
  deps: PaybuzzServiceDeps,
  input: PublishPaybuzzArticleInput,
): Promise<PublishPaybuzzArticleResult> {
  const metabotId = Number(input.metabotId);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('title is required');
  const markdown = String(input.markdown ?? '');
  if (!markdown.trim()) throw new Error('markdown content is required');

  const store = deps.getMetabotStore();
  const bot = store.getMetabotById(metabotId);
  const wallet = store.getMetabotWalletByMetabotId(metabotId);
  if (!bot || !wallet?.mnemonic?.trim()) {
    throw new Error(`MetaBot ${metabotId} or wallet mnemonic not found`);
  }

  const authorMasterSeedBytes = await derivePaybuzzAuthorMasterSeed(wallet.mnemonic, wallet.path);
  const encrypted = encryptPaybuzzContent({
    plaintextMarkdown: markdown,
    authorMasterSeedBytes,
  });

  let ciphertextPinOrBase64: string;
  if (encrypted.ciphertextBuffer.length > PAYBUZZ_INLINE_CIPHERTEXT_THRESHOLD_BYTES) {
    const uploadRes = deps.uploadEncryptedAttachment
      ? await deps.uploadEncryptedAttachment({
          metabotId,
          data: encrypted.ciphertextBuffer,
          fileName: 'paybuzz-article.enc',
        })
      : await uploadMetaFile(store, {
          metabotId,
          data: encrypted.ciphertextBuffer,
          dataFileName: 'paybuzz-article.enc',
          contentType: 'application/octet-stream',
          network: 'mvc',
        });
    const filePinId = String(uploadRes?.pinId ?? '').trim().toLowerCase();
    if (!filePinId) {
      throw new Error('Failed to upload encrypted PayBuzz article attachment');
    }
    ciphertextPinOrBase64 = `metafile://${filePinId}.enc`;
  } else {
    ciphertextPinOrBase64 = `base64:${encrypted.ciphertextBase64}`;
  }

  const unlockRules = normalizePaybuzzUnlockRules(input.unlockRules);
  if (
    unlockRules.tokenPrices.length === 0 &&
    unlockRules.vipMrc721Collections.length === 0 &&
    unlockRules.mePriceMilli == null
  ) {
    throw new Error('At least one unlock rule (tokenPrices, vipMrc721Collections, or mePriceMilli) is required');
  }

  const createdAt = Math.floor((deps.nowMs?.() ?? Date.now()) / 1000);
  const preview = String(input.preview ?? '').trim() || buildDefaultPreview(markdown);
  const wordCount =
    input.wordCount != null && Number.isFinite(Number(input.wordCount)) && Number(input.wordCount) > 0
      ? Math.trunc(Number(input.wordCount))
      : countWords(markdown);

  const payload: PaybuzzPinPayload = {
    title,
    preview,
    contentType: 'text/markdown',
    wordCount,
    encryption: {
      algo: 'AES-256-GCM',
      ivHex: encrypted.ivHex,
      authTagHex: encrypted.authTagHex,
      cipherSha256: encrypted.cipherSha256,
      keySaltHex: encrypted.keySaltHex,
      ciphertextPinOrBase64,
    },
    authorMetaId: String(bot.globalmetaid || bot.metaid || '').trim(),
    authorMvcAddress: String(bot.mvc_address || '').trim(),
    unlockRules,
    createdAt,
  };

  const pinPayload: MetaidDataPayload = {
    operation: 'create',
    path: '/protocols/paybuzz',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  };

  const pinResult = deps.createChainPin
    ? await deps.createChainPin(metabotId, pinPayload)
    : await createPin(store, metabotId, pinPayload, {
        network: input.network ?? 'mvc',
        feeRate: getGlobalFeeRate(input.network ?? 'mvc'),
        origin: 'internal:paybuzz',
      });

  const paybuzzPinId = String(pinResult.pinId ?? `${pinResult.txids?.[0] ?? ''}i0`).trim().toLowerCase();
  if (!paybuzzPinId) {
    throw new Error('createPin did not return a paybuzzPinId');
  }

  const db = deps.getDb();
  upsertPaybuzzAuthoredItem(
    db,
    {
      paybuzzPinId,
      metabotId,
      cipherSha256: encrypted.cipherSha256,
      keySaltHex: encrypted.keySaltHex,
      contentKeyHex: encrypted.contentKeyHex,
      unlockRulesJson: JSON.stringify(unlockRules),
      title,
      preview,
      wordCount,
      createdAt,
    },
    deps.saveDb,
  );

  const cardJson = {
    paybuzzPinId,
    title,
    preview,
    wordCount,
    authorMetaId: payload.authorMetaId,
    authorName: bot.name || undefined,
    authorMvcAddress: payload.authorMvcAddress,
    unlockRules,
  };
  const paybuzzCardFence = `\`\`\`paybuzz-card\n${JSON.stringify(cardJson, null, 2)}\n\`\`\``;

  return {
    paybuzzPinId,
    txids: pinResult.txids ?? [],
    payload,
    paybuzzCardFence,
  };
}

function coercePaybuzzItemFromRaw(
  pinId: string,
  raw: Record<string, unknown>,
): PaybuzzItemRecord | null {
  const payloadObj =
    raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : typeof raw.payload === 'string'
        ? (() => {
            try {
              const p = JSON.parse(raw.payload);
              return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
            } catch {
              return null;
            }
          })()
        : typeof raw.content === 'string'
          ? (() => {
              try {
                const p = JSON.parse(raw.content);
                return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
              } catch {
                return null;
              }
            })()
          : raw;
  if (!payloadObj) return null;

  const encryptionRaw =
    (payloadObj.encryption ?? raw.encryption) && typeof (payloadObj.encryption ?? raw.encryption) === 'object'
      ? ((payloadObj.encryption ?? raw.encryption) as Record<string, unknown>)
      : null;
  if (!encryptionRaw) return null;

  const ivHex = String(encryptionRaw.ivHex ?? '').trim().toLowerCase();
  const authTagHex = String(encryptionRaw.authTagHex ?? '').trim().toLowerCase();
  const cipherSha256 = String(encryptionRaw.cipherSha256 ?? '').trim().toLowerCase();
  const keySaltHex = String(encryptionRaw.keySaltHex ?? '').trim().toLowerCase();
  const ciphertextPinOrBase64 = String(encryptionRaw.ciphertextPinOrBase64 ?? '').trim();
  if (!ivHex || !authTagHex || !cipherSha256 || !ciphertextPinOrBase64) return null;

  const unlockRulesRaw =
    (payloadObj.unlockRules ?? raw.unlockRules) && typeof (payloadObj.unlockRules ?? raw.unlockRules) === 'object'
      ? ((payloadObj.unlockRules ?? raw.unlockRules) as Partial<PaybuzzUnlockRules>)
      : {};
  const unlockRules = normalizePaybuzzUnlockRules(unlockRulesRaw);

  const title = String(payloadObj.title ?? raw.title ?? '').trim() || 'Encrypted Article';
  const preview = String(payloadObj.preview ?? raw.preview ?? '').trim();
  const wordCount = Math.max(0, Math.trunc(Number(payloadObj.wordCount ?? raw.wordCount ?? 0)));
  const authorMetaId = String(
    payloadObj.authorMetaId ?? raw.authorMetaId ?? (raw.creator as Record<string, unknown> | undefined)?.globalMetaId ?? '',
  ).trim();
  const authorMvcAddress = String(
    payloadObj.authorMvcAddress ?? raw.authorMvcAddress ?? (raw.creator as Record<string, unknown> | undefined)?.address ?? '',
  ).trim();
  const authorName = String(
    payloadObj.authorName ?? raw.authorName ?? (raw.creator as Record<string, unknown> | undefined)?.name ?? '',
  ).trim();
  const shopMetaAppPinId = String(payloadObj.shopMetaAppPinId ?? raw.shopMetaAppPinId ?? '').trim();

  return {
    paybuzzPinId: pinId.toLowerCase(),
    title,
    preview,
    contentType: 'text/markdown',
    wordCount,
    encryption: {
      algo: 'AES-256-GCM',
      ivHex,
      authTagHex,
      cipherSha256,
      keySaltHex,
      ciphertextPinOrBase64,
    },
    authorMetaId,
    authorMvcAddress,
    ...(authorName ? { authorName } : {}),
    ...(shopMetaAppPinId ? { shopMetaAppPinId } : {}),
    unlockRules,
    createdAt: Number(payloadObj.createdAt ?? raw.createdAt ?? 0),
  };
}

async function defaultFetchFromMetaso(pinId: string): Promise<Record<string, unknown> | null> {
  const localPath = `/api/paybuzz/info?pinId=${encodeURIComponent(pinId)}`;
  const url = `${getMetasoApiBase()}${localPath}`;
  try {
    const res = await fetchFromLocalOrFallback('/api/paybuzz/info', url);
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: number; data?: Record<string, unknown> };
    if (json && (json.code === 0 || json.code === 1) && json.data && typeof json.data === 'object') {
      return json.data;
    }
    return null;
  } catch {
    return null;
  }
}

async function defaultFetchChainPin(pinId: string): Promise<Record<string, unknown> | null> {
  try {
    const mwPin = await readMetawebPin(pinId);
    if (mwPin && mwPin.payload) {
      return mwPin as unknown as Record<string, unknown>;
    }
  } catch {
    // Fall back to direct manapi pin lookup
  }
  try {
    const pinData = await getPinData(pinId, false);
    if (pinData) {
      return pinData as unknown as Record<string, unknown>;
    }
  } catch {
    // Ignore miss
  }
  return null;
}

export async function fetchPaybuzzItem(
  deps: PaybuzzServiceDeps,
  paybuzzPinId: string,
): Promise<PaybuzzItemRecord | null> {
  const normalizedPinId = String(paybuzzPinId ?? '').trim().toLowerCase();
  if (!normalizedPinId) return null;

  const metasoRaw = deps.fetchFromMetaso
    ? await deps.fetchFromMetaso(normalizedPinId)
    : await defaultFetchFromMetaso(normalizedPinId);
  if (metasoRaw) {
    const parsed = coercePaybuzzItemFromRaw(normalizedPinId, metasoRaw);
    if (parsed) return parsed;
  }

  const chainRaw = deps.fetchChainPin
    ? await deps.fetchChainPin(normalizedPinId)
    : await defaultFetchChainPin(normalizedPinId);
  if (chainRaw) {
    const parsed = coercePaybuzzItemFromRaw(normalizedPinId, chainRaw);
    if (parsed) return parsed;
  }

  return null;
}

function extractMetafilePinId(ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.toLowerCase().startsWith('metafile://')) {
    const rest = trimmed.slice('metafile://'.length).split(/[?#]/)[0] ?? '';
    return rest.replace(/\.[a-z0-9]+$/i, '').toLowerCase() || null;
  }
  if (/^[0-9a-f]{64}i\d+$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

async function defaultFetchCiphertextBytes(pinId: string): Promise<Buffer | null> {
  const encoded = encodeURIComponent(pinId);
  const candidates = [
    () => fetchContentWithFallback(pinId, `${METAID_CONTENT_BASE}/${encoded}`),
    () => fetch(`${METAID_FILE_CONTENT_BASE}/${encoded}`),
  ];
  for (const doFetch of candidates) {
    try {
      const res = await doFetch();
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0) return buf;
    } catch {
      // Try next endpoint
    }
  }
  return null;
}

export async function resolvePaybuzzCiphertextBuffer(
  deps: PaybuzzServiceDeps,
  ciphertextPinOrBase64: string,
): Promise<Buffer> {
  const raw = String(ciphertextPinOrBase64 ?? '').trim();
  if (!raw) {
    throw new Error('ciphertextPinOrBase64 is empty');
  }
  if (raw.startsWith('base64:')) {
    const b64 = raw.slice('base64:'.length).trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) throw new Error('Inline base64 ciphertext is empty');
    return buf;
  }
  const pinId = extractMetafilePinId(raw);
  if (!pinId) {
    throw new Error(`Unsupported ciphertextPinOrBase64 reference: ${raw}`);
  }
  const buf = deps.fetchCiphertextBytes
    ? await deps.fetchCiphertextBytes(pinId)
    : await defaultFetchCiphertextBytes(pinId);
  if (!buf || buf.length === 0) {
    throw new Error(`Unable to download ciphertext metafile ${pinId}`);
  }
  return buf;
}

/**
 * Deterministically recover an author's content key on a fresh machine using
 * only the MetaBot's BIP39 mnemonic + path and the on-chain `keySaltHex` (`plainSha256`).
 */
export async function recoverAuthorPaybuzzKey(
  deps: PaybuzzServiceDeps,
  input: {
    metabotId: number;
    paybuzzPinId: string;
    item?: PaybuzzItemRecord | null;
  },
): Promise<{ contentKeyHex: string; item: PaybuzzItemRecord }> {
  const db = deps.getDb();
  const normalizedPinId = String(input.paybuzzPinId ?? '').trim().toLowerCase();
  const cachedAuthored = getPaybuzzAuthoredItem(db, normalizedPinId);

  const item = input.item ?? (await fetchPaybuzzItem(deps, normalizedPinId));
  if (!item && !cachedAuthored) {
    throw new Error(`PayBuzz item ${normalizedPinId} not found`);
  }

  if (cachedAuthored && cachedAuthored.metabotId === input.metabotId) {
    if (item) {
      return { contentKeyHex: cachedAuthored.contentKeyHex, item };
    }
    return {
      contentKeyHex: cachedAuthored.contentKeyHex,
      item: {
        paybuzzPinId: normalizedPinId,
        title: cachedAuthored.title || 'Encrypted Article',
        preview: cachedAuthored.preview || '',
        contentType: 'text/markdown',
        wordCount: cachedAuthored.wordCount || 0,
        encryption: {
          algo: 'AES-256-GCM',
          ivHex: '',
          authTagHex: '',
          cipherSha256: cachedAuthored.cipherSha256,
          keySaltHex: cachedAuthored.keySaltHex,
          ciphertextPinOrBase64: '',
        },
        authorMetaId: '',
        authorMvcAddress: '',
        unlockRules: normalizePaybuzzUnlockRules(JSON.parse(cachedAuthored.unlockRulesJson)),
        createdAt: cachedAuthored.createdAt,
      },
    };
  }

  if (!item) {
    throw new Error(`PayBuzz item ${normalizedPinId} not found on chain`);
  }

  const store = deps.getMetabotStore();
  const bot = store.getMetabotById(input.metabotId);
  const wallet = store.getMetabotWalletByMetabotId(input.metabotId);
  if (!bot || !wallet?.mnemonic?.trim()) {
    throw new Error(`Author MetaBot ${input.metabotId} wallet not available`);
  }

  const botIds = new Set(
    [bot.globalmetaid, bot.metaid, bot.mvc_address]
      .map((s) => String(s ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  const itemAuthorRefs = [item.authorMetaId, item.authorMvcAddress]
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (itemAuthorRefs.length > 0 && !itemAuthorRefs.some((ref) => botIds.has(ref))) {
    throw new Error(`MetaBot ${input.metabotId} is not the author of PayBuzz item ${normalizedPinId}`);
  }

  if (!item.encryption.keySaltHex || !/^[0-9a-f]{64}$/.test(item.encryption.keySaltHex)) {
    throw new Error(`PayBuzz item ${normalizedPinId} lacks keySaltHex for mnemonic key recovery`);
  }

  const masterSeed = await derivePaybuzzAuthorMasterSeed(wallet.mnemonic, wallet.path);
  const keyBuf = derivePaybuzzContentKey(masterSeed, item.encryption.keySaltHex);
  const contentKeyHex = keyBuf.toString('hex');

  // Re-index into local SQLite so subsequent requests hit the fast DB cache
  upsertPaybuzzAuthoredItem(
    db,
    {
      paybuzzPinId: normalizedPinId,
      metabotId: input.metabotId,
      cipherSha256: item.encryption.cipherSha256,
      keySaltHex: item.encryption.keySaltHex,
      contentKeyHex,
      unlockRulesJson: JSON.stringify(item.unlockRules),
      title: item.title,
      preview: item.preview,
      wordCount: item.wordCount,
      createdAt: item.createdAt,
    },
    deps.saveDb,
  );

  return { contentKeyHex, item };
}

export async function decryptAndCachePaybuzzWithKey(
  deps: PaybuzzServiceDeps,
  input: {
    paybuzzPinId: string;
    contentKeyHex: string;
    grantedVia: 'vip-nft' | 'token' | 'author';
    item?: PaybuzzItemRecord | null;
  },
): Promise<PaybuzzUnlockedCacheRecord> {
  const normalizedPinId = String(input.paybuzzPinId ?? '').trim().toLowerCase();
  const item = input.item ?? (await fetchPaybuzzItem(deps, normalizedPinId));
  if (!item) {
    throw new Error(`PayBuzz item ${normalizedPinId} not found`);
  }

  const ciphertextBuffer = await resolvePaybuzzCiphertextBuffer(
    deps,
    item.encryption.ciphertextPinOrBase64,
  );

  const decrypted = decryptPaybuzzContent({
    ciphertextBuffer,
    contentKeyHex: input.contentKeyHex,
    ivHex: item.encryption.ivHex,
    authTagHex: item.encryption.authTagHex,
    expectedCipherSha256: item.encryption.cipherSha256,
    ...(item.encryption.keySaltHex ? { expectedPlainSha256: item.encryption.keySaltHex } : {}),
  });

  const record: PaybuzzUnlockedCacheRecord = {
    paybuzzPinId: normalizedPinId,
    contentKeyHex: input.contentKeyHex.toLowerCase(),
    decryptedMarkdown: decrypted.plaintextMarkdown,
    grantedVia: input.grantedVia,
    title: item.title,
    authorMetaId: item.authorMetaId,
    unlockedAt: deps.nowMs?.() ?? Date.now(),
  };

  upsertPaybuzzUnlockedCache(deps.getDb(), record, deps.saveDb);

  deps.emitToRenderer?.('paybuzz:unlocked', {
    paybuzzPinId: normalizedPinId,
    grantedVia: record.grantedVia,
    title: record.title,
    authorMetaId: record.authorMetaId,
    decryptedMarkdown: record.decryptedMarkdown,
    unlockedAt: record.unlockedAt,
  });

  return record;
}

export async function findMatchingVipNftHolding(
  deps: PaybuzzServiceDeps,
  input: {
    holderAddress: string;
    collections: PaybuzzVipCollectionRule[];
  },
): Promise<{ collectionPinId: string; collectionName: string; itemCount: number } | null> {
  const holderAddress = String(input.holderAddress ?? '').trim();
  if (!holderAddress || input.collections.length === 0) return null;

  for (const col of input.collections) {
    const items = deps.fetchMrc721ItemsForAddress
      ? await deps.fetchMrc721ItemsForAddress({
          address: holderAddress,
          collectionPinId: col.collectionPinId,
        })
      : await fetchMrc721AddressItems({
          address: holderAddress,
          pinId: col.collectionPinId,
        });

    const active = items.filter(
      (item) =>
        item &&
        item.burned !== true &&
        Boolean(item.itemPinId || (item as unknown as { pinId?: string }).pinId),
    );
    if (active.length > 0) {
      return {
        collectionPinId: col.collectionPinId,
        collectionName: col.collectionName,
        itemCount: active.length,
      };
    }
  }
  return null;
}

export interface UnlockPaybuzzArticleInput {
  paybuzzPinId: string;
  metabotId?: number;
  preferredTrack?: 'auto' | 'vip-nft' | 'token';
  assetKey?: string;
  paymentTxId?: string;
  confirmTokenPay?: boolean;
  waitTimeoutMs?: number;
}

export interface UnlockPaybuzzArticleResult {
  status: 'unlocked' | 'pending_key' | 'payment_required';
  track?: 'cache' | 'author' | 'vip-nft' | 'token';
  paybuzzPinId: string;
  grantedVia?: 'vip-nft' | 'token' | 'author';
  decryptedMarkdown?: string;
  title?: string;
  authorMetaId?: string;
  vipMatch?: { collectionPinId: string; collectionName: string };
  paymentTxId?: string;
  assetKey?: string;
  error?: string;
}

export async function unlockPaybuzzArticle(
  deps: PaybuzzServiceDeps,
  input: UnlockPaybuzzArticleInput,
): Promise<UnlockPaybuzzArticleResult> {
  const normalizedPinId = String(input.paybuzzPinId ?? '').trim().toLowerCase();
  if (!normalizedPinId) {
    throw new Error('paybuzzPinId is required');
  }

  const db = deps.getDb();
  const cached = getPaybuzzUnlockedCache(db, normalizedPinId);
  if (cached) {
    return {
      status: 'unlocked',
      track: 'cache',
      paybuzzPinId: normalizedPinId,
      grantedVia: cached.grantedVia,
      decryptedMarkdown: cached.decryptedMarkdown,
      title: cached.title,
      authorMetaId: cached.authorMetaId,
    };
  }

  const item = await fetchPaybuzzItem(deps, normalizedPinId);
  if (!item) {
    throw new Error(`PayBuzz article ${normalizedPinId} not found`);
  }

  const store = deps.getMetabotStore();
  const metabots = store.listMetabots().filter((m) => m.enabled !== false);
  const bot =
    input.metabotId != null
      ? store.getMetabotById(input.metabotId)
      : metabots.find((m) => m.metabot_type === 'twin') ?? metabots[0] ?? null;

  if (!bot) {
    throw new Error('No enabled MetaBot found to unlock article');
  }
  const wallet = store.getMetabotWalletByMetabotId(bot.id);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error(`MetaBot ${bot.id} wallet mnemonic not available`);
  }

  const readerGlobalMetaId = String(bot.globalmetaid || bot.metaid || '').trim();
  if (!readerGlobalMetaId) {
    throw new Error(`MetaBot ${bot.id} has no globalMetaId`);
  }

  const preferredTrack = input.preferredTrack ?? 'auto';

  // Author self-preview fast path when no explicit track override is requested
  if (
    preferredTrack === 'auto' &&
    item.authorMetaId &&
    item.authorMetaId === readerGlobalMetaId
  ) {
    const recovered = await recoverAuthorPaybuzzKey(deps, {
      metabotId: bot.id,
      paybuzzPinId: normalizedPinId,
      item,
    });
    const cachedAuthor = await decryptAndCachePaybuzzWithKey(deps, {
      paybuzzPinId: normalizedPinId,
      contentKeyHex: recovered.contentKeyHex,
      grantedVia: 'author',
      item,
    });
    return {
      status: 'unlocked',
      track: 'author',
      paybuzzPinId: normalizedPinId,
      grantedVia: 'author',
      decryptedMarkdown: cachedAuthor.decryptedMarkdown,
      title: cachedAuthor.title,
      authorMetaId: cachedAuthor.authorMetaId,
    };
  }

  // Track A: VIP MRC-721 NFT Card check
  if (
    (preferredTrack === 'auto' || preferredTrack === 'vip-nft') &&
    item.unlockRules.vipMrc721Collections.length > 0 &&
    bot.mvc_address
  ) {
    const vipMatch = await findMatchingVipNftHolding(deps, {
      holderAddress: bot.mvc_address,
      collections: item.unlockRules.vipMrc721Collections,
    });
    if (vipMatch) {
      if (!deps.sendEncryptedPrivateMessage) {
        throw new Error('sendEncryptedPrivateMessage is required to request VIP key grant');
      }
      const timestamp = Math.floor((deps.nowMs?.() ?? Date.now()) / 1000);
      const signed = await signPaybuzzVipChallenge({
        mnemonic: wallet.mnemonic,
        path: wallet.path,
        paybuzzPinId: normalizedPinId,
        readerGlobalMetaId,
        timestamp,
      });
      const wire = formatPayReadWireMessage({
        type: 'PAYREAD_VIP_REQ_V1',
        paybuzzPinId: normalizedPinId,
        collectionPinId: vipMatch.collectionPinId,
        holderAddress: bot.mvc_address,
        readerGlobalMetaId,
        timestamp,
        signatureHex: signed.signatureHex,
      });
      await deps.sendEncryptedPrivateMessage(bot.id, item.authorMetaId, wire);

      const unlockedAfterWait = await waitForUnlockedCache(
        db,
        normalizedPinId,
        input.waitTimeoutMs ?? 0,
      );
      if (unlockedAfterWait) {
        return {
          status: 'unlocked',
          track: 'vip-nft',
          paybuzzPinId: normalizedPinId,
          grantedVia: unlockedAfterWait.grantedVia,
          decryptedMarkdown: unlockedAfterWait.decryptedMarkdown,
          title: unlockedAfterWait.title,
          authorMetaId: unlockedAfterWait.authorMetaId,
          vipMatch: {
            collectionPinId: vipMatch.collectionPinId,
            collectionName: vipMatch.collectionName,
          },
        };
      }

      return {
        status: 'pending_key',
        track: 'vip-nft',
        paybuzzPinId: normalizedPinId,
        title: item.title,
        authorMetaId: item.authorMetaId,
        vipMatch: {
          collectionPinId: vipMatch.collectionPinId,
          collectionName: vipMatch.collectionName,
        },
      };
    }
    if (preferredTrack === 'vip-nft') {
      throw new Error('No eligible VIP MRC-721 Member Card held by this MetaBot');
    }
  }

  // Track B: FT Micropayment
  if (item.unlockRules.tokenPrices.length === 0) {
    return {
      status: 'payment_required',
      paybuzzPinId: normalizedPinId,
      title: item.title,
      authorMetaId: item.authorMetaId,
      error: 'No eligible VIP card held and no token payment rules configured',
    };
  }

  const normalizedRequestedKey = input.assetKey
    ? normalizeFtAssetKey(input.assetKey)
    : item.unlockRules.tokenPrices[0].assetKey;
  const rule = item.unlockRules.tokenPrices.find((r) => r.assetKey === normalizedRequestedKey);
  if (!rule) {
    throw new Error(`Unsupported token assetKey '${normalizedRequestedKey}' for this article`);
  }

  let paymentTxId = String(input.paymentTxId ?? '').trim().toLowerCase();
  if (!paymentTxId) {
    if (input.confirmTokenPay !== true) {
      return {
        status: 'payment_required',
        track: 'token',
        paybuzzPinId: normalizedPinId,
        title: item.title,
        authorMetaId: item.authorMetaId,
        assetKey: rule.assetKey,
      };
    }

    if (rule.chain === 'mvc') {
      if (!rule.codehash || !rule.genesis) {
        throw new Error(`Invalid MVC FT rule for ${rule.assetKey}`);
      }
      if (deps.transferMvcFt) {
        const res = await deps.transferMvcFt({
          metabotId: bot.id,
          codehash: rule.codehash,
          genesis: rule.genesis,
          toAddress: rule.receiveAddress,
          amountBase: rule.amountBase,
        });
        paymentTxId = res.txId.toLowerCase();
      } else {
        const feeRate = getGlobalFeeRate('mvc');
        const built = await buildMvcFtTransferRawTx(store, {
          metabotId: bot.id,
          token: { codeHash: rule.codehash, genesisHash: rule.genesis },
          toAddress: rule.receiveAddress,
          amount: rule.amountBase,
          feeRate,
        });
        const broadcasted = await broadcastMvcFtTransferBundle(
          {
            amountCheckRawTx: built.amount_check_raw_tx,
            rawTx: built.raw_tx,
          },
          defaultBroadcastMvcRawTx,
        );
        paymentTxId = broadcasted.txId.toLowerCase();
      }
    } else {
      if (!rule.mrc20Id) {
        throw new Error(`Invalid BTC MRC-20 rule for ${rule.assetKey}`);
      }
      if (!bot.btc_address) {
        throw new Error(`MetaBot ${bot.id} BTC address not found`);
      }
      if (deps.transferBtcMrc20) {
        const res = await deps.transferBtcMrc20({
          metabotId: bot.id,
          mrc20Id: rule.mrc20Id,
          decimal: rule.decimals,
          symbol: rule.symbol,
          fromAddress: bot.btc_address,
          toAddress: rule.receiveAddress,
          amountBase: rule.amountBase,
          amountDisplay: rule.amountDisplay,
        });
        paymentTxId = res.revealTxId.toLowerCase();
      } else {
        const res = await executeMrc20Transfer(store, {
          metabotId: bot.id,
          asset: {
            mrc20Id: rule.mrc20Id,
            symbol: rule.symbol,
            address: bot.btc_address,
            decimal: rule.decimals,
          },
          toAddress: rule.receiveAddress,
          amount: rule.amountDisplay,
          feeRate: getGlobalFeeRate('btc'),
        });
        paymentTxId = res.revealTxId.toLowerCase();
      }
    }
  }

  if (!deps.sendEncryptedPrivateMessage) {
    throw new Error('sendEncryptedPrivateMessage is required to request token unlock key');
  }

  const wire = formatPayReadWireMessage({
    type: 'PAYREAD_TOKEN_REQ_V1',
    paybuzzPinId: normalizedPinId,
    assetKey: rule.assetKey,
    paymentTxId,
    readerGlobalMetaId,
  });
  await deps.sendEncryptedPrivateMessage(bot.id, item.authorMetaId, wire);

  const unlockedAfterWait = await waitForUnlockedCache(
    db,
    normalizedPinId,
    input.waitTimeoutMs ?? 0,
  );
  if (unlockedAfterWait) {
    return {
      status: 'unlocked',
      track: 'token',
      paybuzzPinId: normalizedPinId,
      grantedVia: unlockedAfterWait.grantedVia,
      decryptedMarkdown: unlockedAfterWait.decryptedMarkdown,
      title: unlockedAfterWait.title,
      authorMetaId: unlockedAfterWait.authorMetaId,
      paymentTxId,
      assetKey: rule.assetKey,
    };
  }

  return {
    status: 'pending_key',
    track: 'token',
    paybuzzPinId: normalizedPinId,
    title: item.title,
    authorMetaId: item.authorMetaId,
    paymentTxId,
    assetKey: rule.assetKey,
  };
}

async function waitForUnlockedCache(
  db: Database,
  paybuzzPinId: string,
  timeoutMs: number,
): Promise<PaybuzzUnlockedCacheRecord | null> {
  if (!timeoutMs || timeoutMs <= 0) {
    return getPaybuzzUnlockedCache(db, paybuzzPinId);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = getPaybuzzUnlockedCache(db, paybuzzPinId);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getPaybuzzUnlockedCache(db, paybuzzPinId);
}
