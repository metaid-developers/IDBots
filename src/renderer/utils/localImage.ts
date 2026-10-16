// Shared local-image helpers.
//
// Two surfaces need to agree on what counts as a local image path and on how
// such a path is turned into something renderable: the session transcript
// (image preview strip under an assistant message) and the composer
// (attachments typed/pasted into the input box). Keeping the extension test
// and the preview read in one module means they can never drift apart, and the
// composer no longer shows an attached screenshot as "image-1730000000000.png".

export const LOCAL_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

export const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

export const hasSupportedImageExtension = (value: string): boolean => {
  const base = stripHashAndQuery(value.trim());
  const match = /\.([A-Za-z0-9]+)$/.exec(base);
  if (!match) return false;
  return LOCAL_IMAGE_EXTENSIONS.has(match[1].toLowerCase());
};

export const LOCAL_IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type LocalImagePreviewEntry =
  | { status: 'ready'; dataUrl: string }
  | { status: 'error' };

const localImagePreviewCache = new Map<string, LocalImagePreviewEntry>();

/** Cache lookup used by render paths: resolves synchronously, no IPC. */
export const getLocalImagePreviewEntry = (path: string): LocalImagePreviewEntry | undefined => (
  localImagePreviewCache.get(path)
);

export const setLocalImagePreviewEntry = (
  path: string,
  entry: LocalImagePreviewEntry,
): LocalImagePreviewEntry => {
  localImagePreviewCache.set(path, entry);
  return entry;
};

/**
 * Resolve a local image into a data URL, memoized per path. Reads never throw:
 * a failed or unsupported read is cached as `error` so the caller can render a
 * non-empty fallback instead of an empty hole.
 */
export const loadLocalImagePreview = async (
  path: string,
  maxBytes: number = LOCAL_IMAGE_PREVIEW_MAX_BYTES,
): Promise<LocalImagePreviewEntry> => {
  const cached = localImagePreviewCache.get(path);
  if (cached) return cached;

  try {
    const result = await window.electron.cowork.readLocalImage({ path, maxBytes });
    if (result?.success && typeof result.dataUrl === 'string' && result.dataUrl) {
      return setLocalImagePreviewEntry(path, { status: 'ready', dataUrl: result.dataUrl });
    }
  } catch (error) {
    console.error('Failed to read local image preview:', path, error);
  }
  return setLocalImagePreviewEntry(path, { status: 'error' });
};
