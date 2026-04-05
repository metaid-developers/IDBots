import { promises as fs } from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHttpServer } from './httpServer';
import { resolveMetabotPaths, type MetabotPaths } from '../core/state/paths';
import type { MetabotDaemonHttpHandlers } from './routes/types';

export interface MetabotDaemonAddress {
  host: string;
  port: number;
  baseUrl: string;
}

export interface MetabotDaemonInstance {
  ownerId: string;
  lockPath: string;
  start(port?: number, host?: string): Promise<MetabotDaemonAddress>;
  close(): Promise<void>;
}

export interface CreateMetabotDaemonOptions {
  homeDirOrPaths: string | MetabotPaths;
  handlers?: MetabotDaemonHttpHandlers;
  ownerId?: string;
}

function resolvePaths(input: string | MetabotPaths): MetabotPaths {
  return typeof input === 'string' ? resolveMetabotPaths(input) : input;
}

async function closeServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createMetabotDaemon(options: CreateMetabotDaemonOptions): MetabotDaemonInstance {
  const paths = resolvePaths(options.homeDirOrPaths);
  const ownerId = options.ownerId?.trim() || `metabot-daemon-${randomUUID()}`;
  const lockPath = path.join(paths.hotRoot, 'daemon.lock');
  const handlers = options.handlers ?? {};

  let server: http.Server | null = null;
  let startedAddress: MetabotDaemonAddress | null = null;
  let lockHeld = false;

  async function acquireLock(): Promise<void> {
    await fs.mkdir(paths.hotRoot, { recursive: true });
    await fs.writeFile(lockPath, `${JSON.stringify({ ownerId, acquiredAt: Date.now() }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    lockHeld = true;
  }

  async function releaseLock(): Promise<void> {
    if (!lockHeld) return;
    lockHeld = false;
    try {
      await fs.rm(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return {
    ownerId,
    lockPath,
    async start(port = 0, host = '127.0.0.1') {
      if (startedAddress) {
        return startedAddress;
      }

      await acquireLock();

      try {
        server = createHttpServer(handlers);
        await new Promise<void>((resolve, reject) => {
          server!.listen(port, host, () => resolve());
          server!.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected daemon server to bind a TCP address.');
        }

        startedAddress = {
          host,
          port: address.port,
          baseUrl: `http://${host}:${address.port}`,
        };
        return startedAddress;
      } catch (error) {
        await closeServer(server);
        server = null;
        startedAddress = null;
        await releaseLock();
        throw error;
      }
    },
    async close() {
      await closeServer(server);
      server = null;
      startedAddress = null;
      await releaseLock();
    },
  };
}
