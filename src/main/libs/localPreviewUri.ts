/**
 * preview-metaapp:// / preview-file:// URI construction and normalization for local paths.
 * Each path segment is percent-encoded (including parentheses so Markdown links
 * `[label](uri)` never break on unbalanced parens); the preview server decodes
 * them back to a filesystem path.
 */
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//u;
const LOCAL_PREVIEW_OR_FILE_SCHEME_RE = /^(preview-metaapp|preview-file|file):\/\/(.*)$/iu;

function encodeSegmentMarkdownSafe(segment: string): string {
  if (/^[A-Za-z]:$/u.test(segment)) return segment;
  return encodeURIComponent(segment)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function decodePathnameTolerant(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

export function encodeLocalPreviewPath(localPath: string): string {
  let normalized = localPath.replace(/\\/g, '/');
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    normalized = `/${normalized}`;
  }
  return normalized.split('/').map(encodeSegmentMarkdownSafe).join('/');
}

export function previewMetaappUriForPath(localPath: string): string {
  return `preview-metaapp://localhost${encodeLocalPreviewPath(localPath)}`;
}

export function previewFileUriForPath(localPath: string): string {
  return `preview-file://localhost${encodeLocalPreviewPath(localPath)}`;
}

/**
 * Normalize a `preview-file://`, `preview-metaapp://`, or `file://` URI that may
 * arrive from LLM output with triple slashes (`preview-file:///Users/...`),
 * Windows backslashes, raw spaces, CJK characters, parentheses, or stray `%`
 * without double-encoding already-valid `%XX` sequences.
 */
export function normalizeLocalPreviewUri(rawUri: string): string {
  const trimmed = String(rawUri ?? '').trim();
  const match = trimmed.match(LOCAL_PREVIEW_OR_FILE_SCHEME_RE);
  if (!match) return trimmed;

  const rawScheme = match[1].toLowerCase();
  const scheme = rawScheme === 'file' ? 'preview-file' : rawScheme;
  const rest = match[2].replace(/\\/g, '/');

  let host = 'localhost';
  let remainder = '';
  if (rest.startsWith('/')) {
    remainder = rest;
  } else if (WINDOWS_DRIVE_PATH_RE.test(rest)) {
    remainder = `/${rest}`;
  } else {
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return trimmed;
    host = rest.slice(0, slashIdx) || 'localhost';
    remainder = rest.slice(slashIdx);
  }

  let pathPart = remainder;
  let suffix = '';
  if (scheme === 'preview-file') {
    const hashIdx = pathPart.indexOf('#');
    if (hashIdx !== -1) {
      const before = pathPart.slice(0, hashIdx);
      const after = pathPart.slice(hashIdx + 1);
      const baseBefore = before.slice(before.lastIndexOf('/') + 1);
      if (!baseBefore.includes('.') && /\.[A-Za-z0-9]{1,12}$/.test(after)) {
        pathPart = `${before}%23${after.replace(/#/g, '%23')}`;
      } else {
        pathPart = before;
        suffix = `#${after}`;
      }
    }
    const qIdx = pathPart.indexOf('?');
    if (qIdx !== -1) {
      const before = pathPart.slice(0, qIdx);
      const after = pathPart.slice(qIdx + 1);
      const baseBefore = before.slice(before.lastIndexOf('/') + 1);
      if (!baseBefore.includes('.') && /\.[A-Za-z0-9]{1,12}$/.test(after) && !after.includes('=')) {
        pathPart = `${before}%3F${after.replace(/\?/g, '%3F')}`;
      } else {
        pathPart = before;
        suffix = `?${after}${suffix}`;
      }
    }
  } else {
    const splitIdx = pathPart.search(/[?#]/);
    if (splitIdx !== -1) {
      suffix = pathPart.slice(splitIdx);
      pathPart = pathPart.slice(0, splitIdx);
    }
  }

  let encodedPath = '';
  for (let i = 0; i < pathPart.length; ) {
    const ch = pathPart[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(pathPart.slice(i + 1, i + 3))) {
      encodedPath += pathPart.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch === '%') {
      encodedPath += '%25';
      i += 1;
      continue;
    }
    if (/^[A-Za-z0-9._~:@!$&*+,;=/\-]$/.test(ch)) {
      encodedPath += ch;
      i += 1;
      continue;
    }
    const cp = pathPart.codePointAt(i)!;
    const charStr = String.fromCodePoint(cp);
    encodedPath += encodeURIComponent(charStr)
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/'/g, '%27');
    i += charStr.length;
  }
  encodedPath = encodedPath.replace(/\/\/+/g, '/');
  return `${scheme}://${host}${encodedPath}${suffix}`;
}

/**
 * Extract a decoded absolute local filesystem path from either a raw path
 * (`/Users/...`, `C:\Users\...`) or a local preview URI (`preview-file://...`,
 * `preview-metaapp://...`, `file://...`). Returns `null` for non-local schemes
 * (`pin://`, `metaapp://`, `https://`, etc.) or relative strings.
 */
export function localFilesystemPathFromArtifactRef(
  ref: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const trimmed = String(ref ?? '').trim();
  if (!trimmed) return null;

  const uriMatch = trimmed.match(LOCAL_PREVIEW_OR_FILE_SCHEME_RE);
  if (uriMatch) {
    const normalizedUri = normalizeLocalPreviewUri(trimmed);
    try {
      const parsed = new URL(normalizedUri);
      if (parsed.username || parsed.password) return null;
      if (parsed.host && parsed.host.toLowerCase() !== 'localhost') return null;
      let decoded = decodePathnameTolerant(parsed.pathname).replace(/\/\/+/g, '/');
      if (!decoded.startsWith('/')) return null;
      if (platform === 'win32' && /^\/[A-Za-z]:\//.test(decoded)) {
        decoded = decoded.slice(1);
      }
      return decoded;
    } catch {
      return null;
    }
  }

  // Reject any other scheme URI (pin://, metaapp://, https://, etc.), while keeping Windows C:\...
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  return null;
}
