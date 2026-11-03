import { fetchMrc721ItemInfo } from './mrc721Service';
import { resolvePinAssetSource } from './pinAssetService';

/**
 * MetaBot NFT avatar reference resolution.
 *
 * Reference format (stored in the metabots.avatar TEXT column, no schema
 * change): `nft://mrc721/<itemPinId>` where itemPinId is the MRC-721 item
 * pin (`<64hex>i<n>`) as listed by `idbots:getMetabotNfts` (kind 'mrc721').
 * The reference is a local display-only decoration — the /info/avatar chain
 * protocol pins image bytes, so NFT references are never published on-chain
 * (see buildEditAvatarSyncStep in metaidCore.ts).
 *
 * Resolution (wired into the `metaid:resolveAvatarSource` IPC): item info is
 * read through the standard mrc721 remote-first indexer route for the cover,
 * and the cover reference is then turned into a data URL through the same
 * pin-asset chain every other avatar uses (local-first content routes).
 * Unresolvable → null avatarUrl → the renderer falls back to its existing
 * placeholder. Facts (collectionPinId/collectionName) ride along so the
 * renderer can match the item's collection against the IDBots NFT CA
 * registry for the certified badge.
 *
 * Every path is fail-soft: this module never throws.
 */

/** `nft://mrc721/<itemPinId>` — the only supported NFT avatar reference form. */
const NFT_AVATAR_PATTERN = /^nft:\/\/mrc721\/([0-9a-f]{64}i\d+)$/i;

export function parseNftAvatarReference(reference: string | null | undefined): { itemPinId: string } | null {
  const normalized = typeof reference === 'string' ? reference.trim() : '';
  if (!normalized) {
    return null;
  }
  const match = normalized.match(NFT_AVATAR_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  return { itemPinId: match[1].toLowerCase() };
}

export interface NftAvatarFacts {
  itemPinId: string;
  collectionPinId?: string;
  collectionName?: string;
}

export interface NftAvatarResolution {
  /** Renderable artwork source (data URL), or null when unresolvable. */
  avatarUrl: string | null;
  nft: NftAvatarFacts;
}

interface NftItemFacts {
  cover?: string;
  collectionPinId?: string;
  collectionName?: string;
}

/**
 * Process-lifetime cache of item facts per itemPinId. Artwork bytes ride the
 * separate resolvePinAssetSource promise cache (keyed by the cover
 * reference). Failed lookups are not cached so a transient indexer outage
 * can heal on the next render.
 */
const nftItemFactsCache = new Map<string, NftItemFacts | null>();

export function clearNftAvatarItemFactsCache(): void {
  nftItemFactsCache.clear();
}

async function getNftItemFacts(itemPinId: string): Promise<NftItemFacts | null> {
  const cached = nftItemFactsCache.get(itemPinId);
  if (cached !== undefined) {
    return cached;
  }
  let facts: NftItemFacts | null = null;
  try {
    const item = await fetchMrc721ItemInfo({ pinId: itemPinId });
    const cover = item?.cover?.trim();
    const collectionPinId = item?.collectionPinId?.trim();
    const collectionName = item?.collectionName?.trim();
    if (item) {
      facts = {
        ...(cover ? { cover } : {}),
        ...(collectionPinId ? { collectionPinId } : {}),
        ...(collectionName ? { collectionName } : {}),
      };
    }
  } catch {
    facts = null; // transient — leave uncached so the next render retries
  }
  if (facts) {
    nftItemFactsCache.set(itemPinId, facts);
  }
  return facts;
}

/**
 * Resolve an already-parsed nft://mrc721/<itemPinId> reference. Never
 * throws; a missing item, missing cover, or failed artwork fetch yields
 * avatarUrl:null with whatever facts the item info carried.
 */
export async function resolveNftAvatar(parsed: { itemPinId: string }): Promise<NftAvatarResolution> {
  const nft: NftAvatarFacts = { itemPinId: parsed.itemPinId };
  try {
    const facts = await getNftItemFacts(parsed.itemPinId);
    if (facts?.collectionPinId) nft.collectionPinId = facts.collectionPinId;
    if (facts?.collectionName) nft.collectionName = facts.collectionName;
    if (!facts?.cover) {
      return { avatarUrl: null, nft };
    }
    const avatarUrl = await resolvePinAssetSource(facts.cover);
    return { avatarUrl: avatarUrl ?? null, nft };
  } catch {
    return { avatarUrl: null, nft };
  }
}
