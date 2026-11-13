import React, { useEffect, useState } from 'react';
import TwinBadge from '../../components/metabots/TwinBadge';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import { builtinAvatarSrc, getBuiltinAvatarByReference } from '../../assets/builtinAvatars';
import { subscribeMetabotsChanged } from '../../services/metabotEvents';
import {
  resolveSurfaceIdentityBadge,
  type ResolvedSurfaceIdentity,
  type SurfaceIdentityRosterEntry,
} from './surfaceIdentityBadge';

/** Read-only live identity; hover or keyboard focus previews the session title. */
export const SurfaceIdentityBadgeView: React.FC<{ identity: ResolvedSurfaceIdentity }> = ({ identity }) => {
  const builtinAvatar = getBuiltinAvatarByReference(identity.avatar);
  const avatarSrc = builtinAvatar
    ? builtinAvatarSrc(builtinAvatar)
    : (identity.avatar && isRenderableAvatarSource(identity.avatar) ? identity.avatar : null);
  return (
    <div
      data-slot="cowork-surface-identity-badge"
      title={identity.name}
      tabIndex={0}
      className="flex h-9 min-w-0 max-w-full items-center justify-center gap-2 rounded-lg px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
    >
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt=""
          className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/10"
        />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-black/10 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:ring-white/10">
          <span className="text-[10px] font-semibold uppercase leading-none dark:text-claude-darkText text-claude-text">
            {identity.name.slice(0, 2) || '?'}
          </span>
        </span>
      )}
      <span className="min-w-0 max-w-[140px] truncate text-sm font-medium leading-none dark:text-claude-darkText text-claude-text">
        {identity.name}
      </span>
      {identity.isTwin ? <TwinBadge /> : null}
    </div>
  );
};

interface CoworkSurfaceIdentityBadgeProps {
  /** The open session's owning MetaBot id (null for unattributed sessions). */
  metabotId: number | null;
  /**
   * The shared sessions summary row's identity — the same read the
   * session-name slot uses — as the fallback while the roster has not landed.
   */
  fallbackName?: string | null;
  fallbackAvatar?: string | null;
}

/**
 * Resolves the live session's actor from the roster, with the session summary
 * as a loading or missing-roster fallback. Drafts use BotPickerChip instead;
 * unattributed sessions render no identity.
 */
const CoworkSurfaceIdentityBadge: React.FC<CoworkSurfaceIdentityBadgeProps> = ({
  metabotId,
  fallbackName = null,
  fallbackAvatar = null,
}) => {
  const [roster, setRoster] = useState<SurfaceIdentityRosterEntry[]>([]);

  // Roster freshness: the same channel the panel used for the chip (one
  // `metabot.list()` read, re-read on the shared metabots-changed broadcast
  // so a My Bots edit — above all a Twin appointment — re-renders the badge).
  useEffect(() => {
    let cancelled = false;
    const loadRoster = async () => {
      try {
        const result = await window.electron?.metabot?.list?.();
        if (cancelled || !result?.success || !result.list) return;
        setRoster(result.list.map((entry) => ({
          id: entry.id,
          name: entry.name,
          avatar: entry.avatar ?? null,
          metabot_type: entry.metabot_type,
        })));
      } catch {
        // Bridge down: the summary-row fallback identity carries alone.
      }
    };
    void loadRoster();
    const unsubscribe = subscribeMetabotsChanged(() => {
      void loadRoster();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const identity = resolveSurfaceIdentityBadge(roster, {
    id: metabotId ?? null,
    name: fallbackName ?? null,
    avatar: fallbackAvatar ?? null,
  });
  if (!identity) return null;
  return <SurfaceIdentityBadgeView identity={identity} />;
};

export default CoworkSurfaceIdentityBadge;
