import JSZip from 'jszip';
import {
  buildMetafileAcceleratedContentUrl,
  preparePreviewHtml,
  type MetaAppPreviewSessionFactory,
} from '@openagentinternet/agent-browser-core';
import { publishMobilePreviewFile } from './mobilePreviewPublisher';

const METAFILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const METAFILE_ACCELERATE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
const MAX_PACKAGE_BYTES = 30 * 1024 * 1024;
const MAX_PACKAGE_FILES = 512;

const MIME_BY_EXTENSION: Record<string, string> = {
  css: 'text/css',
  gif: 'image/gif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  png: 'image/png',
  svg: 'image/svg+xml',
  ts: 'text/plain',
  txt: 'text/plain',
  wasm: 'application/wasm',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  xml: 'application/xml',
};

type PublishPreview = (file: { name: string; data: Uint8Array; mime: string }) => Promise<string>;

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

function normalizePackagePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  return normalized;
}

function resolvePackageReference(reference: string, fromPath: string): string {
  const value = reference.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
  try {
    const url = new URL(value, `https://metaapp.local/${fromPath}`);
    return normalizePackagePath(decodeURIComponent(url.pathname));
  } catch {
    return '';
  }
}

function rewriteCssResources(css: string, fromPath: string, objectUrls: ReadonlyMap<string, string>): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/giu, (match, quote: string, reference: string) => {
    const resolved = resolvePackageReference(reference, fromPath);
    const replacement = resolved ? objectUrls.get(resolved) : '';
    return replacement ? `url(${quote}${replacement}${quote})` : match;
  });
}

function rewriteSrcset(srcset: string, fromPath: string, objectUrls: ReadonlyMap<string, string>): string {
  return srcset.split(',').map((candidate) => {
    const trimmed = candidate.trim();
    const [reference, ...descriptors] = trimmed.split(/\s+/u);
    const resolved = resolvePackageReference(reference ?? '', fromPath);
    const replacement = resolved ? objectUrls.get(resolved) : '';
    return replacement ? [replacement, ...descriptors].join(' ') : trimmed;
  }).join(', ');
}

export function rewriteMobileMetaAppHtml(
  html: string,
  fromPath: string,
  objectUrls: ReadonlyMap<string, string>,
): string {
  const rewritten = html.replace(/(^|\s)(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu, (match, prefix: string, attribute: string, doubleQuoted: string, singleQuoted: string) => {
    const quote = doubleQuoted !== undefined ? '"' : "'";
    const value = doubleQuoted ?? singleQuoted ?? '';
    const resolved = resolvePackageReference(value, fromPath);
    const replacement = resolved ? objectUrls.get(resolved) : '';
    return replacement ? `${prefix}${attribute}=${quote}${replacement}${quote}` : match;
  });
  return rewritten.replace(/(^|\s)(srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu, (_match, prefix: string, attribute: string, doubleQuoted: string, singleQuoted: string) => {
    const quote = doubleQuoted !== undefined ? '"' : "'";
    const value = doubleQuoted ?? singleQuoted ?? '';
    return `${prefix}${attribute}=${quote}${rewriteSrcset(value, fromPath, objectUrls)}${quote}`;
  });
}

export function rewriteMobileMetaAppJavaScript(
  source: string,
  fromPath: string,
  objectUrls: ReadonlyMap<string, string>,
): string {
  const replaceReference = (match: string, prefix: string, reference: string, suffix: string): string => {
    const resolved = resolvePackageReference(reference, fromPath);
    const replacement = resolved ? objectUrls.get(resolved) : '';
    return replacement ? `${prefix}${replacement}${suffix}` : match;
  };
  const replaceTemplateReference = (match: string, prefix: string, reference: string, suffix: string): string => {
    const directory = `${reference.replace(/^\.\//, '').split('/')[0]}/`;
    for (const [path, url] of objectUrls) {
      if (path.startsWith(directory)) {
        const fileName = path.split('/').pop() ?? '';
        const urlFileName = url.split('/').pop() ?? '';
        const filePrefix = fileName && urlFileName.endsWith(fileName)
          ? urlFileName.slice(0, urlFileName.length - fileName.length)
          : '';
        const base = url.slice(0, url.lastIndexOf('/') + 1) + filePrefix;
        return `${prefix}${base}${reference.slice(directory.length)}${suffix}`;
      }
    }
    return match;
  };
  return source
    .replace(/(\bfrom\s+['"])([^'"]+)(['"])/giu, replaceReference)
    .replace(/(\bimport\s*\(\s*['"])([^'"]+)(['"]\s*\))/giu, replaceReference)
    .replace(/(\bimport\s+['"])([^'"]+)(['"])/giu, replaceReference)
    .replace(/(\brequire\s*\(\s*['"])([^'"]+)(['"]\s*\))/giu, replaceReference)
    .replace(/(\bfetch\s*\(\s*['"])([^'"]+)(['"]\s*\))/giu, replaceReference)
    .replace(/(\bfetch\s*\(\s*`)([^`]+)(`\s*\))/giu, replaceTemplateReference);
}

function prepareHtml(html: string): string {
  return String(preparePreviewHtml({
    body: html as unknown as Buffer,
    contentType: 'text/html',
    metafileContentBaseUrl: METAFILE_CONTENT_BASE,
  }));
}

async function localizeExternalScripts(args: {
  html: string;
  pinId: string;
  fetchImpl: typeof fetch;
  publishEntry: (path: string, data: Uint8Array) => Promise<string>;
}): Promise<string> {
  const urls = [...new Set([...args.html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/giu)].map((match) => match[1]))];
  const replacements = await Promise.all(urls.map(async (url, index) => {
    try {
      const response = await args.fetchImpl(url, { credentials: 'omit', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`MetaApp dependency download failed with HTTP ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('MetaApp dependency exceeds the 5 MB preview limit.');
      return {
        url,
        previewUrl: await args.publishEntry(`external-${index}.js`, bytes),
      };
    } catch {
      return { url, previewUrl: url };
    }
  }));
  let html = args.html;
  for (const replacement of replacements) html = html.split(replacement.url).join(replacement.previewUrl);
  return html.replace(/<script\b(?![^>]*\bdefer\b)([^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*)>/giu, '<script$1 defer>');
}

function contentUrls(reference: string): string[] {
  if (/^https?:\/\//i.test(reference)) return [reference];
  if (!/^metafile:\/\//i.test(reference)) throw new Error('MetaApp content must use http(s) or metafile://.');
  const pinId = reference.slice('metafile://'.length).split(/[?#]/, 1)[0]?.replace(/\.[a-z0-9]+$/i, '') ?? '';
  if (!pinId || pinId.includes('/') || pinId.includes('\\')) throw new Error('MetaApp content reference is invalid.');
  return [
    buildMetafileAcceleratedContentUrl(METAFILE_CONTENT_BASE, pinId),
    buildMetafileAcceleratedContentUrl(METAFILE_ACCELERATE_CONTENT_BASE, pinId),
  ];
}

async function fetchPackage(url: string, fetchImpl: typeof fetch): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const response = await fetchImpl(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`MetaApp package download failed with HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_PACKAGE_BYTES) throw new Error('MetaApp package exceeds the 30 MB mobile preview limit.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('MetaApp package exceeds the 30 MB mobile preview limit.');
  return {
    bytes,
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
  };
}

export function createMobileMetaAppPreviewSession(
  fetchImpl: typeof fetch = globalThis.fetch,
  publish: PublishPreview = publishMobilePreviewFile,
): {
  createPreviewSession: MetaAppPreviewSessionFactory;
  dispose: () => void;
} {
  const previewPromises = new Map<string, Promise<string>>();

  const buildPreview = async (input: Parameters<MetaAppPreviewSessionFactory>[0]): Promise<string> => {
    let packageResult: Awaited<ReturnType<typeof fetchPackage>> | null = null;
    let lastError: unknown = null;
    for (const url of contentUrls(input.contentReference)) {
      try {
        packageResult = await fetchPackage(url, fetchImpl);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!packageResult) throw lastError instanceof Error ? lastError : new Error('MetaApp package download failed.');
    const bytes = packageResult.bytes;
    const isZip = input.contentType.includes('zip')
      || packageResult.contentType.includes('zip')
      || (new Uint8Array(bytes, 0, 4).join(',') === '80,75,3,4');
    const publishEntry = (path: string, data: Uint8Array): Promise<string> => publish({
      name: `metaapp-${input.pinId.slice(0, 12)}-${path.replace(/[^a-z0-9._-]/gi, '-')}`,
      data,
      mime: MIME_BY_EXTENSION[extensionOf(path)] ?? 'application/octet-stream',
    });

    if (!isZip) {
      const html = prepareHtml(await localizeExternalScripts({
        html: new TextDecoder().decode(bytes),
        pinId: input.pinId,
        fetchImpl,
        publishEntry,
      }));
      return publishEntry('index.html', new TextEncoder().encode(html));
    }

    const zip = await JSZip.loadAsync(bytes);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length > MAX_PACKAGE_FILES) throw new Error('MetaApp package has too many files for mobile preview.');
    const normalizedEntries = entries.map((entry) => ({ entry, path: normalizePackagePath(entry.name) }));
    if (normalizedEntries.some((item) => !item.path)) throw new Error('MetaApp package contains an unsafe file path.');
    const entryPath = normalizePackagePath(input.indexFile);
    if (!normalizedEntries.some((item) => item.path === entryPath)) throw new Error('MetaApp entry file is missing from the package.');

    const urlByPath = new Map<string, string>();
    let uncompressedBytes = 0;
    for (const item of normalizedEntries) {
      const path = item.path;
      const extension = extensionOf(path);
      if (extension === 'html' || extension === 'css' || extension === 'js') continue;
      const content = await item.entry.async('uint8array');
      uncompressedBytes += content.byteLength;
      if (uncompressedBytes > MAX_PACKAGE_BYTES * 2) throw new Error('MetaApp package expands beyond the mobile preview limit.');
      urlByPath.set(path, await publishEntry(path, content));
    }
    for (const item of normalizedEntries) {
      const path = item.path;
      if (extensionOf(path) !== 'js') continue;
      const content = await item.entry.async('uint8array');
      uncompressedBytes += content.byteLength;
      if (uncompressedBytes > MAX_PACKAGE_BYTES * 2) throw new Error('MetaApp package expands beyond the mobile preview limit.');
      urlByPath.set(path, await publishEntry(path, content));
    }
    for (const extension of ['js', 'css', 'html'] as const) {
      for (const item of normalizedEntries) {
        const path = item.path;
        if (extensionOf(path) !== extension) continue;
        const text = await item.entry.async('string');
        if (extension !== 'js') uncompressedBytes += new TextEncoder().encode(text).byteLength;
        if (uncompressedBytes > MAX_PACKAGE_BYTES * 2) throw new Error('MetaApp package expands beyond the mobile preview limit.');
        const rewritten = extension === 'html'
          ? prepareHtml(await localizeExternalScripts({
              html: rewriteMobileMetaAppHtml(text, path, urlByPath),
              pinId: input.pinId,
              fetchImpl,
              publishEntry,
            }))
          : extension === 'js'
            ? rewriteMobileMetaAppJavaScript(text, path, urlByPath)
            : rewriteCssResources(text, path, urlByPath);
        urlByPath.set(path, await publishEntry(path, new TextEncoder().encode(rewritten)));
      }
    }
    const localPreviewUrl = urlByPath.get(entryPath);
    if (!localPreviewUrl) throw new Error('MetaApp preview entry could not be created.');
    return localPreviewUrl;
  };

  const createPreviewSession: MetaAppPreviewSessionFactory = (input) => {
    const key = `${input.pinId}:${input.contentReference}:${input.indexFile}`;
    const existing = previewPromises.get(key);
    if (existing) return existing.then((localPreviewUrl) => ({ localPreviewUrl }));
    const promise = buildPreview(input);
    previewPromises.set(key, promise);
    promise.catch(() => previewPromises.delete(key));
    return promise.then((localPreviewUrl) => ({ localPreviewUrl }));
  };

  return {
    createPreviewSession,
    dispose: () => previewPromises.clear(),
  };
}
