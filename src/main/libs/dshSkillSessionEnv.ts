// Per-session skill env for the shared DSH runtime.
//
// DSH is one child process for every CoWork session. Global host channels
// (SKILLS_ROOT, IDBOTS_API_BASE_URL, RPC authfile) can ride that child env.
// Per-session identity (metabot id, mnemonic, image-provider KEY/TOKEN names)
// cannot: a shared env would leak Bot A's wallet into Bot B's bash, and the
// DSH subprocess scrub drops names matching /KEY|PASSWORD|SECRET|TOKEN/i
// before model-visible bash anyway.
//
// Channel: BASH_ENV (scrub-proof) sources a 0600 env file keyed by the
// per-execution DSH_SESSION_ID that dsh-shell-env injects after the scrub.
// Concurrent sessions keep distinct files; subagent sessions copy the parent
// file when they start.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export const DSH_SKILL_ENV_DIR_ENV = 'IDBOTS_SKILL_ENV_DIR';
export const DSH_SKILL_ENV_LOADER_ENV = 'BASH_ENV';
export const DSH_SKILL_ENV_DIRNAME = 'dsh-skill-env';
export const DSH_SKILL_ENV_LOADER_FILENAME = 'loader.sh';

/** POSIX-safe loader sourced by non-interactive bash via BASH_ENV. */
export const DSH_SKILL_ENV_LOADER_SCRIPT = `# IDBots DSH skill-session env loader.
# Sourced via BASH_ENV after DSH scrubs KEY/TOKEN names from the parent env.
# Per-execution DSH_SESSION_ID selects this cowork session's env file.
# Print nothing: stdout is the skill script's contract.
if [ -n "\${IDBOTS_SKILL_ENV_DIR:-}" ] && [ -n "\${DSH_SESSION_ID:-}" ]; then
  case "\${DSH_SESSION_ID}" in
    *[!A-Za-z0-9._:-]*) ;;
    *)
      _idbots_skill_env_file="\${IDBOTS_SKILL_ENV_DIR}/\${DSH_SESSION_ID}.env"
      if [ -f "\${_idbots_skill_env_file}" ]; then
        set -a
        # shellcheck disable=SC1090
        . "\${_idbots_skill_env_file}"
        set +a
      fi
      unset _idbots_skill_env_file
      ;;
  esac
fi
`;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,180}$/;

export function isSafeDshSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function dshSkillEnvDir(userDataPath: string): string {
  return join(userDataPath, DSH_SKILL_ENV_DIRNAME);
}

export function dshSkillEnvFilePath(userDataPath: string, dshSessionId: string): string {
  return join(dshSkillEnvDir(userDataPath), `${dshSessionId}.env`);
}

export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Convert a host path into a Git-bash-readable form (`C:\\Users\\x` → `/c/Users/x`). */
export function toGitBashPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const slash = String(filePath ?? '').replace(/\\/g, '/');
  if (platform !== 'win32') return slash;
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(slash);
  if (drive) return `/${drive[1].toLowerCase()}${slash.slice(2)}`;
  return slash;
}

function looksLikeWindowsAbsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

const BASH_PATH_ENV_KEYS = new Set(['TMPDIR', 'TMP', 'TEMP', DSH_SKILL_ENV_DIR_ENV]);

export function formatPosixEnvFile(env: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) continue;
    const raw = String(value);
    const next = BASH_PATH_ENV_KEYS.has(key) || looksLikeWindowsAbsPath(raw)
      ? toGitBashPath(raw, platform)
      : raw;
    lines.push(`${key}=${posixSingleQuote(next)}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function tryChmod(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // Windows and some network FS ignore POSIX modes.
  }
}

/** Create the env directory and loader script; return scrub-proof child-env keys. */
export function ensureDshSkillEnvChannel(userDataPath: string): Record<string, string> {
  const dir = dshSkillEnvDir(userDataPath);
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const loaderPath = join(dir, DSH_SKILL_ENV_LOADER_FILENAME);
  writeFileSync(loaderPath, DSH_SKILL_ENV_LOADER_SCRIPT, { encoding: 'utf8' });
  tryChmod(loaderPath, 0o644);
  return {
    [DSH_SKILL_ENV_DIR_ENV]: toGitBashPath(dir),
    [DSH_SKILL_ENV_LOADER_ENV]: toGitBashPath(loaderPath),
  };
}

/** Write a 0600 POSIX env file for one DSH session id (overwrites each turn). */
export function writeDshSkillSessionEnvFile(
  userDataPath: string,
  dshSessionId: string,
  env: Record<string, string>
): string | null {
  if (!isSafeDshSessionId(dshSessionId)) return null;
  const dir = dshSkillEnvDir(userDataPath);
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const dest = dshSkillEnvFilePath(userDataPath, dshSessionId);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, formatPosixEnvFile(env), { encoding: 'utf8' });
  tryChmod(tmp, 0o600);
  renameSync(tmp, dest);
  tryChmod(dest, 0o600);
  return dest;
}

/** Copy a parent session env file onto a subagent DSH session id. */
export function copyDshSkillSessionEnvFile(
  userDataPath: string,
  fromDshSessionId: string,
  toDshSessionId: string
): void {
  if (!isSafeDshSessionId(fromDshSessionId) || !isSafeDshSessionId(toDshSessionId)) return;
  if (fromDshSessionId === toDshSessionId) return;
  const src = dshSkillEnvFilePath(userDataPath, fromDshSessionId);
  if (!existsSync(src)) return;
  const dest = dshSkillEnvFilePath(userDataPath, toDshSessionId);
  copyFileSync(src, dest);
  tryChmod(dest, 0o600);
}

export const DSH_SKILL_ENV_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneStaleDshSkillEnvFiles(
  userDataPath: string,
  options?: { maxAgeMs?: number; nowMs?: number; activeDshSessionIds?: ReadonlySet<string> },
): number {
  const dir = dshSkillEnvDir(userDataPath);
  if (!existsSync(dir)) return 0;
  const maxAgeMs = Math.max(60_000, options?.maxAgeMs ?? DSH_SKILL_ENV_RETENTION_MS);
  const cutoffMs = (options?.nowMs ?? Date.now()) - maxAgeMs;
  const activeIds = options?.activeDshSessionIds;
  let removed = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.env')) continue;
      const sessionId = entry.name.slice(0, -4);
      if (activeIds?.has(sessionId)) continue;
      const fullPath = join(dir, entry.name);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs < cutoffMs) {
          unlinkSync(fullPath);
          removed += 1;
        }
      } catch {
        // Best-effort per-file cleanup.
      }
    }
  } catch {
    // Ignore directory read errors.
  }
  return removed;
}
