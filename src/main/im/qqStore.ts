/**
 * QQ channel credential store.
 *
 * Layout (per account slot, under `<userData>/qq`):
 *   accounts/{accountId}.json   appId + appSecret + botId + owner OpenID + source
 *
 * WHY A FILE AND NOT THE CONFIG TABLE: `appSecret` is a bearer credential. The
 * IM config table is serialized straight to the renderer through
 * `im:config:get`, so a secret stored there would be readable from any renderer
 * context and would end up in every support dump. Files are written 0600 and
 * are never read back into a renderer-visible object.
 *
 * SECRET HANDLING: `appSecret` never appears in `getStatus()`, log lines, error
 * messages or buzzes. `describeStored()` exists so callers can log "has a
 * credential" without ever touching the value.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { QQLoginCredentials } from './qqProtocol';

export const QQ_DEFAULT_ACCOUNT_ID = 'default';

export type QQCredentialSource = 'qr' | 'manual';

export interface QQStoredCredentials {
  appId: string;
  /** Sensitive. Never logged, never returned to the renderer. */
  appSecret: string;
  botId: string | null;
  ownerUserOpenid: string | null;
  source: QQCredentialSource;
  accountId: string;
  savedAt: number;
}

/** Filesystem-safe account slot name. */
export function normalizeQQAccountId(accountId?: string | null): string {
  const raw = (accountId || '').trim();
  if (!raw) return QQ_DEFAULT_ACCOUNT_ID;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return safe || QQ_DEFAULT_ACCOUNT_ID;
}

/** Resolve the default state directory lazily so the module works outside Electron. */
export function resolveDefaultQQStateDir(): string {
  try {
    const electron = require('electron');
    const userData = electron?.app?.getPath?.('userData');
    if (typeof userData === 'string' && userData) {
      return path.join(userData, 'qq');
    }
  } catch {
    // Electron not available (unit tests / plain node).
  }
  return path.join(os.tmpdir(), 'idbots-qq');
}

export class QQStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir && baseDir.trim() ? baseDir : resolveDefaultQQStateDir();
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getAccountDir(): string {
    return path.join(this.baseDir, 'accounts');
  }

  getCredentialsPath(accountId?: string | null): string {
    return path.join(this.getAccountDir(), `${normalizeQQAccountId(accountId)}.json`);
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
      // Windows may not support chmod; best effort.
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore
    }
  }

  loadCredentials(accountId?: string | null): QQStoredCredentials | null {
    const filePath = this.getCredentialsPath(accountId);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<QQStoredCredentials>;
      if (!parsed || typeof parsed.appId !== 'string' || !parsed.appId.trim()) return null;
      if (typeof parsed.appSecret !== 'string' || !parsed.appSecret.trim()) return null;
      return {
        appId: parsed.appId.trim(),
        appSecret: parsed.appSecret,
        botId: typeof parsed.botId === 'string' ? parsed.botId : null,
        ownerUserOpenid: typeof parsed.ownerUserOpenid === 'string' ? parsed.ownerUserOpenid : null,
        source: parsed.source === 'qr' ? 'qr' : 'manual',
        accountId: normalizeQQAccountId(parsed.accountId || accountId),
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      };
    } catch {
      return null;
    }
  }

  saveCredentials(
    credentials: QQLoginCredentials,
    options: {
      accountId?: string | null;
      botId?: string | null;
      source?: QQCredentialSource;
      now?: number;
    } = {}
  ): QQStoredCredentials {
    const stored: QQStoredCredentials = {
      appId: credentials.appId.trim(),
      appSecret: credentials.appSecret,
      botId: options.botId ?? null,
      ownerUserOpenid: credentials.userOpenid ?? null,
      source: options.source ?? 'manual',
      accountId: normalizeQQAccountId(options.accountId),
      savedAt: options.now ?? Date.now(),
    };
    this.writeJsonAtomic(this.getCredentialsPath(options.accountId), stored);
    return stored;
  }

  clearCredentials(accountId?: string | null): void {
    try {
      fs.rmSync(this.getCredentialsPath(accountId), { force: true });
    } catch {
      // Best effort: the caller re-binds credentials right after.
    }
  }

  /** Credential-free description for logs and diagnostics. */
  describeStored(accountId?: string | null): {
    present: boolean;
    appId: string | null;
    botId: string | null;
    source: QQCredentialSource | null;
    savedAt: number | null;
  } {
    const stored = this.loadCredentials(accountId);
    if (!stored) {
      return { present: false, appId: null, botId: null, source: null, savedAt: null };
    }
    return {
      present: true,
      appId: stored.appId,
      botId: stored.botId,
      source: stored.source,
      savedAt: stored.savedAt,
    };
  }
}
