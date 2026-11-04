/**
 * Address → identity (name + avatar) resolution for chat NFT cards.
 *
 * The card shows holder and issuer as avatar + name instead of a bare
 * address. Resolution reuses the existing renderer service
 * (metabotInfoService, backed by the metaid:getUserInfo IPC, whose main-side
 * handler queries the same indexer info route omni_read user_info uses for
 * addresses). Results are cached per address for the process lifetime so a
 * conversation with many cards does not spam the indexer.
 *
 * Degradation contract: every failure path resolves to null — the card then
 * falls back to the emitter-provided label, then a short address. A card must
 * never blank or crash because identity resolution failed.
 */

import { useEffect, useState } from 'react';
import { fetchMetaidInfoByAddress, type MetaidInfoResult } from '../../services/metabotInfoService';

export type NftCardIdentity = Pick<MetaidInfoResult, 'name' | 'avatarUrl'>;

const identityCache = new Map<string, NonNullable<NftCardIdentity>>();
const inflight = new Map<string, Promise<NftCardIdentity | null>>();

/** Short address rendering fallback (1AxUdSkVd…dvcJx style). */
export const shortAddress = (address: string, head = 8, tail = 6): string =>
  address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;

/**
 * Resolve one MVC address to a display identity. Returns null when the bridge
 * is unavailable (SSR/tests), the lookup fails, or the indexer knows nothing —
 * callers degrade to label/short-address rendering.
 */
export const resolveNftCardIdentity = (address: string | undefined | null): Promise<NftCardIdentity | null> => {
  const key = (address || '').trim();
  if (!key) return Promise.resolve(null);
  const cached = identityCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<NftCardIdentity | null> => {
    try {
      const info = await fetchMetaidInfoByAddress(key);
      const identity: NftCardIdentity | null = info && (info.name || info.avatarUrl)
        ? { name: info.name || null, avatarUrl: info.avatarUrl || null }
        : null;
      // Cache only real hits: a transient indexer outage must not poison the
      // address for the rest of the process lifetime.
      if (identity) identityCache.set(key, identity);
      return identity;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
};

/**
 * React hook flavor: resolves on mount (and when the address changes),
 * starting from the synchronous cache so re-mounted cards paint instantly.
 * Safe under SSR (no window) — stays null.
 */
export const useNftCardIdentity = (address: string | undefined | null): NftCardIdentity | null => {
  const key = (address || '').trim();
  const [identity, setIdentity] = useState<NftCardIdentity | null>(() =>
    key ? identityCache.get(key) ?? null : null,
  );

  useEffect(() => {
    if (!key) {
      setIdentity(null);
      return undefined;
    }
    let alive = true;
    const cached = identityCache.get(key) ?? null;
    setIdentity(cached);
    void resolveNftCardIdentity(key).then((resolved) => {
      // resolved === null can mean "cached miss pending": only overwrite a
      // non-null cached value with a non-null fresh one.
      if (alive && resolved) setIdentity(resolved);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return identity;
};
