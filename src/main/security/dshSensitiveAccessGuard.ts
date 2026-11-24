/**
 * DSH Sensitive Host Access Guard.
 *
 * Enforced unconditionally inside CoworkRunner.evaluateDshToolPolicy BEFORE
 * permissionMode ('acceptEdits' / 'bypassPermissions') or autoApprove skips,
 * so even an unattended or bypassPermissions session cannot use fs/bash tools
 * to read IDBots wallet databases, master RPC tokens, other sessions' BASH_ENV
 * files, or OS credential stores.
 */

import path from 'node:path';
import { isSensitiveHostFilePath } from './secretEgressGuard';

export interface DshSensitiveAccessResult {
  blocked: boolean;
  reason?: string;
  category?: 'sensitive_file_path' | 'sensitive_bash_command';
}

const FILE_TOOL_NAMES = new Set([
  'read',
  'read_image',
  'write',
  'edit',
  'multi_edit',
  'glob',
  'grep',
  'list_dir',
  'view',
  'delete',
  'rm',
]);

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'pwsh',
  'powershell',
  'shell',
  'execute',
  'run_command',
]);

const PATH_ARG_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_path',
  'targetPath',
  'directory',
  'dir',
  'cwd',
] as const;

function normalizePathForCheck(rawPath: string): string {
  return path.resolve(rawPath).replace(/\\/g, '/').toLowerCase();
}

function isInsideDir(candidateNorm: string, dirNorm: string): boolean {
  if (!dirNorm) return false;
  const cleanDir = dirNorm.endsWith('/') ? dirNorm.slice(0, -1) : dirNorm;
  return candidateNorm === cleanDir || candidateNorm.startsWith(`${cleanDir}/`);
}

/**
 * Check whether an absolute or relative path points to a sensitive IDBots
 * credential/storage target (SQLite wallet DBs, master RPC token, dsh-skill-env
 * session env/token files, or OS keystores).
 */
export function isBlockedDshFilePath(
  rawPath: string,
  cwd: string,
  userDataPath?: string | null,
): boolean {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return false;
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);

  if (isSensitiveHostFilePath(resolved)) {
    return true;
  }

  const norm = normalizePathForCheck(resolved);
  const base = path.basename(norm);

  // Always block wallet/config databases and RPC token mirrors regardless of directory.
  if (
    base === 'idbots.sqlite'
    || base === 'idbots.sqlite-wal'
    || base === 'idbots.sqlite-shm'
    || base === 'idbots.sqlite-journal'
    || base === 'cowork.sqlite'
    || base === 'cowork.sqlite-wal'
    || base === 'cowork.sqlite-shm'
    || base === 'metaid-rpc-token'
  ) {
    return true;
  }

  // Always block direct access to dsh-skill-env session files (contains scoped tokens).
  if (norm.includes('/dsh-skill-env/') || norm.endsWith('/dsh-skill-env')) {
    return true;
  }

  // Block sensitive userData files when userDataPath is known.
  if (userDataPath && userDataPath.trim()) {
    const udNorm = normalizePathForCheck(userDataPath);
    if (
      isInsideDir(norm, `${udNorm}/dsh-skill-env`)
      || norm === `${udNorm}/metaid-rpc-token`
      || norm.startsWith(`${udNorm}/idbots.sqlite`)
      || norm.startsWith(`${udNorm}/cowork.sqlite`)
    ) {
      return true;
    }
  }

  // Block OS credential directories & local metabot keystore files.
  if (
    norm.includes('/.ssh/')
    || norm.endsWith('/.ssh')
    || norm.includes('/.aws/')
    || norm.endsWith('/.aws')
    || norm.includes('/.gnupg/')
    || norm.endsWith('/.gnupg')
    || norm.includes('/.metabot/')
    || norm.endsWith('/.metabot')
  ) {
    return true;
  }

  return false;
}

const SENSITIVE_COMMAND_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bidbots\.sqlite(?:-wal|-shm|-journal)?\b/i, label: 'IDBots SQLite database' },
  { re: /\bcowork\.sqlite(?:-wal|-shm|-journal)?\b/i, label: 'CoWork SQLite database' },
  { re: /\bmetaid-rpc-token\b/i, label: 'master MetaID RPC token file' },
  { re: /\bdsh-skill-env\b/i, label: 'DSH skill session env directory' },
  { re: /\bIDBOTS_METABOT_MNEMONIC\b/i, label: 'wallet mnemonic environment variable' },
  { re: /\bmetabot_wallets\b/i, label: 'metabot_wallets table' },
  { re: /\buser_identity\b/i, label: 'user_identity table' },
  { re: /(?:\$|%\{?|\bprintenv\b[^\n;|&]*)\bIDBOTS_RPC_(?:TOKEN|AUTHFILE)\b/i, label: 'RPC auth token/file inspection' },
  { re: /\b(?:cat|head|tail|less|more|sed|awk|grep|rg|strings|xxd|od|hexdump|base64|cp|mv|tar|zip|scp|curl)\b[^\n;|&]*(?:\/\.ssh\/|~\/\.ssh\/|\/\.aws\/credentials|~\/\.aws\/credentials|\/\.gnupg\/|~\/\.gnupg\/)/i, label: 'OS credential store' },
  { re: /\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b/i, label: 'macOS Keychain dump' },
  { re: /\/proc\/(?:self|\d+)\/environ\b/i, label: 'process environ inspection' },
];

const A2A_ENV_DUMP_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|[;&|]\s*)(?:printenv|env)\s*(?:$|[;&|>])/m, label: 'full environment dump in A2A session' },
  { re: /(?:^|[;&|]\s*)export\s+-p\b/m, label: 'exported environment dump in A2A session' },
];

/**
 * Inspect a bash/shell command string for attempts to access IDBots wallet DBs,
 * master RPC tokens, session env directories, or OS credential stores.
 */
export function detectSensitiveHostAccessInCommand(
  command: string,
  options?: { userDataPath?: string | null; sessionType?: string | null },
): { matched: boolean; label?: string } {
  const text = String(command ?? '');
  if (!text.trim()) return { matched: false };

  for (const { re, label } of SENSITIVE_COMMAND_PATTERNS) {
    if (re.test(text)) {
      return { matched: true, label };
    }
  }

  if (options?.sessionType === 'a2a') {
    for (const { re, label } of A2A_ENV_DUMP_PATTERNS) {
      if (re.test(text)) {
        return { matched: true, label };
      }
    }
  }

  return { matched: false };
}

function extractCommandText(toolInput: Record<string, unknown>): string {
  for (const key of ['command', 'cmd', 'script']) {
    const val = toolInput[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

/**
 * Central guard invoked from CoworkRunner.evaluateDshToolPolicy.
 */
export function evaluateDshSensitiveAccess(params: {
  toolName: string;
  toolInput: Record<string, unknown> | undefined | null;
  cwd: string;
  userDataPath?: string | null;
  sessionType?: string | null;
}): DshSensitiveAccessResult {
  const normalized = String(params.toolName ?? '').trim().toLowerCase();
  const input = params.toolInput ?? {};

  if (FILE_TOOL_NAMES.has(normalized)) {
    for (const key of PATH_ARG_KEYS) {
      const raw = input[key];
      if (typeof raw === 'string' && raw.trim()) {
        if (isBlockedDshFilePath(raw, params.cwd, params.userDataPath)) {
          return {
            blocked: true,
            category: 'sensitive_file_path',
            reason: `Security policy: direct ${normalized} access to sensitive IDBots wallet/credential storage ("${path.basename(raw)}") is blocked.`,
          };
        }
      }
    }
    // Also inspect glob/grep pattern if it explicitly targets sqlite/token files.
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    if (
      pattern
      && /(?:idbots\.sqlite|cowork\.sqlite|metaid-rpc-token|dsh-skill-env)/i.test(pattern)
    ) {
      return {
        blocked: true,
        category: 'sensitive_file_path',
        reason: `Security policy: searching sensitive IDBots credential/storage files via ${normalized} is blocked.`,
      };
    }
    return { blocked: false };
  }

  if (SHELL_TOOL_NAMES.has(normalized)) {
    const command = extractCommandText(input);
    const hit = detectSensitiveHostAccessInCommand(command, {
      userDataPath: params.userDataPath,
      sessionType: params.sessionType,
    });
    if (hit.matched) {
      return {
        blocked: true,
        category: 'sensitive_bash_command',
        reason: `Security policy: shell command accessing ${hit.label ?? 'sensitive IDBots storage/credentials'} is blocked.`,
      };
    }
  }

  return { blocked: false };
}
