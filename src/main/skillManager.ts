import { app, BrowserWindow, session } from 'electron';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import extractZip from 'extract-zip';
import { SqliteStore } from './sqliteStore';
import { getEnhancedEnv } from './libs/coworkUtil';
import { isPathWithin, resolveElectronExecutablePath } from './libs/runtimePaths';
import { buildImageSkillEnvOverrides } from './libs/skillImageProviderEnv';
import { getMetaidRpcBase } from './services/metaidRpcEndpoint';

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

  constructor(private getStore: () => SqliteStore) {}

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

  getSkillsRoot(): string {
    const envOverride = process.env.IDBOTS_SKILLS_ROOT?.trim() || process.env.SKILLS_ROOT?.trim();
    if (envOverride) {
      return path.resolve(envOverride);
    }
    if (!app.isPackaged) {
      const projectRoot = path.resolve(__dirname, '..');
      return path.resolve(projectRoot, SKILLS_DIR_NAME);
    }
    return path.resolve(app.getPath('userData'), SKILLS_DIR_NAME);
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
          && this.isSkillManifestDifferent(dir, targetDir);
        const shouldRepairRuntime = targetExists
          && isOfficial
          && canRepairFromBundled
          && this.isSkillRuntimeBroken(dir, targetDir);
        const shouldPatchRuntimeOnly = targetExists
          && isOfficial
          && !canRepairFromBundled
          && this.isSkillRuntimeBroken(dir, targetDir);
        const shouldRefreshManifest = targetExists
          && isOfficial
          && canRepairFromBundled
          && this.isSkillManifestDifferent(dir, targetDir);
        const shouldSync = !targetExists
          || shouldRepair
          || shouldUpgradeByVersion
          || shouldBootstrapOfficialUpdate
          || shouldRepairRuntime
          || shouldPatchRuntimeOnly
          || shouldRefreshManifest;
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
          } else if (shouldRefreshManifest) {
            console.log(`[skills] Refreshed bundled skill "${id}" due to manifest drift in user data`);
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
    } catch (error) {
      console.warn('[skills] Failed to sync bundled skills:', error);
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

  private isSuperpowersSkillId(skillId: string): boolean {
    return String(skillId || '').trim().startsWith(SUPERPOWERS_SKILL_PREFIX);
  }

  private buildSkillEntries(skills: SkillRecord[]): string {
    return skills
      .map((skill) => `  <skill><id>${skill.id}</id><name>${skill.name}</name><description>${skill.description}</description><location>${skill.skillPath}</location></skill>`)
      .join('\n');
  }

  private buildRoutingPromptFromSkills(
    skills: SkillRecord[],
    options?: {
      introBlocks?: string[];
      extraRules?: string[];
    }
  ): string | null {
    if (skills.length === 0) return null;

    const promptBody = [
      '## Skills (mandatory)',
      'Before replying: scan <available_skills> <description> entries, but only after applying any higher-priority MetaApp routing rules already present in the system prompt.',
      '- If the request is to open/use/start a local MetaApp or application, evaluate MetaApps first and do not select a SKILL unless the user is asking for a workflow beyond opening the app.',
      '- If exactly one skill clearly applies: read its SKILL.md at <location> with the Read tool, then follow it.',
      '- If multiple could apply: choose the most specific one, then read/follow it.',
      '- If none clearly apply: do not read any SKILL.md.',
      '- Do not call the "Skill" tool. It is not wired to this SKILLs registry in this environment.',
      '- Execute selected skills only via Read + Bash as documented in each SKILL.md.',
      '- If a skill command exits with code 0, treat that execution as successful (do not bypass it with ad-hoc fallback logic).',
      '- If a skill command fails, diagnose and retry within the same skill workflow before considering alternatives.',
      '- For the selected skill, treat <location> as the canonical SKILL.md path.',
      '- Resolve relative paths mentioned by that SKILL.md against its directory (dirname(<location>)), not the workspace root.',
      '- Prefer precompiled JavaScript entrypoints (scripts/*.js or scripts/dist/*.js); avoid npx ts-node unless absolutely required.',
      'Constraints: never read more than one skill up front; only read additional skills if the first one explicitly references them.',
      ...(options?.extraRules ?? []).filter(Boolean),
      '',
      '<available_skills>',
      this.buildSkillEntries(skills),
      '</available_skills>',
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
      '- In IDBots, use `Read + Bash` to follow skill instructions. Do not call a `Skill` tool.',
      ...routingHints,
    ].join('\n');
  }

  buildAutoRoutingPrompt(): string | null {
    const skills = this.listSkills();
    const enabled = skills.filter(s => s.enabled && s.prompt);
    return this.buildRoutingPromptFromSkills(enabled);
  }

  buildCoworkAutoRoutingPrompt(): string | null {
    const skills = this.listSkills();
    const enabled = skills.filter((skill) => skill.enabled && skill.prompt);
    return this.buildRoutingPromptFromSkills(enabled, {
      introBlocks: [this.buildCoworkSuperpowersBootstrap(enabled)].filter(Boolean),
    });
  }

  buildRemoteServicesPrompt(availableServices: any[]): string | null {
    if (!availableServices || availableServices.length === 0) return null;

    const entries = availableServices
      .map(
        (svc) =>
          `  <remote_service>` +
          `<service_pin_id>${svc.pinId || svc.servicePinId || ''}</service_pin_id>` +
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
      `       provider Bot name. Ask the user to confirm before delegating.\n` +
      `    3. After the user confirms, output [DELEGATE_REMOTE_SERVICE] followed by\n` +
      `       a JSON object on the next line. This message will be intercepted by\n` +
      `       the system — do NOT show it to the user.\n` +
      `    4. Do NOT attempt to read SKILL.md files for remote services.\n\n` +
      `    [DELEGATE_REMOTE_SERVICE] JSON format:\n` +
      `    {"servicePinId":"...","serviceName":"...","providerGlobalMetaid":"...","price":"...","currency":"...","userTask":"summary","taskContext":"full context"}\n` +
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
   * Used by cognitive orchestrator for allowed_skills (no enabled/prompt filter).
   */
  buildAutoRoutingPromptForSkillIds(skillIds: string[]): string | null {
    if (skillIds.length === 0) return null;
    const set = new Set(
      skillIds
        .flatMap((id) => this.getSkillIdCandidates(id))
        .filter(Boolean)
    );
    const skills = this.listSkills().filter((s) => set.has(s.id));
    const omniCasterConstraint = set.has('metabot-omni-caster')
      ? '- For metabot-omni-caster: path and payload must come from SKILL.md and references (e.g. buzz uses /protocols/simplebuzz); do not guess.'
      : '';
    return this.buildRoutingPromptFromSkills(skills, {
      extraRules: [omniCasterConstraint],
    });
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
   * Uses invocation adapter for known skills (e.g. metabot-omni-caster); otherwise
   * runs scripts/index.js|index.ts or scripts/run.js|run.ts with --payload.
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
    };
    let metabotLlmId: string | null = null;
    if (context?.metabotId != null) {
      envOverrides.IDBOTS_METABOT_ID = String(context.metabotId);
      try {
        const db = this.getStore().getDatabase();
        const row = db.exec(
          `SELECT mw.mnemonic AS mnemonic, mw.path AS path, m.name AS name, m.globalmetaid AS globalmetaid, m.llm_id AS llm_id
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
      appConfig: this.getStore().get('app_config'),
      processEnv: process.env,
    });
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...envOverrides, ...imageEnvOverrides };

    let scriptPath: string;
    let scriptArgs: string[];
    const id = skillId.trim().toLowerCase();

    if (id === 'metabot-omni-caster') {
      const omniScriptCandidates = [
        path.join(skillDir, 'scripts', 'omni-caster.js'),
        path.join(skillDir, 'scripts', 'dist', 'omni-caster.js'),
        path.join(skillDir, 'scripts', 'omni-caster.ts'),
      ];
      const omniScript = omniScriptCandidates.find((candidate) => fs.existsSync(candidate));
      if (!omniScript) {
        return {
          success: false,
          observation: 'metabot-omni-caster: scripts/omni-caster.js, scripts/dist/omni-caster.js, or scripts/omni-caster.ts not found',
        };
      }
      let pathVal: string;
      let payloadVal: string;
      let operation = 'create';
      let contentType = 'application/json';
      try {
        const obj = JSON.parse(payloadJson || '{}') as Record<string, unknown>;
        pathVal = typeof obj.path === 'string' ? obj.path.trim() : '';
        payloadVal = typeof obj.payload === 'string' ? obj.payload : JSON.stringify(obj.payload ?? {});
        if (typeof obj.operation === 'string' && obj.operation.trim()) {
          operation = obj.operation.trim().toLowerCase();
        }
        if (typeof obj.contentType === 'string' && obj.contentType.trim()) {
          contentType = obj.contentType.trim();
        }
        // If LLM sent single "payload" string with nested JSON (e.g. {"path":"...","payload":"..."})
        if (!pathVal && typeof obj.payload === 'string') {
          try {
            const inner = JSON.parse(obj.payload) as Record<string, unknown>;
            if (typeof inner.path === 'string') pathVal = inner.path.trim();
            if (typeof inner.payload === 'string') payloadVal = inner.payload;
            else payloadVal = JSON.stringify(inner.payload ?? {});
          } catch {
            // use pathVal/payloadVal as already set
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, observation: `Invalid payload JSON: ${msg}` };
      }
      if (!pathVal) {
        return { success: false, observation: 'metabot-omni-caster: path is required' };
      }
      scriptPath = omniScript;
      scriptArgs = ['--path', pathVal, '--payload', payloadVal];
      if (operation !== 'create') scriptArgs.push('--operation', operation);
      if (contentType !== 'application/json') scriptArgs.push('--content-type', contentType);
    } else {
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
      scriptPath = selectedEntry;
      scriptArgs = ['--payload', payloadJson];
    }

    const timeoutMs = 60_000;
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

    fs.rmSync(targetDir, { recursive: true, force: true });
    const state = this.loadSkillStateMap();
    delete state[id];
    this.saveSkillStateMap(state);
    this.startWatching();
    this.notifySkillsChanged();
    return this.listSkills();
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

      for (const skillDir of skillDirs) {
        const folderName = normalizeFolderName(path.basename(skillDir));
        let targetDir = resolveWithin(root, folderName);
        let suffix = 1;
        while (fs.existsSync(targetDir)) {
          targetDir = resolveWithin(root, `${folderName}-${suffix}`);
          suffix += 1;
        }
        fs.cpSync(skillDir, targetDir, { recursive: true, dereference: false });
      }

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

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.startWatching();
      this.notifySkillsChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private notifySkillsChanged(): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('skills:changed');
      }
    });
  }

  private parseSkillDir(
    dir: string,
    state: SkillStateMap,
    defaults: Record<string, SkillDefaultConfig>,
    isBuiltIn: boolean
  ): SkillRecord | null {
    const skillFile = path.join(dir, SKILL_FILE_NAME);
    if (!fs.existsSync(skillFile)) return null;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const { frontmatter, content } = parseFrontmatter(raw);
      const name = (String(frontmatter.name || '') || path.basename(dir)).trim() || path.basename(dir);
      const description = (String(frontmatter.description || '') || extractDescription(content) || name).trim();
      const isOfficial = isTruthy(frontmatter.official) || isTruthy(frontmatter.isOfficial);
      const updatedAt = fs.statSync(skillFile).mtimeMs;
      const id = path.basename(dir);
      const prompt = content.trim();
      const defaultEnabled = defaults[id]?.enabled ?? true;
      const enabled = state[id]?.enabled ?? defaultEnabled;
      return { id, name, description, enabled, isOfficial, isBuiltIn, updatedAt, prompt, skillPath: skillFile };
    } catch (error) {
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

  private isSkillManifestDifferent(bundledSkillDir: string, localSkillDir: string): boolean {
    try {
      const bundledSkillPath = path.join(bundledSkillDir, SKILL_FILE_NAME);
      const localSkillPath = path.join(localSkillDir, SKILL_FILE_NAME);
      if (!fs.existsSync(bundledSkillPath) || !fs.existsSync(localSkillPath)) {
        return true;
      }
      const bundledRaw = fs.readFileSync(bundledSkillPath, 'utf8').replace(/\r\n/g, '\n');
      const localRaw = fs.readFileSync(localSkillPath, 'utf8').replace(/\r\n/g, '\n');
      return bundledRaw !== localRaw;
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
    if (app.isPackaged) {
      // In production, bundled SKILLs should be in Resources/SKILLs.
      const resourcesRoot = path.resolve(process.resourcesPath, SKILLS_DIR_NAME);
      if (fs.existsSync(resourcesRoot)) {
        return resourcesRoot;
      }

      // Fallback for older packages where SKILLs are inside app.asar.
      return path.resolve(app.getAppPath(), SKILLS_DIR_NAME);
    }

    // In development, use the project root (parent of dist-electron).
    // __dirname is dist-electron/, so we need to go up one level to get to project root
    const projectRoot = path.resolve(__dirname, '..');
    return path.resolve(projectRoot, SKILLS_DIR_NAME);
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
    const electronExecutable = resolveElectronExecutablePath();
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
