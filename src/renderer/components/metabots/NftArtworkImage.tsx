/**
 * Shared NFT artwork <img> for the metabot wallet surfaces (NFT wallet modal
 * tiles, wallet assets NFT grid). Walks the ordered candidate `sources` on
 * load error and degrades to an initials placeholder — a tile never shows a
 * broken image glyph. Extracted verbatim from MetaBotNftWalletModal so the
 * wallet assets modal grid renders identical tiles.
 */

import React, { useEffect, useState } from 'react';

export const NftArtworkPlaceholder: React.FC<{ initials: string; large?: boolean }> = ({ initials, large }) => (
  <div
    className={`flex w-full items-center justify-center bg-gradient-to-br from-claude-accent/10 to-violet-500/10 dark:from-claude-accent/20 dark:to-violet-500/20 ${
      large ? 'min-h-[240px] text-4xl' : 'aspect-square text-xl'
    } font-semibold tracking-wide text-claude-accent`}
  >
    {initials}
  </div>
);

export const NftArtworkImage: React.FC<{ sources: string[]; initials: string; alt: string; large?: boolean }> = ({
  sources,
  initials,
  alt,
  large,
}) => {
  const [failedCount, setFailedCount] = useState(0);
  const sourceKey = sources.join('|');
  useEffect(() => {
    setFailedCount(0);
  }, [sourceKey]);

  if (!sources.length || failedCount >= sources.length) {
    return <NftArtworkPlaceholder initials={initials} large={large} />;
  }
  return (
    <img
      src={sources[failedCount]}
      alt={alt}
      loading="lazy"
      className={`w-full bg-black/5 object-cover dark:bg-white/5 ${large ? 'max-h-[55vh]' : 'aspect-square'}`}
      onError={() => setFailedCount((count) => count + 1)}
    />
  );
};
