/**
 * Outbound image fitting for the Weixin channel.
 *
 * WeChat re-encodes images server side, so there is no documented send-size
 * limit; this module exists to avoid pushing a 40 MB camera original through a
 * mobile upload for no reason. The thresholds are OUR client-side guard
 * (`WEIXIN_IMAGE_COMPRESS_BYTES` / `WEIXIN_IMAGE_MAX_SIDE_PX`), not a platform
 * limit, and the callers degrade to sending the original whenever the encoder is
 * unavailable.
 *
 * Encoding uses Electron's built-in `nativeImage` — no new dependency. The
 * module is importable from plain Node (unit tests): electron is resolved lazily
 * and `compressWeixinImage` returns null when it is not there.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WEIXIN_IMAGE_COMPRESS_BYTES,
  WEIXIN_IMAGE_MAX_SIDE_PX,
} from './weixinMedia';

export interface WeixinImageSize {
  width: number | null;
  height: number | null;
}

export interface WeixinImageFitDecision {
  /** True when the caller should re-encode before upload. */
  needsCompression: boolean;
  /** Why: too many bytes, too many pixels, or unknown dimensions but oversize. */
  reason: 'bytes' | 'dimensions' | 'both' | null;
  /** Longest side to keep (null = keep the original dimensions). */
  targetLongSide: number | null;
}

/**
 * Decide whether an image needs re-encoding before upload.
 * Pure so the policy can be unit tested without an image encoder.
 */
export function decideWeixinImageCompression(
  input: { bytes: number; width?: number | null; height?: number | null },
  options: { maxBytes?: number; maxSide?: number } = {}
): WeixinImageFitDecision {
  const maxBytes = options.maxBytes ?? WEIXIN_IMAGE_COMPRESS_BYTES;
  const maxSide = options.maxSide ?? WEIXIN_IMAGE_MAX_SIDE_PX;
  const overBytes = Number.isFinite(input.bytes) && input.bytes > maxBytes;

  const width = input.width ?? null;
  const height = input.height ?? null;
  const known = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
  const longest = known ? Math.max(width as number, height as number) : 0;
  const overSide = known && longest > maxSide;

  if (!overBytes && !overSide) {
    return {
      needsCompression: false,
      reason: null,
      targetLongSide: null,
    };
  }

  return {
    needsCompression: true,
    reason: overBytes && overSide ? 'both' : overBytes ? 'bytes' : 'dimensions',
    // Only shrink dimensions when they actually exceed the cap; a large file that
    // already fits keeps its pixel size and is re-encoded at the same size.
    targetLongSide: overSide ? maxSide : null,
  };
}

interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike;
  toJPEG(quality: number): Buffer;
}

interface NativeImageModule {
  createFromPath(filePath: string): NativeImageLike;
}

/** Electron's nativeImage, or null outside Electron (plain-node tests). */
function loadNativeImage(): NativeImageModule | null {
  try {
    const electron = require('electron');
    const nativeImage = electron?.nativeImage;
    if (nativeImage && typeof nativeImage.createFromPath === 'function') {
      return nativeImage as NativeImageModule;
    }
  } catch {
    // Not running inside Electron.
  }
  return null;
}

export interface CompressedWeixinImage {
  /** Path to send (a temp file when compression actually happened). */
  path: string;
  bytes: number;
  width: number;
  height: number;
  /** True when `path` is a freshly encoded temp file the caller may delete. */
  temporary: boolean;
}

/**
 * Re-encode an oversize image as JPEG while keeping the long side within the cap.
 *
 * Returns null when no work is needed OR when the encoder is unavailable — both
 * mean "send the original", which is a successful outcome, not an error.
 */
export function compressWeixinImage(
  filePath: string,
  options: { maxBytes?: number; maxSide?: number; outputDir?: string } = {}
): CompressedWeixinImage | null {
  let bytes: number;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    bytes = stat.size;
  } catch {
    return null;
  }

  const nativeImage = loadNativeImage();
  if (!nativeImage) return null;

  let source: NativeImageLike;
  try {
    source = nativeImage.createFromPath(filePath);
  } catch {
    return null;
  }
  if (!source || source.isEmpty()) return null;

  const size = source.getSize();
  const decision = decideWeixinImageCompression(
    { bytes, width: size.width, height: size.height },
    options
  );
  if (!decision.needsCompression) return null;

  let target = source;
  if (decision.targetLongSide && Math.max(size.width, size.height) > decision.targetLongSide) {
    const scale = decision.targetLongSide / Math.max(size.width, size.height);
    target = source.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'best',
    });
  }

  const maxBytes = options.maxBytes ?? WEIXIN_IMAGE_COMPRESS_BYTES;
  // Quality ladder: stop as soon as the encoded result is under the byte cap.
  let encoded: Buffer | null = null;
  for (const quality of [82, 70, 60]) {
    const candidate = target.toJPEG(quality);
    if (!candidate || candidate.length === 0) continue;
    encoded = candidate;
    if (candidate.length <= maxBytes) break;
  }
  if (!encoded) return null;

  const outputDir = options.outputDir ?? path.join(os.tmpdir(), 'idbots-weixin-outbound');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `weixin_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`
  );
  fs.writeFileSync(outputPath, encoded, { mode: 0o600 });

  const encodedSize = target.getSize();
  return {
    path: outputPath,
    bytes: encoded.length,
    width: encodedSize.width,
    height: encodedSize.height,
    temporary: true,
  };
}
