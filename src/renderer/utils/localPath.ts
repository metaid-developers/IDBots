// Shared local-path helpers.
//
// Every surface that turns a path carried by a transcript into something the
// renderer can act on has to answer the same questions: is this a local path at
// all, is it absolute, what does it resolve to against the session cwd, and how
// is its basename displayed? The transcript (CoworkSessionDetail) and the Bot
// Internet cowork sidebar panel (BotBrowserCoworkPanel) both need those
// answers, and two copies of the logic is exactly how a fix lands on one
// surface and silently misses the other. Keep it here, once.

import type { CoworkExecutionMode } from '../types/cowork';
import { stripHashAndQuery } from './localImage';

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(value);

const isAbsolutePath = (value: string): boolean => (
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
);

const isRelativePath = (value: string): boolean => !isAbsolutePath(value) && !hasScheme(value);
const SANDBOX_WORKSPACE_GUEST_ROOT = '/workspace/project';
const SANDBOX_WORKSPACE_LEGACY_ROOT = '/workspace';
const SANDBOX_WORKSPACE_RESERVED_DIRS = new Set(['skills', 'ipc', 'tmp']);
const SANDBOX_WORKSPACE_PATH_PATTERN = /\/workspace(?:\/project)?(?:\/[^\s'"`)\]}>,;:!?]*)?/g;

const isReservedSandboxSegment = (relativePath: string): boolean => {
  const [firstSegment] = relativePath.split('/');
  return Boolean(firstSegment && SANDBOX_WORKSPACE_RESERVED_DIRS.has(firstSegment.toLowerCase()));
};

const mapSandboxGuestPathToCwd = (filePath: string, cwd?: string): string | null => {
  if (!cwd) return null;

  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedCwd = cwd.replace(/[\\/]+$/, '');

  if (
    normalizedPath === SANDBOX_WORKSPACE_GUEST_ROOT
    || normalizedPath.startsWith(`${SANDBOX_WORKSPACE_GUEST_ROOT}/`)
  ) {
    const relativePath = normalizedPath
      .slice(SANDBOX_WORKSPACE_GUEST_ROOT.length)
      .replace(/^\/+/, '');
    if (relativePath && isReservedSandboxSegment(relativePath)) {
      return null;
    }
    return relativePath ? `${normalizedCwd}/${relativePath}` : normalizedCwd;
  }

  if (
    normalizedPath !== SANDBOX_WORKSPACE_LEGACY_ROOT
    && !normalizedPath.startsWith(`${SANDBOX_WORKSPACE_LEGACY_ROOT}/`)
  ) {
    return null;
  }

  const legacyRelativePath = normalizedPath
    .slice(SANDBOX_WORKSPACE_LEGACY_ROOT.length)
    .replace(/^\/+/, '');
  if (!legacyRelativePath) {
    return normalizedCwd;
  }

  if (isReservedSandboxSegment(legacyRelativePath)) {
    return null;
  }

  return `${normalizedCwd}/${legacyRelativePath}`;
};

export const mapSandboxGuestPathsInText = (value: string, cwd?: string): string => {
  if (!value || !cwd || !value.includes('/workspace')) {
    return value;
  }

  return value.replace(SANDBOX_WORKSPACE_PATH_PATTERN, (candidatePath) =>
    mapSandboxGuestPathToCwd(candidatePath, cwd) ?? candidatePath);
};

const parseRootRelativePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;
  const separatorIndex = trimmed.indexOf('::');
  if (separatorIndex < 0) return null;

  const rootPart = trimmed.slice(0, separatorIndex);
  const relativePart = trimmed.slice(separatorIndex + 2);
  if (!relativePart.trim()) return null;

  const rootPath = safeDecodeURIComponent(stripFileProtocol(stripHashAndQuery(rootPart)));
  const relativePath = safeDecodeURIComponent(stripHashAndQuery(relativePart));
  if (!rootPath || !relativePath) return null;

  const normalizedRoot = rootPath.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '');
  if (!normalizedRelative) return null;

  return `${normalizedRoot}/${normalizedRelative}`;
};

export const normalizeLocalPath = (
  value: string
): { path: string; isRelative: boolean; isAbsolute: boolean } | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fileScheme = /^file:\/\//i.test(trimmed);
  const schemePresent = hasScheme(trimmed);
  if (schemePresent && !fileScheme && !isAbsolutePath(trimmed)) return null;

  let raw = trimmed;
  if (fileScheme) {
    raw = stripFileProtocol(raw);
  }
  raw = stripHashAndQuery(raw);
  const decoded = safeDecodeURIComponent(raw);
  const path = decoded || raw;
  if (!path) return null;

  const isAbsolute = isAbsolutePath(path);
  const isRelative = isRelativePath(path);
  return { path, isRelative, isAbsolute };
};

const toAbsolutePathFromCwd = (filePath: string, cwd: string): string => {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }
  return `${cwd.replace(/\/$/, '')}/${filePath.replace(/^\.\//, '')}`;
};

/** Display basename of a local path (POSIX or Windows separators). */
export const getPathBaseName = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
};

/** `(href, text) => absolute path | null`, the shape every attachment surface takes. */
export type LocalFilePathResolver = (href: string, text: string) => string | null;

export interface LocalPathResolutionContext {
  cwd?: string | null;
  executionMode?: CoworkExecutionMode | null;
}

/**
 * Resolve a local path carried by a transcript against the session context.
 *
 * This is the single implementation behind both the transcript's
 * `resolveLocalFilePath` callback and the sidebar panel's resolver: an absolute
 * path (including `file://`) resolves as-is, a relative path joins the session
 * cwd, a `file://root::relative` value resolves against its declared root, and
 * in sandbox mode a `/workspace/...` guest path maps back to the host cwd.
 * Returns null when the value is not a resolvable local path.
 */
export const resolveLocalPathAgainstCwd = (
  href: string,
  text: string,
  context: LocalPathResolutionContext = {},
): string | null => {
  const hrefValue = typeof href === 'string' ? href.trim() : '';
  const textValue = typeof text === 'string' ? text.trim() : '';
  if (!hrefValue && !textValue) return null;

  const { cwd } = context;

  // In sandbox mode, translate VM guest paths to host paths.
  const mapSandboxPath = (filePath: string): string => {
    if (context.executionMode !== 'sandbox' || !cwd) {
      return filePath;
    }
    const mapped = mapSandboxGuestPathToCwd(filePath, cwd);
    return mapped ?? filePath;
  };

  const hrefRootRelative = hrefValue ? parseRootRelativePath(hrefValue) : null;
  if (hrefRootRelative) {
    return mapSandboxPath(hrefRootRelative);
  }

  const hrefPath = hrefValue ? normalizeLocalPath(hrefValue) : null;
  if (hrefPath) {
    if (hrefPath.isRelative && cwd) {
      return mapSandboxPath(toAbsolutePathFromCwd(hrefPath.path, cwd));
    }
    if (hrefPath.isAbsolute) {
      return mapSandboxPath(hrefPath.path);
    }
  }

  const textRootRelative = textValue ? parseRootRelativePath(textValue) : null;
  if (textRootRelative) {
    return mapSandboxPath(textRootRelative);
  }

  const textPath = textValue ? normalizeLocalPath(textValue) : null;
  if (textPath) {
    if (textPath.isRelative && cwd) {
      return mapSandboxPath(toAbsolutePathFromCwd(textPath.path, cwd));
    }
    if (textPath.isAbsolute) {
      return mapSandboxPath(textPath.path);
    }
  }

  return null;
};
