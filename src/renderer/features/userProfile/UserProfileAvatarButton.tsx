import React, { useEffect } from 'react';
import { UserCircleIcon } from '@heroicons/react/24/outline';
import NftAvatarFrame from '../../components/metabots/NftAvatarFrame';
import { useUserProfileCopy } from './i18n';
import {
  getUserProfileIdentity,
  openUserProfile,
  refreshUserProfileIdentity,
  subscribeUserProfileIdentity,
} from './userProfileStore';

/**
 * THE identity entry — owner D-line final ruling 2026-11-09: it lives in the
 * LEFT RAIL's top slot, in the Mac-WeChat form: a rounded-square, PURE avatar
 * with NO visible label. WorkspaceRail gives the slot the band row's exact
 * 52 px height, so the avatar's centerline rides the Studio | BotWorks
 * labels' centerline, and the rail's own centerline keeps it on the icon
 * column's X. The click keeps the old entry behaviour (it opens the user
 * profile page), and the label + the user's NAME ride the tooltip, so the
 * slot reads the same for every identity.
 *
 * 空槽位形态 (总裁办侧栏微调批单 2026-11-09 12:23): while the identity has
 * NO avatar, the slot renders as an EXPLICIT reserved seat for the human
 * user's NFT avatar — a dashed-outline rounded square with a faint user
 * glyph and a slot tooltip, NOT a filled hover button. Hover raises the
 * outline instead of filling a background, so the resting state reads
 * 「预留槽位」; the click affordance (cursor, focus ring, tooltip, click →
 * profile page) is unchanged. With an avatar set, the same footprint renders
 * the avatar normally.
 *
 * The avatar is rendered by the EXISTING shared frame component
 * (`components/metabots/NftAvatarFrame`) — the same public export the Bot list,
 * the Bot editor and the Co-Work transcript use. It renders a plain data/http
 * avatar exactly as before and grows the rainbow NFT frame + certified badge
 * when the stored avatar is an `nft://mrc721/<itemPinId>` reference, so no
 * second avatar stack is introduced here.
 */
const UserProfileAvatarButton: React.FC = () => {
  const copy = useUserProfileCopy();
  const snapshot = React.useSyncExternalStore(
    subscribeUserProfileIdentity,
    getUserProfileIdentity,
    getUserProfileIdentity,
  );

  useEffect(() => {
    void refreshUserProfileIdentity();
  }, []);

  const identity = snapshot.identity;
  const name = (identity?.name || '').trim();
  // The EXPLICIT empty slot shows whenever no avatar is set (no identity yet,
  // or an identity without an avatar — same reserved seat either way).
  const hasAvatar = Boolean(identity?.avatar);
  const tooltip = hasAvatar
    ? `${copy.avatarEntryLabel}${name ? ` · ${name}` : ''}`
    : copy.avatarSlotEmptyHint;

  return (
    <button
      type="button"
      data-slot="user-profile-entry"
      data-user-profile-has-identity={identity ? 'true' : 'false'}
      data-user-profile-has-avatar={hasAvatar ? 'true' : 'false'}
      onClick={() => openUserProfile()}
      aria-label={tooltip}
      aria-haspopup="dialog"
      title={tooltip}
      // No hover FILL on the entry itself: the empty state must rest as a
      // slot, not as a button. The hover raise lives on the slot's outline
      // (group-hover below); the focus ring keeps keyboard affordance.
      className="non-draggable group inline-flex items-center justify-center rounded-xl p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
    >
      {/* PURE avatar (owner D-line final ruling 2026-11-09): no label span —
          the visible 「用户」 word is gone; the slot is just the frame. The
          avatar spec is still the BOT CARD's exact one (MetaBotListCard:
          w-12 h-12 rounded-xl, no extra img border — the NFT frame draws its
          own ring; plain data/http avatars render exactly as on a bot card).
          The fallback is the EXPLICIT reserved slot: dashed outline, faint
          fill, dimmed user glyph — the Mac-WeChat top-left seat reading
          「this place is kept for your NFT avatar」, not a plain button. */}
      <NftAvatarFrame
        avatar={identity?.avatar ?? null}
        frameClassName="w-12 h-12 rounded-xl"
        fallback={
          <div
            data-slot="user-profile-avatar-empty-slot"
            className="flex h-12 w-12 items-center justify-center rounded-xl border-[1.5px] border-dashed border-claude-border/80 bg-claude-surface/40 transition-colors group-hover:border-claude-textSecondary/60 dark:border-claude-darkBorder dark:bg-claude-darkSurface/40 dark:group-hover:border-claude-darkTextSecondary/60"
          >
            <UserCircleIcon
              aria-hidden="true"
              className="h-6 w-6 text-claude-textSecondary/50 dark:text-claude-darkTextSecondary/50"
            />
          </div>
        }
        alt={name || copy.entryLabel}
      />
    </button>
  );
};

export default UserProfileAvatarButton;
