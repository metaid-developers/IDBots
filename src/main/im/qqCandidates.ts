/**
 * QQ groups that TALKED to the bot but are not authorised yet.
 *
 * THE DEADLOCK THIS FILE EXISTS FOR: a group allowlist can only be filled with
 * the platform's group OpenID (32 hex chars, e.g.
 * `D5C5A8FEDB9C07ED3962FC31238BE4EE`). A human never sees that string — the
 * only place it exists is inside an inbound message payload. So the old flow
 * required: "the bot must receive a message from the group → to learn the id →
 * to allow the group → to answer it". But an unauthorised group's messages were
 * dropped WITHOUT being remembered, so the id was thrown away and the loop
 * could never start. The owner held an 8-digit group number that means nothing
 * to the platform.
 *
 * THE FIX — record, do not grant: when the gate refuses a group because it is
 * not allowlisted, the gateway writes the group id here. Nothing else changes:
 * no reply, no model call, no tool, no memory write, no attachment download.
 * The trust decision is untouched; a recorded group is still refused on every
 * subsequent message until the owner clicks "允许" in the settings page.
 *
 * WHY A SEPARATE FILE, NOT THE CONFIG TABLE:
 *   - the config table is serialized to the renderer on every change; a message
 *     storm in 50 groups would churn it,
 *   - the gateway writes here on the message path, while the renderer owns the
 *     config — two writers on one record means lost updates,
 *   - this is channel STATE, not a user preference: it must be safe to delete.
 *
 * NOT LONG-TERM MEMORY: this file never enters the memory store, the knowledge
 * bases, the dream/consolidation pass, or a model prompt. It is a bounded
 * local list the owner reads in the settings page.
 *
 * FAIL-CLOSED / DENIAL-OF-WALLET SAFETY: every operation swallows filesystem
 * errors. A full disk or a read-only userData directory must never turn a
 * dropped message into an answered one — `record()` returning null is not an
 * authorisation, and nothing in this file can grant one.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { QQGroupNameStatus } from './qqGroupInfo';

/**
 * Single source of truth for the lookup outcome lives in `qqGroupInfo.ts`
 * (platform semantics); re-exported here so the settings layer has one import.
 */
export type { QQGroupNameStatus };

export const QQ_GROUP_CANDIDATES_FILE = 'group-candidates.json';

/**
 * Hard cap on remembered groups. A hostile actor can invite the bot into many
 * groups; without a cap this file grows forever. 100 is far above any real
 * deployment and keeps the settings list scannable. Oldest `lastSeenAt` loses.
 */
export const QQ_GROUP_CANDIDATE_LIMIT = 100;

/** Longest accepted group id. Platform ids are 32 chars; leave headroom. */
const GROUP_ID_MAX_LEN = 128;

/**
 * Outcome of the optional group-name lookup.
 *
 *   ok          the platform returned a name
 *   forbidden   the endpoint exists but this app is not whitelisted (code 11253)
 *   unavailable the app has no credentials, or the call was never made
 *   error       network / unexpected failure
 */
// (type imported above from qqGroupInfo)

export interface QQGroupCandidate {
  /** The platform group OpenID. Never a display name, never the 8-digit 群号. */
  groupId: string;
  /** Group name when the platform gave us one; null otherwise. */
  name: string | null;
  nameStatus: QQGroupNameStatus;
  nameCheckedAt: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** How many dropped messages mentioned this group. Diagnostics only. */
  messageCount: number;
  /** Owner pressed 忽略: keep it out of the pending list, still not allowed. */
  ignored: boolean;
}

interface QQGroupCandidateFile {
  version: 1;
  groups: QQGroupCandidate[];
}

/** Trim and bound an inbound group id; empty/oversized/garbage becomes ''. */
export function normalizeQQGroupId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > GROUP_ID_MAX_LEN) return '';
  // Control characters would come from a malformed payload and must not reach
  // a JSON state file or the settings list.
  if (/[\u0000-\u001f\u007f]/.test(id)) return '';
  return id;
}

function coerceTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function coerceCandidate(raw: unknown): QQGroupCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const groupId = normalizeQQGroupId(record.groupId);
  if (!groupId) return null;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null;
  const nameStatus: QQGroupNameStatus =
    record.nameStatus === 'ok'
    || record.nameStatus === 'forbidden'
    || record.nameStatus === 'error'
    || record.nameStatus === 'unavailable'
      ? record.nameStatus
      : name
        ? 'ok'
        : 'unavailable';
  const firstSeenAt = coerceTimestamp(record.firstSeenAt, 0);
  const lastSeenAt = coerceTimestamp(record.lastSeenAt, firstSeenAt);
  return {
    groupId,
    name,
    nameStatus,
    nameCheckedAt:
      typeof record.nameCheckedAt === 'number' && Number.isFinite(record.nameCheckedAt)
        ? record.nameCheckedAt
        : null,
    firstSeenAt,
    lastSeenAt,
    messageCount:
      typeof record.messageCount === 'number' && Number.isFinite(record.messageCount)
      && record.messageCount > 0
        ? Math.floor(record.messageCount)
        : 1,
    ignored: record.ignored === true,
  };
}

/** Default state dir (`<userData>/qq`), matching `qqStore`/`qqTrust`. */
export function resolveDefaultQQCandidateDir(): string {
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'qq');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-qq');
}

/**
 * Append-mostly JSON store of unauthorised groups that have spoken to the bot.
 *
 * Deliberately synchronous and tiny: it is written from the inbound message
 * path, before any model work, so it must not add latency or an await point
 * that a concurrent turn could interleave with.
 */
export class QQGroupCandidateStore {
  private readonly dir: string;

  constructor(dir?: string | null) {
    this.dir = dir && dir.trim() ? dir : resolveDefaultQQCandidateDir();
  }

  getDir(): string {
    return this.dir;
  }

  filePath(): string {
    return path.join(this.dir, QQ_GROUP_CANDIDATES_FILE);
  }

  /** All remembered groups, newest activity first. Never throws. */
  list(): QQGroupCandidate[] {
    const file = this.read();
    return file.groups
      .slice()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.groupId.localeCompare(b.groupId));
  }

  /**
   * Record one dropped message from `groupId`.
   *
   * Returns the stored candidate, or null when the id is unusable or the write
   * failed. NULL IS NOT A GRANT: callers must never branch on this value in a
   * way that answers the message.
   */
  record(groupId: unknown, now: number): QQGroupCandidate | null {
    const id = normalizeQQGroupId(groupId);
    if (!id) return null;
    const file = this.read();
    const stamp = Number.isFinite(now) && now > 0 ? now : Date.now();
    const existing = file.groups.find((entry) => entry.groupId === id);
    let candidate: QQGroupCandidate;
    if (existing) {
      existing.lastSeenAt = stamp;
      existing.messageCount += 1;
      candidate = existing;
    } else {
      candidate = {
        groupId: id,
        name: null,
        nameStatus: 'unavailable',
        nameCheckedAt: null,
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        messageCount: 1,
        ignored: false,
      };
      file.groups.push(candidate);
    }
    this.prune(file);
    if (!this.write(file)) return null;
    return { ...candidate };
  }

  /** Store a name-lookup result. Returns the updated candidate or null. */
  setName(
    groupId: unknown,
    result: { name: string | null; status: QQGroupNameStatus },
    now: number
  ): QQGroupCandidate | null {
    const id = normalizeQQGroupId(groupId);
    if (!id) return null;
    const file = this.read();
    const existing = file.groups.find((entry) => entry.groupId === id);
    if (!existing) return null;
    // A stale 'ok' must not survive a later failure: the name is only shown
    // when the LAST check succeeded, so a revoked whitelist degrades honestly.
    existing.name = result.status === 'ok' && result.name ? result.name.trim() || null : null;
    existing.nameStatus = result.status;
    existing.nameCheckedAt = Number.isFinite(now) && now > 0 ? now : Date.now();
    if (!this.write(file)) return null;
    return { ...existing };
  }

  /** Owner pressed 忽略. The group stays refused; it just leaves the list. */
  setIgnored(groupId: unknown, ignored: boolean): boolean {
    const id = normalizeQQGroupId(groupId);
    if (!id) return false;
    const file = this.read();
    const existing = file.groups.find((entry) => entry.groupId === id);
    if (!existing) return false;
    existing.ignored = ignored;
    return this.write(file);
  }

  /** Forget a group entirely (used when it is allowed or the list is cleaned). */
  forget(groupId: unknown): boolean {
    const id = normalizeQQGroupId(groupId);
    if (!id) return false;
    const file = this.read();
    const next = file.groups.filter((entry) => entry.groupId !== id);
    if (next.length === file.groups.length) return false;
    file.groups = next;
    return this.write(file);
  }

  /** Pending = recorded, not ignored, and not in `allowlist`. */
  pending(allowlist: readonly string[] = []): QQGroupCandidate[] {
    const allowed = new Set(
      allowlist.map((value) => normalizeQQGroupId(value)).filter(Boolean)
    );
    return this.list().filter((entry) => !entry.ignored && !allowed.has(entry.groupId));
  }

  private read(): QQGroupCandidateFile {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<QQGroupCandidateFile>;
      const groups = Array.isArray(parsed?.groups)
        ? parsed.groups.map(coerceCandidate).filter((entry): entry is QQGroupCandidate => entry !== null)
        : [];
      // De-duplicate by id, keeping the newer activity record.
      const byId = new Map<string, QQGroupCandidate>();
      for (const group of groups) {
        const prior = byId.get(group.groupId);
        if (!prior || group.lastSeenAt > prior.lastSeenAt) byId.set(group.groupId, group);
      }
      return { version: 1, groups: [...byId.values()] };
    } catch {
      // Missing file, unreadable permission, or torn JSON: start empty. An
      // empty candidate list can only ever refuse groups, never allow one.
      return { version: 1, groups: [] };
    }
  }

  private prune(file: QQGroupCandidateFile): void {
    if (file.groups.length <= QQ_GROUP_CANDIDATE_LIMIT) return;
    file.groups.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    file.groups = file.groups.slice(0, QQ_GROUP_CANDIDATE_LIMIT);
  }

  private write(file: QQGroupCandidateFile): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const target = this.filePath();
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tmp, target);
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        // Windows may not support chmod; best effort.
      }
      return true;
    } catch {
      return false;
    }
  }
}
