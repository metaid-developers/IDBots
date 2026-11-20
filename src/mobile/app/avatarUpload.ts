/**
 * Avatar file → data-URL pipeline for the mobile edit form (A5).
 *
 * Browser-only (canvas): decode directly at the target size where the WebView
 * supports it, with the original <img> path as a compatibility fallback. The
 * pure geometry lives in a2aLimits.fitInside and is unit-tested separately.
 * Output is a 256px-wide `data:image/png` URL so the metabots.avatar BLOB stays small.
 */
import { fitInside } from './a2aLimits';

export const AVATAR_MAX_EDGE = 256;

function renderAvatar(source: CanvasImageSource, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { resizeWidth: AVATAR_MAX_EDGE, resizeQuality: 'high' });
      try {
        return renderAvatar(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close?.();
      }
    } catch {
      // Older WebViews may expose createImageBitmap without resize support.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('avatar decode failed'));
      element.src = objectUrl;
    });
    const { width, height } = fitInside(image.naturalWidth || AVATAR_MAX_EDGE, image.naturalHeight || AVATAR_MAX_EDGE, AVATAR_MAX_EDGE);
    return renderAvatar(image, width, height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
