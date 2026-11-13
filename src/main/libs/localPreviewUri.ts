/**
 * preview-metaapp:// / preview-file:// URI construction for local paths.
 * Each path segment is percent-encoded (userData lives under
 * "Application Support" on macOS, so spaces are guaranteed); the preview
 * server decodes them back to a filesystem path.
 */
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//u;

export function encodeLocalPreviewPath(localPath: string): string {
  let normalized = localPath.replace(/\\/g, '/');
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    normalized = `/${normalized}`;
  }
  return normalized.split('/').map((segment) => {
    if (/^[A-Za-z]:$/u.test(segment)) return segment;
    return encodeURIComponent(segment);
  }).join('/');
}

export function previewMetaappUriForPath(localPath: string): string {
  return `preview-metaapp://localhost${encodeLocalPreviewPath(localPath)}`;
}
