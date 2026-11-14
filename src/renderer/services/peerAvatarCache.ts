import type { CoworkSessionSummary } from '../types/cowork';

interface PeerAvatarEntry {
  peerAvatar: string | null;
  version: number;
}

const MAX_SESSIONS_PER_FETCH = 200;

export class PeerAvatarCache {
  private entries = new Map<string, PeerAvatarEntry>();
  private pendingFetch: Promise<void> | null = null;

  async attachPeerAvatars(sessions: CoworkSessionSummary[]): Promise<CoworkSessionSummary[]> {
    const fetchFn = window.electron?.cowork?.listPeerAvatars;
    if (typeof fetchFn !== 'function') {
      return sessions;
    }
    if (this.pendingFetch) {
      await this.pendingFetch;
    }
    const stale = this.collectStaleSessions(sessions);
    if (stale.length > 0) {
      const fetch = this.fetchAvatars(stale, fetchFn);
      this.pendingFetch = fetch;
      try {
        await fetch;
      } finally {
        if (this.pendingFetch === fetch) {
          this.pendingFetch = null;
        }
      }
    }

    return sessions.map((session) => {
      if (session.peerAvatarVersion == null) return session;
      const entry = this.entries.get(session.id);
      return entry ? { ...session, peerAvatar: entry.peerAvatar } : session;
    });
  }

  private collectStaleSessions(sessions: CoworkSessionSummary[]): Array<{ id: string; version: number }> {
    const stale: Array<{ id: string; version: number }> = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      const version = session.peerAvatarVersion;
      if (version == null || !session.id || seen.has(session.id)) continue;
      seen.add(session.id);
      const entry = this.entries.get(session.id);
      if (!entry || entry.version !== version) {
        stale.push({ id: session.id, version });
        if (stale.length >= MAX_SESSIONS_PER_FETCH) break;
      }
    }
    return stale;
  }

  private async fetchAvatars(
    stale: Array<{ id: string; version: number }>,
    fetchFn: NonNullable<Window['electron']['cowork']['listPeerAvatars']>,
  ): Promise<void> {
    let avatars: Array<{ sessionId: string; peerAvatar: string | null }>;
    try {
      const result = await fetchFn(stale.map((item) => item.id));
      if (!result?.success || !Array.isArray(result.avatars)) {
        return;
      }
      avatars = result.avatars;
    } catch {
      return;
    }

    const bySessionId = new Map(avatars.map((item) => [item.sessionId, item.peerAvatar ?? null]));
    for (const { id, version } of stale) {
      this.entries.set(id, {
        peerAvatar: bySessionId.get(id) ?? null,
        version,
      });
    }
  }
}

export const peerAvatarCache = new PeerAvatarCache();
