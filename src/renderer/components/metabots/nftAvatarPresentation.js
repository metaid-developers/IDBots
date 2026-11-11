/**
 * Pure view-model helpers for MetaBot NFT avatars (plain JS, no React, so the
 * reference parsing and CA-badge decision stay unit testable — same pattern
 * as metabotNftPresentation.js).
 *
 * Identity-bound `nft://mrc721/<itemPinId>?owner=…&metaid=…` references
 * resolve to cover art, live ownership facts, and the collection facts needed
 * for the optional IDBots-certified frame.
 */

const NFT_AVATAR_PATTERN = /^nft:\/\/mrc721\/([0-9a-f]{64}i\d+)(?:\?([^#]*))?$/i;

/** Parse an identity-bound nft:// avatar reference; null for anything else. */
export function parseNftAvatarReference(avatar) {
  const normalized = typeof avatar === 'string' ? avatar.trim() : '';
  if (!normalized) return null;
  const match = normalized.match(NFT_AVATAR_PATTERN);
  if (!match || !match[1]) return null;
  const params = new URLSearchParams(match[2] || '');
  const ownerAddress = (params.get('owner') || '').trim();
  const globalMetaId = (params.get('metaid') || '').trim();
  return {
    itemPinId: match[1].toLowerCase(),
    ...(ownerAddress ? { ownerAddress } : {}),
    ...(globalMetaId ? { globalMetaId } : {}),
  };
}

/**
 * True when the collection is certified: the registry must be verified
 * (its CA pin creator matched the official MetaID) AND list the collection.
 * Uncertified NFTs and unverified registries never show a badge.
 */
export function isCollectionCertified(registry, collectionPinId) {
  const pinId = String(collectionPinId || '').trim().toLowerCase();
  if (!pinId) return false;
  if (!registry || registry.verified !== true) return false;
  const collections = Array.isArray(registry.collections) ? registry.collections : [];
  return collections.some((entry) => String(entry?.collectionPinId || '').trim().toLowerCase() === pinId);
}


export function resolveNftAvatarBadgeKind({ src, ownershipVerified, certified }) {
  if (!src) return 'fallback';
  if (!ownershipVerified) return 'plain';
  return certified ? 'certified' : 'nft';
}
