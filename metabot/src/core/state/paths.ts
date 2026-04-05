import path from 'node:path';

export interface MetabotPaths {
  baseRoot: string;
  hotRoot: string;
  exportRoot: string;
  runtimeDbPath: string;
  secretsPath: string;
}

export function resolveMetabotPaths(homeDir: string): MetabotPaths {
  if (!homeDir || typeof homeDir !== 'string') {
    throw new Error('A home directory is required to resolve metabot paths');
  }

  const baseRoot = path.join(homeDir, '.metabot');
  const hotRoot = path.join(baseRoot, 'hot');
  const exportRoot = path.join(baseRoot, 'exports');

  return {
    baseRoot,
    hotRoot,
    exportRoot,
    runtimeDbPath: path.join(hotRoot, 'runtime.sqlite'),
    secretsPath: path.join(hotRoot, 'secrets.json')
  };
}
