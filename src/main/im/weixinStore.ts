/**
 * Weixin credential and long-poll cursor store.
 *
 * Layout (per account, under `<userData>/weixin`):
 *   accounts/{accountId}.json       bot token + base url + bot/user ids
 *   accounts/{accountId}.sync.json  opaque get_updates_buf cursor
 *
 * Why the filesystem and not the SQLite config table: the token is a bearer
 * credential that must never end up in a config payload that the renderer reads
 * back or that a support bundle dumps. Files are written with mode 0600.
 *
 * SECRET HANDLING: `token` is never logged, never thrown in an error message and
 * never returned by any status object built here.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WeixinLoginCredentials } from './weixinProtocol';
import { WEIXIN_DEFAULT_BASE_URL } from './weixinProtocol';

export const WEIXIN_DEFAULT_ACCOUNT_ID = 'default';

export interface WeixinStoredCredentials extends WeixinLoginCredentials {
  accountId: string;
  savedAt: number;
}

export interface WeixinSyncState {
  getUpdatesBuf: string;
  updatedAt: number;
}

/** Filesystem-safe account slot name. */
export function normalizeWeixinAccountId(accountId?: string | null): string {
  const raw = (accountId || '').trim();
  if (!raw) return WEIXIN_DEFAULT_ACCOUNT_ID;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return safe || WEIXIN_DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve the default state directory lazily so this module stays importable
 * outside Electron (unit tests pass an explicit directory instead).
 */
export function resolveDefaultWeixinStateDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'weixin');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-weixin');
}

export class WeixinStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir && baseDir.trim() ? baseDir : resolveDefaultWeixinStateDir();
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getAccountDir(): string {
    return path.join(this.baseDir, 'accounts');
  }

  getCredentialsPath(accountId?: string | null): string {
    return path.join(this.getAccountDir(), `${normalizeWeixinAccountId(accountId)}.json`);
  }

  getSyncPath(accountId?: string | null): string {
    return path.join(this.getAccountDir(), `${normalizeWeixinAccountId(accountId)}.sync.json`);
  }

  private ensureAccountDir(): void {
    fs.mkdirSync(this.getAccountDir(), { recursive: true, mode: 0o700 });
  }

  private writeJsonAtomic(filePath: string, value: unknown): void {
    this.ensureAccountDir();
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows/best-effort: chmod may be unsupported.
    }
  }

  loadCredentials(accountId?: string | null): WeixinStoredCredentials | null {
    const filePath = this.getCredentialsPath(accountId);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WeixinStoredCredentials>;
      if (!parsed || typeof parsed.token !== 'string' || !parsed.token) return null;
      return {
        token: parsed.token,
        baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : WEIXIN_DEFAULT_BASE_URL,
        botId: typeof parsed.botId === 'string' ? parsed.botId : null,
        userId: typeof parsed.userId === 'string' ? parsed.userId : null,
        accountId: normalizeWeixinAccountId(parsed.accountId || accountId),
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      };
    } catch {
      return null;
    }
  }

  saveCredentials(
    credentials: WeixinLoginCredentials,
    accountId?: string | null,
    now: number = Date.now()
  ): WeixinStoredCredentials {
    const stored: WeixinStoredCredentials = {
      token: credentials.token,
      baseUrl: credentials.baseUrl || WEIXIN_DEFAULT_BASE_URL,
      botId: credentials.botId ?? null,
      userId: credentials.userId ?? null,
      accountId: normalizeWeixinAccountId(accountId),
      savedAt: now,
    };
    this.writeJsonAtomic(this.getCredentialsPath(accountId), stored);
    return stored;
  }

  clearCredentials(accountId?: string | null): void {
    try {
      fs.rmSync(this.getCredentialsPath(accountId), { force: true });
    } catch {
      // Ignore: clearing best-effort, the caller still proceeds to re-login.
    }
  }

  loadSync(accountId?: string | null): WeixinSyncState | null {
    const filePath = this.getSyncPath(accountId);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WeixinSyncState>;
      if (!parsed || typeof parsed.getUpdatesBuf !== 'string') return null;
      return {
        getUpdatesBuf: parsed.getUpdatesBuf,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
    } catch {
      return null;
    }
  }

  saveSync(getUpdatesBuf: string, accountId?: string | null, now: number = Date.now()): void {
    this.writeJsonAtomic(this.getSyncPath(accountId), { getUpdatesBuf, updatedAt: now });
  }

  clearSync(accountId?: string | null): void {
    try {
      fs.rmSync(this.getSyncPath(accountId), { force: true });
    } catch {
      // Ignore.
    }
  }
}
