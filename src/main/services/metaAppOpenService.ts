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

const isValidTargetPathForApp = (appId: string, targetPath: string): boolean => {
  if (!appId) return false;
  if (!targetPath) return false;
  if (!targetPath.startsWith('/')) return false;
  return targetPath.startsWith(`/${appId}/`);
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

    const { pathPart, suffix } = splitPathSuffix(requested);
    if (!isValidTargetPathForApp(appId, pathPart)) {
      return { success: false, error: `Invalid targetPath for app ${appId}` };
    }

    const metaAppsRoot = path.dirname(path.resolve(record.appRoot));
    const ready = await input.ensureServerReady(metaAppsRoot);
    const baseUrl = String(ready?.baseUrl ?? '').trim();
    if (!baseUrl) {
      return { success: false, error: 'MetaApp server baseUrl is empty' };
    }

    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const finalUrl = `${normalizedBaseUrl}${pathPart}${suffix}`;

    await input.shellOpenExternal(finalUrl);
    return { success: true, appId: record.id, name: record.name, url: finalUrl };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

