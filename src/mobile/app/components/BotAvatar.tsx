import { useState } from 'react';
import { avatarInitial } from '../botList';
import { isRenderableAvatar } from '../avatar';
import NftAvatarFrame from '../../../renderer/components/metabots/NftAvatarFrame';
import { parseNftAvatarReference } from '../../../renderer/components/metabots/nftAvatarPresentation.js';

/**
 * Shared MetaBot avatar (UE rework 2026-10-29, A1/A2/A3/A4).
 *
 * Renders the real avatar only when `isRenderableAvatar` says the string can
 * possibly decode (see src/mobile/app/avatar.ts for the gateway-truncation
 * story); otherwise — and whenever the <img> itself errors at runtime — it
 * falls back to the initial-letter disc instead of showing a broken image.
 */
export function BotAvatar(props: {
  name: string | null | undefined;
  avatar?: string | null | undefined;
  fallbackSource?: string | null | undefined;
  size?: number;
  testId: string;
}): JSX.Element {
  const [broken, setBroken] = useState(false);
  const renderable = isRenderableAvatar(props.avatar);
  const size = props.size ?? 40;
  const dimension = { width: size, height: size };
  if (parseNftAvatarReference(props.avatar)) {
    return (
      <span data-testid={props.testId} data-avatar-state="nft" style={dimension} className="relative block shrink-0">
        <NftAvatarFrame
          avatar={props.avatar}
          fallbackSource={props.fallbackSource}
          frameClassName="h-full w-full rounded-full"
          fallback={(
            <span className="flex h-full w-full items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-main)] text-base font-semibold text-[var(--text-secondary)]">
              {avatarInitial(props.name)}
            </span>
          )}
        />
      </span>
    );
  }
  if (renderable && !broken) {
    return (
      <img
        src={props.avatar}
        alt=""
        data-testid={props.testId}
        data-avatar-state="image"
        onError={() => setBroken(true)}
        style={dimension}
        className="shrink-0 rounded-full border border-[var(--border-color)] object-cover"
      />
    );
  }
  return (
    <span
      data-testid={props.testId}
      data-avatar-state={renderable ? 'image-errored' : 'fallback'}
      aria-hidden
      style={dimension}
      className="flex shrink-0 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-main)] text-base font-semibold text-[var(--text-secondary)]"
    >
      {avatarInitial(props.name)}
    </span>
  );
}
