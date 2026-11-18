/**
 * Session-log guard for quit cleanup and startup (T-C, RSI/WTL second batch).
 *
 * Why: the 2026-10-19 04:34 incident left twelve DSH session logs behind —
 * ten of them 0 bytes and two missing their header frame — with mtimes exactly
 * on a shutdown-cleanup instant (main.ts "Closing DSH runtime"). The root cause
 * was never established, but one gap is certain: the quit sequence did nothing
 * at all to guard the logs. A log truncated at the moment the runtime closes is
 * unrecoverable, and nothing ever noticed it happened afterwards.
 *
 * Three layers, all READ-ONLY on the logs:
 *   a. quit: before the DSH runtime closes, fsync (flush) every active
 *      session's log and check the first-frame invariant (frame 1 must decode
 *      to exactly one session header line). A failed check only logs — the
 *      file is never rewritten, repaired, or removed.
 *   b. startup: scan the session root, flag 0-byte / header-less artifacts in
 *      a WARN log line (path + mtime + size + verdict). Nothing is deleted.
 *   c. audit: every step that touches a log file leaves one audit line with
 *      the path, the byte size before/after, and the verdict.
 *
 * Hard constraint (inherited from the work order): this module NEVER deletes,
 * truncates, rewrites, or "repairs" a log file. The only mutating syscall it
 * issues is `fsync` on an already-open handle, which cannot change content.
 * (On Windows the handle is opened `'r+'` because FlushFileBuffers refuses a
 * read-only one — still not a single byte is written; see
 * flushSessionLogArtifact.)
 *
 * Frame format (authoritative source: dsh-runtime's
 * @deepseek-ai/dsh-session-persistence-jsonl):
 *   - plaintext artifacts: `session.v4.jsonl`, frame 1 = the header line;
 *   - zstd artifacts: `session.v4.jsonl.zstd`, concatenated zstd frames where
 *     frame 1 decodes to exactly the header line, and later appends concatenate
 *     whole frames after it (see lib/migrate-session-root-zstd.mjs).
 *   The header line is one JSON object with type:"session", a numeric version,
 *   a string id, and a numeric createdAt (isSessionHeaderLine below).
 *
 * Directory layout (same package): root / projectKey(cwd) / encodeSegment(id) /
 * session.v4.jsonl[.zstd]. Both key encoders are mirrored here verbatim — they
 * are the on-disk contract, so they are pinned by unit tests rather than
 * imported (dsh-runtime is not a host dependency).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

const decompressZstd = promisify(zstdDecompress);

/** Session format generation this host writes (see generationLogFilename). */
export const DSH_SESSION_LOG_GENERATION = 4;
export const DSH_SESSION_LOG_PLAIN_NAME = `session.v${DSH_SESSION_LOG_GENERATION}.jsonl`;
export const DSH_SESSION_LOG_ZSTD_NAME = `${DSH_SESSION_LOG_PLAIN_NAME}.zstd`;

/** Structural declaration of what the guard is allowed to do. Audited in
 *  tests so a future edit cannot quietly widen it. */
export const DSH_SESSION_LOG_GUARD_POLICY = {
  /** fsync only — the single mutating syscall the guard may issue. */
  mayFlush: true,
  /** The guard must never delete / truncate / rewrite / repair a log. */
  mayDelete: false,
  mayRewrite: false,
} as const;

// ── Path encoding (mirrors the persistence backend's on-disk contract) ──────

/**
 * One filesystem-safe path segment: [A-Za-z0-9._-] kept verbatim, every other
 * code unit escaped as `~XXXX` (uppercase hex, 4 digits). Mirrors
 * encodeSegment() in @deepseek-ai/dsh-session-persistence-jsonl.
 */
export function encodeDshSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Human-navigable project directory name for a session cwd: `/`, `\` and `:`
 * collapse into single `-` runs, other unsafe code units escape, leading
 * dashes are stripped, the result is truncated to 251 chars and wrapped in
 * `--`. Mirrors projectKey() in @deepseek-ai/dsh-session-persistence-jsonl.
 */
export function dshProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** Session directory path for one (cwd, session id) pair. */
export function dshSessionDirFor(sessionRoot: string, cwd: string | null, sessionId: string): string {
  const projectDir = cwd === null ? path.join(sessionRoot, '_no-cwd') : path.join(sessionRoot, dshProjectKey(cwd));
  return path.join(projectDir, encodeDshSessionSegment(sessionId));
}

/** Candidate log artifact paths for a session dir (zstd first, then plain —
 *  a root mid-migration legitimately carries either). */
export function dshSessionLogCandidates(sessionDir: string): string[] {
  return [
    path.join(sessionDir, DSH_SESSION_LOG_ZSTD_NAME),
    path.join(sessionDir, DSH_SESSION_LOG_PLAIN_NAME),
  ];
}

// ── Header-frame invariant ─────────────────────────────────────────────────

export interface DshSessionHeaderLine {
  type: 'session';
  version: number;
  id: string;
  createdAt: number;
}

/**
 * Whether one decoded line is a session header line. Mirrors the persistence
 * backend's REQUIRED-KEY check narrowed to what the guard needs: type, a
 * positive-integer version, a non-empty id, a finite createdAt. Extra keys are
 * tolerated (the backend also allows cwd/parentSession/origin/agentPreset).
 */
export function isDshSessionHeaderLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  return record.type === 'session'
    && typeof record.version === 'number'
    && Number.isSafeInteger(record.version)
    && record.version >= 0
    && typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.createdAt === 'number'
    && Number.isSafeInteger(record.createdAt)
    && record.createdAt >= 0;
}

/**
 * First frame of a zstd artifact, as the raw bytes of frame 1 only. Walks the
 * frame headers without decompressing blocks (the same header walk the
 * persistence backend's scanZstdFrames performs — that package does not export
 * it, so the shape is mirrored here). Returns null when the first frame cannot
 * be located (corrupt magic / truncated header).
 */
export function readFirstZstdFrame(buffer: Buffer): Buffer | null {
  const ZSTD_FRAME_MAGIC = 0xfd2fb528;
  if (buffer.length < 8 || buffer.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) return null;
  let offset = 4;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  if ((descriptor & 24) !== 0) return null; // reserved frame-header bit
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  for (;;) {
    if (offset + 3 > buffer.length) return null; // truncated block header
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) return null; // reserved block type
    offset += blockType === 1 ? 1 : blockSize;
    if (offset > buffer.length) return null; // truncated block body
    if (lastBlock) break;
  }
  if (checksum) offset += 4;
  if (offset > buffer.length) return null;
  return buffer.subarray(0, offset);
}

/**
 * The first decoded line of an artifact: (a) zstd → decompress frame 1 only;
 * (b) plaintext → the bytes up to the first newline. Returns null when no
 * first line exists at all (0-byte file, header frame absent or undecodable).
 */
export async function readFirstSessionLogLine(
  artifactPath: string,
  buffer: Buffer,
): Promise<{ firstLine: string | null; verdict: SessionLogVerdict; detail: string }> {
  if (buffer.length === 0) {
    return { firstLine: null, verdict: 'empty', detail: '0-byte artifact' };
  }
  const isZstd = artifactPath.endsWith('.zstd');
  if (!isZstd) {
    const newline = buffer.indexOf(10);
    if (newline === -1) {
      // A plaintext artifact whose only content is the header line and no
      // trailing newline is still readable; anything else with no newline and
      // no valid header is header-less.
      const text = buffer.toString('utf8');
      return isDshSessionHeaderLine(text)
        ? { firstLine: text, verdict: 'ok', detail: 'header line (no trailing newline)' }
        : { firstLine: null, verdict: 'missing_header', detail: 'no header line' };
    }
    const firstLine = buffer.subarray(0, newline).toString('utf8');
    return isDshSessionHeaderLine(firstLine)
      ? { firstLine, verdict: 'ok', detail: `header frame (${buffer.length} bytes)` }
      : { firstLine, verdict: 'missing_header', detail: 'frame 1 is not a session header line' };
  }
  const frame = readFirstZstdFrame(buffer);
  if (!frame) {
    return { firstLine: null, verdict: 'missing_header', detail: 'zstd frame 1 is unreadable' };
  }
  try {
    const decoded = await decompressZstd(frame);
    // Frame 1 must carry EXACTLY one line: the header. A frame that decodes
    // to more means the artifact was written by a foreign encoder and the
    // first-frame invariant no longer holds for it.
    const text = decoded.toString('utf8');
    const newline = text.indexOf('\n');
    const firstLine = newline === -1 ? text : text.slice(0, newline);
    if (!isDshSessionHeaderLine(firstLine)) {
      return { firstLine, verdict: 'missing_header', detail: 'zstd frame 1 is not a session header line' };
    }
    if (newline !== -1 && text.slice(newline + 1).trim().length > 0) {
      return { firstLine, verdict: 'header_not_isolated', detail: 'frame 1 carries more than the header line' };
    }
    return { firstLine, verdict: 'ok', detail: `header frame (${frame.length}/${buffer.length} bytes)` };
  } catch (error) {
    return {
      firstLine: null,
      verdict: 'missing_header',
      detail: `zstd frame 1 failed to decompress: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type SessionLogVerdict = 'ok' | 'empty' | 'missing_header' | 'header_not_isolated' | 'unreadable';

export interface SessionLogGuardAuditLine {
  /** Which layer produced the line: quit flush/verify, startup scan, audit of
   *  a directory entry, or a skipped path. */
  step: 'quit_flush' | 'quit_verify' | 'startup_scan' | 'startup_probe';
  path: string;
  verdict: SessionLogVerdict;
  sizeBytes: number | null;
  mtimeMs: number | null;
  detail: string;
}

/**
 * Flush (fsync) ONE artifact. Never writes a byte. Returns the size after the
 * fsync and whether the flush succeeded; a missing file is reported as
 * `sizeBytes: null` with `error: null` and is NOT an error (the guard runs on
 * shutdown, a removed temp file is normal).
 *
 * Windows: FlushFileBuffers requires a write-mode handle — fsync on the POSIX
 * `'r'` handle fails with EPERM on EVERY quit, which both defeated the whole
 * durability layer and spammed the quit audit with false 'unreadable' verdicts
 * (every Windows upgrade force-kills the app, so this flush is the only thing
 * standing between the runtime's buffered log bytes and `taskkill /F`). There
 * the handle is opened `'r+'` instead: no byte is ever written, the write
 * access only satisfies the API. Any remaining Windows fsync refusal (e.g. an
 * antivirus holding the artifact) degrades to a clean "skipped" audit —
 * `flushed:false, error:null` with a `detail` — so the quit verdict stays
 * 'ok' instead of a false alarm. POSIX keeps the strictly-read-only `'r'`
 * handle and real error reporting.
 */
export async function flushSessionLogArtifact(
  artifactPath: string,
): Promise<{ sizeBytes: number | null; mtimeMs: number | null; flushed: boolean; error: string | null; detail?: string }> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(artifactPath, process.platform === 'win32' ? 'r+' : 'r');
    const stat = await handle.stat();
    await handle.sync();
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, flushed: true, error: null };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'ENOENT') {
      return { sizeBytes: null, mtimeMs: null, flushed: false, error: null };
    }
    if (process.platform === 'win32') {
      return {
        sizeBytes: null,
        mtimeMs: null,
        flushed: false,
        error: null,
        detail: `fsync skipped on win32 (${code ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      sizeBytes: null,
      mtimeMs: null,
      flushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Quit layer (a): flush + first-frame verification for one session's artifacts.
 * Picks the artifact that exists (zstd first), flushes it, then re-reads and
 * verifies the first-frame invariant. NEVER mutates the file — a failed check
 * is reported, not repaired.
 */
export async function guardSessionLogAtQuit(
  sessionDir: string,
  log: (line: SessionLogGuardAuditLine) => void,
): Promise<SessionLogVerdict | 'absent'> {
  const candidates = dshSessionLogCandidates(sessionDir);
  for (const artifactPath of candidates) {
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(artifactPath);
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT') continue;
      log({
        step: 'quit_flush',
        path: artifactPath,
        verdict: 'unreadable',
        sizeBytes: null,
        mtimeMs: null,
        detail: `stat failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 'unreadable';
    }
    if (!stat.isFile()) continue;

    const flush = await flushSessionLogArtifact(artifactPath);
    log({
      step: 'quit_flush',
      path: artifactPath,
      verdict: flush.error ? 'unreadable' : 'ok',
      sizeBytes: flush.sizeBytes,
      mtimeMs: flush.mtimeMs,
      detail: flush.error
        ? `fsync failed: ${flush.error}`
        : flush.detail ?? `fsync ok (${flush.sizeBytes ?? 0} bytes durable)`,
    });

    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(artifactPath);
    } catch (error) {
      log({
        step: 'quit_verify',
        path: artifactPath,
        verdict: 'unreadable',
        sizeBytes: flush.sizeBytes,
        mtimeMs: flush.mtimeMs,
        detail: `read-back failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 'unreadable';
    }
    const { verdict, detail } = await readFirstSessionLogLine(artifactPath, buffer);
    log({
      step: 'quit_verify',
      path: artifactPath,
      verdict,
      sizeBytes: buffer.length,
      mtimeMs: flush.mtimeMs,
      detail,
    });
    return verdict;
  }
  // No artifact for this session (never flushed a turn, or already migrated
  // away). Not an incident — audited so the quit sequence is complete.
  log({
    step: 'quit_flush',
    path: sessionDir,
    verdict: 'unreadable',
    sizeBytes: null,
    mtimeMs: null,
    detail: 'no session log artifact present (never written or already migrated)',
  });
  return 'absent';
}

/**
 * Quit layer entry point: guard every active DSH session's log. `targets` come
 * from the runner (dsh session id + the session cwd the artifact path keys on).
 * Never throws, never blocks the quit on a failure.
 */
export async function guardActiveSessionLogsAtQuit(
  sessionRoot: string,
  targets: ReadonlyArray<{ dshSessionId: string; cwd: string | null }>,
  log: (line: SessionLogGuardAuditLine) => void,
): Promise<{ checked: number; ok: number; warned: number }> {
  let ok = 0;
  let warned = 0;
  for (const target of targets) {
    try {
      const sessionDir = dshSessionDirFor(sessionRoot, target.cwd, target.dshSessionId);
      const verdict = await guardSessionLogAtQuit(sessionDir, log);
      if (verdict === 'ok') ok += 1;
      else warned += 1;
    } catch (error) {
      warned += 1;
      log({
        step: 'quit_verify',
        path: target.dshSessionId,
        verdict: 'unreadable',
        sizeBytes: null,
        mtimeMs: null,
        detail: `guard failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { checked: targets.length, ok, warned };
}

/**
 * Startup layer (b): scan the session root and report every artifact whose
 * first-frame invariant fails (0-byte, header-less, unreadable). READ-ONLY:
 * nothing is deleted, moved, or rewritten — the scan only produces WARN lines
 * carrying the path, its mtime and size, so a repeat of the 2026-10-19
 * incident is at least visible the next boot.
 *
 * Bounded on purpose: a deep root can hold thousands of artifacts and boot
 * must not pay for them. `maxArtifacts` caps the walk; `maxReported` caps the
 * report. Directories are walked in sorted order so the cap is deterministic.
 */
export async function scanSessionLogsForHeaderInvariant(input: {
  sessionRoot: string;
  maxArtifacts?: number;
  maxReported?: number;
  projectDirs?: string[];
}): Promise<{ scanned: number; ok: number; problems: SessionLogGuardAuditLine[]; truncated: boolean }> {
  const maxArtifacts = input.maxArtifacts ?? 400;
  const maxReported = input.maxReported ?? 50;
  const problems: SessionLogGuardAuditLine[] = [];
  let scanned = 0;
  let ok = 0;
  let truncated = false;

  const projectDirs = input.projectDirs
    ?? (await listDirectoriesByRecency(input.sessionRoot)).map((dir) => dir.name);
  for (const projectDir of projectDirs) {
    if (scanned >= maxArtifacts) { truncated = true; break; }
    const sessionDirs = (await listDirectoriesByRecency(path.join(input.sessionRoot, projectDir))).map((dir) => dir.name);
    for (const sessionDirName of sessionDirs) {
      if (scanned >= maxArtifacts) { truncated = true; break; }
      const sessionDir = path.join(input.sessionRoot, projectDir, sessionDirName);
      for (const artifactName of [DSH_SESSION_LOG_ZSTD_NAME, DSH_SESSION_LOG_PLAIN_NAME]) {
        const artifactPath = path.join(sessionDir, artifactName);
        let stat: Awaited<ReturnType<typeof fsp.stat>>;
        try {
          stat = await fsp.stat(artifactPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        scanned += 1;
        let buffer: Buffer;
        try {
          buffer = await fsp.readFile(artifactPath);
        } catch (error) {
          if (problems.length < maxReported) {
            problems.push({
              step: 'startup_scan',
              path: artifactPath,
              verdict: 'unreadable',
              sizeBytes: stat.size,
              mtimeMs: stat.mtimeMs,
              detail: `read failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          continue;
        }
        const { verdict, detail } = await readFirstSessionLogLine(artifactPath, buffer);
        if (verdict === 'ok') { ok += 1; continue; }
        if (problems.length < maxReported) {
          problems.push({
            step: 'startup_scan',
            path: artifactPath,
            verdict,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
            detail,
          });
        }
        if (scanned >= maxArtifacts) { truncated = true; break; }
      }
    }
  }
  return { scanned, ok, problems, truncated };
}

/**
 * Directories under `parent`, newest-mtime FIRST. Ordering is load-bearing:
 * the scan is capped (a deep root holds thousands of sessions), and the class
 * of artifact this check exists for is exactly the RECENT one — the 2026-10-19
 * incident left 0-byte files whose mtimes sat on the shutdown instant. An
 * alphabetical cap would instead re-scan the same oldest directories every
 * boot and never reach the incident region. Unreadable entries sort last.
 */
async function listDirectoriesByRecency(parent: string): Promise<Array<{ name: string; mtimeMs: number }>> {
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const withMtime = await Promise.all(dirs.map(async (name) => {
      try {
        const stat = await fsp.stat(path.join(parent, name));
        return { name, mtimeMs: stat.mtimeMs };
      } catch {
        return { name, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    }));
    return withMtime.sort((a, b) => (b.mtimeMs === a.mtimeMs ? 0 : b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Render one audit line as the single log string every layer emits. */
export const formatSessionLogAuditLine = (line: SessionLogGuardAuditLine): string =>
  `[SessionLogGuard] ${line.step} ${line.path} — verdict=${line.verdict}`
  + ` size=${line.sizeBytes ?? 'n/a' } mtime=${line.mtimeMs == null ? 'n/a' : new Date(line.mtimeMs).toISOString()} :: ${line.detail}`;
