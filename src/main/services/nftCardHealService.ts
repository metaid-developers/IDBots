/**
 * NftCard heal service — renderer-side fallback lookups for chat NFT cards.
 *
 * The card fence is emitter-owned: whatever artwork/issuer facts the wallet
 * tools held at broadcast time ride the fence, and that is all a pure
 * renderer can show. Two gaps cannot be filled at emission time and are
 * healed here, per card identity, on demand from the renderer:
 *
 *   1. Missing artwork (no imgUrl and no icon in the fence):
 *      - metacontract: wallet-api v4 `mvc/address/contract/nft/utxo-list`
 *        scoped by the fence's owner address, filtered to the fence's
 *        genesis+tokenIndex row — its `imgUrl` (an https direct link) is
 *        returned verbatim and its `icon` as the metafile fallback.
 *      - mrc721: `mrc721/item/info` by pinId — the item `cover` becomes the
 *        icon (the same metafile chain the NFT wallet modal walks).
 *   2. Missing metacontract issuer, by the AC's preferred route: a v4 row's
 *        `issuerAddress` when the wire actually carries one (largest live
 *        series leave it "--"), else the CONTRACT GENESIS TX's first input
 *        address = the deployer. The genesis txid is recoverable from the
 *        row's `sensibleId`: its first 32 bytes, byte-reversed, are the
 *        genesis txid in display order (live-verified 2026-11-02, MetaBot
 *        Avatar: 4e7a7d3e…ea53 → 53ea2502…7d7a4e, whose first input
 *        176C9RPW… resolves on-chain to MetaID identity "Bot"; replayed
 *        independently by both worker sessions on this slice). Issuer
 *        results are cached per genesis txid for the process lifetime.
 *
 * Every path is best-effort and fails soft: the IPC answers null fields,
 * never throws, so the card degrades to its placeholder / short address.
 * Results are cached per process: identity → heal result, and genesis
 * txid → issuer address.
 */

import { createHash } from 'crypto';
import { freshGetUrlAndInit } from './freshFetch';
import { fetchMrc721ItemInfo } from './mrc721Service';
import { fetchMvcNftUtxoListByAddress, type RawMvcNftUtxoRow } from './mvcNftService';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

export interface NftCardHealInput {
  format: 'metacontract' | 'mrc721';
  genesis?: string;
  tokenIndex?: string;
  pinId?: string;
  /** MVC address holding the token at broadcast time (fence `owner`). */
  owner?: string;
}

export interface NftCardHealResult {
  /** https direct artwork link (v4 utxo-list `imgUrl`), returned verbatim. */
  imgUrl?: string;
  /** metafile:// fallback artwork (v4 `icon` / MRC-721 item cover). */
  icon?: string;
  /** Collection issuer: wire issuerAddress when real, else the genesis tx's first input (metacontract only). */
  issuer?: string;
}

// ---------------------------------------------------------------------------
// raw tx parsing — first input's spending pubkey → P2PKH address
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function readVarInt(buffer: Buffer, offset: number): { value: number; nextOffset: number } {
  const prefix = buffer.readUInt8(offset);
  if (prefix < 0xfd) return { value: prefix, nextOffset: offset + 1 };
  if (prefix === 0xfd) return { value: buffer.readUInt16LE(offset + 1), nextOffset: offset + 3 };
  if (prefix === 0xfe) return { value: buffer.readUInt32LE(offset + 1), nextOffset: offset + 5 };
  const lo = buffer.readUInt32LE(offset + 1);
  const hi = buffer.readUInt32LE(offset + 5);
  return { value: hi * 0x100000000 + lo, nextOffset: offset + 9 };
}

function base58CheckEncode(payload: Buffer): string {
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

/**
 * Extract the public key from a P2PKH input's scriptSig (`<sig> <pubkey>`)
 * — the LAST push that looks like a compressed (33B, 02/03) or uncompressed
 * (65B, 04) key. Returns null for any other script shape.
 */
function pubkeyFromScriptSig(script: Buffer): Buffer | null {
  let offset = 0;
  let found: Buffer | null = null;
  while (offset < script.length) {
    const pushLen = script[offset];
    if (pushLen === 0x4c) {
      offset += 1; // OP_PUSHDATA1 marker; length follows — skip conservatively
      continue;
    }
    const push = script.subarray(offset + 1, offset + 1 + pushLen);
    if (
      (pushLen === 33 && (push[0] === 0x02 || push[0] === 0x03)) ||
      (pushLen === 65 && push[0] === 0x04)
    ) {
      found = push;
    }
    offset += 1 + pushLen;
  }
  return found;
}

/**
 * Derive the first input's P2PKH address (MVC livenet, version byte 0x00)
 * from a raw transaction hex. Pure — exported for tests with mainnet
 * fixtures. Returns null whenever the tx is malformed or the first input
 * carries no recognizable pubkey.
 */
export function deriveMvcFirstInputAddressFromRawTx(rawTxHex: string): string | null {
  try {
    const buffer = Buffer.from(String(rawTxHex || '').trim(), 'hex');
    if (buffer.length < 10) return null;
    let offset = 4; // version
    if (buffer[offset] === 0x00 && buffer[offset + 1] !== 0x00) {
      offset += 2; // segwit marker + flag (defensive; MVC contract txs are legacy)
    }
    const inputCount = readVarInt(buffer, offset);
    offset = inputCount.nextOffset;
    if (inputCount.value < 1) return null;
    offset += 32 + 4; // first input: prev txid + vout
    const scriptLen = readVarInt(buffer, offset);
    offset = scriptLen.nextOffset;
    const scriptSig = buffer.subarray(offset, offset + scriptLen.value);
    const pubkey = pubkeyFromScriptSig(scriptSig);
    if (!pubkey) return null;
    const hash160 = createHash('ripemd160')
      .update(createHash('sha256').update(pubkey).digest())
      .digest();
    return base58CheckEncode(Buffer.concat([Buffer.from([0x00]), hash160]));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// wallet-api raw tx fetch + per-metaTx issuer cache
// ---------------------------------------------------------------------------

async function fetchMvcRawTxHex(txId: string): Promise<string> {
  const freshRequest = freshGetUrlAndInit(
    `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`,
  );
  const response = await fetch(freshRequest.url, freshRequest.init);
  const json = (await response.json()) as {
    code?: number;
    message?: string;
    data?: { rawTx?: string; hex?: string } | string;
  };
  if (json.code !== 0 && json.code != null) {
    throw new Error(json.message || `Failed to fetch raw tx (code=${json.code})`);
  }
  const data = json.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') return data.rawTx ?? data.hex ?? '';
  return '';
}

/**
 * sensibleId (v4 utxo-list) = <genesisTxid in internal byte order><genesis
 * 20B code id>. The display-order txid is the first 32 bytes byte-reversed.
 * Pure — exported for tests with the live MetaBot Avatar vector.
 */
export function reverseSensibleIdToGenesisTxid(sensibleId: string): string | null {
  const text = String(sensibleId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64,}$/.test(text)) return null;
  const internal = Buffer.from(text.slice(0, 64), 'hex');
  return Buffer.from(internal).reverse().toString('hex');
}

const genesisIssuerCache = new Map<string, string>();

/** The wire issuerAddress only counts when it is a real address ("--"/"" don't). */
function realIssuerAddress(value: unknown): string | undefined {
  const address = String(value ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(address)) return undefined;
  return address;
}

async function resolveMetaContractIssuerByGenesis(
  sensibleId: string | undefined,
): Promise<string | undefined> {
  const genesisTxid = reverseSensibleIdToGenesisTxid(sensibleId ?? '');
  if (!genesisTxid) return undefined;
  const cached = genesisIssuerCache.get(genesisTxid);
  if (cached) return cached;
  try {
    const rawHex = await fetchMvcRawTxHex(genesisTxid);
    const address = deriveMvcFirstInputAddressFromRawTx(rawHex);
    if (address) genesisIssuerCache.set(genesisTxid, address);
    return address ?? undefined;
  } catch {
    return undefined; // silent — issuer is optional enrichment
  }
}

// ---------------------------------------------------------------------------
// heal channels
// ---------------------------------------------------------------------------

function sanitizeHttpsUrl(value: unknown): string | undefined {
  const url = String(value ?? '').trim();
  if (!url || !/^https:\/\//i.test(url) || /\s/.test(url)) return undefined;
  return url.slice(0, 512);
}

/** metafile://<64hex>i<N>(.ext)? — the fence `icon` contract (bare pins get the scheme). */
function sanitizeMetafileIcon(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text)) return undefined;
  const withScheme = text.toLowerCase().startsWith('metafile://')
    ? text
    : /^[0-9a-fA-F]{64}i\d+(\.[A-Za-z0-9]{1,8})?$/.test(text)
      ? `metafile://${text}`
      : null;
  return withScheme ? withScheme.slice(0, 512) : undefined;
}

/**
 * v4 icons are MetaLet image-host file names (metafile://<64hex>.png) whose
 * pin is NOT a MetaID metafile — keep the raw string only when it matches
 * the fence icon contract; anything else is left for the caller's
 * compress-URL derivation on the renderer side.
 */
function sanitizeWalletApiIcon(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!text || /\s/.test(text)) return undefined;
  if (/^metafile:\/\//i.test(text)) return text.slice(0, 512);
  if (/^[0-9a-fA-F]{64}(\.[A-Za-z0-9]{1,8})?$/.test(text)) {
    return `metafile://${text}`.slice(0, 512);
  }
  return undefined;
}

const healCache = new Map<string, NftCardHealResult>();

function metacontractIdentity(
  input: NftCardHealInput,
): { genesis: string; tokenIndex: string; cacheKey: string } | null {
  const genesis = (input.genesis || '').trim().toLowerCase();
  const tokenIndex = (input.tokenIndex || '').trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(genesis)) return null;
  if (!/^\d{1,10}$/.test(tokenIndex)) return null;
  return { genesis, tokenIndex, cacheKey: `metacontract:${genesis}:${tokenIndex}` };
}

function findUtxoRow(rows: RawMvcNftUtxoRow[], genesis: string, tokenIndex: string): RawMvcNftUtxoRow | undefined {
  const wanted = String(tokenIndex).replace(/^0+(?=\d)/, '');
  return rows.find((row) => {
    const rowGenesis = String(row.genesis ?? '').trim().toLowerCase();
    const rowIndex = String(row.tokenIndex ?? '').trim().replace(/^0+(?=\d)/, '');
    return rowGenesis === genesis && rowIndex === wanted;
  });
}

async function healMetaContract(input: NftCardHealInput): Promise<NftCardHealResult> {
  const identity = metacontractIdentity(input);
  const owner = (input.owner || '').trim();
  if (!identity || !owner) return {};
  const cacheKey = `${identity.cacheKey}:${owner}`;
  const cached = healCache.get(cacheKey);
  if (cached) return cached;
  const result: NftCardHealResult = {};
  try {
    const rows = await fetchMvcNftUtxoListByAddress(owner);
    const row = findUtxoRow(rows, identity.genesis, identity.tokenIndex);
    if (row) {
      const imgUrl = sanitizeHttpsUrl(row.imgUrl);
      const icon = sanitizeWalletApiIcon(row.icon);
      if (imgUrl || icon) {
        result.imgUrl = imgUrl;
        result.icon = icon;
      }
      // Issuer: the wire's own issuerAddress when real, else the contract
      // genesis tx's first input (deployer) via the sensibleId reversal.
      const issuer = realIssuerAddress(row.issuerAddress) ?? (await resolveMetaContractIssuerByGenesis(row.sensibleId));
      if (issuer) result.issuer = issuer;
    }
  } catch {
    return {}; // silent — placeholder / short address degradation
  }
  healCache.set(cacheKey, result);
  return result;
}

async function healMrc721(input: NftCardHealInput): Promise<NftCardHealResult> {
  const pinId = (input.pinId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}i\d{1,6}$/.test(pinId)) return {};
  const cached = healCache.get(`mrc721:${pinId}`);
  if (cached) return cached;
  const result: NftCardHealResult = {};
  try {
    const item = await fetchMrc721ItemInfo({ pinId });
    const icon = sanitizeMetafileIcon(item?.cover);
    if (icon) result.icon = icon;
  } catch {
    return {}; // silent
  }
  healCache.set(`mrc721:${pinId}`, result);
  return result;
}

/** Best-effort heal for one card identity. Never throws; empty result = no data. */
export async function healNftCard(input: NftCardHealInput): Promise<NftCardHealResult> {
  try {
    if (input?.format === 'mrc721') return await healMrc721(input);
    if (input?.format === 'metacontract') return await healMetaContract(input);
    return {};
  } catch {
    return {};
  }
}
