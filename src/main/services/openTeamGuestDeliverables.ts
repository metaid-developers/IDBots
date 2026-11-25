/**
 * OpenTeam guest file delivery (M3): turn a guest skill turn's file output
 * into on-chain deliverables.
 *
 * This deliberately mirrors the private-chat order flow
 * (serviceDeliveryArtifacts.js + metaFileUploadService): collect the produced
 * file(s) — explicit paths mentioned in the assistant reply first, then a
 * time-windowed scan of the skill working directory — and publish each
 * on-chain paid by the GUEST bot's own wallet, with the protocol chosen by
 * content kind (MetaWeb URI convention): readable text documents (Markdown /
 * plain text) become simplenote notes delivered as
 * `[DELIVERABLE] note: pin://<pinId>` lines, binary files become metafiles
 * delivered as `[DELIVERABLE] metafile: metafile://<pinId><ext>` lines. Both
 * line shapes are exactly what groupTaskDeliverableParser ingests on the
 * inviter side (one deliverable per line, kind taken from the URI scheme).
 *
 * Only the collection helpers live here; the upload/publish itself stays
 * behind the daemon's injected seams (uploadDeliverableFile →
 * metaFileUploadService.uploadMetaFile, publishTextDeliverable →
 * deliverableTextNote.publishTextFileAsNote, both wired in main.ts) so tests
 * never touch a wallet or the chain.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import metaFileUploadShared from './metaFileUploadShared.js';
import { buildMetafileUri } from './serviceDeliveryArtifacts.js';
import { isSensitiveHostFilePath } from '../security/secretEgressGuard';

const { DEFAULT_MAX_FILE_SIZE_BYTES, inferContentTypeFromFilePath } = metaFileUploadShared;

/** Default cap on files delivered per guest turn (each upload costs the guest bot's own fees). */
export const DEFAULT_MAX_DELIVERABLE_FILES = 10; // quota audit 2026-09-17 (F1): was 3

/**
 * Deliverable file extensions. Same categories as serviceDeliveryArtifacts,
 * plus the common office/document formats document-generation skills emit
 * (the order flow's explicit-path regex misses those).
 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);
const DOC_EXTENSIONS = new Set([
  '.zip',
  '.pdf',
  '.txt',
  '.json',
  '.csv',
  '.md',
  '.html',
  '.xml',
  '.tar',
  '.gz',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.epub',
  '.rtf',
]);
const ALL_DELIVERABLE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...DOC_EXTENSIONS,
]);

/** Never descend into these while scanning the skill working directory. */
const IGNORED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  '.vite',
]);

/** How far outside the [turnStartedAt, turnCompletedAt] window a scanned file's mtime may drift. */
const SCAN_WINDOW_PRE_TOLERANCE_MS = 2_000;
const SCAN_WINDOW_POST_TOLERANCE_MS = 5_000;
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_CANDIDATES = 200;

export interface GuestDeliverableFile {
  filePath: string;
  fileName: string;
  contentType: string;
  size: number;
}

export interface CollectGuestDeliverableFilesInput {
  /**
   * Assistant text(s) of the skill turn, most important first (usually just
   * the final reply). Explicit file paths are extracted from these.
   */
  texts: string[];
  /**
   * Working directory the skill turn ran in: relative mentioned paths resolve
   * against it, and it is the root of the generated-file scan fallback.
   */
  cwd: string;
  /**
   * Allowlist root for every collected file (explicit mentions AND scan
   * results): anything outside is dropped and logged. Defaults to cwd — the
   * daemon wires cwd to the guest session's private workspace, so files can
   * never be picked up from arbitrary host paths or other processes' dirs.
   */
  allowedRoot?: string;
  /** Drop/audit log; defaults to a no-op. */
  emitLog?: (message: string) => void;
  /** Turn start (ms epoch); the scan fallback only picks files touched at/after this. */
  turnStartedAt?: number;
  /** Turn end (ms epoch); the scan fallback ignores files touched after this. */
  turnCompletedAt?: number;
  /** Cap on collected files (default DEFAULT_MAX_DELIVERABLE_FILES). */
  maxFiles?: number;
}

/** Trim prose decoration around a mentioned path, then resolve it against cwd. */
function normalizeMentionedPath(candidate: string, cwd: string): string {
  const trimmed = String(candidate || '')
    .trim()
    .replace(/^[`"'“‘《<（(]+/, '')
    .replace(/[`"'”’》。>,，,；;:：!！?？)）]+$/, '');
  if (!trimmed) return '';
  // Already on-chain references are not local files.
  if (/^metafile:\/\//i.test(trimmed)) return '';
  const expanded = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : trimmed;
  return path.resolve(cwd || process.cwd(), expanded);
}

function makeDeliverableFile(filePath: string): GuestDeliverableFile | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  // Over-limit files cannot go on-chain; skip them here so the daemon does not
  // attempt a doomed upload (the model is told to keep files under the limit).
  if (stat.size <= 0 || stat.size >= DEFAULT_MAX_FILE_SIZE_BYTES) return null;
  return {
    filePath,
    fileName: path.basename(filePath),
    contentType: inferContentTypeFromFilePath(filePath),
    size: stat.size,
  };
}

/** Explicit deliverable paths mentioned in the assistant text(s), in mention order. */
function collectExplicitFilePaths(texts: string[], cwd: string): string[] {
  const extensionPattern = Array.from(ALL_DELIVERABLE_EXTENSIONS)
    .map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(
    // \ and : in both character classes so Windows guest paths (C:\dir\file.txt)
    // match too — without them a Windows host never collects explicitly
    // mentioned deliverables (v1.1.3 tag run 45551178172 exposed the gap).
    String.raw`(?:^|[\s:：，,（(])([~./\\:A-Za-z0-9_\-][~./\\:A-Za-z0-9_@\-]*\.(${extensionPattern}))(?=$|[\s。；;，,)）])`,
    'gi',
  );
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const content = String(text || '');
    if (!content.trim()) continue;
    for (const match of content.matchAll(regex)) {
      const resolved = normalizeMentionedPath(match[1], cwd);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push(resolved);
    }
  }
  return candidates;
}

/** Scan cwd for deliverable-extension files modified inside the turn window (newest first). */
function scanGeneratedFilePaths(
  cwd: string,
  turnStartedAt: number,
  turnCompletedAt: number,
): string[] {
  const root = path.resolve(String(cwd || ''));
  if (!root) return [];
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || candidates.length > SCAN_MAX_CANDIDATES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length > SCAN_MAX_CANDIDATES) return;
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      if (!ALL_DELIVERABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < turnStartedAt - SCAN_WINDOW_PRE_TOLERANCE_MS) continue;
      if (stat.mtimeMs > turnCompletedAt + SCAN_WINDOW_POST_TOLERANCE_MS) continue;
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  };

  walk(root, 0);
  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((candidate) => candidate.filePath);
}

/**
 * Collect the file(s) a guest skill turn produced, in delivery order:
 * 1. paths explicitly mentioned in the assistant text(s) that exist on disk;
 * 2. otherwise, files inside the skill working directory whose mtime falls in
 *    the turn window (generated-but-unmentioned output).
 * Verified (existing, regular file, under the on-chain size limit), deduped,
 * capped at maxFiles. Every candidate — mentioned or scanned — must resolve
 * inside allowedRoot (default cwd); outside paths are dropped and logged so a
 * forged/absolute mention can never put an arbitrary host file on-chain.
 */
export function collectGuestDeliverableFiles(
  input: CollectGuestDeliverableFilesInput,
): GuestDeliverableFile[] {
  const maxFiles = Math.max(1, Math.trunc(input.maxFiles ?? DEFAULT_MAX_DELIVERABLE_FILES));
  const cwd = path.resolve(String(input.cwd || '') || process.cwd());
  const allowedRoot = path.resolve(String(input.allowedRoot ?? cwd) || cwd);
  const canonicalAllowedRoot = (() => {
    try {
      return fs.realpathSync(allowedRoot);
    } catch {
      return allowedRoot;
    }
  })();
  const emitLog = input.emitLog ?? (() => undefined);

  const isInsideAllowedRoot = (filePath: string): boolean => {
    const relative = path.relative(allowedRoot, filePath);
    if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
      return false;
    }
    // Reject symlinks and verify canonical realpath stays inside canonicalAllowedRoot
    // so a symlink placed inside cwd cannot exfiltrate host files like idbots.sqlite.
    try {
      const lstat = fs.lstatSync(filePath);
      if (lstat.isSymbolicLink()) return false;
      const realFile = fs.realpathSync(filePath);
      const realRel = path.relative(canonicalAllowedRoot, realFile);
      if (realRel !== '' && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
        return false;
      }
    } catch {
      return false;
    }
    if (isSensitiveHostFilePath(filePath)) {
      return false;
    }
    return true;
  };

  const collected: GuestDeliverableFile[] = [];
  const seen = new Set<string>();
  const push = (filePath: string): void => {
    if (collected.length >= maxFiles || seen.has(filePath)) return;
    if (!isInsideAllowedRoot(filePath)) {
      emitLog(
        `[OpenTeam] Deliverable dropped: ${filePath} is outside the allowed workspace ${allowedRoot}`,
      );
      return;
    }
    const artifact = makeDeliverableFile(filePath);
    if (!artifact) return;
    seen.add(filePath);
    collected.push(artifact);
  };

  for (const filePath of collectExplicitFilePaths(input.texts, cwd)) {
    push(filePath);
  }

  const startedAt = Number(input.turnStartedAt);
  if (collected.length === 0 && Number.isFinite(startedAt) && startedAt > 0) {
    const completedAt = Number.isFinite(Number(input.turnCompletedAt))
      ? Number(input.turnCompletedAt)
      : startedAt;
    for (const filePath of scanGeneratedFilePaths(cwd, startedAt, completedAt)) {
      push(filePath);
    }
  }

  return collected;
}

/**
 * Build the group deliverable line for one uploaded file:
 * `[DELIVERABLE] metafile: metafile://<pinId><ext>` — the exact line shape
 * groupTaskDeliverableParser records as a valid `metafile` deliverable.
 * Returns null when the upload produced no usable pinId.
 */
export function buildGuestMetafileDeliverableLine(input: {
  pinId: string;
  fileName?: string;
  contentType?: string;
}): string | null {
  const uri = buildMetafileUri(input.pinId, {
    fileName: input.fileName,
    contentType: input.contentType,
  });
  if (!uri) return null;
  return `[DELIVERABLE] metafile: ${uri}`;
}

/**
 * Build the group deliverable line for a readable text document published as
 * a simplenote note: `[DELIVERABLE] note: pin://<pinId>` — recorded by
 * groupTaskDeliverableParser as a valid `pinid` deliverable. MetaWeb URI
 * convention: text documents cite pin://; metafile:// is for binary payloads.
 * Returns null when the publish produced no usable pinId.
 */
export function buildGuestNoteDeliverableLine(input: {
  pinId: string;
  fileName?: string;
}): string | null {
  const pinId = typeof input.pinId === 'string' ? input.pinId.trim().toLowerCase() : '';
  if (!pinId) return null;
  return `[DELIVERABLE] note: pin://${pinId}`;
}
