// Stale-while-revalidate cache for the first page of MetaApp lists. Entries are
// written to localStorage so a reopened MetaApps page can render the previous
// root page instantly while a fresh fetch runs in the background. No TTL: the
// cached page is only a render seed and every read is always revalidated.

const CACHE_VERSION = 1;
const COMMUNITY_ROOT_KEY = 'idbots.metaapps.community.root.v1';
const OWNER_ROOT_KEY_PREFIX = 'idbots.metaapps.owner.';

export const communityRootCacheKey = () => COMMUNITY_ROOT_KEY;
export const ownerRootCacheKey = (metabotId) => `${OWNER_ROOT_KEY_PREFIX}${metabotId}.root.v1`;

export const readCachedListPage = (key, storage = globalThis.localStorage) => {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== CACHE_VERSION || parsed.data == null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const writeCachedListPage = (key, data, storage = globalThis.localStorage) => {
  try {
    storage?.setItem(key, JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), data }));
  } catch {
    // Quota/serialization failures must never break list loading.
  }
};
