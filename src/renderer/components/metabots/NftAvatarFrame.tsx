/**
 * Shared NFT avatar frame for MetaBot avatar surfaces.
 *
 * For a plain avatar (data:/http or empty) this renders exactly what the
 * surfaces rendered before — an <img> or the caller's placeholder — so the
 * component is a drop-in wrapper. For an `nft://mrc721/<itemPinId>` avatar
 * reference it resolves the artwork through `metaid:resolveAvatarSource` and
 * decorates the render with:
 *   - a subtle rainbow ring (the "this avatar is an NFT" marking), and
 *   - a blue-check badge when the item's collection is present in the IDBots
 *     NFT CA registry (`idbots:getNftCaRegistry`) — uncertified NFTs get the
 *     ring only.
 *
 * Fail-soft by construction: resolution failure or an unresolvable reference
 * degrades to the caller's placeholder, never a broken image.
 */

import React, { useEffect, useState } from 'react';
import { CheckIcon } from '@heroicons/react/24/solid';
import { i18nService } from '../../services/i18n';
import { getNftCaRegistryCached, isCollectionCertified } from '../../services/nftCaRegistryService';
import { parseNftAvatarReference } from './nftAvatarPresentation';

interface NftAvatarState {
  /** Resolved artwork source; null = unresolvable (placeholder fallback). */
  src: string | null;
  certified: boolean;
}

// Module-level resolution cache keyed by the full nft:// reference. Failed
// resolutions are dropped so a transient indexer outage can heal on the next
// render instead of being frozen for the session.
const resolutionCache = new Map<string, Promise<NftAvatarState>>();

function loadNftAvatarState(reference: string): Promise<NftAvatarState> {
  const cached = resolutionCache.get(reference);
  if (cached) return cached;
  const pending = (async (): Promise<NftAvatarState> => {
    try {
      const result = await window.electron.p2p.resolveAvatarSource({ reference });
      const json = result as {
        success?: boolean;
        avatarUrl?: string | null;
        nft?: { itemPinId: string; collectionPinId?: string; collectionName?: string };
      };
      const src = json?.success !== false && typeof json?.avatarUrl === 'string' && json.avatarUrl
        ? json.avatarUrl
        : null;
      let certified = false;
      if (src && json?.nft?.collectionPinId) {
        const registry = await getNftCaRegistryCached();
        certified = isCollectionCertified(registry, json.nft.collectionPinId);
      }
      return { src, certified };
    } catch {
      return { src: null, certified: false };
    }
  })();
  resolutionCache.set(reference, pending);
  // Never cache a failed resolution: only keep promises that yielded art, so
  // a transient outage heals on the next render.
  void pending.then((state) => {
    if (!state.src) resolutionCache.delete(reference);
  }).catch(() => {
    resolutionCache.delete(reference);
  });
  return pending;
}

function useNftAvatarState(reference: string | null): NftAvatarState | null {
  const [state, setState] = useState<NftAvatarState | null>(null);
  useEffect(() => {
    if (!reference) {
      setState(null);
      return;
    }
    let cancelled = false;
    loadNftAvatarState(reference)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState({ src: null, certified: false });
      });
    return () => {
      cancelled = true;
    };
  }, [reference]);
  return state;
}

export interface NftAvatarFrameProps {
  /** Raw avatar value from the metabot record (may be an nft:// reference). */
  avatar: string | null | undefined;
  /** Size/shape classes applied to both the plain-img path and the NFT frame, e.g. "w-12 h-12 rounded-xl". */
  frameClassName: string;
  /** Extra classes for the plain-img path only (e.g. the legacy border). */
  imgClassName?: string;
  /** Placeholder content when there is no (or an unresolvable) avatar. */
  fallback: React.ReactNode;
  alt?: string;
}

const NftAvatarFrame: React.FC<NftAvatarFrameProps> = ({ avatar, frameClassName, imgClassName, fallback, alt = '' }) => {
  const nftRef = parseNftAvatarReference(avatar ?? null);
  const resolved = useNftAvatarState(nftRef ? (avatar as string).trim() : null);

  if (!nftRef) {
    // Legacy behavior for non-NFT avatars — unchanged rendering.
    if (avatar && (avatar.startsWith('data:') || avatar.startsWith('http'))) {
      return <img src={avatar} alt={alt} className={`${frameClassName} object-cover ${imgClassName ?? ''}`} />;
    }
    return <>{fallback}</>;
  }

  if (!resolved?.src) {
    return <>{fallback}</>;
  }

  return (
    <div
      className={`relative ${frameClassName} shrink-0 p-[2px]`}
      style={{ background: 'conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171)' }}
      data-nft-avatar={nftRef.itemPinId}
    >
      <div className="h-full w-full overflow-hidden rounded-[inherit] dark:bg-claude-darkSurface bg-claude-surface">
        <img src={resolved.src} alt={alt} className="h-full w-full object-cover" />
      </div>
      {resolved.certified && (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 ring-2 ring-white dark:ring-[#1a1d21]"
          title={i18nService.t('metabotNftAvatarCertifiedBadge')}
          aria-label={i18nService.t('metabotNftAvatarCertifiedBadge')}
        >
          <CheckIcon className="h-2.5 w-2.5 text-white" />
        </span>
      )}
    </div>
  );
};

export default NftAvatarFrame;
