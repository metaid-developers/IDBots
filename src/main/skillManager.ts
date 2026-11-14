import { app, session } from 'electron';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { stripLoneSurrogates, truncateUtf16Units } from './libs/llmSafeText';
import yaml from 'js-yaml';
import extractZip from 'extract-zip';
import { SqliteStore } from './sqliteStore';
import { getEnhancedEnv, getSkillHostEnv } from './libs/coworkUtil';
import { isPathWithin, resolveElectronSkillExecutablePath } from './libs/runtimePaths';
import { resolveBundledSkillsRoot, resolveWritableSkillsRoot } from './libs/skillRoots';
import {
  assignSkillToMetabot,
  ensureSkillAssignmentSchema,
  getGlobalScopeMap,
  listAssignedSkillIds,
  listAssignmentMetabotIds,
  listMissingAuthorizedSkillIds,
  removeSkillFromAssignmentStore,
  setMetabotAssignedSkills,
  setSkillAssignments,
  setSkillScope,
  syncAllowChatSkillsColumnsFromRows,
  type SkillAssignmentVia,
} from './libs/skillAssignmentStore';
import type { MetabotStore } from './metabotStore';
import { buildImageSkillEnvOverrides } from './libs/skillImageProviderEnv';
import { getMetaidRpcBase, getMetaidRpcToken } from './services/metaidRpcEndpoint';
import { broadcastToRenderers } from './ipc/broadcast';

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
};

export type ChatSkillsRoutingPromptResult = {
  prompt: string | null;
  activeSkillIds: string[];
};

export type OrderSkillScopePromptResult = {
  prompt: string | null;
  activeSkillIds: string[];
  missingSkillNames: string[];
};

type SkillStateMap = Record<string, { enabled: boolean }>;

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

type EmailConnectivityCheck = {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
};

type SkillDefaultConfig = {
  order?: number;
  enabled?: boolean;
  version?: string;
  'creator-metaid'?: string;
  installedAt?: number;
  /** Where this skill was installed from (metafile://, URL, local path,
   * github ref, npm:<pkg>, skills.sh:<name>) — enables reinstall after the
   * directory is lost. Absent for installs that predate source tracking. */
  sourceUri?: string;
};

type SkillsConfig = {
  version: number;
  description?: string;
  defaults: Record<string, SkillDefaultConfig>;
};

const SKILLS_DIR_NAME = 'SKILLs';
const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_CONFIG_FILE = 'skills.config.json';
const SKILL_STATE_KEY = 'skills_state';
const WATCH_DEBOUNCE_MS = 250;
const SUPERPOWERS_SKILL_PREFIX = 'superpowers-';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_SCRIPT_REFERENCE_RE = /scripts\/[A-Za-z0-9._/-]+\.js/g;

const parseFrontmatter = (raw: string): { frontmatter: Record<string, unknown>; content: string } => {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, content: normalized };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (error) {
    console.warn('[skills] Failed to parse YAML frontmatter:', error);
  }

  const content = normalized.slice(match[0].length);
  return { frontmatter, content };
};

const isTruthy = (value?: unknown): boolean => {
  if (value === true) return true;
  if (!value || typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
};

const extractDescription = (content: string): string => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '');
  }
  return '';
};

const normalizeFolderName = (name: string): string => {
  const normalized = name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'skill';
};

const extractScriptReferencesFromSkillMarkdown = (content: string): string[] => {
  const matches = content.match(SKILL_SCRIPT_REFERENCE_RE);
  if (!matches) {
    return [];
  }

  return Array.from(
    new Set(
      matches
        .map((value) => value.replace(/\\/g, '/').replace(/^\.\/+/, ''))
        .filter((value) => value.startsWith('scripts/'))
    )
  );
};

const compareVersions = (a: string | undefined, b: string | undefined): number => {
  const parse = (value: string | undefined): number[] => {
    return String(value || '0')
      .replace(/^v/i, '')
      .split(/[.-]/)
      .map((part) => parseInt(part, 10) || 0);
  };

  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const va = aa[i] ?? 0;
    const vb = bb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
};

const isZipFile = (filePath: string): boolean => path.extname(filePath).toLowerCase() === '.zip';

const resolveWithin = (root: string, target: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  if (!isPathWithin(resolvedRoot, resolvedTarget)) {
    throw new Error('Invalid target path');
  }
  return resolvedTarget;
};

const appendEnvPath = (current: string | undefined, entries: string[]): string => {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const existing = (current || '').split(delimiter).filter(Boolean);
  const merged = [...existing];
  entries.forEach(entry => {
    if (!entry || merged.includes(entry)) return;
    merged.push(entry);
  });
  return merged.join(delimiter);
};

const listWindowsCommandPaths = (command: string): string[] => {
  if (process.platform !== 'win32') return [];

  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const resolveWindowsGitExecutable = (): string | null => {
  if (process.platform !== 'win32') return null;

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const installedCandidates = [
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(programFiles, 'Git', 'bin', 'git.exe'),
    path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'git.exe'),
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
  ];

  for (const candidate of installedCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const whereCandidates = listWindowsCommandPaths('where git');
  for (const candidate of whereCandidates) {
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (normalized.toLowerCase().endsWith('git.exe') && fs.existsSync(normalized)) {
      return normalized;
    }
  }

  const bundledRoots = app.isPackaged
    ? [path.join(process.resourcesPath, 'mingit')]
    : [
      path.join(__dirname, '..', '..', 'resources', 'mingit'),
      path.join(app.getAppPath(), 'resources', 'mingit'),
      path.join(process.cwd(), 'resources', 'mingit'),
    ];

  for (const root of bundledRoots) {
    const bundledCandidates = [
      path.join(root, 'cmd', 'git.exe'),
      path.join(root, 'bin', 'git.exe'),
      path.join(root, 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'usr', 'bin', 'git.exe'),
    ];
    for (const candidate of bundledCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const resolveGitCommand = (): { command: string; env?: NodeJS.ProcessEnv } => {
  if (process.platform !== 'win32') {
    return { command: 'git' };
  }

  const gitExe = resolveWindowsGitExecutable();
  if (!gitExe) {
    return { command: 'git' };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  const gitDir = path.dirname(gitExe);
  const gitRoot = path.dirname(gitDir);
  const candidateDirs = [
    gitDir,
    path.join(gitRoot, 'cmd'),
    path.join(gitRoot, 'bin'),
    path.join(gitRoot, 'mingw64', 'bin'),
    path.join(gitRoot, 'usr', 'bin'),
  ].filter(dir => fs.existsSync(dir));

  env.PATH = appendEnvPath(env.PATH, candidateDirs);
  return { command: gitExe, env };
};

const runCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', error => reject(error));
  child.on('close', code => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
  });
});

type SkillScriptRunResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  spawnErrorCode?: string;
};

const runScriptWithTimeout = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SkillScriptRunResult> => new Promise((resolve) => {
  const startedAt = Date.now();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let forceKillTimer: NodeJS.Timeout | null = null;

  const settle = (result: SkillScriptRunResult) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2000);
  }, options.timeoutMs);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    settle({
      success: false,
      exitCode: null,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut,
      error: error.message,
      spawnErrorCode: error.code,
    });
  });

  child.on('close', (exitCode) => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    settle({
      success: !timedOut && exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut,
      error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
    });
  });
});

const cleanupPathSafely = (targetPath: string | null): void => {
  if (!targetPath) return;
  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: process.platform === 'win32' ? 200 : 0,
    });
  } catch (error) {
    console.warn('[skills] Failed to cleanup temporary directory:', targetPath, error);
  }
};

const listSkillDirs = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const skillFile = path.join(root, SKILL_FILE_NAME);
  if (fs.existsSync(skillFile)) {
    return [root];
  }

  const entries = fs.readdirSync(root);
  return entries
    .map(entry => path.join(root, entry))
    .filter((entryPath) => {
      try {
        const stat = fs.lstatSync(entryPath);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          return false;
        }
        return fs.existsSync(path.join(entryPath, SKILL_FILE_NAME));
      } catch {
        return false;
      }
    });
};

/**
 * Bundled-skill ids whose userData copy declares npm dependencies
 * (package.json) but has no node_modules yet — candidates for the background
 * first-use dependency install. web-search is excluded: SkillServices owns
 * its dedicated runtime repair flow. Pure/fs-only; exported for tests.
 */
export const findBundledSkillsMissingDependencies = (
  bundledIds: readonly string[],
  userRoot: string
): string[] => {
  return bundledIds.filter((id) => {
    if (id === 'web-search') return false;
    const dir = path.join(userRoot, id);
    return fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'));
  });
};

const collectSkillDirsFromSource = (source: string): string[] => {
  const resolved = path.resolve(source);
  if (fs.existsSync(path.join(resolved, SKILL_FILE_NAME))) {
    return [resolved];
  }

  const nestedRoot = path.join(resolved, SKILLS_DIR_NAME);
  if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
    const nestedSkills = listSkillDirs(nestedRoot);
    if (nestedSkills.length > 0) {
      return nestedSkills;
    }
  }

  const directSkills = listSkillDirs(resolved);
  if (directSkills.length > 0) {
    return directSkills;
  }

  return collectSkillDirsRecursively(resolved);
};

const collectSkillDirsRecursively = (root: string): string[] => {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];

  const matchedDirs: string[] = [];
  const queue: string[] = [resolvedRoot];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const normalized = path.resolve(current);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(normalized);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

    if (fs.existsSync(path.join(normalized, SKILL_FILE_NAME))) {
      matchedDirs.push(normalized);
      continue;
    }

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(normalized);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry || entry === '.git' || entry === 'node_modules') continue;
      queue.push(path.join(normalized, entry));
    }
  }

  return matchedDirs;
};

const deriveRepoName = (source: string): string => {
  const cleaned = source.replace(/[#?].*$/, '');
  const base = cleaned.split('/').filter(Boolean).pop() || 'skill';
  return normalizeFolderName(base.replace(/\.git$/, ''));
};

type NormalizedGitSource = {
  repoUrl: string;
  sourceSubpath?: string;
  ref?: string;
  repoNameHint?: string;
};

type GithubRepoSource = {
  owner: string;
  repo: string;
};

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const parseGithubRepoSource = (repoUrl: string): GithubRepoSource | null => {
  const trimmed = repoUrl.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(trimmed);
    if (!['github.com', 'www.github.com'].includes(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    const segments = parsedUrl.pathname
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    return {
      owner: segments[0],
      repo: segments[1],
    };
  } catch {
    return null;
  }
};

const downloadGithubArchive = async (
  source: GithubRepoSource,
  tempRoot: string,
  ref?: string
): Promise<string> => {
  const encodedRef = ref ? encodeURIComponent(ref) : '';
  const archiveUrlCandidates: Array<{ url: string; headers: Record<string, string> }> = [];

  if (encodedRef) {
    archiveUrlCandidates.push(
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/refs/heads/${encodedRef}.zip`,
        headers: { 'User-Agent': 'IDBots Skill Downloader' },
      },
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/refs/tags/${encodedRef}.zip`,
        headers: { 'User-Agent': 'IDBots Skill Downloader' },
      },
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/${encodedRef}.zip`,
        headers: { 'User-Agent': 'IDBots Skill Downloader' },
      }
    );
  }

  archiveUrlCandidates.push({
    url: `https://api.github.com/repos/${source.owner}/${source.repo}/zipball${encodedRef ? `/${encodedRef}` : ''}`,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'IDBots Skill Downloader',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  let buffer: Buffer | null = null;
  let lastError: string | null = null;

  for (const candidate of archiveUrlCandidates) {
    try {
      const response = await session.defaultSession.fetch(candidate.url, {
        method: 'GET',
        headers: candidate.headers,
      });

      if (!response.ok) {
        const detail = (await response.text()).trim();
        lastError = `Archive download failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`;
        continue;
      }

      buffer = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      lastError = extractErrorMessage(error);
    }
  }

  if (!buffer) {
    throw new Error(lastError || 'Archive download failed');
  }

  const zipPath = path.join(tempRoot, 'github-archive.zip');
  const extractRoot = path.join(tempRoot, 'github-archive');
  fs.writeFileSync(zipPath, buffer);
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZip(zipPath, { dir: extractRoot });

  const extractedDirs = fs.readdirSync(extractRoot)
    .map(entry => path.join(extractRoot, entry))
    .filter(entryPath => {
      try {
        return fs.statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });

  if (extractedDirs.length === 1) {
    return extractedDirs[0];
  }

  return extractRoot;
};

const normalizeGithubSubpath = (value: string): string | null => {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  const segments = trimmed
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
};

const parseGithubTreeOrBlobUrl = (source: string): NormalizedGitSource | null => {
  try {
    const parsedUrl = new URL(source);
    if (!['github.com', 'www.github.com'].includes(parsedUrl.hostname)) {
      return null;
    }

    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    if (segments.length < 5) {
      return null;
    }

    const [owner, repoRaw, mode, ref, ...rest] = segments;
    if (!owner || !repoRaw || !ref || (mode !== 'tree' && mode !== 'blob')) {
      return null;
    }

    const repo = repoRaw.replace(/\.git$/i, '');
    const sourceSubpath = normalizeGithubSubpath(rest.join('/'));
    if (!repo || !sourceSubpath) {
      return null;
    }

    return {
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      sourceSubpath,
      ref: decodeURIComponent(ref),
      repoNameHint: repo,
    };
  } catch {
    return null;
  }
};

const isWebSearchSkillBroken = (skillRoot: string): boolean => {
  const startServerScript = path.join(skillRoot, 'scripts', 'start-server.sh');
  const searchScript = path.join(skillRoot, 'scripts', 'search.sh');
  const serverEntry = path.join(skillRoot, 'dist', 'server', 'index.js');
  const requiredPaths = [
    startServerScript,
    searchScript,
    serverEntry,
    path.join(skillRoot, 'node_modules', 'iconv-lite', 'encodings', 'index.js'),
  ];

  if (requiredPaths.some(requiredPath => !fs.existsSync(requiredPath))) {
    return true;
  }

  try {
    const startScript = fs.readFileSync(startServerScript, 'utf-8');
    const searchScriptContent = fs.readFileSync(searchScript, 'utf-8');
    const serverEntryContent = fs.readFileSync(serverEntry, 'utf-8');
    if (!startScript.includes('WEB_SEARCH_FORCE_REPAIR')) {
      return true;
    }
    if (!startScript.includes('detect_healthy_bridge_server')) {
      return true;
    }
    if (!searchScriptContent.includes('ACTIVE_SERVER_URL')) {
      return true;
    }
    if (!searchScriptContent.includes('try_switch_to_local_server')) {
      return true;
    }
    if (!searchScriptContent.includes('build_search_payload')) {
      return true;
    }
    if (!searchScriptContent.includes('@query_file')) {
      return true;
    }
    if (!serverEntryContent.includes('decodeJsonRequestBody')) {
      return true;
    }
    if (!serverEntryContent.includes("TextDecoder('gb18030'")) {
      return true;
    }
  } catch {
    return true;
  }

  return false;
};

export class SkillManager {
  private watchers: fs.FSWatcher[] = [];
  private notifyTimer: NodeJS.Timeout | null = null;
  private getMetabotStoreImpl: (() => MetabotStore) | null = null;

  constructor(private getStore: () => SqliteStore) {}

  /**
   * Wire the MetabotStore (main.ts) so assignment-row writes can mirror into
   * metabots.allow_chat_skills — the published projection the bot editors
   * initialize their replacement lists from. Optional: callers without a bot
   * roster (tests, bare embeddings) simply skip the column sync.
   */
  setMetabotStoreGetter(getter: () => MetabotStore): void {
    this.getMetabotStoreImpl = getter;
  }

  /**
   * Mirror rows -> allow_chat_skills column for the given bots (no-op when the
   * metabot store is not wired). Runs after every assignment-row write so the
   * column never goes stale again: a stale column is what made bot edits
   * silently un-assign skill_tool-installed skills.
   */
  private syncAllowChatSkillsColumns(metabotIds: Iterable<number>): void {
    if (!this.getMetabotStoreImpl) return;
    try {
      const store = this.getStore();
      const synced = syncAllowChatSkillsColumnsFromRows(
        store.getDatabase(),
        store.getSaveFunction(),
        this.getMetabotStoreImpl(),
        metabotIds
      );
      if (synced.length > 0) {
        console.log(
          `[skills-audit] allow_chat_skills column re-synced from assignment rows for metabot(s): ${synced.join(', ')}`
        );
      }
    } catch (error) {
      console.warn('[skills] allow_chat_skills column sync failed:', error);
    }
  }

  /**
   * One heal pass over every bot: the column must equal the assignment rows.
   * Idempotent (writes only on drift), so it runs at every startup — covers
   * both historical drift (skill_tool installs never reached the column) and
   * any future write path that forgets to sync.
   */
  reconcileAllowChatSkillsColumns(): void {
    if (!this.getMetabotStoreImpl) return;
    try {
      this.ensureAssignmentSchema();
      const ids = this.getMetabotStoreImpl().listMetabots().map((metabot) => metabot.id);
      this.syncAllowChatSkillsColumns(ids);
    } catch (error) {
      console.warn('[skills] allow_chat_skills reconcile failed:', error);
    }
  }

  private getSkillIdCandidates(skillId: string): string[] {
    const trimmed = String(skillId || '').trim();
    if (!trimmed) return [];
    return Array.from(new Set([
      trimmed,
      trimmed.replace(/_/g, '-'),
      trimmed.replace(/-/g, '_'),
    ]));
  }

  private resolveSkillById(skillId: string, skills: SkillRecord[] = this.listSkills()): SkillRecord | null {
    const candidates = this.getSkillIdCandidates(skillId);
    for (const candidate of candidates) {
      const match = skills.find((s) => s.id === candidate);
      if (match) return match;
    }
    return null;
  }

  private resolveSkillByName(skillName: string, skills: SkillRecord[] = this.listSkills()): SkillRecord | null {
    const trimmed = String(skillName || '').trim();
    if (!trimmed) return null;
    const normalized = trimmed.toLowerCase();
    return skills.find((skill) => skill.name.trim().toLowerCase() === normalized) ?? null;
  }

  getSkillsRoot(): string {
    return resolveWritableSkillsRoot();
  }

  ensureSkillsRoot(): string {
    const root = this.getSkillsRoot();
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  /**
   * Returns all skill roots (userData + bundled/project) in the same order as listSkills.
   * Used by cognitive orchestrator for Read/Bash multi-root support.
   */
  getAllSkillRoots(): string[] {
    return this.getSkillRoots(this.ensureSkillsRoot());
  }

  syncBundledSkillsToUserData(): void {
    if (!app.isPackaged) {
      return;
    }

    const userRoot = this.ensureSkillsRoot();
    const bundledRoot = this.getBundledSkillsRoot();
    if (!bundledRoot || bundledRoot === userRoot || !fs.existsSync(bundledRoot)) {
      return;
    }

    try {
      const bundledDefaults = this.loadSkillDefaultsFromRoot(bundledRoot);
      const userDefaults = this.loadSkillDefaultsFromRoot(userRoot);
      const syncedSkillIds = new Set<string>();
      const bundledSkillDirs = listSkillDirs(bundledRoot);
      bundledSkillDirs.forEach((dir) => {
        const id = path.basename(dir);
        const targetDir = path.join(userRoot, id);
        const targetExists = fs.existsSync(targetDir);
        const shouldRepair = id === 'web-search' && targetExists && isWebSearchSkillBroken(targetDir);
        const bundledVersion = bundledDefaults[id]?.version;
        const localVersion = userDefaults[id]?.version;
        const canRepairFromBundled = compareVersions(bundledVersion, localVersion) >= 0;
        const isOfficial = this.isOfficialSkillDir(dir);
        const shouldUpgradeByVersion = targetExists && compareVersions(bundledVersion, localVersion) > 0;
        const shouldBootstrapOfficialUpdate = targetExists
          && !localVersion
          && isOfficial
          && this.isSkillContentDifferent(dir, targetDir);
        const shouldRepairRuntime = targetExists
          && isOfficial
          && canRepairFromBundled
          && this.isSkillRuntimeBroken(dir, targetDir);
        const shouldPatchRuntimeOnly = targetExists
          && isOfficial
          && !canRepairFromBundled
          && this.isSkillRuntimeBroken(dir, targetDir);
        // Compare the whole skill directory (not just SKILL.md) so script-only
        // updates also reach existing users without requiring a version bump.
        const shouldRefreshOfficialContent = targetExists
          && isOfficial
          && canRepairFromBundled
          && this.isSkillContentDifferent(dir, targetDir);
        const shouldSync = !targetExists
          || shouldRepair
          || shouldUpgradeByVersion
          || shouldBootstrapOfficialUpdate
          || shouldRepairRuntime
          || shouldPatchRuntimeOnly
          || shouldRefreshOfficialContent;
        if (!shouldSync) return;

        try {
          if (shouldPatchRuntimeOnly) {
            const patched = this.patchSkillRuntimeFromBundled(dir, targetDir);
            if (patched) {
              console.log(`[skills] Patched missing runtime files for skill "${id}" without version override`);
            } else {
              console.warn(`[skills] Skill "${id}" runtime appears broken, but no patchable bundled files were found`);
            }
            return;
          }

          const forceCopy = targetExists;
          if (targetExists && isOfficial) {
            // Official skills are app-managed: replace the whole directory so files
            // dropped from newer bundles do not linger in the user copy.
            fs.rmSync(targetDir, { recursive: true, force: true });
          }
          fs.cpSync(dir, targetDir, {
            recursive: true,
            dereference: true,
            force: forceCopy,
            errorOnExist: false,
          });
          syncedSkillIds.add(id);
          if (shouldRepair) {
            console.log('[skills] Repaired bundled skill "web-search" in user data');
          } else if (shouldUpgradeByVersion) {
            console.log(`[skills] Upgraded bundled skill "${id}" in user data (${localVersion || 'unknown'} -> ${bundledVersion || 'unknown'})`);
          } else if (shouldBootstrapOfficialUpdate) {
            console.log(`[skills] Refreshed legacy bundled skill "${id}" in user data`);
          } else if (shouldRepairRuntime) {
            console.log(`[skills] Repaired runtime files for bundled skill "${id}" in user data`);
          } else if (shouldRefreshOfficialContent) {
            console.log(`[skills] Refreshed official skill "${id}" due to content drift in user data`);
          }
        } catch (error) {
          console.warn(`[skills] Failed to sync bundled skill "${id}":`, error);
        }
      });

      const bundledConfig = path.join(bundledRoot, SKILLS_CONFIG_FILE);
      const targetConfig = path.join(userRoot, SKILLS_CONFIG_FILE);
      if (fs.existsSync(bundledConfig) && !fs.existsSync(targetConfig)) {
        fs.cpSync(bundledConfig, targetConfig, { dereference: false });
      }
      if (syncedSkillIds.size > 0) {
        this.mergeBundledSkillDefaults(userRoot, bundledRoot, syncedSkillIds);
      }

      // Retire legacy skill directories that were renamed in the bundled set,
      // so upgraded users do not end up with two competing skills.
      this.retireLegacySkillsFromUserData(userRoot);

      // Bundled skills with npm dependencies (pptx, imap-smtp-email, ...)
      // ship without node_modules; install them in the background so the
      // skill works on first use after an upgrade.
      this.ensureBundledSkillDependencies();
    } catch (error) {
      console.warn('[skills] Failed to sync bundled skills:', error);
    }
  }

  private skillDependencyInstallRunning = false;

  /**
   * Spawn npm with the login-shell-aware skill env merged in: an Electron app
   * launched from Finder/Dock/Start menu gets a bare PATH, so a Homebrew/nvm
   * npm would be invisible with raw process.env.
   */
  private skillChildEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...getSkillHostEnv() };
  }

  private hasNpm(): boolean {
    try {
      const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: process.platform === 'win32',
        env: this.skillChildEnv(),
      });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  private runNpmInstall(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: dir,
        windowsHide: true,
        shell: process.platform === 'win32',
        env: this.skillChildEnv(),
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install exited ${code}: ${stderr.trim().slice(-500)}`));
        }
      });
    });
  }

  /**
   * Bundled skills with npm dependencies (pptx, imap-smtp-email, ...) are
   * copied into user data without node_modules; install them in the
   * background so the skill works on first use after an upgrade. web-search
   * is owned by SkillServices' dedicated repair flow and is skipped here.
   * Best-effort: failures are logged and the skill needs a manual install.
   * Runs against the userData copy only — the repo tree stays pnpm-managed.
   */
  ensureBundledSkillDependencies(): void {
    if (this.skillDependencyInstallRunning) return;
    let ids: string[];
    try {
      ids = findBundledSkillsMissingDependencies(
        Array.from(this.listBuiltInSkillIds()),
        this.ensureSkillsRoot()
      );
    } catch {
      return;
    }
    if (ids.length === 0) return;
    if (!this.hasNpm()) {
      console.warn(`[skills] Bundled skill dependencies pending but npm is unavailable on this machine: ${ids.join(', ')}`);
      return;
    }
    this.skillDependencyInstallRunning = true;
    void (async () => {
      for (const id of ids) {
        const dir = path.join(this.ensureSkillsRoot(), id);
        try {
          console.log(`[skills] Installing dependencies for bundled skill "${id}" (first-use preparation)…`);
          await this.runNpmInstall(dir);
          console.log(`[skills] Dependencies ready for bundled skill "${id}"`);
        } catch (error) {
          console.warn(
            `[skills] Dependency install failed for bundled skill "${id}" (the skill needs a manual npm install in its directory):`,
            error instanceof Error ? error.message : error
          );
        }
      }
    })().finally(() => {
      this.skillDependencyInstallRunning = false;
    });
  }

  private retireLegacySkillsFromUserData(userRoot: string): void {
    // metabot-upload-file was converted to the built-in upload_file tool; its
    // on-chain logic now lives in services/metaFileUploadService.ts. The six
    // metabot-* skills below were likewise converted to native built-in tools
    // (post_buzz / send_private_chat / group_chat / omni_read / omni_cast /
    // browser_open — see src/main/libs/*AgentTools.ts). Retire the external
    // skills so existing installs drop them (dir + skills.config entry).
    //
    // The 2026-09 bundled-set prune removed ten more skills from the default
    // bundle: metabot-create-metaapp / metabot-post-metaapp were superseded by
    // the unified metabot-metaapp skill (IDFramework legacy + standalone
    // publish flow); the rest (proactive-agent, create-plan, develop-web-game,
    // films-search, music-search, remotion, find-skills, technology-news-
    // search) were ecosystem imports overlapping built-in tools or marginal
    // for the product. Existing installs drop them on upgrade; owners who
    // still want one can reinstall it from the skill market.
    //
    // The 2026-09-30 prune drops the two on-chain trading skills from the
    // default bundle on owner request: metabot-trade-metaidmarket was bundled,
    // metabot-trade-mvcswap was never bundled in current builds but exists in
    // older installs (seeded scope=global by the assignment migration) — both
    // are retired here so existing installs drop them too.
    // metabot-chat was once bundled (still carries official: true) and is fully
    // superseded by the built-in group_chat tool's orchestrate action; it was
    // dropped from the bundle without a retire entry, so existing installs
    // kept it — retire it now.
    const retiredSkillIds = [
      'metabot-upload-largefile',
      'metabot-upload-file',
      'metabot-post-buzz',
      'metabot-chat-privatechat',
      'metabot-chat-groupchat',
      'metabot-omni-reader',
      'metabot-omni-caster',
      'metabot-browser-open',
      'metabot-create-metaapp',
      'metabot-post-metaapp',
      'proactive-agent-3.1.0',
      'create-plan',
      'develop-web-game',
      'films-search',
      'music-search',
      'remotion',
      'find-skills-0.1.0',
      'technology-news-search',
      'metabot-trade-metaidmarket',
      'metabot-trade-mvcswap',
      'metabot-chat',
    ];
    for (const retiredId of retiredSkillIds) {
      const legacyDir = path.join(userRoot, retiredId);
      try {
        if (fs.existsSync(legacyDir)) {
          fs.rmSync(legacyDir, { recursive: true, force: true });
          console.log(`[skills] Removed retired skill "${retiredId}" from user data`);
        }
      } catch (error) {
        console.warn(`[skills] Failed to remove retired skill "${retiredId}":`, error);
      }
      // Purge the authorization trail too (assignment rows + global scope):
      // retired means gone, and dangling authorization would otherwise surface
      // in the missing-skills detector as a reinstallable ghost. Reinstalling
      // from the market starts library-scoped, same as deleteSkill.
      try {
        this.ensureAssignmentSchema();
        const store = this.getStore();
        const db = store.getDatabase();
        const affectedBots = listAssignmentMetabotIds(db, retiredId);
        removeSkillFromAssignmentStore(db, store.getSaveFunction(), store, retiredId);
        if (affectedBots.length > 0) {
          console.log(
            `[skills-audit] retired skill "${retiredId}" un-assigned from metabot(s): ${affectedBots.join(', ')}`
          );
          this.syncAllowChatSkillsColumns(affectedBots);
        }
      } catch (error) {
        console.warn(`[skills] Failed to purge authorization for retired skill "${retiredId}":`, error);
      }
    }

    const targetConfigPath = path.join(userRoot, SKILLS_CONFIG_FILE);
    if (!fs.existsSync(targetConfigPath)) {
      return;
    }
    try {
      const targetRaw = fs.readFileSync(targetConfigPath, 'utf8');
      const targetConfig = JSON.parse(targetRaw) as SkillsConfig;
      let changed = false;
      if (targetConfig.defaults && typeof targetConfig.defaults === 'object') {
        for (const retiredId of retiredSkillIds) {
          if (retiredId in targetConfig.defaults) {
            delete targetConfig.defaults[retiredId];
            changed = true;
          }
        }
      }
      if (changed) {
        fs.writeFileSync(targetConfigPath, JSON.stringify(targetConfig, null, 2), 'utf8');
        console.log('[skills] Pruned retired skill entries from user skills.config.json');
      }
    } catch (error) {
      console.warn('[skills] Failed to prune retired skill config entries:', error);
    }
  }

  listSkills(): SkillRecord[] {
    const primaryRoot = this.ensureSkillsRoot();
    const state = this.loadSkillStateMap();
    const roots = this.getSkillRoots(primaryRoot);
    const orderedRoots = roots.filter(root => root !== primaryRoot).concat(primaryRoot);
    const defaults = this.loadSkillsDefaults(roots);
    const builtInSkillIds = this.listBuiltInSkillIds();
    const skillMap = new Map<string, SkillRecord>();

    orderedRoots.forEach(root => {
      if (!fs.existsSync(root)) return;
      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        const skill = this.parseSkillDir(dir, state, defaults, builtInSkillIds.has(path.basename(dir)));
        if (!skill) return;
        skillMap.set(skill.id, skill);
      });
    });

    const skills = Array.from(skillMap.values());

    skills.sort((a, b) => {
      const orderA = defaults[a.id]?.order ?? 999;
      const orderB = defaults[b.id]?.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    return skills;
  }

  /* ------------------------------------------------------------------ */
  /* Per-MetaBot skill resolution (assignment model)                     */
  /* ------------------------------------------------------------------ */

  private assignmentSchemaEnsured = false;

  /** Create the assignment table on first use (idempotent, memoized). */
  private ensureAssignmentSchema(): void {
    if (this.assignmentSchemaEnsured) return;
    ensureSkillAssignmentSchema(this.getStore().getDatabase());
    this.assignmentSchemaEnsured = true;
  }

  /**
   * Skills visible to one bot: bundled (implicitly every bot) + scope=global +
   * explicitly assigned, all still gated by the library-level enabled switch.
   * A null metabotId (bot-less user session or system surface) sees bundled +
   * global only. The memory backend's twin-fallback must NOT be reused here:
   * a bot-less session resolving the first twin's skills would silently leak
   * that bot's assignments into the user's own sessions.
   */
  listSkillsForMetabot(metabotId: number | null): SkillRecord[] {
    this.ensureAssignmentSchema();
    const enabled = this.listSkills().filter((skill) => skill.enabled && skill.prompt);
    const globalScope = getGlobalScopeMap(this.getStore());
    if (metabotId == null) {
      return enabled.filter((skill) => skill.isBuiltIn || globalScope[skill.id] === 'global');
    }
    const assigned = new Set(listAssignedSkillIds(this.getStore().getDatabase(), metabotId));
    return enabled.filter(
      (skill) => skill.isBuiltIn || globalScope[skill.id] === 'global' || assigned.has(skill.id)
    );
  }

  /**
   * Pinned-skill backstop for the cowork IPC boundary: intersect a
   * renderer-supplied skill-id list with the bot's visible set (bundled +
   * global + assigned; a null metabotId maps to bundled + global — never an
   * empty set). The renderer scopes its own skills picker, but the boundary
   * cannot trust it: a bypassed or forged renderer must not be able to pin
   * arbitrary library skills onto any bot's session (same boundary as the
   * B2 assignment-write hole).
   */
  filterSkillIdsForMetabotView(skillIds: readonly string[], metabotId: number | null): string[] {
    if (skillIds.length === 0) return [];
    const visibleIds = new Set(this.listSkillsForMetabot(metabotId).map((skill) => skill.id));
    return skillIds.filter((id) => visibleIds.has(id));
  }

  /**
   * Chat-routing baseline (anyone messaging the bot): BUNDLED skills + the
   * bot's ASSIGNED external skills. Bundled skills are host-blessed and must
   * stay usable by every peer (A2A chats, group-task workers, OpenTeam
   * guests) — otherwise they would be unreachable for every bot but the
   * owner/chair. Global external skills stay OUT of the baseline: they are
   * community-installed code the owner only meant to share across their own
   * bots, so peer-triggered turns must not run them.
   */
  private listChatRoutingBaselineSkills(metabotId: number | null): SkillRecord[] {
    const enabled = this.listSkills().filter((skill) => skill.enabled && skill.prompt);
    if (metabotId == null) {
      return enabled.filter((skill) => skill.isBuiltIn);
    }
    this.ensureAssignmentSchema();
    const assigned = new Set(listAssignedSkillIds(this.getStore().getDatabase(), metabotId));
    return enabled.filter((skill) => skill.isBuiltIn || assigned.has(skill.id));
  }

  /** Library metadata for the Skills UI: scope + assigned bots, external skills only. */
  getSkillAssignmentInfo(): Record<string, { scope: 'library' | 'global'; assignedMetabotIds: number[] }> {
    this.ensureAssignmentSchema();
    const globalScope = getGlobalScopeMap(this.getStore());
    const db = this.getStore().getDatabase();
    const info: Record<string, { scope: 'library' | 'global'; assignedMetabotIds: number[] }> = {};
    for (const skill of this.listSkills()) {
      if (skill.isBuiltIn) continue;
      info[skill.id] = {
        scope: globalScope[skill.id] === 'global' ? 'global' : 'library',
        assignedMetabotIds: listAssignmentMetabotIds(db, skill.id),
      };
    }
    return info;
  }

  setSkillScopeForSkill(id: string, scope: 'library' | 'global'): void {
    const resolved = this.resolveSkillById(id);
    if (!resolved) {
      throw new Error(`Unknown skill: ${id}`);
    }
    setSkillScope(this.getStore(), resolved.id, scope);
    console.log(`[skills-audit] skill "${resolved.id}" scope set to ${scope}`);
    this.notifySkillsChanged();
  }

  /** Skill-side scope editor: replace one skill's assignment set exactly. */
  setAssignmentsForSkill(id: string, metabotIds: number[], via: SkillAssignmentVia = 'ui'): void {
    const resolved = this.resolveSkillById(id);
    if (!resolved) {
      throw new Error(`Unknown skill: ${id}`);
    }
    const store = this.getStore();
    const db = store.getDatabase();
    const before = new Set(listAssignmentMetabotIds(db, resolved.id));
    setSkillAssignments(db, store.getSaveFunction(), resolved.id, metabotIds, via);
    const after = new Set(
      metabotIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
    );
    const removed = [...before].filter((metabotId) => !after.has(metabotId));
    if (removed.length > 0) {
      console.log(
        `[skills-audit] unassigned skill "${resolved.id}" from metabot(s) ${removed.join(', ')} (via=${via})`
      );
    }
    this.syncAllowChatSkillsColumns([...before, ...after]);
    this.notifySkillsChanged();
  }

  /** Resolve an allowlist entry (skill id or name) to a registry skill id. */
  resolveSkillIdForAssignment(idOrName: string): string | null {
    const skills = this.listSkills();
    const match = this.resolveSkillById(idOrName, skills) ?? this.resolveSkillByName(idOrName, skills);
    return match?.id ?? null;
  }

  /**
   * Bot-side assignment replace (metabot_update / bot Skills tab). Accepts ids
   * or names; bundled skills are dropped — they are implicitly visible to
   * every bot and must not consume assignment rows. Returns the resolved ids
   * so callers can mirror them into metabots.allow_chat_skills.
   */
  applyMetabotAssignedSkills(
    metabotId: number,
    entries: readonly string[],
    via: SkillAssignmentVia = 'metabot_update'
  ): string[] {
    this.ensureAssignmentSchema();
    const skills = this.listSkills();
    const seen = new Set<string>();
    const resolvedIds: string[] = [];
    for (const entry of entries) {
      const match = this.resolveSkillById(entry, skills) ?? this.resolveSkillByName(entry, skills);
      if (!match || match.isBuiltIn || seen.has(match.id)) continue;
      seen.add(match.id);
      resolvedIds.push(match.id);
    }
    const store = this.getStore();
    const db = store.getDatabase();
    const previous = listAssignedSkillIds(db, metabotId);
    setMetabotAssignedSkills(db, store.getSaveFunction(), metabotId, resolvedIds, via);
    const removed = previous.filter((skillId) => !resolvedIds.includes(skillId));
    if (removed.length > 0) {
      console.log(
        `[skills-audit] metabot ${metabotId} assignment replace (via=${via}) removed skill(s): ${removed.join(', ')}`
      );
    }
    this.syncAllowChatSkillsColumns([metabotId]);
    this.notifySkillsChanged();
    return resolvedIds;
  }

  /** skill_tool install auto-assignment: add one skill to one bot. */
  assignInstalledSkill(skillId: string, metabotId: number, via: SkillAssignmentVia = 'skill_tool'): void {
    this.ensureAssignmentSchema();
    const store = this.getStore();
    assignSkillToMetabot(store.getDatabase(), store.getSaveFunction(), skillId, metabotId, via);
    console.log(`[skills-audit] assigned skill "${skillId}" to metabot ${metabotId} (via=${via})`);
    this.syncAllowChatSkillsColumns([metabotId]);
    this.notifySkillsChanged();
  }

  private isSuperpowersSkillId(skillId: string): boolean {
    return String(skillId || '').trim().startsWith(SUPERPOWERS_SKILL_PREFIX);
  }

  /**
   * Cap routing-list descriptions: the router only needs the leading trigger
   * clauses, and a handful of skills carry 700-900-char descriptions that
   * bloat every first-turn prompt on both kernels. Truncate at the last
   * sentence/clause boundary before the cap (falling back to a hard cut when
   * no boundary sits in the last 40%) so trailing keywords are not half-cut.
   */
  private truncateSkillDescriptionForListing(description: string, maxChars = 500): string {
    const text = stripLoneSurrogates(String(description ?? '').trim());
    if (text.length <= maxChars) return text;
    const window = truncateUtf16Units(text, maxChars);
    const boundary = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('. '),
      window.lastIndexOf('; '),
      window.lastIndexOf('；'),
      window.lastIndexOf('\n')
    );
    const cut = boundary >= maxChars * 0.6 ? window.slice(0, boundary + 1) : window;
    return `${cut.trim()}…`;
  }

  private buildSkillEntries(skills: SkillRecord[]): string {
    return skills
      .map((skill) => `  <skill><id>${skill.id}</id><name>${skill.name}</name><description>${this.truncateSkillDescriptionForListing(skill.description)}</description><location>${skill.skillPath}</location></skill>`)
      .join('\n');
  }

  /**
   * Compact per-skill lines for the cowork volatile catalog: `- \`name\`:
   * description`, one skill per line, no <location>. Host absolute paths add
   * ~50-80 chars per skill to every carried turn and the model does not need
   * them — it loads the full SKILL.md on demand via skill_tool read_skill,
   * which returns the skill directory for relative-path resolution.
   */
  private buildSkillCatalogLines(skills: SkillRecord[]): string {
    return skills
      .map((skill) => `- \`${skill.name}\`: ${this.truncateSkillDescriptionForListing(skill.description)}`)
      .join('\n');
  }

  private buildRoutingPromptFromSkills(
    skills: SkillRecord[],
    options?: {
      introBlocks?: string[];
      extraRules?: string[];
      /**
       * 'inline' appends the <available_skills> catalog to this prompt section
       * (IM/scheduler/sandbox surfaces). 'volatile' leaves the catalog out:
       * cowork sessions inject it into the per-turn user-message tail instead
       * (see buildVolatileContextPrompt in coworkRunner), keeping the
       * cacheable system-prompt head byte-stable when skills are installed or
       * updated mid-session.
       */
      catalogPlacement?: 'inline' | 'volatile';
    }
  ): string | null {
    if (skills.length === 0) return null;

    const catalogInline = (options?.catalogPlacement ?? 'inline') === 'inline';

    // Token-diet rewrite (Phase 3): 17 rule lines -> 7. Every hard-won
    // semantic guard survives (selection discipline, Read+Bash-only
    // execution, exit-0 = success, dirname resolution, precompiled
    // entrypoints, one-skill-up-front); the MetaApp precedence now lives here
    // as ONE line instead of four — the detailed rules stay in the MetaApp
    // block that immediately precedes this one when MetaApps exist.
    const promptBody = [
      '## Skills (mandatory)',
      ...(catalogInline
        ? [
          'Before replying: scan <available_skills> <description> entries.',
          '- If the current turn explicitly asks to open/use/start a local app or MetaApp, prefer app routing over skill routing; generic confirmations ("好的" / "确定" / "继续") are not app requests.',
          '- Select the one clearly-applicable skill (the most specific if several), read its SKILL.md at <location>, and follow it; if none clearly applies, do not read any SKILL.md.',
        ]
        : [
          'Before replying: scan the <available_skills> catalog carried in this conversation\'s context messages (a user-role block listing each skill\'s name and description).',
          '- If the current turn explicitly asks to open/use/start a local app or MetaApp, prefer app routing over skill routing; generic confirmations ("好的" / "确定" / "继续") are not app requests.',
          '- Select the one clearly-applicable skill (the most specific if several), load it with skill_tool (action read_skill), and follow it; if none clearly applies, do not load any skill.',
          '- If no <available_skills> catalog is visible in the conversation (e.g. after context compaction), call skill_tool with action list_installed_skills to rediscover the available skills.',
        ]),
      '- Execute skills only via the file-read and shell tools as documented in each SKILL.md; never call a "Skill" tool — it is not wired to this registry.',
      '- A skill command that exits with code 0 is successful: do not bypass it with ad-hoc fallback logic. If it fails, diagnose and retry within the same skill workflow before considering alternatives.',
      '- Resolve relative paths in a SKILL.md against that skill\'s own directory (the <location> dirname, or the directory returned by read_skill), not the workspace root; prefer precompiled JavaScript entrypoints (scripts/*.js or scripts/dist/*.js) over npx ts-node unless absolutely required.',
      '- Never read more than one skill up front; read another only if the first one explicitly references it.',
      ...(options?.extraRules ?? []).filter(Boolean),
      ...(catalogInline
        ? ['', '<available_skills>', this.buildSkillEntries(skills), '</available_skills>']
        : []),
    ].join('\n');

    const introBlocks = (options?.introBlocks ?? []).filter((block): block is string => Boolean(block?.trim()));
    return [...introBlocks, promptBody].join('\n\n');
  }

  private buildCoworkSuperpowersBootstrap(skills: SkillRecord[]): string | null {
    const enabledSuperpowersSkills = skills.filter((skill) => this.isSuperpowersSkillId(skill.id));
    if (enabledSuperpowersSkills.length === 0) {
      return null;
    }

    const availableSkillIds = new Set(enabledSuperpowersSkills.map((skill) => skill.id));
    const routingHints = [
      availableSkillIds.has('superpowers-systematic-debugging')
        ? '- Use `superpowers-systematic-debugging` first for bugs, failing tests, build failures, or unexpected behavior.'
        : '',
      availableSkillIds.has('superpowers-brainstorming')
        ? '- Use `superpowers-brainstorming` before adding features, changing behavior, or making product/design decisions.'
        : '',
      availableSkillIds.has('superpowers-writing-plans')
        ? '- Use `superpowers-writing-plans` after a design is approved or when a multi-step implementation needs an explicit plan.'
        : '',
      availableSkillIds.has('superpowers-test-driven-development')
        ? '- Use `superpowers-test-driven-development` before writing implementation code for a feature or bugfix.'
        : '',
      availableSkillIds.has('superpowers-using-git-worktrees')
        ? '- Use `superpowers-using-git-worktrees` when the user wants isolated branch/worktree setup or the change should be isolated.'
        : '',
      availableSkillIds.has('superpowers-verification-before-completion')
        ? '- Use `superpowers-verification-before-completion` before claiming the work is complete, fixed, or passing.'
        : '',
    ].filter(Boolean);

    return [
      '## Superpowers Workflow (Cowork)',
      '- Enabled `superpowers-*` skills are an IDBots-native engineering workflow for Cowork sessions.',
      '- If the user explicitly asks to use superpowers, prefer the matching `superpowers-*` skill when one clearly applies.',
      '- User instructions, repository instructions, and app policy override skill instructions.',
      '- In IDBots, follow skill instructions with file reads and shell commands. Do not call a `Skill` tool.',
      ...routingHints,
    ].join('\n');
  }

  /**
   * Auto routing prompt for bot-less system surfaces (IM gateway, scheduler):
   * bundled + global only — same view a bot-less user session gets.
   */
  buildAutoRoutingPrompt(): string | null {
    const enabled = this.listSkillsForMetabot(null);
    return this.buildRoutingPromptFromSkills(enabled);
  }

  private buildScopedRoutingPrompt(skills: SkillRecord[]): string | null {
    if (skills.length === 0) return null;
    const uniqueSkills = Array.from(new Map(skills.map((skill) => [skill.id, skill])).values());
    return this.buildRoutingPromptFromSkills(uniqueSkills);
  }

  /**
   * Chat-surface skill routing under the assignment model.
   * Baseline (anyone messaging the bot): bundled skills + the bot's ASSIGNED
   * external skills — the successor of the legacy allow_chat_skills allowlist
   * (which the one-time migration converts into assignment rows), widened to
   * keep bundled skills reachable for peers.
   * Widened (owner / boss / chair): the bot's full visible set (bundled +
   * global + assigned) — the only tier that unlocks GLOBAL external skills.
   */
  resolveChatSkillIds(input: { metabotId?: number | null; widened?: boolean } = {}): string[] {
    if (input.widened) {
      return this.listSkillsForMetabot(input.metabotId ?? null).map((skill) => skill.id);
    }
    return this.listChatRoutingBaselineSkills(input.metabotId ?? null).map((skill) => skill.id);
  }

  buildChatSkillsRoutingPrompt(input: {
    metabotId?: number | null;
    widened?: boolean;
  } = {}): ChatSkillsRoutingPromptResult {
    const activeSkills = input.widened
      ? this.listSkillsForMetabot(input.metabotId ?? null)
      : this.listChatRoutingBaselineSkills(input.metabotId ?? null);
    const activeSkillIds = activeSkills.map((skill) => skill.id);
    return {
      prompt: this.buildScopedRoutingPrompt(activeSkills),
      activeSkillIds,
    };
  }

  /** Diagnostic auto-routing prompt (skills:autoRoutingPrompt IPC): bot-less view. */
  buildCoworkAutoRoutingPrompt(): string | null {
    const enabled = this.listSkillsForMetabot(null);
    return this.buildRoutingPromptFromSkills(enabled, {
      introBlocks: [this.buildCoworkSuperpowersBootstrap(enabled)].filter(Boolean),
    });
  }

  /**
   * Cowork skill-prompt parts from a single listSkills scan, scoped to one
   * bot's visible set (null = bot-less session: bundled + global):
   * - rules: the `## Skills (mandatory)` rules section WITHOUT the catalog;
   *   composed into the system prompt (promptComposer SKILLS slot).
   * - catalog: the bare <available_skills> block in compact one-line-per-skill
   *   form (no <location>; the model loads full SKILL.md files via skill_tool
   *   read_skill). Cowork sessions inject it into the per-turn volatile
   *   user-message tail so skill installs/updates never rewrite the cacheable
   *   system-prompt head.
   * - sandboxSection: the legacy combined section (rules + inline catalog)
   *   for sandbox sessions, whose prompt must carry the catalog inline so
   *   resolveAutoRoutingForSandbox can rewrite locations to guest paths.
   */
  buildCoworkSkillPromptParts(metabotId: number | null = null): {
    rules: string | null;
    catalog: string | null;
    sandboxSection: string | null;
  } {
    const enabled = this.listSkillsForMetabot(metabotId);
    const introBlocks = [this.buildCoworkSuperpowersBootstrap(enabled)].filter(Boolean);
    return {
      rules: this.buildRoutingPromptFromSkills(enabled, { introBlocks, catalogPlacement: 'volatile' }),
      catalog: enabled.length > 0
        ? ['<available_skills>', this.buildSkillCatalogLines(enabled), '</available_skills>'].join('\n')
        : null,
      sandboxSection: this.buildRoutingPromptFromSkills(enabled, { introBlocks, catalogPlacement: 'inline' }),
    };
  }

  /**
   * Load one enabled skill's full SKILL.md on demand, backing the cowork
   * skill_tool read_skill action. Accepts an id or a (case-insensitive) name.
   * The metabotId is REQUIRED and scopes the lookup to that bot's visible
   * set (null = bot-less session: bundled + global). This is a TOOL-LEVEL
   * gate only — it decides which entries this API resolves, not a filesystem
   * boundary: the session's Read/Bash file access is prompt-gated, so a
   * determined model could still open another skill's path directly. Returns
   * the skill directory so the caller can tell the model where to resolve
   * the relative paths SKILL.md files routinely contain. Disabled skills are
   * not routed and are not loadable through this path.
   */
  readSkillCatalogEntry(nameOrId: string, metabotId: number | null): {
    id: string;
    name: string;
    directory: string;
    skillPath: string;
    content: string;
  } | null {
    const trimmed = String(nameOrId ?? '').trim();
    if (!trimmed) return null;
    const pool = this.listSkillsForMetabot(metabotId);
    const enabled = pool.filter((skill) => skill.enabled && skill.prompt);
    const match = this.resolveSkillById(trimmed, enabled) ?? this.resolveSkillByName(trimmed, enabled);
    if (!match) return null;
    let content: string;
    try {
      content = fs.readFileSync(match.skillPath, 'utf-8');
    } catch {
      return null;
    }
    return {
      id: match.id,
      name: match.name,
      directory: path.dirname(match.skillPath),
      skillPath: match.skillPath,
      content,
    };
  }

  buildRemoteServicesPrompt(availableServices: any[]): string | null {
    if (!availableServices || availableServices.length === 0) return null;

    const entries = availableServices
      .map(
        (svc) =>
          `  <remote_service>` +
          `<service_pin_id>${svc.currentPinId || svc.id || svc.pinId || svc.servicePinId || ''}</service_pin_id>` +
          `<service_name>${svc.displayName || svc.serviceName || ''}</service_name>` +
          `<description>${svc.description || ''}</description>` +
          `<price_amount>${svc.price || ''}</price_amount>` +
          `<price_currency>${svc.currency || ''}</price_currency>` +
          `<rating_avg>${svc.ratingAvg ?? 'N/A'}</rating_avg>` +
          `<rating_count>${svc.ratingCount ?? 0}</rating_count>` +
          `<provider_name>${svc.providerMetaBot || svc.providerName || ''}</provider_name>` +
          `<provider_global_metaid>${svc.providerGlobalMetaId || ''}</provider_global_metaid>` +
          `</remote_service>`,
      )
      .join('\n');

    return (
      `\n<available_remote_services>\n` +
      `  <notice>\n` +
      `    The following are on-chain services provided by remote MetaBots on the\n` +
      `    permissionless agent collaboration network.\n\n` +
      `    RULES:\n` +
      `    1. ONLY consider these when NO local skill can fulfill the user's request.\n` +
      `    2. When you find a matching remote service, present it to the user in\n` +
      `       natural language with: service name, description, price, rating, and\n` +
      `       provider Bot name.\n` +
      `       - If price > 0, ask the user to confirm before delegating.\n` +
      `       - If price = 0, it is free and you may delegate directly without\n` +
      `         extra user confirmation.\n` +
      `    3. After confirmation (for paid) or directly (for free), output\n` +
      `       [DELEGATE_REMOTE_SERVICE] followed by\n` +
      `       a JSON object on the next line. This message will be intercepted by\n` +
      `       the system — do NOT show it to the user.\n` +
      `       - "rawRequest" MUST contain the user's original request verbatim.\n` +
      `       - "userTask" is a short summary only.\n` +
      `       - "taskContext" may add concise routing context, but must not replace "rawRequest".\n` +
      `    4. Do NOT attempt to read SKILL.md files for remote services.\n\n` +
      `    [DELEGATE_REMOTE_SERVICE] JSON format:\n` +
      `    {"servicePinId":"...","serviceName":"...","providerGlobalMetaid":"...","price":"...","currency":"...","rawRequest":"verbatim original request","userTask":"summary","taskContext":"routing context"}\n` +
      `    Note: "price" must be numeric only, without the currency/unit suffix.\n` +
      `    Note: providerAddress is resolved by the system using servicePinId.\n` +
      `  </notice>\n` +
      entries +
      '\n' +
      `</available_remote_services>\n`
    );
  }

  /**
   * Same format as buildAutoRoutingPrompt but restricted to skills whose id is in skillIds.
   * Used by chat runtimes for scoped skill routing; disabled or promptless skills are excluded.
   */
  buildAutoRoutingPromptForSkillIds(skillIds: string[]): string | null {
    if (skillIds.length === 0) return null;
    const set = new Set(
      skillIds
        .flatMap((id) => this.getSkillIdCandidates(id))
        .filter(Boolean)
    );
    const skills = this.listSkills().filter((s) => set.has(s.id) && s.enabled && s.prompt);
    return this.buildScopedRoutingPrompt(skills);
  }

  /**
   * Seller order execution should prefer the single explicitly ordered local skill.
   * Resolution order: skillId -> skillName treated as id -> exact skill display name.
   * Falls back to the full auto-routing prompt when no local skill can be resolved.
   */
  buildAutoRoutingPromptForOrderSkill(params: {
    skillId?: string | null;
    skillName?: string | null;
  }): string | null {
    const result = this.buildAutoRoutingPromptForOrderSkillScope({
      skillIds: [params.skillId || ''].filter(Boolean),
      skillNames: [params.skillName || ''].filter(Boolean),
      strictScope: true,
    });

    if (result.prompt) return result.prompt;

    return this.buildAutoRoutingPrompt();
  }

  buildAutoRoutingPromptForOrderSkillScope(params: {
    skillIds?: string[];
    skillNames?: string[];
    strictScope?: boolean;
  } = {}): OrderSkillScopePromptResult {
    const rawSkillIds = Array.isArray(params.skillIds) ? params.skillIds : [];
    const rawSkillNames = Array.isArray(params.skillNames) ? params.skillNames : [];
    const candidates = [...rawSkillIds, ...rawSkillNames]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const hasScopeInput = candidates.length > 0;
    const enabledSkills = this.listSkills().filter((skill) => skill.enabled && skill.prompt);

    if (!hasScopeInput && !params.strictScope) {
      const activeSkillIds = enabledSkills.map((skill) => skill.id);
      return {
        prompt: this.buildAutoRoutingPrompt(),
        activeSkillIds,
        missingSkillNames: [],
      };
    }

    const resolvedSkills: SkillRecord[] = [];
    const seenSkillIds = new Set<string>();
    const missingSkillNames: string[] = [];
    const seenMissing = new Set<string>();

    for (const candidate of candidates) {
      const resolved =
        this.resolveSkillById(candidate, enabledSkills)
        || this.resolveSkillByName(candidate, enabledSkills);
      if (resolved) {
        if (!seenSkillIds.has(resolved.id)) {
          seenSkillIds.add(resolved.id);
          resolvedSkills.push(resolved);
        }
      } else if (!seenMissing.has(candidate)) {
        seenMissing.add(candidate);
        missingSkillNames.push(candidate);
      }
    }

    if (resolvedSkills.length === 0 && params.strictScope) {
      return {
        prompt: null,
        activeSkillIds: [],
        missingSkillNames,
      };
    }

    return {
      prompt: this.buildScopedRoutingPrompt(resolvedSkills),
      activeSkillIds: resolvedSkills.map((skill) => skill.id),
      missingSkillNames,
    };
  }

  setSkillEnabled(id: string, enabled: boolean): SkillRecord[] {
    const state = this.loadSkillStateMap();
    const resolved = this.resolveSkillById(id);
    const targetId = resolved?.id || id;
    state[targetId] = { enabled };
    this.saveSkillStateMap(state);
    this.notifySkillsChanged();
    return this.listSkills();
  }

  /**
   * Return skill records whose id is in the given list. Used by cognitive orchestrator
   * to build dynamic tool schemas from allowed_skills without hardcoding a registry.
   */
  getSkillsForIds(ids: string[]): SkillRecord[] {
    if (ids.length === 0) return [];
    const set = new Set(
      ids
        .flatMap((id) => this.getSkillIdCandidates(id))
        .filter(Boolean)
    );
    return this.listSkills().filter((s) => set.has(s.id));
  }

  /**
   * Run a skill by id with a JSON payload (e.g. from orchestrator tool call).
   * Runs scripts/index.js|index.ts or scripts/run.js|run.ts with --payload.
   * Returns observation string for the LLM.
   */
  async runSkillById(
    skillId: string,
    payloadJson: string,
    context?: { metabotId?: number }
  ): Promise<{ success: boolean; observation: string }> {
    const skills = this.listSkills();
    const skill = this.resolveSkillById(skillId, skills);
    if (!skill) {
      return { success: false, observation: `Skill not found: ${skillId}` };
    }
    const skillDir = path.dirname(skill.skillPath);
    const skillsRoot = this.getSkillsRoot();
    const envOverrides: Record<string, string> = {
      SKILLS_ROOT: skillsRoot,
      IDBOTS_SKILLS_ROOT: skillsRoot,
      IDBOTS_RPC_URL: getMetaidRpcBase(),
      IDBOTS_RPC_TOKEN: getMetaidRpcToken(),
    };
    let metabotLlmId: string | null = null;
    let metabotLlmProvider: string | null = null;
    if (context?.metabotId != null) {
      envOverrides.IDBOTS_METABOT_ID = String(context.metabotId);
      try {
        const db = this.getStore().getDatabase();
        const row = db.exec(
          `SELECT mw.mnemonic AS mnemonic, mw.path AS path, m.name AS name, m.globalmetaid AS globalmetaid, m.llm_id AS llm_id, m.llm_provider AS llm_provider
           FROM metabots m
           JOIN metabot_wallets mw ON mw.id = m.wallet_id
           WHERE m.id = ?
           LIMIT 1`,
          [context.metabotId]
        );
        const values = row[0]?.values?.[0] as unknown[] | undefined;
        if (values) {
          const mnemonic = typeof values[0] === 'string' ? values[0].trim() : '';
          const walletPath = typeof values[1] === 'string' ? values[1].trim() : '';
          const metabotName = typeof values[2] === 'string' ? values[2].trim() : '';
          const globalmetaid = typeof values[3] === 'string' ? values[3].trim() : '';
          metabotLlmId = typeof values[4] === 'string' ? values[4].trim() || null : null;
          metabotLlmProvider = typeof values[5] === 'string' ? values[5].trim() || null : null;
          if (mnemonic) envOverrides.IDBOTS_METABOT_MNEMONIC = mnemonic;
          if (walletPath) envOverrides.IDBOTS_METABOT_PATH = walletPath;
          if (metabotName) envOverrides.IDBOTS_TWIN_NAME = metabotName;
          if (globalmetaid) envOverrides.IDBOTS_METABOT_GLOBALMETAID = globalmetaid;
        }
      } catch {
        // Ignore wallet env injection failure; scripts can still use RPC-only mode.
      }
    }
    const baseEnv = await getEnhancedEnv('local');
    const imageEnvOverrides = buildImageSkillEnvOverrides({
      activeSkillIds: [skill.id],
      metabotLlmId,
      metabotLlmProvider,
      appConfig: this.getStore().get('app_config'),
      processEnv: process.env,
    });
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...envOverrides, ...imageEnvOverrides };

    // Note: the metabot-omni-caster invocation adapter was removed together
    // with the skill — its capability is now the built-in omni_cast tool.
    const entryCandidates = [
      path.join(skillDir, 'scripts', 'index.js'),
      path.join(skillDir, 'scripts', 'dist', 'index.js'),
      path.join(skillDir, 'scripts', 'run.js'),
      path.join(skillDir, 'scripts', 'dist', 'run.js'),
      path.join(skillDir, 'scripts', 'index.ts'),
      path.join(skillDir, 'scripts', 'run.ts'),
    ];
    const selectedEntry = entryCandidates.find((candidate) => fs.existsSync(candidate));
    if (!selectedEntry) {
      return {
        success: false,
        observation: `Skill "${skillId}": no scripts/index.js, scripts/dist/index.js, run.js, scripts/dist/run.js, index.ts, or run.ts found`,
      };
    }
    const scriptPath = selectedEntry;
    const scriptArgs = ['--payload', payloadJson];

    // fix-v2 (B3): chain-facing skill scripts are long operations — the
    // group-task create flow (on-chain group create + indexing waits + member
    // joins) routinely exceeds a minute and used to be SIGTERMed at 60s
    // although the task was actually created (task #55). 180s covers the slow
    // chain cadence without letting a wedged script run forever.
    const timeoutMs = 180_000;
    const result = await this.runSkillScriptWithEnv(skillDir, scriptPath, scriptArgs, env, envOverrides, timeoutMs);

    const observation = result.success
      ? (this.parseScriptMessage(result.stdout) ?? result.stdout?.trim() ?? 'Done.')
      : (result.error ?? result.stderr?.trim() ?? result.stdout?.trim() ?? 'Skill script failed.');
    return { success: result.success, observation };
  }

  deleteSkill(id: string): SkillRecord[] {
    const root = this.ensureSkillsRoot();
    if (id !== path.basename(id)) {
      throw new Error('Invalid skill id');
    }
    if (this.isBuiltInSkillId(id)) {
      throw new Error('Built-in skills cannot be deleted');
    }

    const targetDir = resolveWithin(root, id);
    if (!fs.existsSync(targetDir)) {
      throw new Error('Skill not found');
    }

    const affectedBots = listAssignmentMetabotIds(this.getStore().getDatabase(), id);
    fs.rmSync(targetDir, { recursive: true, force: true });
    const state = this.loadSkillStateMap();
    delete state[id];
    this.saveSkillStateMap(state);
    // Drop assignment rows + scope entry so an uninstalled skill leaves no
    // dangling authorization behind (reinstalling starts library-scoped).
    this.ensureAssignmentSchema();
    removeSkillFromAssignmentStore(
      this.getStore().getDatabase(),
      this.getStore().getSaveFunction(),
      this.getStore(),
      id
    );
    console.log(
      `[skills-audit] deleted skill "${id}" from disk (was assigned to metabot(s): ${affectedBots.join(', ') || 'none'})`
    );
    this.syncAllowChatSkillsColumns(affectedBots);
    this.startWatching();
    this.notifySkillsChanged();
    return this.listSkills();
  }

  /**
   * External skills that are still authorized (global scope, or assigned to
   * some bot) but whose directory is gone from disk. The authorization rows
   * survive a directory loss, so after a reinstall the skill is immediately
   * usable again — surfacing this list (startup audit log, Skills UI, bot's
   * list_installed_skills) is what turns "skill mysteriously gone" into a
   * recoverable state.
   */
  listMissingExternalSkills(): Array<{
    id: string;
    scope: 'library' | 'global';
    assignedMetabotIds: number[];
    sourceUri: string | null;
  }> {
    this.ensureAssignmentSchema();
    const store = this.getStore();
    const db = store.getDatabase();
    const onDisk = new Set(this.listSkills().map((skill) => skill.id));
    const builtIn = this.listBuiltInSkillIds();
    const missing = listMissingAuthorizedSkillIds(db, store, onDisk)
      .filter((id) => !builtIn.has(id));
    if (missing.length === 0) return [];
    const scopeMap = getGlobalScopeMap(store);
    const defaults = this.loadSkillsDefaults(this.getSkillRoots());
    return missing.map((id) => ({
      id,
      scope: scopeMap[id] === 'global' ? ('global' as const) : ('library' as const),
      assignedMetabotIds: listAssignmentMetabotIds(db, id),
      sourceUri: typeof defaults[id]?.sourceUri === 'string' && defaults[id].sourceUri.trim()
        ? defaults[id].sourceUri.trim()
        : null,
    }));
  }

  /**
   * Purge the authorization + config record of a skill whose directory is
   * already gone (one entry of the missing list). Refused while the directory
   * still exists — that is what deleteSkill is for.
   */
  forgetMissingSkill(id: string): void {
    if (id !== path.basename(id)) {
      throw new Error('Invalid skill id');
    }
    const root = this.ensureSkillsRoot();
    if (fs.existsSync(resolveWithin(root, id))) {
      throw new Error('Skill still exists on disk; use deleteSkill instead');
    }
    this.ensureAssignmentSchema();
    const store = this.getStore();
    const db = store.getDatabase();
    const affectedBots = listAssignmentMetabotIds(db, id);
    removeSkillFromAssignmentStore(db, store.getSaveFunction(), store, id);
    const configPath = path.join(root, SKILLS_CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SkillsConfig;
        if (config.defaults && typeof config.defaults === 'object' && id in config.defaults) {
          delete config.defaults[id];
          fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        }
      } catch (error) {
        console.warn(`[skills] Failed to prune config entry for missing skill "${id}":`, error);
      }
    }
    console.log(
      `[skills-audit] forgot missing skill "${id}" (was assigned to metabot(s): ${affectedBots.join(', ') || 'none'})`
    );
    this.syncAllowChatSkillsColumns(affectedBots);
    this.notifySkillsChanged();
  }

  async downloadSkill(source: string): Promise<{ success: boolean; skills?: SkillRecord[]; error?: string }> {
    let cleanupPath: string | null = null;
    try {
      const trimmed = source.trim();
      if (!trimmed) {
        return { success: false, error: 'Missing skill source' };
      }

      const root = this.ensureSkillsRoot();
      let localSource = trimmed;
      if (fs.existsSync(localSource)) {
        const stat = fs.statSync(localSource);
        if (stat.isFile()) {
          if (isZipFile(localSource)) {
            const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'idbots-skill-zip-'));
            await extractZip(localSource, { dir: tempRoot });
            localSource = tempRoot;
            cleanupPath = tempRoot;
          } else if (path.basename(localSource) === SKILL_FILE_NAME) {
            localSource = path.dirname(localSource);
          } else {
            return { success: false, error: 'Skill source must be a directory, zip file, or SKILL.md file' };
          }
        }
      } else {
        const normalized = this.normalizeGitSource(trimmed);
        if (!normalized) {
          return { success: false, error: 'Invalid skill source. Use owner/repo, repo URL, or a GitHub tree/blob URL.' };
        }
        const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'idbots-skill-'));
        cleanupPath = tempRoot;
        const repoName = normalizeFolderName(normalized.repoNameHint || deriveRepoName(normalized.repoUrl));
        const clonePath = path.join(tempRoot, repoName);
        const cloneArgs = ['clone', '--depth', '1'];
        if (normalized.ref) {
          cloneArgs.push('--branch', normalized.ref);
        }
        cloneArgs.push(normalized.repoUrl, clonePath);
        const gitRuntime = resolveGitCommand();
        const githubSource = parseGithubRepoSource(normalized.repoUrl);
        let downloadedSourceRoot = clonePath;
        try {
          await runCommand(gitRuntime.command, cloneArgs, { env: gitRuntime.env });
        } catch (error) {
          const errno = (error as NodeJS.ErrnoException | null)?.code;
          if (githubSource) {
            try {
              downloadedSourceRoot = await downloadGithubArchive(githubSource, tempRoot, normalized.ref);
            } catch (archiveError) {
              const gitMessage = extractErrorMessage(error);
              const archiveMessage = extractErrorMessage(archiveError);
              if (errno === 'ENOENT' && process.platform === 'win32') {
                throw new Error(
                  'Git executable not found. Please install Git for Windows or reinstall IDBots with bundled PortableGit.'
                  + ` Archive fallback also failed: ${archiveMessage}`
                );
              }
              throw new Error(`Git clone failed: ${gitMessage}. Archive fallback failed: ${archiveMessage}`);
            }
          } else if (errno === 'ENOENT' && process.platform === 'win32') {
            throw new Error('Git executable not found. Please install Git for Windows or reinstall IDBots with bundled PortableGit.');
          } else {
            throw error;
          }
        }

        if (normalized.sourceSubpath) {
          const scopedSource = resolveWithin(downloadedSourceRoot, normalized.sourceSubpath);
          if (!fs.existsSync(scopedSource)) {
            return { success: false, error: `Path "${normalized.sourceSubpath}" not found in repository` };
          }
          const scopedStat = fs.statSync(scopedSource);
          if (scopedStat.isFile()) {
            if (path.basename(scopedSource) === SKILL_FILE_NAME) {
              localSource = path.dirname(scopedSource);
            } else {
              return { success: false, error: 'GitHub path must point to a directory or SKILL.md file' };
            }
          } else {
            localSource = scopedSource;
          }
        } else {
          localSource = downloadedSourceRoot;
        }

      }

      const skillDirs = collectSkillDirsFromSource(localSource);
      if (skillDirs.length === 0) {
        cleanupPathSafely(cleanupPath);
        cleanupPath = null;
        return { success: false, error: 'No SKILL.md found in source' };
      }

      const placedSkillIds: string[] = [];
      for (const skillDir of skillDirs) {
        const folderName = normalizeFolderName(path.basename(skillDir));
        let targetDir = resolveWithin(root, folderName);
        let suffix = 1;
        while (fs.existsSync(targetDir)) {
          targetDir = resolveWithin(root, `${folderName}-${suffix}`);
          suffix += 1;
        }
        fs.cpSync(skillDir, targetDir, { recursive: true, dereference: false });
        placedSkillIds.push(path.basename(targetDir));
      }
      this.recordSkillInstallSources(placedSkillIds, trimmed);

      cleanupPathSafely(cleanupPath);
      cleanupPath = null;

      this.startWatching();
      this.notifySkillsChanged();
      return { success: true, skills: this.listSkills() };
    } catch (error) {
      cleanupPathSafely(cleanupPath);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to download skill' };
    }
  }

  startWatching(): void {
    this.stopWatching();
    const primaryRoot = this.ensureSkillsRoot();
    const roots = this.getSkillRoots(primaryRoot);

    const watchHandler = () => this.scheduleNotify();
    roots.forEach(root => {
      if (!fs.existsSync(root)) return;
      try {
        this.watchers.push(fs.watch(root, watchHandler));
      } catch (error) {
        console.warn('[skills] Failed to watch skills root:', root, error);
      }

      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        try {
          this.watchers.push(fs.watch(dir, watchHandler));
        } catch (error) {
          console.warn('[skills] Failed to watch skill directory:', dir, error);
        }
      });
    });
  }

  stopWatching(): void {
    this.watchers.forEach(watcher => watcher.close());
    this.watchers = [];
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  handleWorkingDirectoryChange(): void {
    this.startWatching();
    this.notifySkillsChanged();
  }

  /** Immediate rescan after install_skill so the new skill is usable on this turn. */
  reloadAfterInstall(): void {
    this.startWatching();
    this.notifySkillsChanged();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.startWatching();
      this.notifySkillsChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private parsedSkillFileCache = new Map<string, {
    mtimeMs: number;
    ctimeMs: number;
    size: number;
    name: string;
    description: string;
    isOfficial: boolean;
    prompt: string;
  }>();

  private notifySkillsChanged(): void {
    this.parsedSkillFileCache.clear();
    broadcastToRenderers('skills:changed');
  }

  private parseSkillDir(
    dir: string,
    state: SkillStateMap,
    defaults: Record<string, SkillDefaultConfig>,
    isBuiltIn: boolean
  ): SkillRecord | null {
    const skillFile = path.join(dir, SKILL_FILE_NAME);
    try {
      const stat = fs.statSync(skillFile);
      if (!stat.isFile()) return null;
      const id = path.basename(dir);
      const cached = this.parsedSkillFileCache.get(skillFile);
      let name: string;
      let description: string;
      let isOfficial: boolean;
      let prompt: string;
      if (
        cached
        && cached.mtimeMs === stat.mtimeMs
        && cached.ctimeMs === stat.ctimeMs
        && cached.size === stat.size
      ) {
        name = cached.name;
        description = cached.description;
        isOfficial = cached.isOfficial;
        prompt = cached.prompt;
      } else {
        const raw = fs.readFileSync(skillFile, 'utf8');
        const { frontmatter, content } = parseFrontmatter(raw);
        name = (String(frontmatter.name || '') || id).trim() || id;
        description = (String(frontmatter.description || '') || extractDescription(content) || name).trim();
        isOfficial = isTruthy(frontmatter.official) || isTruthy(frontmatter.isOfficial);
        prompt = content.trim();
        if (this.parsedSkillFileCache.size >= 2048) {
          const oldest = this.parsedSkillFileCache.keys().next().value;
          if (oldest !== undefined) this.parsedSkillFileCache.delete(oldest);
        }
        this.parsedSkillFileCache.set(skillFile, {
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          size: stat.size,
          name,
          description,
          isOfficial,
          prompt,
        });
      }
      const defaultEnabled = defaults[id]?.enabled ?? true;
      const enabled = state[id]?.enabled ?? defaultEnabled;
      return { id, name, description, enabled, isOfficial, isBuiltIn, updatedAt: stat.mtimeMs, prompt, skillPath: skillFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        this.parsedSkillFileCache.delete(skillFile);
        return null;
      }
      console.warn('[skills] Failed to parse skill:', dir, error);
      return null;
    }
  }

  private listBuiltInSkillIds(): Set<string> {
    const builtInRoot = this.getBundledSkillsRoot();
    if (!builtInRoot || !fs.existsSync(builtInRoot)) {
      return new Set();
    }
    return new Set(listSkillDirs(builtInRoot).map(dir => path.basename(dir)));
  }

  private isBuiltInSkillId(id: string): boolean {
    return this.listBuiltInSkillIds().has(id);
  }

  private loadSkillStateMap(): SkillStateMap {
    const store = this.getStore();
    const raw = store.get(SKILL_STATE_KEY) as SkillStateMap | SkillRecord[] | undefined;
    if (Array.isArray(raw)) {
      const migrated: SkillStateMap = {};
      raw.forEach(skill => {
        migrated[skill.id] = { enabled: skill.enabled };
      });
      store.set(SKILL_STATE_KEY, migrated);
      return migrated;
    }
    return raw ?? {};
  }

  private saveSkillStateMap(map: SkillStateMap): void {
    this.getStore().set(SKILL_STATE_KEY, map);
  }

  private loadSkillDefaultsFromRoot(root: string): Record<string, SkillDefaultConfig> {
    const configPath = path.join(root, SKILLS_CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as SkillsConfig;
      return parsed.defaults && typeof parsed.defaults === 'object'
        ? parsed.defaults
        : {};
    } catch (error) {
      console.warn('[skills] Failed to load skill defaults from root:', root, error);
      return {};
    }
  }

  private isOfficialSkillDir(skillDir: string): boolean {
    try {
      const skillFilePath = path.join(skillDir, SKILL_FILE_NAME);
      if (!fs.existsSync(skillFilePath)) return false;
      const raw = fs.readFileSync(skillFilePath, 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      return isTruthy(frontmatter.official) || isTruthy(frontmatter.isOfficial);
    } catch {
      return false;
    }
  }

  /**
   * Recursively compare a bundled skill directory with the local copy.
   * Returns true when any file is missing, extra, or has different content,
   * so script-only updates (SKILL.md unchanged) also trigger a refresh.
   * OS noise files are ignored; SKILL.md comparison tolerates CRLF drift.
   */
  private isSkillContentDifferent(bundledSkillDir: string, localSkillDir: string): boolean {
    const IGNORED_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', 'thumbs.db']);
    const collectFiles = (root: string): Map<string, string> => {
      const files = new Map<string, string>();
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (IGNORED_ENTRIES.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() || entry.isSymbolicLink()) {
            const relative = path.relative(root, full).split(path.sep).join('/');
            files.set(relative, full);
          }
        }
      };
      walk(root);
      return files;
    };

    try {
      const bundledFiles = collectFiles(bundledSkillDir);
      const localFiles = collectFiles(localSkillDir);
      if (bundledFiles.size !== localFiles.size) {
        return true;
      }
      for (const [relative, bundledPath] of bundledFiles) {
        const localPath = localFiles.get(relative);
        if (!localPath) {
          return true;
        }
        const bundledRaw = fs.readFileSync(bundledPath);
        const localRaw = fs.readFileSync(localPath);
        if (relative === SKILL_FILE_NAME) {
          const normalize = (buf: Buffer): string => buf.toString('utf8').replace(/\r\n/g, '\n');
          if (normalize(bundledRaw) !== normalize(localRaw)) {
            return true;
          }
        } else if (!bundledRaw.equals(localRaw)) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  private isSkillRuntimeBroken(bundledSkillDir: string, localSkillDir: string): boolean {
    try {
      const bundledSkillPath = path.join(bundledSkillDir, SKILL_FILE_NAME);
      const localSkillPath = path.join(localSkillDir, SKILL_FILE_NAME);
      if (!fs.existsSync(localSkillPath)) {
        return true;
      }
      if (!fs.existsSync(bundledSkillPath)) {
        return false;
      }

      const bundledRaw = fs.readFileSync(bundledSkillPath, 'utf8');
      const scriptReferences = extractScriptReferencesFromSkillMarkdown(bundledRaw);
      for (const relativeScriptPath of scriptReferences) {
        const bundledScriptPath = path.join(bundledSkillDir, relativeScriptPath);
        if (!fs.existsSync(bundledScriptPath)) {
          continue;
        }
        const localScriptPath = path.join(localSkillDir, relativeScriptPath);
        if (fs.existsSync(localScriptPath)) {
          continue;
        }
        const localDistFallback = path.join(
          localSkillDir,
          'scripts',
          'dist',
          path.basename(relativeScriptPath)
        );
        if (!fs.existsSync(localDistFallback)) {
          return true;
        }
      }

      return false;
    } catch {
      return true;
    }
  }

  private patchSkillRuntimeFromBundled(bundledSkillDir: string, localSkillDir: string): boolean {
    try {
      const bundledSkillPath = path.join(bundledSkillDir, SKILL_FILE_NAME);
      if (!fs.existsSync(bundledSkillPath)) {
        return false;
      }

      const bundledRaw = fs.readFileSync(bundledSkillPath, 'utf8');
      const scriptReferences = extractScriptReferencesFromSkillMarkdown(bundledRaw);
      if (scriptReferences.length === 0) {
        return false;
      }

      let patched = false;
      for (const relativeScriptPath of scriptReferences) {
        const bundledScriptPath = path.join(bundledSkillDir, relativeScriptPath);
        if (!fs.existsSync(bundledScriptPath)) {
          continue;
        }

        const localScriptPath = path.join(localSkillDir, relativeScriptPath);
        if (!fs.existsSync(localScriptPath)) {
          fs.mkdirSync(path.dirname(localScriptPath), { recursive: true });
          fs.cpSync(bundledScriptPath, localScriptPath, {
            recursive: false,
            force: false,
            errorOnExist: false,
          });
          patched = true;
        }

        const fileName = path.basename(relativeScriptPath);
        const bundledDistFallback = path.join(bundledSkillDir, 'scripts', 'dist', fileName);
        const localDistFallback = path.join(localSkillDir, 'scripts', 'dist', fileName);
        if (!fs.existsSync(localDistFallback) && fs.existsSync(bundledDistFallback)) {
          fs.mkdirSync(path.dirname(localDistFallback), { recursive: true });
          fs.cpSync(bundledDistFallback, localDistFallback, {
            recursive: false,
            force: false,
            errorOnExist: false,
          });
          patched = true;
        }
      }

      return patched;
    } catch (error) {
      console.warn('[skills] Failed to patch runtime files from bundled skill:', error);
      return false;
    }
  }

  private mergeBundledSkillDefaults(
    userRoot: string,
    bundledRoot: string,
    syncedSkillIds: Set<string>
  ): void {
    const bundledConfigPath = path.join(bundledRoot, SKILLS_CONFIG_FILE);
    const targetConfigPath = path.join(userRoot, SKILLS_CONFIG_FILE);
    if (!fs.existsSync(bundledConfigPath) || !fs.existsSync(targetConfigPath)) {
      return;
    }

    try {
      const bundledRaw = fs.readFileSync(bundledConfigPath, 'utf8');
      const targetRaw = fs.readFileSync(targetConfigPath, 'utf8');
      const bundledConfig = JSON.parse(bundledRaw) as SkillsConfig;
      const targetConfig = JSON.parse(targetRaw) as SkillsConfig;

      if (!bundledConfig.defaults || typeof bundledConfig.defaults !== 'object') return;
      if (!targetConfig.defaults || typeof targetConfig.defaults !== 'object') {
        targetConfig.defaults = {};
      }

      for (const skillId of syncedSkillIds) {
        const bundledDefault = bundledConfig.defaults[skillId];
        if (!bundledDefault) continue;
        const existing = targetConfig.defaults[skillId] ?? {};
        targetConfig.defaults[skillId] = {
          ...existing,
          version: bundledDefault.version ?? existing.version,
          'creator-metaid': bundledDefault['creator-metaid'] ?? existing['creator-metaid'],
          installedAt: Date.now(),
          enabled: existing.enabled ?? bundledDefault.enabled ?? true,
          order: existing.order ?? bundledDefault.order,
        };
      }

      fs.writeFileSync(targetConfigPath, JSON.stringify(targetConfig, null, 2), 'utf8');
    } catch (error) {
      console.warn('[skills] Failed to merge bundled skill defaults:', error);
    }
  }

  /**
   * Record where a skill came from (downloadSkill / UI add-from-source) so a
   * lost directory can be reinstalled from the same reference later.
   */
  private recordSkillInstallSources(skillIds: string[], sourceUri: string): void {
    if (skillIds.length === 0 || !sourceUri.trim()) return;
    try {
      const root = this.ensureSkillsRoot();
      const configPath = path.join(root, SKILLS_CONFIG_FILE);
      let config: SkillsConfig = { version: 1, defaults: {} };
      if (fs.existsSync(configPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SkillsConfig;
          if (parsed && typeof parsed.defaults === 'object') {
            config = parsed;
          }
        } catch {
          config = { version: 1, defaults: {} };
        }
      }
      const now = Date.now();
      for (const id of skillIds) {
        const existing = config.defaults[id] ?? {};
        config.defaults[id] = {
          ...existing,
          installedAt: existing.installedAt ?? now,
          enabled: existing.enabled ?? true,
          sourceUri,
        };
      }
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.warn('[skills] Failed to record skill install source:', error);
    }
  }

  private loadSkillsDefaults(roots: string[]): Record<string, SkillDefaultConfig> {
    const merged: Record<string, SkillDefaultConfig> = {};

    // Load from roots in reverse order so higher priority roots override lower ones
    // roots[0] is user directory (highest priority), roots[1] is app-bundled (lower priority)
    const reversedRoots = [...roots].reverse();

    for (const root of reversedRoots) {
      const configPath = path.join(root, SKILLS_CONFIG_FILE);
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw) as SkillsConfig;
        if (config.defaults && typeof config.defaults === 'object') {
          for (const [id, settings] of Object.entries(config.defaults)) {
            const ids = Array.from(new Set([id, id.replace(/_/g, '-'), id.replace(/-/g, '_')]));
            for (const aliasId of ids) {
              merged[aliasId] = { ...merged[aliasId], ...settings };
            }
          }
        }
      } catch (error) {
        console.warn('[skills] Failed to load skills config:', configPath, error);
      }
    }

    return merged;
  }

  private getSkillRoots(primaryRoot?: string): string[] {
    const resolvedPrimary = primaryRoot ?? this.getSkillsRoot();
    const roots = [resolvedPrimary];
    const appRoot = this.getBundledSkillsRoot();
    if (appRoot !== resolvedPrimary && fs.existsSync(appRoot)) {
      roots.push(appRoot);
    }
    return roots;
  }

  private getBundledSkillsRoot(): string {
    return resolveBundledSkillsRoot();
  }

  getSkillConfig(skillId: string): { success: boolean; config?: Record<string, string>; error?: string } {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      if (!fs.existsSync(envPath)) {
        return { success: true, config: {} };
      }
      const raw = fs.readFileSync(envPath, 'utf8');
      const config: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        config[key] = value;
      }
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read skill config' };
    }
  }

  setSkillConfig(skillId: string, config: Record<string, string>): { success: boolean; error?: string } {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      const lines = Object.entries(config)
        .filter(([key]) => key.trim())
        .map(([key, value]) => `${key}=${value}`);
      fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write skill config' };
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }> {
    try {
      const skillDir = this.resolveSkillDir(skillId);
      const imapScript = path.join(skillDir, 'scripts', 'imap.js');
      const smtpScript = path.join(skillDir, 'scripts', 'smtp.js');
      if (!fs.existsSync(imapScript) || !fs.existsSync(smtpScript)) {
        return { success: false, error: 'Email connectivity scripts not found' };
      }

      const envOverrides = Object.fromEntries(
        Object.entries(config ?? {})
          .filter(([key]) => key.trim())
          .map(([key, value]) => [key, String(value ?? '')])
      );
      const baseEnv = await getEnhancedEnv('local');

      const imapResult = await this.runSkillScriptWithEnv(
        skillDir,
        imapScript,
        ['list-mailboxes'],
        baseEnv,
        envOverrides,
        20000
      );
      const smtpResult = await this.runSkillScriptWithEnv(
        skillDir,
        smtpScript,
        ['verify'],
        baseEnv,
        envOverrides,
        20000
      );

      const checks: EmailConnectivityCheck[] = [
        this.buildEmailConnectivityCheck('imap_connection', imapResult),
        this.buildEmailConnectivityCheck('smtp_connection', smtpResult),
      ];
      const verdict: EmailConnectivityVerdict = checks.every(check => check.level === 'pass') ? 'pass' : 'fail';

      return {
        success: true,
        result: {
          testedAt: Date.now(),
          verdict,
          checks,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test email connectivity',
      };
    }
  }

  private resolveSkillDir(skillId: string): string {
    const skill = this.resolveSkillById(skillId);
    if (!skill) {
      throw new Error('Skill not found');
    }
    return path.dirname(skill.skillPath);
  }

  private getScriptRuntimeCandidates(): Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> {
    const candidates: Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> = [];
    if (!app.isPackaged) {
      candidates.push({ command: 'node' });
    }
    const electronExecutable = resolveElectronSkillExecutablePath();
    candidates.push({
      command: electronExecutable,
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    return candidates;
  }

  private async runSkillScriptWithEnv(
    skillDir: string,
    scriptPath: string,
    scriptArgs: string[],
    baseEnv: NodeJS.ProcessEnv,
    envOverrides: Record<string, string>,
    timeoutMs: number
  ): Promise<SkillScriptRunResult> {
    let lastResult: SkillScriptRunResult | null = null;

    for (const runtime of this.getScriptRuntimeCandidates()) {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...runtime.extraEnv,
        ...envOverrides,
      };
      const result = await runScriptWithTimeout({
        command: runtime.command,
        args: [scriptPath, ...scriptArgs],
        cwd: skillDir,
        env,
        timeoutMs,
      });
      lastResult = result;

      if (result.spawnErrorCode === 'ENOENT') {
        continue;
      }
      return result;
    }

    return lastResult ?? {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      error: 'Failed to run skill script',
    };
  }

  private parseScriptMessage(stdout: string): string | null {
    if (!stdout) {
      return null;
    }
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  private getLastOutputLine(text: string): string {
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(-1)[0] || '';
  }

  private buildEmailConnectivityCheck(
    code: EmailConnectivityCheckCode,
    result: SkillScriptRunResult
  ): EmailConnectivityCheck {
    const label = code === 'imap_connection' ? 'IMAP' : 'SMTP';

    if (result.success) {
      const parsedMessage = this.parseScriptMessage(result.stdout);
      return {
        code,
        level: 'pass',
        message: parsedMessage || `${label} connection successful`,
        durationMs: result.durationMs,
      };
    }

    const message = result.timedOut
      ? `${label} connectivity check timed out`
      : result.error
        || this.getLastOutputLine(result.stderr)
        || this.getLastOutputLine(result.stdout)
        || `${label} connection failed`;

    return {
      code,
      level: 'fail',
      message,
      durationMs: result.durationMs,
    };
  }

  private normalizeGitSource(source: string): NormalizedGitSource | null {
    const githubTreeOrBlob = parseGithubTreeOrBlobUrl(source);
    if (githubTreeOrBlob) {
      return githubTreeOrBlob;
    }

    if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
      return {
        repoUrl: `https://github.com/${source}.git`,
      };
    }
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@')) {
      return {
        repoUrl: source,
      };
    }
    if (source.endsWith('.git')) {
      return {
        repoUrl: source,
      };
    }
    return null;
  }
}

export const __skillManagerTestUtils = {
  parseFrontmatter,
  isTruthy,
  extractDescription,
};
