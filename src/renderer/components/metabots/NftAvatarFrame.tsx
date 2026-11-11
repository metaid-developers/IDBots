import React, { useEffect, useState } from 'react';
import { CheckIcon } from '@heroicons/react/24/solid';
import { i18nService } from '../../services/i18n';
import { getNftCaRegistryCached, isCollectionCertified } from '../../services/nftCaRegistryService';
import { parseNftAvatarReference, resolveNftAvatarBadgeKind } from './nftAvatarPresentation';
import { isMetafileAvatarReference } from '../../utils/metafileAvatar';

interface NftAvatarState {
  src: string | null;
  ownershipVerified: boolean;
  certified: boolean;
}

const RESOLUTION_TTL_MS = 30_000;
const resolutionCache = new Map<string, { createdAt: number; pending: Promise<NftAvatarState> }>();

function loadNftAvatarState(reference: string): Promise<NftAvatarState> {
  const cached = resolutionCache.get(reference);
  if (cached && Date.now() - cached.createdAt < RESOLUTION_TTL_MS) return cached.pending;
  const pending = (async (): Promise<NftAvatarState> => {
    try {
      const result = await window.electron.p2p.resolveAvatarSource({ reference });
      const json = result as {
        success?: boolean;
        avatarUrl?: string | null;
        nft?: {
          itemPinId: string;
          collectionPinId?: string;
          collectionName?: string;
          ownershipVerified?: boolean;
        };
      };
      const src = json?.success !== false && typeof json?.avatarUrl === 'string' && json.avatarUrl
        ? json.avatarUrl
        : null;
      const ownershipVerified = json?.nft?.ownershipVerified === true;
      let certified = false;
      if (src && ownershipVerified && json?.nft?.collectionPinId) {
        const registry = await getNftCaRegistryCached();
        certified = isCollectionCertified(registry, json.nft.collectionPinId);
      }
      return { src, ownershipVerified, certified };
    } catch {
      return { src: null, ownershipVerified: false, certified: false };
    }
  })();
  resolutionCache.set(reference, { createdAt: Date.now(), pending });
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
        if (!cancelled) setState({ src: null, ownershipVerified: false, certified: false });
      });
    return () => {
      cancelled = true;
    };
  }, [reference]);
  return state;
}

export interface NftAvatarFrameProps {
  avatar: string | null | undefined;
  /** Stored NFT cover that keeps the image visible while verification is unavailable. */
  fallbackSource?: string | null;
  frameClassName: string;
  imgClassName?: string;
  fallback: React.ReactNode;
  alt?: string;
}

const NftAvatarFrame: React.FC<NftAvatarFrameProps> = ({
  avatar,
  fallbackSource,
  frameClassName,
  imgClassName,
  fallback,
  alt = '',
}) => {
  const nftRef = parseNftAvatarReference(avatar ?? null);
  const metafileRef = isMetafileAvatarReference(avatar);
  const resolved = useNftAvatarState(nftRef || metafileRef ? (avatar as string).trim() : null);

  if (!nftRef && !metafileRef) {
    if (avatar && (avatar.startsWith('data:') || avatar.startsWith('http'))) {
      return <img src={avatar} alt={alt} className={`${frameClassName} object-cover ${imgClassName ?? ''}`} />;
    }
    return <>{fallback}</>;
  }

  if (metafileRef) {
    if (!resolved?.src) return <>{fallback}</>;
    return <img src={resolved.src} alt={alt} className={`${frameClassName} object-cover ${imgClassName ?? ''}`} data-metafile-avatar={avatar?.trim()} />;
  }

  const src = resolved?.src ?? fallbackSource ?? null;
  const badgeKind = resolveNftAvatarBadgeKind({
    src,
    ownershipVerified: resolved?.ownershipVerified === true,
    certified: resolved?.certified === true,
  });
  if (badgeKind === 'fallback') return <>{fallback}</>;
  if (badgeKind === 'plain') {
    return <img src={src} alt={alt} className={`${frameClassName} object-cover ${imgClassName ?? ''}`} />;
  }

  if (badgeKind === 'certified') {
    return (
      <div
        className={`relative ${frameClassName} shrink-0 p-[2px]`}
        style={{ background: 'conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f472b6, #f87171)' }}
        data-nft-avatar={nftRef.itemPinId}
        data-nft-ownership="verified"
        data-nft-certified="true"
      >
        <div className="h-full w-full overflow-hidden rounded-[inherit] dark:bg-claude-darkSurface bg-claude-surface">
          <img src={src} alt={alt} className="h-full w-full object-cover" />
        </div>
        <span
          className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 ring-2 ring-white dark:ring-[#1a1d21]"
          title={i18nService.t('metabotNftAvatarCertifiedBadge')}
          aria-label={i18nService.t('metabotNftAvatarCertifiedBadge')}
        >
          <CheckIcon className="h-2.5 w-2.5 text-white" />
        </span>
      </div>
    );
  }

  return (
    <div
      className={`relative ${frameClassName} shrink-0`}
      data-nft-avatar={nftRef.itemPinId}
      data-nft-ownership="verified"
    >
      <img src={src} alt={alt} className={`h-full w-full rounded-[inherit] object-cover ${imgClassName ?? ''}`} />
      <span
        className="absolute -bottom-0.5 -right-0.5 rounded-[3px] bg-black/55 px-0.5 text-[6px] font-medium leading-3 tracking-[0.04em] text-white/80 ring-1 ring-white/40 dark:ring-black/40"
        title={i18nService.t('metabotNftAvatarVerifiedBadge')}
        aria-label={i18nService.t('metabotNftAvatarVerifiedBadge')}
      >
        NFT
      </span>
    </div>
  );
};

export default NftAvatarFrame;
