/**
 * nft-card fence syntax — the chat NFT card contract shared by every markdown
 * surface (CoWork conversation, A2A private chat, group/group-task transcript).
 *
 * A bot embeds a card as a fenced code block whose fence tag is `nft-card`
 * (`nft` / `nftcard` are accepted aliases) and whose body is one JSON object:
 *
 * ```nft-card
 * {"genesis":"…40hex…","codehash":"…40hex…","tokenIndex":"5028","name":"小明",
 *  "series":"Metabot Gen 2","imgUrl":"https://…","icon":"metafile://…",
 *  "owner":"1Grq…","ownerLabel":"AI_Sunny","priceSats":100000,"action":"listed"}
 * ```
 *
 * Old clients without the card renderer degrade to the plain code block they
 * already ship, so the payload stays readable everywhere. The identity fields
 * (genesis/codehash/tokenIndex) are required — they are the minimum a card
 * must show; everything else is display enrichment the emitter already holds
 * (the wallet tools embed it automatically at action time).
 *
 * This module is DOM-free so server-rendered renderer tests drive it directly.
 */

/** Fence tags that switch a code block into NFT card rendering. */
export const NFT_CARD_FENCE_TAG = 'nft-card';
const NFT_CARD_FENCE_TAGS = new Set(['nft-card', 'nftcard', 'nft']);

// MetaContract genesis ids on MVC are 40 hex (live wire shape, mainnet
// 2026-11-02: 2b5f8a84…); 64 hex is also accepted so future/longer id
// shapes never break parsing.
const GENESIS_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const CODEHASH_RE = /^[0-9a-fA-F]{40}$/;
const TOKEN_INDEX_RE = /^\d{1,10}$/;
/** Base58-ish MVC address shape (covers mainnet P2PKH prefixes we see live). */
const MVC_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{20,60}$/;

/** Upper bounds keep a malformed/hostile payload from blowing up the bubble. */
const MAX_TEXT_FIELD = 64;
const MAX_ACTION_FIELD = 16;

export interface NftCardData {
  genesis: string;
  codehash: string;
  tokenIndex: string;
  name?: string;
  series?: string;
  /** https direct artwork link (wallet-api v4 utxo-list `imgUrl`). */
  imgUrl?: string;
  /** metafile:// fallback artwork (v4 `icon`). */
  icon?: string;
  /** MVC address holding the token at broadcast time. */
  owner?: string;
  /** Display name for the owner (bot/human), shown beside the address. */
  ownerLabel?: string;
  /** Ask/deal price in sats at broadcast time. */
  priceSats?: number;
  /** listed | transferred | sold | escrow | delisted | info … */
  action?: string;
}

export const isNftCardFenceLanguage = (language: string): boolean =>
  NFT_CARD_FENCE_TAGS.has(language.trim().toLowerCase());

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

const cleanMetafileUri = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('metafile://')) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  return trimmed.slice(0, 512);
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

/**
 * Parse the body of an nft-card fence. Returns null when the payload is not a
 * JSON object carrying a valid (genesis, codehash, tokenIndex) identity — the
 * caller then falls back to the plain code-block rendering, exactly like any
 * unparsable fence.
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

  const genesis = typeof row.genesis === 'string' ? row.genesis.trim().toLowerCase() : '';
  const codehash = typeof row.codehash === 'string' ? row.codehash.trim().toLowerCase() : '';
  const tokenIndex = typeof row.tokenIndex === 'string' || typeof row.tokenIndex === 'number'
    ? String(row.tokenIndex).trim()
    : '';
  if (!GENESIS_RE.test(genesis) || !CODEHASH_RE.test(codehash) || !TOKEN_INDEX_RE.test(tokenIndex)) {
    return null;
  }

  const data: NftCardData = {
    genesis,
    codehash,
    tokenIndex: tokenIndex.replace(/^0+(?=\d)/, ''),
  };
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
  const priceSats = cleanPriceSats(row.priceSats);
  if (priceSats !== undefined) data.priceSats = priceSats;
  const action = cleanTextField(row.action, MAX_ACTION_FIELD);
  if (action) data.action = action.toLowerCase();
  return data;
};

const NFT_CARD_KEY_ORDER: Array<keyof NftCardData> = [
  'genesis', 'codehash', 'tokenIndex', 'name', 'series', 'imgUrl', 'icon',
  'owner', 'ownerLabel', 'priceSats', 'action',
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
