/**
 * Pure core of `gateway:file:sign` (C2 "File Download", `02` P1-R with R-path).
 *
 * Confirms the requested path is real and confined to the tenant data root
 * (symlink escape included, because confinement runs on the realpath), stats
 * it, derives a MIME type from the extension, and mints a signed download
 * token good for 10 minutes.
 *
 * Pure module: node:fs / node:path only plus sibling gateway modules — no
 * electron imports, loadable from plain node.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRootList, isPathInside, resolveConfinementPath, type GatewayPaths } from './restrictions';
import { isGatewayError, makeError, type GatewayError } from './protocol';
import { signFileToken, type FileTokenDisposition } from './tokens';

/** C2 File Download: expiry "at most 10 minutes ahead". */
export const FILE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Tenant route for signed downloads; also the control-plane-relative URL form. */
export const FILE_ROUTE_PATH_PREFIX = '/gateway/v1/files';

/** Small built-in extension → MIME map for the download route's Content-Type. */
export const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const INLINE_PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.ts': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

export const DEFAULT_FILE_MIME = 'application/octet-stream';

export interface SignFileDownloadDeps {
  secret: string;
  tenantId: string;
  paths: GatewayPaths;
  /** Injected for testability; fs.realpathSync in production. */
  realpathSync: (target: string) => string;
}

export interface SignFileDownloadInput {
  path: string;
  disposition?: FileTokenDisposition;
}

export interface SignedFileDownload {
  url: string;
  expiresAt: number;
  size: number;
  mime: string;
}

export function mimeForPath(filePath: string, disposition: FileTokenDisposition = 'attachment'): string {
  const extension = path.extname(filePath).toLowerCase();
  if (disposition === 'inline') {
    const previewMime = INLINE_PREVIEW_MIME_BY_EXTENSION[extension];
    if (previewMime) return previewMime;
  }
  return FILE_MIME_BY_EXTENSION[extension] ?? DEFAULT_FILE_MIME;
}

/**
 * Sign one file download. Returns `{ url, expiresAt, size, mime }` on success
 * or a GatewayError: INVALID_ARGS for a malformed/unreadable path,
 * ARG_RESTRICTED when the path escapes the data root (including via symlink).
 */
export function signFileDownload(
  deps: SignFileDownloadDeps,
  input: SignFileDownloadInput,
  now: number = Date.now(),
): SignedFileDownload | GatewayError {
  const rawPath = typeof input?.path === 'string' ? input.path.trim() : '';
  if (!rawPath) {
    return makeError('INVALID_ARGS', 'path is required');
  }
  const disposition: FileTokenDisposition = input.disposition === 'inline' ? 'inline' : 'attachment';

  const dataRoots = dataRootList(deps.paths).map(resolveConfinementPath);
  let resolved: string;
  try {
    // realpath follows symlinks, so a symlink pointing outside the data root
    // resolves to its out-of-root target and fails the containment check.
    resolved = deps.realpathSync(rawPath);
  } catch {
    return makeError('ARG_RESTRICTED', 'path does not resolve to a file inside the data root');
  }
  if (!dataRoots.some((root) => isPathInside(resolved, root))) {
    return makeError('ARG_RESTRICTED', 'path resolves outside the data root');
  }

  let size: number;
  try {
    size = fs.statSync(resolved).size;
  } catch {
    return makeError('INVALID_ARGS', 'path is not readable');
  }

  const expiresAt = now + FILE_TOKEN_TTL_MS;
  const token = signFileToken(deps.secret, deps.tenantId, resolved, disposition, expiresAt);
  return {
    url: `${FILE_ROUTE_PATH_PREFIX}/${token}`,
    expiresAt,
    size,
    mime: mimeForPath(resolved, disposition),
  };
}

/** Narrowing helper for the union return. */
export function isSignedFileDownload(value: unknown): value is SignedFileDownload {
  return !isGatewayError(value);
}
