/**
 * Renderer-side heal for chat NFT cards — the fallback lookup channel.
 *
 * The fence payload is the primary data source; when it carries no artwork
 * (no imgUrl AND no icon) or — metacontract only — no issuer while the v4
 * wire cannot provide one at emission time, the card asks the main-process
 * heal service (idbots:healNftCard IPC) by identity key:
 *   metacontract → genesis+tokenIndex (+owner to scope the utxo-list),
 *   mrc721       → pinId.
 *
 * Contract (S3 acceptance):
 *   - never blocks first paint: the card renders its placeholder/short
 *     address immediately; healed fields arrive when they arrive,
 *   - process-level cache + inflight dedup, so a transcript full of the
 *     same card fires one lookup per identity,
 *   - silent degradation: no bridge (SSR/tests), IPC failure, or empty
 *     result all resolve null and the card keeps its fallback rendering,
 *   - only fires when something is actually missing — a fence that carries
 *     artwork AND (an issuer or a non-metacontract format) never requests.
 *
 * The healed `imgUrl` is an https direct link from wallet-api and enters
 * the card verbatim; `icon` follows the metafile:// contract; `issuer` is
 * an MVC address string.
 */

import { useEffect, useState } from 'react';
import type { NftCardData } from './nftCardSyntax';

export interface NftCardHealFields {
  imgUrl?: string;
  icon?: string;
  issuer?: string;
}

const healCache = new Map<string, NftCardHealFields>();
const inflight = new Map<string, Promise<NftCardHealFields | null>>();

/** Stable identity key for one card (the fence identity, minus codehash: genesis implies series). */
export const nftCardHealKey = (data: NftCardData): string | null => {
  if (data.format === 'mrc721') {
    return data.pinId ? `mrc721:${data.pinId}` : null;
  }
  if (data.genesis && data.tokenIndex) {
    return `metacontract:${data.genesis}:${data.tokenIndex}`;
  }
  return null;
};

/**
 * Whether this card is missing anything the heal channel can supply:
 * artwork entirely absent, or a metacontract card with no issuer while the
 * fence carries the owner address the lookup is scoped by.
 */
export const nftCardNeedsHeal = (data: NftCardData): boolean => {
  const artworkMissing = !data.imgUrl && !data.icon;
  const issuerMissing =
    data.format === 'metacontract' && !data.issuer && !data.issuerLabel && !!data.owner;
  return artworkMissing || issuerMissing;
};

const sanitizeHealedImgUrl = (value: unknown): string | undefined => {
  const url = String(value ?? '').trim();
  if (!url || !/^https:\/\//i.test(url) || /\s/.test(url)) return undefined;
  return url.slice(0, 512);
};

const sanitizeHealedIcon = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  if (!text || !/^metafile:\/\//i.test(text) || /\s/.test(text)) return undefined;
  return text.slice(0, 512);
};

const sanitizeHealedIssuer = (value: unknown): string | undefined => {
  const address = String(value ?? '').trim();
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(address)) return undefined;
  return address;
};

/**
 * Best-effort heal lookup for one card identity. Null when there is nothing
 * to look up, no bridge (SSR/tests), the call fails, or nothing came back —
 * callers keep their fallback rendering either way.
 */
export const resolveNftCardHeal = (data: NftCardData): Promise<NftCardHealFields | null> => {
  const key = nftCardHealKey(data);
  if (!key) return Promise.resolve(null);
  const cached = healCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<NftCardHealFields | null> => {
    try {
      const bridge = typeof window !== 'undefined' ? window.electron?.idbots?.healNftCard : undefined;
      if (typeof bridge !== 'function') return null;
      const response = await bridge({
        format: data.format,
        genesis: data.genesis,
        tokenIndex: data.tokenIndex,
        pinId: data.pinId,
        owner: data.owner,
      });
      if (!response?.success) return null;
      const raw = response.result ?? {};
      // Cache only real hits: a transient indexer outage must not poison the
      // identity for the rest of the process lifetime.
      const healed: NftCardHealFields = {};
      const imgUrl = sanitizeHealedImgUrl(raw.imgUrl);
      if (imgUrl) healed.imgUrl = imgUrl;
      const icon = sanitizeHealedIcon(raw.icon);
      if (icon) healed.icon = icon;
      const issuer = sanitizeHealedIssuer(raw.issuer);
      if (issuer) healed.issuer = issuer;
      if (imgUrl || icon || issuer) healCache.set(key, healed);
      return imgUrl || icon || issuer ? healed : null;
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
 * React hook flavor: returns `data` augmented with healed fields once they
 * resolve. Renders with the original data first (placeholder / short
 * address), fires the lookup only when the card needs it, and re-reads the
 * synchronous cache on mount so re-mounted cards paint instantly. Safe
 * under SSR (no window) — returns the input unchanged.
 */
export const useNftCardHeal = (data: NftCardData): NftCardData => {
  const key = nftCardHealKey(data);
  const needsHeal = nftCardNeedsHeal(data);
  const [healed, setHealed] = useState<NftCardHealFields | null>(() =>
    key && needsHeal ? healCache.get(key) ?? null : null,
  );

  const imgUrl = data.imgUrl;
  const icon = data.icon;
  const issuer = data.issuer;
  const issuerLabel = data.issuerLabel;

  useEffect(() => {
    if (!key || !needsHeal) {
      setHealed(null);
      return undefined;
    }
    let alive = true;
    const cached = healCache.get(key) ?? null;
    setHealed(cached);
    if (!cached) {
      void resolveNftCardHeal(data).then((fields) => {
        if (alive && fields) setHealed(fields);
      });
    }
    return () => {
      alive = false;
    };
    // `data` is captured once per missing-field combination; the primitive
    // deps below cover every field nftCardNeedsHeal reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needsHeal, imgUrl, icon, issuer, issuerLabel]);

  if (!healed) return data;
  return {
    ...data,
    imgUrl: data.imgUrl ?? healed.imgUrl,
    icon: data.icon ?? healed.icon,
    issuer: data.issuer ?? healed.issuer,
  };
};
