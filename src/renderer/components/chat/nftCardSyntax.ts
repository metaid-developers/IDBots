/**
 * nft-card fence syntax — the chat NFT card contract shared by every markdown
 * surface (CoWork conversation, A2A private chat, group/group-task transcript).
 *
 * A bot embeds a card as a fenced code block whose fence tag is `nft-card`
 * (`nft` / `nftcard` are accepted aliases) and whose body is one JSON object.
 * Two identity formats exist (dual-format, MRC-721 primary):
 *
 * ```nft-card  (MetaContract — legacy shape, no `format` field)
 * {"genesis":"…40hex…","codehash":"…40hex…","tokenIndex":"5028","name":"小明",
 *  "series":"Metabot Gen 2","imgUrl":"https://…","icon":"metafile://…",
 *  "owner":"1Grq…","ownerLabel":"AI_Sunny","priceSats":100000,"action":"listed"}
 * ```
 *
 * ```nft-card  (MRC-721 — pin-based MetaID NFT)
 * {"format":"mrc721","pinId":"…64hex…i0","number":3,"name":"…",
 *  "series":"collection-name","icon":"metafile://…","owner":"1Ax…",
 *  "issuer":"1Gr…","priceSats":100000,"action":"listed"}
 * ```
 *
 * Identity rules: `format:"mrc721"` requires a valid `pinId` (64-hex txid +
 * "i" + output index); `format:"metacontract"` (or a payload with no format
 * field but a valid genesis/codehash/tokenIndex triple — the historical shape)
 * requires the triple. A payload with no format field and only a pinId is
 * accepted as MRC-721 so lenient emitters still render. Everything besides the
 * identity is display enrichment the emitter already holds.
 *
 * Multiple adjacent nft-card fences (separated by blank lines only) are merged
 * by the renderer preprocessing into one `nft-card-group` fence whose body is
 * a JSON array, so the cards render side by side in a horizontal scroller.
 *
 * Old clients without the card renderer degrade to the plain code block they
 * already ship, so the payload stays readable everywhere.
 *
 * This module is DOM-free so server-rendered renderer tests drive it directly.
 */

/** Fence tags that switch a code block into NFT card rendering. */
export const NFT_CARD_FENCE_TAG = 'nft-card';
const NFT_CARD_FENCE_TAGS = new Set(['nft-card', 'nftcard', 'nft']);

/**
 * Fence tag the preprocessing layer merges adjacent nft-card fences into.
 * Never emitted by tools; old renderers degrade it to a plain code block.
 */
export const NFT_CARD_GROUP_FENCE_TAG = 'nft-card-group';

/** NFT identity formats. MRC-721 is the MetaID-native primary; MetaContract stays compatible (transitional). */
export type NftCardFormat = 'metacontract' | 'mrc721';

// MetaContract genesis ids on MVC are 40 hex (live wire shape, mainnet
// 2026-11-02: 2b5f8a84…); 64 hex is also accepted so future/longer id
// shapes never break parsing.
const GENESIS_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const CODEHASH_RE = /^[0-9a-fA-F]{40}$/;
const TOKEN_INDEX_RE = /^\d{1,10}$/;
/** MRC-721 item pinId: `<64-hex txid>i<output index>` (same shape as mrc721Service.isMrc721PinId). */
const MRC721_PIN_ID_RE = /^[0-9a-f]{64}i\d{1,6}$/;
/** Base58-ish MVC address shape (covers mainnet P2PKH prefixes we see live). */
const MVC_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{20,60}$/;

/** Upper bounds keep a malformed/hostile payload from blowing up the bubble. */
const MAX_TEXT_FIELD = 64;
const MAX_ACTION_FIELD = 16;

export interface NftCardPriceToken {
  assetKey: string;
  chain: 'btc' | 'mvc';
  symbol: string;
  decimals: number;
  amountBase: string;
  amountDisplay: string;
  sellerReceiveAddress?: string;
}

export interface NftCardData {
  /** Identity format. Absent payloads default to metacontract at parse time. */
  format: NftCardFormat;
  /** MetaContract series genesis id (required for metacontract cards). */
  genesis?: string;
  codehash?: string;
  tokenIndex?: string;
  /** MRC-721 item pinId (required for mrc721 cards). */
  pinId?: string;
  /** MRC-721 mint serial inside the collection. */
  number?: number;
  name?: string;
  /** Series (MetaContract) / collection name (MRC-721). */
  series?: string;
  /** https direct artwork link (wallet-api v4 utxo-list `imgUrl`). */
  imgUrl?: string;
  /** metafile:// fallback artwork (v4 `icon` / MRC-721 item cover). */
  icon?: string;
  /** MVC address holding the token at broadcast time. */
  owner?: string;
  /** Display name for the owner (bot/human), shown beside the address. */
  ownerLabel?: string;
  /** MRC-721 collection issuer address (authenticity signal). */
  issuer?: string;
  /** Display name for the issuer. */
  issuerLabel?: string;
  /** Ask/deal price in sats at broadcast time. */
  priceSats?: number;
  /** v2.1 digital goods commerce price in ME milli-units (1 ME = 1000). */
  priceMeMilli?: number;
  /** v2.1 digital goods commerce reference price in CNY cents. */
  priceCnyCents?: number;
  /** v2.2 digital goods commerce accepted token prices (MRC-20 / MVC-FT). */
  priceTokens?: NftCardPriceToken[];
  /** Seller's GlobalMetaID for A2A negotiation & escrow notifications. */
  sellerGlobalMetaId?: string;
  /** Display name for the seller bot. */
  sellerName?: string;
  /** Whether the seller bot is currently online. */
  sellerOnline?: boolean;
  /** Seller's MetaApp Shop pinId (metaapp://<pinId>). */
  shopMetaAppPinId?: string;
  /** Whether the collection is CA-certified official. */
  caVerified?: boolean;
  /** listed | transferred | sold | bought | escrow | delisted | minted | info … */
  action?: string;
  /**
   * Host source signature (S4 source-signing slice, owner decision A):
   * `v1.<issuedMs>.<sessionId>.<hmac64>` stamped by the host main process
   * when it actually executed the card's trade. The renderer holds no HMAC
   * secret, so it can only shape/parse this field and compare the bound
   * session id; the authoritative verification lives main-side
   * (tradeActivityStamp). A v1-shaped stamp is what the trade-mark
   * detection (p2p family) keys on — unsigned cards never mark.
   */
  hostStamp?: string;
}

export const isNftCardFenceLanguage = (language: string): boolean =>
  NFT_CARD_FENCE_TAGS.has(language.trim().toLowerCase());

export const isNftCardGroupFenceLanguage = (language: string): boolean =>
  language.trim().toLowerCase() === NFT_CARD_GROUP_FENCE_TAG;

const cleanTextField = (value: unknown, max = MAX_TEXT_FIELD): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Single line only: newlines would fight the bubble layout.
  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.slice(0, max);
};

const cleanHttpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  return trimmed.slice(0, 512);
};

/**
 * metafile://<pinId>(.ext)? — the extension form the wallet icon route uses is
 * accepted and preserved (A2AMessageItem.parseMetafileUri strips it at render
 * time). A bare `<64hex>i<N>` pin (how MRC-721 covers arrive) is normalized by
 * adding the metafile:// scheme.
 */
const cleanMetafileUri = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const withScheme = trimmed.toLowerCase().startsWith('metafile://')
    ? trimmed
    : /^[0-9a-fA-F]{64}i\d+(\.[A-Za-z0-9]{1,8})?$/.test(trimmed)
      ? `metafile://${trimmed}`
      : null;
  if (!withScheme) return undefined;
  if (/\s/.test(withScheme)) return undefined;
  return withScheme.slice(0, 512);
};

const cleanAddress = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!MVC_ADDRESS_RE.test(trimmed)) return undefined;
  return trimmed;
};

const cleanPriceSats = (value: unknown): number | undefined => {
  // Accept number or numeric string; reject floats/negatives/absurd caps.
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < 0 || num > 2_100_000_000_000_000) return undefined;
  return num;
};

const cleanNonNegInt = (value: unknown, max = 1_000_000_000_000): number | undefined => {
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(num) || num < 0 || num > max) return undefined;
  return num;
};

const cleanPriceTokens = (value: unknown): NftCardPriceToken[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: NftCardPriceToken[] = [];
  for (const raw of value.slice(0, 6)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const assetKey = typeof item.assetKey === 'string' ? item.assetKey.trim().toLowerCase() : '';
    if (!assetKey || (!assetKey.startsWith('mrc20:') && !assetKey.startsWith('mvc-ft:'))) continue;
    const chain: 'btc' | 'mvc' = item.chain === 'btc' || assetKey.startsWith('mrc20:') ? 'btc' : 'mvc';
    const symbol = cleanTextField(item.symbol, 24);
    const amountBase = typeof item.amountBase === 'string' ? item.amountBase.trim() : '';
    const amountDisplay = cleanTextField(item.amountDisplay, 40);
    const decimals = cleanNonNegInt(item.decimals, 36) ?? 0;
    if (!symbol || !/^[1-9]\d*$/.test(amountBase) || !amountDisplay) continue;
    const sellerReceiveAddress = typeof item.sellerReceiveAddress === 'string' && item.sellerReceiveAddress.trim()
      ? item.sellerReceiveAddress.trim().slice(0, 128)
      : undefined;
    out.push({
      assetKey: assetKey.slice(0, 160),
      chain,
      symbol,
      decimals,
      amountBase,
      amountDisplay,
      ...(sellerReceiveAddress ? { sellerReceiveAddress } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
};

const cleanGlobalMetaId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  return trimmed.slice(0, 128);
};

/** MRC-721 mint serial: non-negative integer (number or numeric string). */
const cleanSerial = (value: unknown): number | undefined => {
  const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < 0 || num > 1_000_000_000) return undefined;
  return num;
};

const cleanPinId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase().replace(/^metafile:\/\//, '');
  if (!MRC721_PIN_ID_RE.test(trimmed)) return undefined;
  return trimmed;
};

/**
 * Parse the body of an nft-card fence. Returns null when the payload is not a
 * JSON object carrying a valid identity for its format (MetaContract
 * genesis/codehash/tokenIndex triple, or MRC-721 pinId) — the caller then
 * falls back to the plain code-block rendering, exactly like any unparsable
 * fence. Payloads without a format field keep the historical meaning:
 * triple → metacontract, pinId-only → mrc721.
 */
export const parseNftCardFence = (codeText: string): NftCardData | null => {
  const text = String(codeText ?? '').trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;

  const formatRaw = typeof row.format === 'string' ? row.format.trim().toLowerCase() : '';
  if (formatRaw && formatRaw !== 'metacontract' && formatRaw !== 'mrc721') return null;
  const explicitFormat = (formatRaw || undefined) as NftCardFormat | undefined;

  const genesis = typeof row.genesis === 'string' ? row.genesis.trim().toLowerCase() : '';
  const codehash = typeof row.codehash === 'string' ? row.codehash.trim().toLowerCase() : '';
  const tokenIndex = typeof row.tokenIndex === 'string' || typeof row.tokenIndex === 'number'
    ? String(row.tokenIndex).trim()
    : '';
  const tripleOk = GENESIS_RE.test(genesis) && CODEHASH_RE.test(codehash) && TOKEN_INDEX_RE.test(tokenIndex);
  const pinId = cleanPinId(row.pinId);

  let format: NftCardFormat;
  if (explicitFormat === 'mrc721') {
    if (!pinId) return null;
    format = 'mrc721';
  } else if (explicitFormat === 'metacontract') {
    if (!tripleOk) return null;
    format = 'metacontract';
  } else if (tripleOk) {
    format = 'metacontract';
  } else if (pinId) {
    format = 'mrc721';
  } else {
    return null;
  }

  const data: NftCardData = { format };
  if (tripleOk) {
    data.genesis = genesis;
    data.codehash = codehash;
    data.tokenIndex = tokenIndex.replace(/^0+(?=\d)/, '');
  }
  if (pinId) data.pinId = pinId;
  const number = cleanSerial(row.number);
  if (number !== undefined) data.number = number;
  const name = cleanTextField(row.name);
  if (name) data.name = name;
  const series = cleanTextField(row.series);
  if (series) data.series = series;
  const imgUrl = cleanHttpsUrl(row.imgUrl);
  if (imgUrl) data.imgUrl = imgUrl;
  const icon = cleanMetafileUri(row.icon);
  if (icon) data.icon = icon;
  const owner = cleanAddress(row.owner);
  if (owner) data.owner = owner;
  const ownerLabel = cleanTextField(row.ownerLabel);
  if (ownerLabel) data.ownerLabel = ownerLabel;
  const issuer = cleanAddress(row.issuer);
  if (issuer) data.issuer = issuer;
  const issuerLabel = cleanTextField(row.issuerLabel);
  if (issuerLabel) data.issuerLabel = issuerLabel;
  const priceSats = cleanPriceSats(row.priceSats);
  if (priceSats !== undefined) data.priceSats = priceSats;
  const priceMeMilli = cleanNonNegInt(row.priceMeMilli);
  if (priceMeMilli !== undefined) data.priceMeMilli = priceMeMilli;
  const priceCnyCents = cleanNonNegInt(row.priceCnyCents);
  if (priceCnyCents !== undefined) data.priceCnyCents = priceCnyCents;
  const priceTokens = cleanPriceTokens(row.priceTokens);
  if (priceTokens) data.priceTokens = priceTokens;
  const sellerGlobalMetaId = cleanGlobalMetaId(row.sellerGlobalMetaId);
  if (sellerGlobalMetaId) data.sellerGlobalMetaId = sellerGlobalMetaId;
  const sellerName = cleanTextField(row.sellerName);
  if (sellerName) data.sellerName = sellerName;
  if (typeof row.sellerOnline === 'boolean') data.sellerOnline = row.sellerOnline;
  const shopMetaAppPinId = cleanPinId(row.shopMetaAppPinId);
  if (shopMetaAppPinId) data.shopMetaAppPinId = shopMetaAppPinId;
  if (typeof row.caVerified === 'boolean') data.caVerified = row.caVerified;
  const action = cleanTextField(row.action, MAX_ACTION_FIELD);
  if (action) data.action = action.toLowerCase();
  // hostStamp is copy-through only: an admissible stamp keeps its exact
  // bytes so main-side verification (HMAC over the whole fence payload) sees
  // what was emitted. Malformed → dropped, which fails the mark gate closed.
  const hostStamp = cleanTextField(row.hostStamp, 256);
  if (hostStamp && /^v1\.\d+\.[A-Za-z0-9-]+\.[0-9a-f]{64}$/.test(hostStamp)) {
    data.hostStamp = hostStamp;
  }
  return data;
};

/**
 * Parse an nft-card-group fence body (a JSON array of card payloads — the
 * shape the preprocessing layer merges adjacent nft-card fences into). Each
 * entry is validated by the single-card parser; invalid entries are skipped.
 * Returns null when no entry survives, so the caller degrades to the plain
 * code block exactly like a malformed single-card fence.
 */
export const parseNftCardGroupFence = (codeText: string): NftCardData[] | null => {
  const text = String(codeText ?? '').trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const cards: NftCardData[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const card = parseNftCardFence(JSON.stringify(row));
    if (card) cards.push(card);
  }
  return cards.length ? cards : null;
};

/**
 * Merge runs of ≥2 adjacent nft-card fences (blank lines only between them)
 * into single nft-card-group fences so the renderer can lay the cards out
 * side by side. Non-adjacent fences and everything else pass through
 * verbatim; a run whose members are not all single valid JSON objects stays
 * untouched. Column-0 fences only — indented/nested fences are left alone.
 */
export const groupAdjacentNftCardFences = (content: string): string => {
  const lines = content.split('\n');
  interface Fence {
    open: number;
    close: number;
    body: string;
  }
  const fences: Fence[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^```([A-Za-z0-9_-]*)[ \t]*$/.exec(lines[i]);
    if (!open || !isNftCardFenceLanguage(open[1])) continue;
    let j = i + 1;
    const bodyLines: string[] = [];
    while (j < lines.length && !/^```[ \t]*$/.test(lines[j])) {
      bodyLines.push(lines[j]);
      j += 1;
    }
    if (j >= lines.length) continue; // unterminated fence: leave the markdown alone
    const body = bodyLines.join('\n').trim();
    let valid = false;
    try {
      const probe = JSON.parse(body);
      valid = !!probe && typeof probe === 'object' && !Array.isArray(probe);
    } catch {
      valid = false;
    }
    if (valid) fences.push({ open: i, close: j, body });
    i = j;
  }
  if (fences.length < 2) return content;

  const runs: Fence[][] = [];
  let current: Fence[] = [fences[0]];
  for (let k = 1; k < fences.length; k += 1) {
    const prev = current[current.length - 1];
    const gapBlank = lines
      .slice(prev.close + 1, fences[k].open)
      .every((line) => !line.trim());
    if (gapBlank) current.push(fences[k]);
    else {
      runs.push(current);
      current = [fences[k]];
    }
  }
  runs.push(current);
  if (!runs.some((run) => run.length >= 2)) return content;

  const out: string[] = [];
  let cursor = 0;
  for (const run of runs) {
    const first = run[0];
    while (cursor < first.open) {
      out.push(lines[cursor]);
      cursor += 1;
    }
    if (run.length >= 2) {
      out.push(`\`\`\`${NFT_CARD_GROUP_FENCE_TAG}`);
      out.push(JSON.stringify(run.map((fence) => JSON.parse(fence.body))));
      out.push('```');
    } else {
      for (let n = run[0].open; n <= run[0].close; n += 1) out.push(lines[n]);
    }
    cursor = run[run.length - 1].close + 1;
  }
  while (cursor < lines.length) {
    out.push(lines[cursor]);
    cursor += 1;
  }
  return out.join('\n');
};

const NFT_CARD_KEY_ORDER: Array<keyof NftCardData> = [
  'format', 'pinId', 'genesis', 'codehash', 'tokenIndex', 'number', 'name',
  'series', 'imgUrl', 'icon', 'owner', 'ownerLabel', 'issuer', 'issuerLabel',
  'priceSats', 'priceMeMilli', 'priceCnyCents', 'priceTokens', 'sellerGlobalMetaId',
  'sellerName', 'sellerOnline', 'shopMetaAppPinId', 'caVerified', 'action', 'hostStamp',
];

/**
 * Serialize back to the exact fence form the wallet tools emit. Key order is
 * fixed so byte-identical inputs produce byte-identical fences (tests pin the
 * renderer parser and the main-side builder against this one shape).
 */
export const serializeNftCardFence = (data: NftCardData): string => {
  const ordered: Record<string, unknown> = {};
  for (const key of NFT_CARD_KEY_ORDER) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== '') {
      ordered[key] = value;
    }
  }
  return `\`\`\`${NFT_CARD_FENCE_TAG}\n${JSON.stringify(ordered)}\n\`\`\``;
};

// ---------------------------------------------------------------------------
// Collection card (album-level) — the `nft-collection-card` fence
//
// Emitted by the mrc721 album tools (collection_create / collection_update
// receipts). A separate fence tag, not an nft-card format: the item-card
// identity rules (pinId / genesis triple) do not apply here, the heal
// pipeline stays item-only, and the pinned nft-card contracts are untouched.
// The collectionid (= the collection_desc pinId) is the only required
// identity; everything else degrades independently.
// ---------------------------------------------------------------------------

export const NFT_COLLECTION_CARD_FENCE_TAG = 'nft-collection-card';

export const isNftCollectionCardFenceLanguage = (language: string): boolean =>
  language.trim().toLowerCase() === NFT_COLLECTION_CARD_FENCE_TAG;

export interface NftCollectionPreviewItem {
  pinId: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  icon?: string;
  imgUrl?: string;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
}

export interface NftCollectionCardData {
  /** The collectionid (= the collection_desc pinId) — required identity. */
  collectionId: string;
  /** The path name under /nft/mrc721/. */
  collectionName?: string;
  name?: string;
  desc?: string;
  website?: string;
  /** metafile:// cover URI. */
  icon?: string;
  /** Direct https cover link if available. */
  imgUrl?: string;
  /** -1 = unlimited. */
  totalSupply?: number;
  minted?: number;
  royaltyRate?: number;
  issuer?: string;
  issuerLabel?: string;
  action?: string;
  /** C2 market summary optional fields. */
  caVerified?: boolean;
  listedCount?: number;
  holderCount?: number;
  floorPriceMeMilli?: number;
  floorPriceCnyCents?: number;
  medianPriceMeMilli?: number;
  tradeCount24h?: number;
  shopMetaAppPinId?: string;
  previewItems?: NftCollectionPreviewItem[];
}

/** totalSupply allows -1 (unlimited) — unlike the item serial. */
const cleanTotalSupply = (value: unknown): number | undefined => {
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < -1 || num > 1_000_000_000_000) return undefined;
  return num;
};

const cleanCollectionPreviews = (value: unknown): NftCollectionPreviewItem[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: NftCollectionPreviewItem[] = [];
  for (const raw of value.slice(0, 6)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    const pinId = cleanPinId(it.pinId);
    if (!pinId) continue;
    const tokenIndex =
      typeof it.tokenIndex === 'string' || typeof it.tokenIndex === 'number'
        ? cleanTextField(String(it.tokenIndex), 24)
        : undefined;
    const number = cleanSerial(it.number);
    const name = cleanTextField(it.name);
    const icon = cleanMetafileUri(it.icon);
    const imgUrl = cleanHttpsUrl(it.imgUrl);
    const priceMeMilli = cleanNonNegInt(it.priceMeMilli);
    const priceCnyCents = cleanNonNegInt(it.priceCnyCents);
    const priceSats = cleanPriceSats(it.priceSats);
    const sellerAddress = cleanAddress(it.sellerAddress);
    const sellerGlobalMetaId = cleanGlobalMetaId(it.sellerGlobalMetaId);
    const sellerName = cleanTextField(it.sellerName);
    out.push({
      pinId,
      ...(tokenIndex ? { tokenIndex } : {}),
      ...(number !== undefined ? { number } : {}),
      ...(name ? { name } : {}),
      ...(icon ? { icon } : {}),
      ...(imgUrl ? { imgUrl } : {}),
      ...(priceMeMilli !== undefined ? { priceMeMilli } : {}),
      ...(priceCnyCents !== undefined ? { priceCnyCents } : {}),
      ...(priceSats !== undefined ? { priceSats } : {}),
      ...(sellerAddress ? { sellerAddress } : {}),
      ...(sellerGlobalMetaId ? { sellerGlobalMetaId } : {}),
      ...(sellerName ? { sellerName } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
};

export const parseNftCollectionCardFence = (codeText: string): NftCollectionCardData | null => {
  const text = String(codeText ?? '').trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const collectionId = cleanPinId(row.collectionId);
  if (!collectionId) return null;

  const data: NftCollectionCardData = { collectionId };
  const collectionName = cleanTextField(row.collectionName);
  if (collectionName) data.collectionName = collectionName;
  const name = cleanTextField(row.name);
  if (name) data.name = name;
  const desc = cleanTextField(row.desc, 200);
  if (desc) data.desc = desc;
  const website = cleanTextField(row.website, 200);
  if (website) data.website = website;
  const icon = cleanMetafileUri(row.icon);
  if (icon) data.icon = icon;
  const imgUrl = cleanHttpsUrl(row.imgUrl);
  if (imgUrl) data.imgUrl = imgUrl;
  const totalSupply = cleanTotalSupply(row.totalSupply);
  if (totalSupply !== undefined) data.totalSupply = totalSupply;
  const minted = cleanSerial(row.minted);
  if (minted !== undefined) data.minted = minted;
  const royaltyRate = cleanSerial(row.royaltyRate);
  if (royaltyRate !== undefined) data.royaltyRate = royaltyRate;
  const issuer = cleanAddress(row.issuer);
  if (issuer) data.issuer = issuer;
  const issuerLabel = cleanTextField(row.issuerLabel);
  if (issuerLabel) data.issuerLabel = issuerLabel;
  const action = cleanTextField(row.action, MAX_ACTION_FIELD);
  if (action) data.action = action.toLowerCase();
  if (typeof row.caVerified === 'boolean') data.caVerified = row.caVerified;
  const listedCount = cleanSerial(row.listedCount);
  if (listedCount !== undefined) data.listedCount = listedCount;
  const holderCount = cleanSerial(row.holderCount);
  if (holderCount !== undefined) data.holderCount = holderCount;
  const floorPriceMeMilli = cleanNonNegInt(row.floorPriceMeMilli);
  if (floorPriceMeMilli !== undefined) data.floorPriceMeMilli = floorPriceMeMilli;
  const floorPriceCnyCents = cleanNonNegInt(row.floorPriceCnyCents);
  if (floorPriceCnyCents !== undefined) data.floorPriceCnyCents = floorPriceCnyCents;
  const medianPriceMeMilli = cleanNonNegInt(row.medianPriceMeMilli);
  if (medianPriceMeMilli !== undefined) data.medianPriceMeMilli = medianPriceMeMilli;
  const tradeCount24h = cleanSerial(row.tradeCount24h);
  if (tradeCount24h !== undefined) data.tradeCount24h = tradeCount24h;
  const shopMetaAppPinId = cleanPinId(row.shopMetaAppPinId);
  if (shopMetaAppPinId) data.shopMetaAppPinId = shopMetaAppPinId;
  const previewItems = cleanCollectionPreviews(row.previewItems);
  if (previewItems) data.previewItems = previewItems;
  return data;
};

const NFT_COLLECTION_CARD_KEY_ORDER: Array<keyof NftCollectionCardData> = [
  'collectionId', 'collectionName', 'name', 'desc', 'website', 'icon',
  'totalSupply', 'minted', 'royaltyRate', 'issuer', 'issuerLabel', 'action',
  'imgUrl', 'caVerified', 'listedCount', 'holderCount', 'floorPriceMeMilli',
  'floorPriceCnyCents', 'medianPriceMeMilli', 'tradeCount24h', 'shopMetaAppPinId', 'previewItems',
];

export const serializeNftCollectionCardFence = (data: NftCollectionCardData): string => {
  const ordered: Record<string, unknown> = {};
  for (const key of NFT_COLLECTION_CARD_KEY_ORDER) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== '') {
      ordered[key] = value;
    }
  }
  return `\`\`\`${NFT_COLLECTION_CARD_FENCE_TAG}\n${JSON.stringify(ordered)}\n\`\`\``;
};
