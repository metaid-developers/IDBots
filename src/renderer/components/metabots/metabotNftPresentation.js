/**
 * Pure view-model helpers for the MetaBot NFT Wallet modal.
 *
 * Plain JS (no React) so the sorting/flattening/artwork-chain logic is unit
 * testable, mirroring metabotWalletPresentation.js. Artwork resolution uses
 * the same ordered content routes as the chat NftCard: https direct link
 * first, then the metafile accelerate endpoint, then the plain indexer
 * content endpoint — the <img> walks the candidates on error.
 */

// Same bases as A2AMessageItem's parseMetafileUri / pinAssetService (kept as
// local constants so this module stays dependency-free).
const METAID_ACCELERATE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const PIN_ID_PATTERN = /^[0-9a-fA-F]{64}i\d+$/;
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
 * imageUrl (https direct) → imageRef metafile routes. Empty when the item
 * carries no artwork reference at all (placeholder case).
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

/**
 * Artwork reference a "use this NFT as the bot avatar" call should hand to the
 * main process for one list item (`metabot:setNftAvatar` → avatarNormalize):
 * - mrc721: the cover metafile reference (`metafile://<pinId>` or bare pinId),
 *   which the normalizer resolves THUMBNAIL-FIRST under the 200 KB avatar cap;
 * - metacontract: the https artwork link (`imgUrl`) when present, otherwise
 *   the icon reference — same precedence the tile artwork uses.
 * Returns '' when the item carries no usable artwork reference at all; the
 * caller must not call the mechanism with an empty reference.
 */
export function buildNftAvatarImageRef(item) {
  const imageRef = String(item?.imageRef || '').trim();
  const imageUrl = String(item?.imageUrl || '').trim();
  if (item?.kind === 'metacontract') {
    if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
    return imageRef || imageUrl;
  }
  if (imageRef) return imageRef;
  return /^https?:\/\//i.test(imageUrl) ? imageUrl : '';
}

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
 * floor, buyer must be a base58 MVC address. Same shape as
 * validateNftTransferDraft ({ valid, errorKey }) for the modal's
 * validate-then-confirm convention; errorKeys map onto i18n.
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
