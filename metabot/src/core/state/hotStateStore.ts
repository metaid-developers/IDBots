import { promises as fs } from 'node:fs';
import { resolveMetabotPaths, type MetabotPaths } from './paths';

export interface HotStateStore {
  paths: MetabotPaths;
  ensureLayout(): Promise<MetabotPaths>;
  readSecrets<T extends Record<string, unknown>>(): Promise<T | null>;
  writeSecrets<T extends Record<string, unknown>>(value: T): Promise<string>;
  deleteSecrets(): Promise<void>;
}

async function ensureHotLayout(paths: MetabotPaths): Promise<void> {
  await fs.mkdir(paths.hotRoot, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function createHotStateStore(homeDirOrPaths: string | MetabotPaths): HotStateStore {
  const paths = typeof homeDirOrPaths === 'string' ? resolveMetabotPaths(homeDirOrPaths) : homeDirOrPaths;

  return {
    paths,
    async ensureLayout() {
      await ensureHotLayout(paths);
      return paths;
    },
    async readSecrets() {
      await ensureHotLayout(paths);
      return readJsonFile(paths.secretsPath);
    },
    async writeSecrets(value) {
      await ensureHotLayout(paths);
      await fs.writeFile(paths.secretsPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      return paths.secretsPath;
    },
    async deleteSecrets() {
      try {
        await fs.rm(paths.secretsPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw error;
        }
      }
    }
  };
}
