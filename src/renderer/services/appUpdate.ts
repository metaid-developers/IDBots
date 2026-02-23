const UPDATE_CHECK_URL = 'https://idbots.ai/api/update/check';
const FALLBACK_DOWNLOAD_URL = 'https://idbots.ai';

export const UPDATE_POLL_INTERVAL_MS = 12 * 60 * 60 * 1000;

type UpdateApiResponse = {
  code?: number;
  data?: {
    value?: {
      version?: string;
      url?: string;
    };
  };
};

export interface AppUpdateInfo {
  latestVersion: string;
  url: string;
}

const toVersionParts = (version: string): number[] => (
  version
    .split('.')
    .map((part) => {
      const match = part.trim().match(/^\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    })
);

const compareVersions = (a: string, b: string): number => {
  const aParts = toVersionParts(a);
  const bParts = toVersionParts(b);
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLength; i += 1) {
    const left = aParts[i] ?? 0;
    const right = bParts[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  return 0;
};

const isNewerVersion = (latestVersion: string, currentVersion: string): boolean => (
  compareVersions(latestVersion, currentVersion) > 0
);

export const checkForAppUpdate = async (currentVersion: string): Promise<AppUpdateInfo | null> => {
  const response = await window.electron.api.fetch({
    url: UPDATE_CHECK_URL,
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok || typeof response.data !== 'object' || response.data === null) {
    return null;
  }

  const payload = response.data as UpdateApiResponse;
  if (payload.code !== 0) {
    return null;
  }

  const latestVersion = payload.data?.value?.version?.trim();
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    return null;
  }

  const url = payload.data?.value?.url?.trim() || FALLBACK_DOWNLOAD_URL;
  return {
    latestVersion,
    url,
  };
};
