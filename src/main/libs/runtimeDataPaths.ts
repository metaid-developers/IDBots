import path from 'path';

export const APP_DATA_PATH_ENV = 'IDBOTS_APP_DATA_PATH';
export const USER_DATA_PATH_ENV = 'IDBOTS_USER_DATA_PATH';

type RuntimeDataPathOptions = {
  appDataPath: string;
  currentUserDataPath: string;
  appName: string;
  env?: NodeJS.ProcessEnv;
};

function normalizeOverridePath(value?: string | null): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

export function resolveRuntimeDataPaths(options: RuntimeDataPathOptions): { appDataPath: string; userDataPath: string } {
  const env = options.env ?? process.env;
  const appDataOverride = normalizeOverridePath(env[APP_DATA_PATH_ENV]);
  const userDataOverride = normalizeOverridePath(env[USER_DATA_PATH_ENV]);

  const appDataPath = appDataOverride ?? options.appDataPath;
  const userDataPath = userDataOverride ?? path.join(appDataPath, options.appName);

  return {
    appDataPath,
    userDataPath,
  };
}
