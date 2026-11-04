/**
 * Renderer-side reader for the IDBots NFT CA registry (idbots:getNftCaRegistry).
 *
 * The main process owns the trust logic and a 10-minute TTL cache; this thin
 * wrapper adds a short renderer-side cache so a list of NFT-framed avatars
 * does not fire one IPC per component mount. Every failure path degrades to
 * an empty unverified registry — certification marks simply disappear, never
 * a broken render.
 */

import { isCollectionCertified } from '../components/metabots/nftAvatarPresentation';

/** Mirrors the ElectronNftCaRegistry shape declared in types/electron.d.ts. */
export interface NftCaRegistry {
  protocol: 'idbots-nft-ca';
  version: number;
  verified: boolean;
  status: 'empty-no-pin-configured' | 'unavailable' | 'verified' | 'unverified';
  detail?: string;
  pinId: string | null;
  creatorMetaId: string | null;
  officialMetaId: string;
  collections: Array<{
    collectionPinId: string;
    collectionName?: string;
    note?: string;
    certifiedAt?: number;
  }>;
  fetchedAt: number;
}

export const EMPTY_NFT_CA_REGISTRY: NftCaRegistry = {
  protocol: 'idbots-nft-ca',
  version: 1,
  verified: false,
  status: 'unavailable',
  pinId: null,
  creatorMetaId: null,
  officialMetaId: '',
  collections: [],
  fetchedAt: 0,
};

const RENDERER_CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { registry: NftCaRegistry; at: number } | null = null;
let pending: Promise<NftCaRegistry> | null = null;

export function clearNftCaRegistryRendererCache(): void {
  cache = null;
  pending = null;
}

/**
 * Fetch the CA registry (cached). Never rejects: transport/IPC failures
 * degrade to the empty unverified registry.
 */
export async function getNftCaRegistryCached(options?: { refresh?: boolean }): Promise<NftCaRegistry> {
  if (options?.refresh === true) {
    clearNftCaRegistryRendererCache();
  }
  if (cache && Date.now() - cache.at < RENDERER_CACHE_TTL_MS) {
    return cache.registry;
  }
  if (!pending) {
    pending = (async () => {
      try {
        const response = await window.electron.idbots.getNftCaRegistry({});
        const registry = response?.success && response.registry ? response.registry : EMPTY_NFT_CA_REGISTRY;
        cache = { registry, at: Date.now() };
        return registry;
      } catch {
        return EMPTY_NFT_CA_REGISTRY;
      } finally {
        pending = null;
      }
    })();
  }
  return pending;
}

export { isCollectionCertified };
