/**
 * preview-metaapp:// / preview-file:// URI construction for local paths.
 * Each path segment is percent-encoded (userData lives under
 * "Application Support" on macOS, so spaces are guaranteed); the preview
 * server decodes them back to a filesystem path.
 */
export function encodeLocalPreviewPath(localPath: string): string {
  return localPath.split('/').map((segment) => {
    if (/^[A-Za-z]:$/u.test(segment)) return segment;
    return encodeURIComponent(segment);
  }).join('/');
}

export function previewMetaappUriForPath(localPath: string): string {
  return `preview-metaapp://localhost${encodeLocalPreviewPath(localPath)}`;
}
