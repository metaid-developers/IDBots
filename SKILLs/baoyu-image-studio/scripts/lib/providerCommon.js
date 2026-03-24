const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function getFetch(fetchImpl) {
  const resolved = fetchImpl || globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new Error('Global fetch is unavailable in this runtime.');
  }
  return resolved;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeQuality(value) {
  return value === 'normal' ? 'normal' : '2k';
}

function normalizeCount(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function parseDataUrl(value) {
  const match = normalizeString(value).match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || 'image/png',
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(normalizeString(value));
}

function isFileUrl(value) {
  return /^file:\/\//i.test(normalizeString(value));
}

function mimeTypeFromFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function extensionFromMimeType(mimeType) {
  const normalized = normalizeString(mimeType).toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/bmp') return '.bmp';
  if (normalized === 'image/tiff') return '.tiff';
  if (normalized === 'image/svg+xml') return '.svg';
  return '.png';
}

function sourceBasename(source) {
  const value = normalizeString(source);
  if (!value) {
    return 'reference.png';
  }
  if (isHttpUrl(value) || isFileUrl(value)) {
    try {
      const parsed = new URL(value);
      const fileName = path.basename(parsed.pathname);
      return fileName || 'reference.png';
    } catch {
      return 'reference.png';
    }
  }
  return path.basename(value) || 'reference.png';
}

async function downloadToBuffer(url, fetchImpl, extraHeaders) {
  const fetchFn = getFetch(fetchImpl);
  const response = await fetchFn(url, {
    headers: extraHeaders,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Failed to download image (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const mimeType = normalizeString(response.headers.get('content-type')) || mimeTypeFromFileName(url);
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
  };
}

async function readSourceBytes(source, fetchImpl) {
  const value = normalizeString(source);
  if (!value) {
    throw new Error('Reference image source is empty.');
  }

  const inline = parseDataUrl(value);
  if (inline) {
    return inline;
  }

  if (isHttpUrl(value)) {
    return downloadToBuffer(value, fetchImpl);
  }

  let resolvedPath = value;
  if (isFileUrl(value)) {
    resolvedPath = new URL(value).pathname;
  }

  const buffer = await fsp.readFile(resolvedPath);
  return {
    buffer,
    mimeType: mimeTypeFromFileName(resolvedPath),
  };
}

async function readSourceAsDataUrl(source, fetchImpl) {
  const { buffer, mimeType } = await readSourceBytes(source, fetchImpl);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeReferenceImages(payload = {}) {
  const values = [];
  const candidates = [
    payload.referenceImages,
    payload.references,
    payload.images,
    payload.image,
    payload.referenceImage,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      values.push(...candidate);
    } else if (candidate != null) {
      values.push(candidate);
    }
  }

  return Array.from(
    new Set(
      values
        .map((item) => normalizeString(item))
        .filter(Boolean),
    ),
  );
}

function normalizeOptions(payload = {}) {
  return {
    aspectRatio: normalizeString(payload.aspectRatio || payload.ar || payload.ratio),
    size: normalizeString(payload.size),
    imageSize: normalizeString(payload.imageSize || payload.resolution),
    quality: normalizeQuality(payload.quality),
    n: normalizeCount(payload.n || payload.count || payload.imagesCount, 1),
    referenceImages: normalizeReferenceImages(payload),
  };
}

async function materializeImageResult(imageResult, outputPath, fetchImpl) {
  if (!imageResult) {
    throw new Error('Provider returned an empty image result.');
  }

  if (typeof imageResult === 'object' && imageResult.outputPath) {
    return {
      outputPath: imageResult.outputPath,
      mimeType: imageResult.mimeType || mimeTypeFromFileName(imageResult.outputPath),
      extension: path.extname(imageResult.outputPath) || '.png',
    };
  }

  let buffer = null;
  let mimeType = null;
  let extension = null;

  if (Buffer.isBuffer(imageResult)) {
    buffer = imageResult;
  } else if (imageResult instanceof Uint8Array) {
    buffer = Buffer.from(imageResult);
  } else if (imageResult instanceof ArrayBuffer) {
    buffer = Buffer.from(imageResult);
  } else if (typeof imageResult === 'object') {
    if (Buffer.isBuffer(imageResult.bytes) || imageResult.bytes instanceof Uint8Array) {
      buffer = Buffer.from(imageResult.bytes);
    } else if (imageResult.buffer instanceof ArrayBuffer) {
      buffer = Buffer.from(imageResult.buffer);
    } else if (typeof imageResult.base64 === 'string' && imageResult.base64.trim()) {
      buffer = Buffer.from(imageResult.base64.trim(), 'base64');
    } else if (typeof imageResult.dataUrl === 'string') {
      const parsed = parseDataUrl(imageResult.dataUrl);
      if (parsed) {
        buffer = parsed.buffer;
        mimeType = parsed.mimeType;
      }
    } else if (typeof imageResult.url === 'string' || typeof imageResult.downloadUrl === 'string') {
      const downloaded = await downloadToBuffer(imageResult.url || imageResult.downloadUrl, fetchImpl, imageResult.headers);
      buffer = downloaded.buffer;
      mimeType = downloaded.mimeType;
    }

    if (typeof imageResult.mimeType === 'string' && imageResult.mimeType.trim()) {
      mimeType = imageResult.mimeType.trim();
    }
    if (typeof imageResult.extension === 'string' && imageResult.extension.trim()) {
      extension = imageResult.extension.trim().startsWith('.')
        ? imageResult.extension.trim()
        : `.${imageResult.extension.trim()}`;
    }
  }

  if (!buffer) {
    throw new Error('Provider did not return image bytes, a data URL, or a downloadable image URL.');
  }

  const finalPath = path.extname(outputPath)
    ? outputPath
    : `${outputPath}${extension || extensionFromMimeType(mimeType)}`;
  ensureParentDir(finalPath);
  fs.writeFileSync(finalPath, buffer);

  return {
    outputPath: finalPath,
    mimeType: mimeType || 'image/png',
    extension: path.extname(finalPath) || extension || extensionFromMimeType(mimeType),
  };
}

module.exports = {
  downloadToBuffer,
  ensureParentDir,
  extensionFromMimeType,
  getFetch,
  materializeImageResult,
  mimeTypeFromFileName,
  normalizeOptions,
  normalizeReferenceImages,
  normalizeString,
  parseDataUrl,
  readSourceAsDataUrl,
  readSourceBytes,
  sourceBasename,
};
