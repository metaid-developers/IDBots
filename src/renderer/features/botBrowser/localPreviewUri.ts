import { classifyLocalFile } from '@openagentinternet/agent-browser-core';

const HTML_FILE_RE = /\.html?$/iu;
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//u;
// Mirrors classifyLocalFile's named-file tables (core keeps them private).
const KNOWN_EXTENSIONLESS_FILENAMES = new Set([
  'readme', 'license', 'changelog', 'dockerfile', 'makefile',
]);

/**
 * Turn an absolute local path into the Bot Browser URI that previews it in a
 * tab: HTML pages and directories (app folders) go through preview-metaapp,
 * other previewable documents (markdown, text, code, csv, pdf, images,
 * video, audio) through preview-file. Returns null for paths the Bot Browser
 * cannot preview so callers keep their shell.openPath fallback.
 */
export function buildLocalPreviewUri(absPath: string): string | null {
  const raw = typeof absPath === 'string' ? absPath.trim() : '';
  if (!raw) return null;

  let normalized = raw.replace(/\\/g, '/');
  // Windows drive form: C:/x/y -> /C:/x/y (the URI path must stay absolute).
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    normalized = `/${normalized}`;
  }
  if (!normalized.startsWith('/')) return null;

  const isDirectory = normalized.endsWith('/');
  const trimmedPath = isDirectory ? normalized.replace(/\/+$/u, '') : normalized;
  const encodedPath = trimmedPath.split('/').map((segment) => {
    // The Windows drive segment keeps its literal ':' — preview URIs use the
    // /C:/x/y form, and parsePreviewFileUri rejects a percent-encoded drive.
    if (/^[A-Za-z]:$/u.test(segment)) return segment;
    return encodeURIComponent(segment);
  }).join('/');

  if (isDirectory || HTML_FILE_RE.test(trimmedPath)) {
    return `preview-metaapp://localhost${encodedPath}`;
  }
  const basename = trimmedPath.split('/').pop() ?? '';
  // classifyLocalFile treats every extensionless name as text, which would
  // misroute folder links ("/x/project/src") to preview-file where they fail.
  // Only the named files core itself recognizes (README/LICENSE/CHANGELOG,
  // Dockerfile/Makefile, dotfiles like .gitignore/.env) preview as text/code.
  if (!basename.includes('.') && !KNOWN_EXTENSIONLESS_FILENAMES.has(basename.toLowerCase())) {
    return null;
  }
  if (classifyLocalFile(trimmedPath).kind === 'unsupported') {
    return null;
  }
  return `preview-file://localhost${encodedPath}`;
}
