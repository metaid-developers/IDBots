/**
 * Pure view-model helpers for the MetaBot NFT Wallet modal (N2).
 *
 * Plain JS (no React) so sorting, album grouping, CA badge resolution,
 * pagination, and artwork fallback chains are directly unit-testable.
 */

const METAID_ACCELERATE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
/** MVC/SPACE livenet addresses are base58 (start with 1, 20+ chars). */
export const MVC_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{20,}$/;

const splitMetafileExtension = (value) => {
  const lastDotIndex = value.lastIndexOf('.');
  if (lastDotIndex > 0 && lastDotIndex < value.length - 1) {
    return value.slice(0, lastDotIndex);
  }
  return value;
};

/**
 * metafile://<pinId>(.ext)? (or a bare pin id) → ordered renderable URLs.
 * Returns [] for non-references. https URLs are handled by the caller.
 */
export function metafileToSourceUrls(reference) {
  const normalized = String(reference || '').trim();
  if (!normalized) return [];
  const withoutScheme = normalized.toLowerCase().startsWith('metafile://')
    ? normalized.slice('metafile://'.length).trim()
    : normalized;
  const basePart = (withoutScheme.split(/[?#]/)[0] || '').trim();
  if (!basePart || basePart.includes('/') || basePart.includes('\\')) return [];
  const pinId = splitMetafileExtension(basePart);
  if (!pinId) return [];
  const encoded = encodeURIComponent(pinId);
  return [
    `${METAID_ACCELERATE_CONTENT_BASE}/${encoded}`,
    `${METAID_CONTENT_BASE}/${encoded}`,
  ];
}

/**
 * Ordered <img> candidate sources for a normalized NFT list item:
 * imageUrl (https direct) → imageRef metafile routes.
 */
export function buildNftArtworkSources(item) {
  const sources = [];
  const pushUnique = (value) => {
    if (value && !sources.includes(value)) sources.push(value);
  };
  if (item?.imageUrl && /^https?:\/\//i.test(item.imageUrl)) pushUnique(item.imageUrl);
  for (const source of metafileToSourceUrls(item?.imageRef)) pushUnique(source);
  return sources;
}

const artworkInitials = (item) => {
  const base = item?.name?.trim() || item?.collectionName?.trim() || 'NFT';
  return base.slice(0, 2).toUpperCase();
};

/** Tile view model: title, subtitle, badge and artwork candidates. */
export function buildNftTileViewModel(item) {
  const kind = item?.kind === 'metacontract' ? 'metacontract' : 'mrc721';
  const badge = kind === 'metacontract'
    ? (item?.tokenIndex != null && item?.tokenIndex !== '' ? `#${item.tokenIndex}` : '')
    : (item?.number != null && item.number >= 0 ? `#${item.number}` : '');
  return {
    key: String(item?.key || ''),
    kind,
    title: item?.name?.trim() || (badge || 'NFT'),
    subtitle: item?.collectionName?.trim() || '',
    badge,
    artworkSources: buildNftArtworkSources(item),
    artworkInitials: artworkInitials(item),
  };
}

/**
 * Check whether an NFT item belongs to an official CA-certified collection or
 * certified legacy MetaContract series. Returns false whenever the registry is
 * unverified or absent.
 */
export function isNftItemCertified(registry, item) {
  if (!registry || registry.verified !== true) return false;
  const collections = Array.isArray(registry.collections) ? registry.collections : [];

  if (item?.kind === 'metacontract') {
    const genesis = String(item?.raw?.genesis || '').trim().toLowerCase();
    const codeHash = String(item?.raw?.codeHash || '').trim().toLowerCase();
    if (!genesis) return false;

    const inCollections = collections.some((entry) => {
      const legacyGenesis = String(entry?.legacySeries?.genesis || '').trim().toLowerCase();
      if (!legacyGenesis || legacyGenesis !== genesis) return false;
      const legacyCodehash = String(entry?.legacySeries?.codehash || '').trim().toLowerCase();
      return !legacyCodehash || !codeHash || legacyCodehash === codeHash;
    });
    if (inCollections) return true;

    const officialBots = Array.isArray(registry.officialBots) ? registry.officialBots : [];
    return officialBots.some((bot) => {
      if (bot?.active === false) return false;
      const supported = Array.isArray(bot?.swapConfig?.supportedSeries) ? bot.swapConfig.supportedSeries : [];
      return supported.some((series) => {
        const sGenesis = String(series?.genesis || '').trim().toLowerCase();
        if (!sGenesis || sGenesis !== genesis) return false;
        const sCodehash = String(series?.codehash || '').trim().toLowerCase();
        return !sCodehash || !codeHash || sCodehash === codeHash;
      });
    });
  }

  const collectionPinId = String(item?.raw?.collectionPinId || '').trim().toLowerCase();
  if (!collectionPinId) return false;
  return collections.some(
    (entry) => String(entry?.collectionPinId || '').trim().toLowerCase() === collectionPinId,
  );
}

/**
 * Build identity-bound `nft://mrc721/<pinId>?owner=...&metaid=...` URI.
 */
export function buildNftAvatarUri({ itemPinId, ownerAddress, ownerGlobalMetaId }) {
  const pinId = String(itemPinId || '').trim();
  const owner = String(ownerAddress || '').trim();
  if (!pinId || !owner) return '';
  const params = new URLSearchParams({ owner });
  const metaid = String(ownerGlobalMetaId || '').trim();
  if (metaid) params.set('metaid', metaid);
  return `nft://mrc721/${pinId}?${params.toString()}`;
}

/**
 * Group normalized NFT items into 2-level Album shelf descriptors, preserving
 * acquisition order (first seen album appears first).
 */
export function buildNftAlbumGroups(items, registry = null) {
  const list = Array.isArray(items) ? items : [];
  const map = new Map();

  for (const item of list) {
    if (!item) continue;
    const kind = item.kind === 'metacontract' ? 'metacontract' : 'mrc721';
    const raw = item.raw || {};
    const rawGroupId = kind === 'metacontract'
      ? String(raw.genesis || item.collectionName || 'ungrouped').trim()
      : String(raw.collectionPinId || item.collectionName || 'ungrouped').trim();
    const groupKey = `${kind}:${rawGroupId.toLowerCase()}`;

    let group = map.get(groupKey);
    if (!group) {
      const fallbackTitle = kind === 'metacontract' ? 'MetaContract Series' : 'MRC-721 Collection';
      const title = String(
        item.collectionName || raw.seriesName || raw.collectionName || fallbackTitle,
      ).trim() || fallbackTitle;

      group = {
        key: groupKey,
        kind,
        title,
        collectionPinId: String(raw.collectionPinId || '').trim(),
        genesis: String(raw.genesis || '').trim(),
        codeHash: String(raw.codeHash || '').trim(),
        tokenSupply: raw.tokenSupply != null && Number(raw.tokenSupply) > 0 ? Number(raw.tokenSupply) : null,
        certified: false,
        count: 0,
        coverSources: [],
        coverInitials: title.slice(0, 2).toUpperCase(),
        items: [],
      };
      map.set(groupKey, group);
    }

    group.items.push(item);
    group.count = group.items.length;
    if (!group.certified && isNftItemCertified(registry, item)) {
      group.certified = true;
    }
    if (group.coverSources.length === 0) {
      const candidateSources = buildNftArtworkSources(item);
      if (candidateSources.length > 0) {
        group.coverSources = candidateSources;
      }
    }
  }

  return Array.from(map.values());
}

function resolveSerialSortNumber(item) {
  if (item?.kind === 'metacontract') {
    const parsed = Number(item?.tokenIndex);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
  }
  const num = Number(item?.number);
  return Number.isFinite(num) && num >= 0 ? num : Number.MAX_SAFE_INTEGER;
}

/**
 * Filter and sort NFT items by search query, CA-verified toggle, and sort key.
 * sortBy: 'recent' | 'serial' | 'name'
 */
export function filterAndSortNftItems(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const query = String(options.query || '').trim().toLowerCase();
  const verifiedOnly = options.verifiedOnly === true;
  const sortBy = options.sortBy || 'recent';
  const registry = options.registry ?? null;

  const filtered = list.filter((item) => {
    if (!item) return false;
    if (verifiedOnly && !isNftItemCertified(registry, item)) return false;
    if (!query) return true;

    const serialText = item.kind === 'metacontract'
      ? (item.tokenIndex != null ? `#${item.tokenIndex} ${item.tokenIndex}` : '')
      : (item.number != null && item.number >= 0 ? `#${item.number} ${item.number}` : '');

    const haystack = [
      item.name,
      item.collectionName,
      serialText,
      item.key,
      item.raw?.collectionPinId,
      item.raw?.genesis,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });

  if (sortBy === 'serial') {
    return [...filtered].sort((a, b) => {
      const diff = resolveSerialSortNumber(a) - resolveSerialSortNumber(b);
      if (diff !== 0) return diff;
      return String(a.key || '').localeCompare(String(b.key || ''));
    });
  }

  if (sortBy === 'name') {
    return [...filtered].sort((a, b) => {
      const nameA = String(a.name || a.collectionName || a.key || '').trim();
      const nameB = String(b.name || b.collectionName || b.key || '').trim();
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  return [...filtered];
}

/**
 * Deterministic pagination slice helper. Clamps out-of-range page numbers so
 * filter changes or transfers never leave the user on an empty page > 1.
 */
export function paginateNftItems(items, page = 1, pageSize = 12) {
  const list = Array.isArray(items) ? items : [];
  const safeSize = Math.max(1, Math.floor(Number(pageSize) || 12));
  const totalItems = list.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safeSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.floor(Number(page) || 1)));
  const startIndex = totalItems === 0 ? 0 : (safePage - 1) * safeSize;
  const endIndex = Math.min(totalItems, startIndex + safeSize);

  return {
    items: list.slice(startIndex, endIndex),
    page: safePage,
    pageSize: safeSize,
    totalItems,
    totalPages,
    startIndex,
    endIndex,
  };
}

/**
 * Compact page-button token generator with ellipsis for large collections
 * (e.g. 500+ items -> 42 pages).
 */
export function buildPaginationTokens(currentPage, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const current = Math.min(total, Math.max(1, Math.floor(Number(currentPage) || 1)));

  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx + 1);
  }

  const tokens = [1];
  const windowStart = Math.max(2, current - 1);
  const windowEnd = Math.min(total - 1, current + 1);

  if (windowStart > 2) tokens.push('ellipsis-start');
  for (let p = windowStart; p <= windowEnd; p += 1) {
    tokens.push(p);
  }
  if (windowEnd < total - 1) tokens.push('ellipsis-end');
  tokens.push(total);
  return tokens;
}

const pad2 = (value) => String(value).padStart(2, '0');

/** unix seconds → "YYYY/MM/DD HH:mm" (local time); null for falsy input. */
export function formatNftTime(unixSeconds) {
  const seconds = Number(unixSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const MONO_COPY_FIELDS = new Set([
  'metabotNftFieldItemId',
  'metabotNftFieldGenesisTx',
  'metabotNftFieldGenesis',
  'metabotNftFieldCodeHash',
  'metabotNftFieldTxId',
  'metabotNftFieldMetaTxId',
  'metabotNftFieldOwner',
]);

/**
 * Detail field rows for one NFT (kind-aware). labelKeys map onto i18n; the
 * modal renders value strings verbatim (mono + copy row types for long ids).
 */
export function buildNftDetailRows(item) {
  const rows = [];
  const push = (labelKey, value, mono = false) => {
    const text = value == null ? '' : String(value).trim();
    if (!text) return;
    rows.push({ labelKey, value: text, mono: mono || MONO_COPY_FIELDS.has(labelKey) });
  };

  if (item?.kind === 'metacontract') {
    const raw = item.raw || {};
    push('metabotNftFieldSeries', item.collectionName);
    push('metabotNftFieldTokenIndex', item.tokenIndex != null && item.tokenIndex !== '' ? `#${item.tokenIndex}` : '');
    push('metabotNftFieldNetwork', 'MVC');
    push('metabotNftFieldHeight', item.height != null && item.height > 0 ? item.height : '');
    push('metabotNftFieldSatoshi', raw.satoshi != null ? `${raw.satoshi} sats` : '');
    push('metabotNftFieldGenesis', raw.genesis);
    push('metabotNftFieldCodeHash', raw.codeHash);
    push('metabotNftFieldTxId', raw.txId);
    push('metabotNftFieldMetaTxId', raw.metaTxId);
    return rows;
  }

  const raw = item.raw || {};
  push('metabotNftFieldCollection', item.collectionName);
  push('metabotNftFieldTokenIndex', item.number != null && item.number >= 0 ? `#${item.number}` : '');
  push('metabotNftFieldNetwork', raw.genesisChainName ? String(raw.genesisChainName).toUpperCase() : 'MVC');
  push('metabotNftFieldDesc', raw.desc);
  push('metabotNftFieldOwner', raw.ownerAddress);
  push('metabotNftFieldItemId', item.key);
  push('metabotNftFieldMintTime', formatNftTime(item.createTime ?? raw.createTime));
  push('metabotNftFieldGenesisTx', raw.genesisTx);
  push('metabotNftFieldContentType', raw.contentType);
  push('metabotNftFieldContentSummary', raw.contentSummary);
  push('metabotNftFieldOutputValue', raw.outputValue != null && raw.outputValue > 0 ? `${raw.outputValue} sats` : '');
  push('metabotNftFieldTransferCount', raw.transferCount != null && raw.transferCount > 0 ? raw.transferCount : '');
  return rows;
}

/** Transfer draft validation — mirrors mrc721Service.isMvcAddress. */
export function validateNftTransferDraft({ toAddress }) {
  const to = String(toAddress || '').trim();
  if (!to) return { valid: false, errorKey: 'transferReceiverRequired' };
  if (!MVC_ADDRESS_PATTERN.test(to)) return { valid: false, errorKey: 'metabotNftTransferInvalidAddress' };
  return { valid: true };
}

/**
 * MRC-721 atomic-swap sell floor (mirror of
 * src/main/libs/mrc721AtomicSwapTx.ts MRC721_MIN_SELL_PRICE_SATS).
 */
export const MRC721_MIN_SELL_PRICE_SATS = 22000;

/**
 * Sell-listing draft validation: whole-sat price at or above the protocol
 * floor, buyer must be a base58 MVC address.
 */
export function validateMrc721SellDraft({ priceSats, buyerAddress }) {
  const price = Number(priceSats);
  if (priceSats === '' || priceSats == null || !Number.isInteger(price)) {
    return { valid: false, errorKey: 'metabotNftSellPriceRequired' };
  }
  if (price < MRC721_MIN_SELL_PRICE_SATS) {
    return { valid: false, errorKey: 'metabotNftSellPriceBelowFloor' };
  }
  const buyerValidation = validateNftTransferDraft({ toAddress: buyerAddress });
  if (!buyerValidation.valid) return buyerValidation;
  return { valid: true };
}

/** Sell-order status → i18n key for the "My Listings" badges. */
export function mrc721SellOrderStatusKey(status) {
  if (status === 'valid') return 'metabotNftListingStatusValid';
  if (status === 'expired') return 'metabotNftListingStatusExpired';
  return 'metabotNftListingStatusInvalid';
}

/** Build the transfer IPC payload for one NFT + draft. */
export function buildNftTransferPayload({ metabotId, item, toAddress, feeRate }) {
  const to = String(toAddress || '').trim();
  if (item?.kind === 'metacontract') {
    const raw = item.raw || {};
    return {
      metabotId,
      genesis: String(raw.genesis || ''),
      codehash: String(raw.codeHash || ''),
      tokenIndex: String(item.tokenIndex ?? raw.tokenIndex ?? ''),
      toAddress: to,
      feeRate,
    };
  }
  return { metabotId, pinId: String(item?.key || ''), toAddress: to, feeRate };
}
