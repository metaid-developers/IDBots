/**
 * Pure resolution helpers for the read-only live-session identity centered
 * above the Studio session title. Drafts use the interactive picker instead.
 *
 * Extracted from the JSX so the resolution contract is testable in plain Node
 * without a DOM, mirroring the surfaceSessionName pattern. Resolution order:
 *
 *   - a roster hit (the same `metabot.list()` channel the panel's chip used)
 *     is AUTHORITATIVE for name, avatar and the Twin mark — the roster is the
 *     same freshness surface (it re-reads on the shared metabots-changed
 *     broadcast, exactly like the My Bots editor and the panel);
 *   - the session summary row's identity (metabotName / metabotAvatar on the
 *     shared sessions list — the same read the session-name slot uses) is the
 *     FALLBACK while the roster has not landed or the bot row is gone;
 *   - a candidate with no resolvable name renders NOTHING (legacy
 *     unattributed sessions and the draft state, which has no session row at
 *     all — same contract as the session-name slot returning null on draft).
 */

export interface SurfaceIdentityRosterEntry {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
}

export interface SurfaceIdentityCandidate {
  /** The open session's owning MetaBot id; null for unattributed sessions. */
  id: number | null;
  /** Summary-row display name fallback (may be null). */
  name: string | null;
  /** Summary-row avatar fallback (may be null). */
  avatar: string | null;
}

export interface ResolvedSurfaceIdentity {
  name: string;
  avatar: string | null;
  isTwin: boolean;
}

/**
 * Resolve the badge identity: the roster hit wins for every field (name,
 * avatar, twin-ness); the summary-row fallback fills the gaps only where the
 * roster has no hit. No resolvable name resolves to null — the badge renders
 * nothing rather than an empty control.
 */
export function resolveSurfaceIdentityBadge(
  roster: readonly SurfaceIdentityRosterEntry[],
  candidate: SurfaceIdentityCandidate,
): ResolvedSurfaceIdentity | null {
  const rosterHit = candidate.id != null
    ? roster.find((entry) => entry.id === candidate.id) ?? null
    : null;
  const name = (rosterHit?.name ?? candidate.name ?? '').trim();
  if (!name) return null;
  return {
    name,
    // The roster is authoritative even when it carries a null avatar: a null
    // there means the bot row really has no avatar right now (fresh read),
    // not "unknown".
    avatar: rosterHit ? (rosterHit.avatar ?? null) : (candidate.avatar ?? null),
    isTwin: rosterHit?.metabot_type === 'twin',
  };
}
