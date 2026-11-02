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
  /** listed | transferred | sold | bought | escrow | delisted | minted | info … */
  action?: string;
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
  const action = cleanTextField(row.action, MAX_ACTION_FIELD);
  if (action) data.action = action.toLowerCase();
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
  'priceSats', 'action',
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
