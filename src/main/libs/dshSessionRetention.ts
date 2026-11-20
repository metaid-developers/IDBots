// DSH session-log retention (Phase 2 slice 6, owner-approved Proposal A).
//
// A months-long Studio conversation writes ~17MB/day of v4 JSONL (compacted
// events stay in the log forever), and NOTHING ever deletes or moves those
// bytes — a year of heavy use is a multi-GB dsh-sessions tree. The owner
// ruled: sessions idle for longer than the retention window get ARCHIVED to
// a sibling cold directory (same volume — rename, not copy); an archived
// session is transparently restored to the live root the moment a turn
// addresses it, so opening an old conversation keeps its full kernel
// history. Active sessions are never touched.
//
// conversation_recall / chapter cards / memory all read SQLite, which is
// unaffected — only the kernel resume log moves.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';

export const DSH_SESSION_RETENTION_IDLE_DAYS = 90;

export function dshSessionColdRootFor(liveRoot: string): string {
  // Sibling of the versioned live root (<userData>/dsh-sessions/cold) — same
  // volume, so archival is a rename.
  return join(liveRoot, '..', 'cold');
}

function hasSessionLog(dir: string): boolean {
  return existsSync(join(dir, 'session.v4.jsonl.zstd')) || existsSync(join(dir, 'session.v4.jsonl'));
}

/**
 * Archive every live session directory whose log was last written longer
 * than `idleDays` ago. Best-effort per directory: one unreadable/renameable
 * entry never aborts the sweep.
 */
export function archiveIdleDshSessions(params: {
  liveRoot: string;
  coldRoot: string;
  idleDays?: number;
  now?: number;
}): { scanned: number; archived: number } {
  const idleDays = params.idleDays ?? DSH_SESSION_RETENTION_IDLE_DAYS;
  const now = params.now ?? Date.now();
  const cutoff = now - idleDays * 86_400_000;
  let scanned = 0;
  let archived = 0;
  let buckets: string[] = [];
  try {
    buckets = readdirSync(params.liveRoot);
  } catch {
    return { scanned, archived };
  }
  for (const bucket of buckets) {
    const bucketPath = join(params.liveRoot, bucket);
    let entries: string[] = [];
    try {
      entries = readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('cw-')) continue;
      const liveDir = join(bucketPath, entry);
      if (!hasSessionLog(liveDir)) continue;
      scanned += 1;
      try {
        const logPath = existsSync(join(liveDir, 'session.v4.jsonl.zstd'))
          ? join(liveDir, 'session.v4.jsonl.zstd')
          : join(liveDir, 'session.v4.jsonl');
        if (statSync(logPath).mtimeMs >= cutoff) continue;
        const coldBucket = join(params.coldRoot, bucket);
        const coldDir = join(coldBucket, entry);
        if (existsSync(coldDir)) continue; // never clobber a prior archive
        mkdirSync(coldBucket, { recursive: true });
        renameSync(liveDir, coldDir);
        archived += 1;
      } catch {
        // one stuck directory must not stop the sweep
      }
    }
  }
  return { scanned, archived };
}

/**
 * Restore an archived session directory to the live root before a turn
 * addresses it. Depth-≤2 scan of the cold root (the bucket encoding of the
 * session's cwd is not worth recomputing); no-op when the session is already
 * live or not archived.
 */
export function restoreDshSessionDir(params: {
  liveRoot: string;
  coldRoot: string;
  dshSessionId: string;
}): boolean {
  const { liveRoot, coldRoot, dshSessionId } = params;
  if (!dshSessionId || !dshSessionId.startsWith('cw-')) return false;
  const liveDir = (bucket: string) => join(liveRoot, bucket, dshSessionId);
  let coldBuckets: string[] = [];
  try {
    coldBuckets = existsSync(coldRoot) ? readdirSync(coldRoot) : [];
  } catch {
    return false;
  }
  for (const bucket of coldBuckets) {
    const coldDir = join(coldRoot, bucket, dshSessionId);
    if (!existsSync(coldDir)) continue;
    try {
      const target = liveDir(bucket);
      if (existsSync(target)) return false;
      mkdirSync(join(liveRoot, bucket), { recursive: true });
      renameSync(coldDir, target);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
