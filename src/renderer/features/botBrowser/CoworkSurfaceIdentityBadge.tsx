import React, { useEffect, useState } from 'react';
import TwinBadge from '../../components/metabots/TwinBadge';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import { subscribeMetabotsChanged } from '../../services/metabotEvents';
import {
  resolveSurfaceIdentityBadge,
  type ResolvedSurfaceIdentity,
  type SurfaceIdentityRosterEntry,
} from './surfaceIdentityBadge';

/**
 * The badge's read-only body (v3 close wiring of the 18:21 final layout,
 * 2026-11-11 — supersedes the unshipped 18:19 read-only card): a small
 * avatar + name + Twin mark, one coordination level BELOW the session-name
 * title (secondary ink at 12 px vs the title's full ink at 13 px medium; no
 * hover pill, no bold) and NOT clickable — a plain div, no button, no onClick,
 * no inline-rename handoff. Exported for tests (renderToStaticMarkup), the
 * same seam as BotPickerMenuRow.
 */
export const SurfaceIdentityBadgeView: React.FC<{ identity: ResolvedSurfaceIdentity }> = ({ identity }) => (
  <div
    data-slot="cowork-surface-identity-badge"
    title={identity.name}
    className="flex min-w-0 shrink-0 items-center gap-1.5 px-1"
  >
    {identity.avatar && isRenderableAvatarSource(identity.avatar) ? (
      <img
        src={identity.avatar}
        alt=""
        className="h-4 w-4 shrink-0 rounded-md object-cover"
      />
    ) : (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
        <span className="text-[7px] font-semibold uppercase leading-none dark:text-claude-darkText text-claude-text">
          {identity.name.slice(0, 2) || '?'}
        </span>
      </span>
    )}
    <span className="min-w-0 max-w-[120px] truncate text-xs leading-none dark:text-claude-darkTextSecondary text-claude-textSecondary">
      {identity.name}
    </span>
    {identity.isTwin ? <TwinBadge /> : null}
  </div>
);

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
 * The surface header's read-only live-session identity badge (v3 close
 * wiring of the 18:21 final layout, 2026-11-11; supersedes this file's
 * original 18:19 card, which parked the badge between the session name and
 * the icon cluster and retired the picker — the shipped 18:21 layout keeps
 * the draft picker interactive and gives THIS component the live-session
 * lane instead). For an open session the header's FIRST lane renders this
 * read-only label (the bot identity that used to sit on the composer's
 * top-left row); the draft state keeps the interactive BotPickerChip —
 * picking decides which bot runs the NEXT conversation, while an acting
 * transcript never changes actors mid-flight. The composer's top edge stays
 * the controls row alone.
 *
 * Identity resolution lives in the pure surfaceIdentityBadge module: the
 * roster (the same `metabot.list()` + metabots-changed freshness channel the
 * panel's chip used) is authoritative; the summary-row fallback carries until
 * it lands. Nothing to show (unattributed session, no summary identity)
 * renders nothing — the same contract as the session-name slot returning
 * null on a draft.
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
