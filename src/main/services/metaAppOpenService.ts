import fs from 'fs';
import path from 'path';

type MetaAppRecordLike = {
  id: string;
  name: string;
  entry: string;
  appRoot: string;
};

type MetaAppManagerLike = {
  listMetaApps: () => MetaAppRecordLike[];
};

type EnsureServerReady = (root: string) => Promise<{ baseUrl: string }>;
type ShellOpenExternal = (url: string) => Promise<void>;

const splitPathSuffix = (raw: string): { pathPart: string; suffix: string } => {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { pathPart: '', suffix: '' };

  const hashIndex = trimmed.indexOf('#');
  const queryIndex = trimmed.indexOf('?');
  let cutIndex = trimmed.length;
  if (hashIndex >= 0) cutIndex = Math.min(cutIndex, hashIndex);
  if (queryIndex >= 0) cutIndex = Math.min(cutIndex, queryIndex);

  return { pathPart: trimmed.slice(0, cutIndex), suffix: trimmed.slice(cutIndex) };
};

const decodePathSegments = (pathname: string): string[] | null => {
  if (!pathname.startsWith('/')) return null;
  const rawSegments = pathname.split('/');
  const decodedSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment) continue;
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (!decodedSegment || decodedSegment.includes('/') || decodedSegment.includes('\\')) {
      return null;
    }
    decodedSegments.push(decodedSegment);
  }
  return decodedSegments;
};

const resolveMetaAppFileTarget = (
  record: MetaAppRecordLike,
  metaAppsRoot: string,
  pathname: string,
): { urlPathname: string; filePath: string } | { error: string } => {
  const segments = decodePathSegments(pathname);
  if (!segments || segments.length < 2) {
    return { error: 'targetPath must include an app id and a file path' };
  }

  const [appId, ...relativeSegments] = segments;
  if (!appId || appId !== record.id) {
    return { error: 'targetPath does not match the selected app id' };
  }
  if (relativeSegments.some((segment) => segment === '.' || segment === '..')) {
    return { error: 'targetPath contains dot-segment traversal' };
  }

  const urlPathname = `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;

  let servedRootRealPath: string;
  try {
    servedRootRealPath = fs.realpathSync.native(path.resolve(metaAppsRoot));
  } catch {
    return { error: 'METAAPPs root is missing' };
  }

  const candidatePath = path.resolve(servedRootRealPath, appId, ...relativeSegments);

  let candidateRealPath: string;
  try {
    candidateRealPath = fs.realpathSync.native(candidatePath);
  } catch {
    return { error: 'targetPath does not resolve to an existing file' };
  }

  const relativeToRoot = path.relative(servedRootRealPath, candidateRealPath);
  if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return { error: 'targetPath escapes the served METAAPPs root' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidateRealPath);
  } catch {
    return { error: 'targetPath does not resolve to an existing file' };
  }

  if (!stat.isFile()) {
    return { error: 'targetPath does not resolve to a file' };
  }

  return { urlPathname, filePath: candidateRealPath };
};

const normalizeLocalBaseUrl = (baseUrl: string): string | null => {
  const trimmed = String(baseUrl ?? '').trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(withoutTrailingSlash);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:') return null;
  if (parsed.hostname !== '127.0.0.1') return null;
  if (!parsed.port) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/') return null;
  if (parsed.search || parsed.hash) return null;

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  return `http://127.0.0.1:${port}`;
};

export async function openMetaApp(input: {
  appId: string;
  targetPath?: string;
  manager: Pick<MetaAppManagerLike, 'listMetaApps'>;
  ensureServerReady: EnsureServerReady;
  shellOpenExternal: ShellOpenExternal;
}): Promise<{ success: boolean; appId?: string; name?: string; url?: string; error?: string }> {
  try {
    const appId = String(input?.appId ?? '').trim();
    if (!appId) {
      return { success: false, error: 'App id is empty' };
    }

    const apps = input.manager?.listMetaApps?.() ?? [];
    const record = apps.find((candidate) => candidate?.id === appId);
    if (!record) {
      return { success: false, error: `MetaApp not found: ${appId}` };
    }

    const candidateTarget = String(input.targetPath ?? '').trim();
    const requested = candidateTarget || String(record.entry ?? '').trim();
    if (!requested) {
      return { success: false, error: 'Target path is empty' };
    }

    const metaAppsRoot = path.dirname(path.resolve(record.appRoot));
    const { pathPart, suffix } = splitPathSuffix(requested);
    const resolved = resolveMetaAppFileTarget(record, metaAppsRoot, pathPart);
    if ('error' in resolved) {
      return { success: false, error: resolved.error };
    }

    const ready = await input.ensureServerReady(metaAppsRoot);
    const baseUrl = normalizeLocalBaseUrl(String(ready?.baseUrl ?? ''));
    if (!baseUrl) {
      return { success: false, error: 'MetaApp server baseUrl is invalid' };
    }

    const finalUrl = `${baseUrl}${resolved.urlPathname}${suffix}`;

    await input.shellOpenExternal(finalUrl);
    return { success: true, appId: record.id, name: record.name, url: finalUrl };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
