import { promises as fs } from 'node:fs';
import type { PublishedServiceRecord } from '../services/publishService';
import type { SessionTraceRecord } from '../chat/sessionTrace';
import { resolveMetabotPaths, type MetabotPaths } from './paths';

export interface RuntimeIdentityRecord {
  metabotId: number;
  name: string;
  createdAt: number;
  path: string;
  publicKey: string;
  chatPublicKey: string;
  mvcAddress: string;
  btcAddress: string;
  dogeAddress: string;
  metaId: string;
  globalMetaId: string;
}

export interface RuntimeDaemonRecord {
  ownerId: string;
  pid: number;
  host: string;
  port: number;
  baseUrl: string;
  startedAt: number;
}

export interface RuntimeState {
  identity: RuntimeIdentityRecord | null;
  services: PublishedServiceRecord[];
  traces: SessionTraceRecord[];
}

export interface RuntimeStateStore {
  paths: MetabotPaths;
  ensureLayout(): Promise<MetabotPaths>;
  readState(): Promise<RuntimeState>;
  writeState(nextState: RuntimeState): Promise<RuntimeState>;
  updateState(
    updater: (currentState: RuntimeState) => RuntimeState | Promise<RuntimeState>
  ): Promise<RuntimeState>;
  readDaemon(): Promise<RuntimeDaemonRecord | null>;
  writeDaemon(record: RuntimeDaemonRecord): Promise<RuntimeDaemonRecord>;
  clearDaemon(pid?: number): Promise<void>;
}

function cloneEmptyState(): RuntimeState {
  return {
    identity: null,
    services: [],
    traces: [],
  };
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

function normalizeRuntimeState(value: RuntimeState | null): RuntimeState {
  if (!value || typeof value !== 'object') {
    return cloneEmptyState();
  }

  return {
    identity: value.identity ?? null,
    services: Array.isArray(value.services) ? value.services : [],
    traces: Array.isArray(value.traces) ? value.traces : [],
  };
}

export function createRuntimeStateStore(homeDirOrPaths: string | MetabotPaths): RuntimeStateStore {
  const paths = typeof homeDirOrPaths === 'string' ? resolveMetabotPaths(homeDirOrPaths) : homeDirOrPaths;

  return {
    paths,
    async ensureLayout() {
      await ensureHotLayout(paths);
      return paths;
    },
    async readState() {
      await ensureHotLayout(paths);
      return normalizeRuntimeState(await readJsonFile<RuntimeState>(paths.runtimeStatePath));
    },
    async writeState(nextState) {
      await ensureHotLayout(paths);
      const normalized = normalizeRuntimeState(nextState);
      await fs.writeFile(paths.runtimeStatePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      return normalized;
    },
    async updateState(updater) {
      const currentState = await this.readState();
      const nextState = await updater(currentState);
      return this.writeState(nextState);
    },
    async readDaemon() {
      await ensureHotLayout(paths);
      return readJsonFile<RuntimeDaemonRecord>(paths.daemonStatePath);
    },
    async writeDaemon(record) {
      await ensureHotLayout(paths);
      await fs.writeFile(paths.daemonStatePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      return record;
    },
    async clearDaemon(pid) {
      await ensureHotLayout(paths);
      const current = await readJsonFile<RuntimeDaemonRecord>(paths.daemonStatePath);
      if (pid && current && current.pid !== pid) {
        return;
      }
      try {
        await fs.rm(paths.daemonStatePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw error;
        }
      }
    },
  };
}
