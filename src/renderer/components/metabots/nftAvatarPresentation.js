/**
 * Pure view-model helpers for MetaBot NFT avatars (plain JS, no React, so the
 * reference parsing and CA-badge decision stay unit testable — same pattern
 * as metabotNftPresentation.js).
 *
 * Reference format: `nft://mrc721/<itemPinId>` stored in the metabots.avatar
 * TEXT column. It is a local display-only decoration; the main process
 * resolves it (metaid:resolveAvatarSource) to the item's artwork plus the
 * collection facts needed for the IDBots-certified badge.
 */

const NFT_AVATAR_PATTERN = /^nft:\/\/mrc721\/([0-9a-f]{64}i\d+)$/i;

/** Parse an nft:// avatar reference; null for anything else. */
export function parseNftAvatarReference(avatar) {
  const normalized = typeof avatar === 'string' ? avatar.trim() : '';
  if (!normalized) return null;
  const match = normalized.match(NFT_AVATAR_PATTERN);
  if (!match || !match[1]) return null;
  return { itemPinId: match[1].toLowerCase() };
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
