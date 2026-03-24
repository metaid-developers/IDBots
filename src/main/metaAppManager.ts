import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

const METAAPPS_DIR_NAME = 'METAAPPs';
const METAAPP_FILE_NAME = 'APP.md';
const METAAPPS_CONFIG_FILE_NAME = 'metaapps.config.json';
const WATCH_DEBOUNCE_MS = 250;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

type AppLike = {
  isPackaged: boolean;
  getPath: (name: string) => string;
  getAppPath: () => string;
};

type MetaAppManagerOptions = {
  app?: AppLike;
  resourcesPath?: string;
};

type FrontmatterParseResult = {
  frontmatter: Record<string, string>;
  content: string;
};

type MetaAppSourceType = 'bundled-idbots' | 'chain-idbots' | 'chain-community' | 'manual';

type MetaAppDefaultConfig = {
  version?: string;
  'creator-metaid'?: string;
  'source-type'?: string;
  installedAt?: number;
  updatedAt?: number;
};

type MetaAppsConfig = {
  version?: number;
  description?: string;
  defaults: Record<string, MetaAppDefaultConfig>;
};

export type MetaAppRecord = {
  id: string;
  name: string;
  description: string;
  isOfficial: boolean;
  updatedAt: number;
  entry: string;
  appPath: string;
  appRoot: string;
  prompt: string;
  version: string;
  creatorMetaId: string;
  sourceType: MetaAppSourceType;
  managedByIdbots: boolean;
};

const parseFrontmatter = (raw: string): FrontmatterParseResult => {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, content: normalized };
  }

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
    frontmatter[key] = value;
  }

  const content = normalized.slice(match[0].length);
  return { frontmatter, content };
};

const isTruthy = (value?: string): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
};

const resolveMetaAppsConfigPath = (root: string): string => path.join(root, METAAPPS_CONFIG_FILE_NAME);

const normalizeSourceType = (sourceType?: string): MetaAppSourceType => {
  const value = String(sourceType || '').trim();
  if (value === 'bundled-idbots' || value === 'chain-idbots' || value === 'chain-community' || value === 'manual') {
    return value;
  }
  return 'manual';
};

const isIdbotsManagedSource = (sourceType: MetaAppSourceType): boolean =>
  sourceType === 'bundled-idbots' || sourceType === 'chain-idbots';

const loadMetaAppsConfigFromRoot = (root: string): MetaAppsConfig | null => {
  const configPath = resolveMetaAppsConfigPath(root);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as MetaAppsConfig;
    const defaults = parsed && typeof parsed === 'object' && parsed.defaults && typeof parsed.defaults === 'object'
      ? parsed.defaults
      : {};
    return {
      version: parsed?.version,
      description: parsed?.description,
      defaults,
    };
  } catch (error) {
    console.warn('[metaapps] Failed to read metaapps.config.json:', configPath, error);
    return null;
  }
};

const loadMetaAppDefaultsFromRoot = (root: string): Record<string, MetaAppDefaultConfig> => {
  const config = loadMetaAppsConfigFromRoot(root);
  return config?.defaults ?? {};
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

const normalizeEntryPath = (entry: string): string => {
  const trimmed = String(entry || '').trim();
  if (!trimmed) return '';
  const hashIndex = trimmed.indexOf('#');
  const queryIndex = trimmed.indexOf('?');
  let cutIndex = trimmed.length;
  if (hashIndex >= 0) cutIndex = Math.min(cutIndex, hashIndex);
  if (queryIndex >= 0) cutIndex = Math.min(cutIndex, queryIndex);
  return trimmed.slice(0, cutIndex);
};

const isPathInside = (root: string, target: string): boolean => {
  const relativePath = path.relative(root, target);
  if (!relativePath) return false;
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
};

const resolveEntryFilePath = (appId: string, appRootDir: string, entry: string): string | null => {
  if (!entry.startsWith('/')) return null;
  const normalizedPath = normalizeEntryPath(entry);
  if (!normalizedPath) return null;
  if (!normalizedPath.startsWith(`/${appId}/`)) return null;

  const normalizedPosixPath = path.posix.normalize(normalizedPath);
  const appRootPosixPath = `/${appId}`;
  if (!normalizedPosixPath.startsWith(`${appRootPosixPath}/`)) {
    return null;
  }

  const relativePath = path.posix.relative(appRootPosixPath, normalizedPosixPath);
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.posix.isAbsolute(relativePath)) {
    return null;
  }

  const resolvedFilePath = path.resolve(appRootDir, ...relativePath.split('/'));
  if (!isPathInside(appRootDir, resolvedFilePath)) {
    return null;
  }
  if (!fs.existsSync(resolvedFilePath)) {
    return null;
  }
  try {
    if (!fs.statSync(resolvedFilePath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  return resolvedFilePath;
};

const listMetaAppDirs = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root);
  return entries
    .map((entry) => path.join(root, entry))
    .filter((entryPath) => {
      try {
        const stat = fs.lstatSync(entryPath);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          return false;
        }
        return fs.existsSync(path.join(entryPath, METAAPP_FILE_NAME));
      } catch {
        return false;
      }
    });
};

export class MetaAppManager {
  private watchers: fs.FSWatcher[] = [];
  private notifyTimer: NodeJS.Timeout | null = null;
  private readonly runtimeApp: AppLike | undefined;
  private readonly runtimeResourcesPath: string | undefined;

  constructor(options?: MetaAppManagerOptions) {
    this.runtimeApp = options?.app ?? ((app as unknown) as AppLike | undefined);
    this.runtimeResourcesPath = options?.resourcesPath;
  }

  getMetaAppsRoot(): string {
    const envOverride = process.env.IDBOTS_METAAPPS_ROOT?.trim();
    if (envOverride) {
      return path.resolve(envOverride);
    }

    if (!this.runtimeApp?.isPackaged) {
      const projectRoot = path.resolve(__dirname, '..');
      return path.resolve(projectRoot, METAAPPS_DIR_NAME);
    }

    return path.resolve(this.runtimeApp.getPath('userData'), METAAPPS_DIR_NAME);
  }

  ensureMetaAppsRoot(): string {
    const root = this.getMetaAppsRoot();
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  getBundledMetaAppsRoot(): string {
    const packaged = Boolean(this.runtimeApp?.isPackaged);
    if (packaged) {
      const runtimeResourcesPath = this.runtimeResourcesPath || process.resourcesPath;
      const resourcesRoot = path.resolve(runtimeResourcesPath, METAAPPS_DIR_NAME);
      if (fs.existsSync(resourcesRoot)) {
        return resourcesRoot;
      }
      const appPath = this.runtimeApp?.getAppPath?.();
      if (appPath) {
        return path.resolve(appPath, METAAPPS_DIR_NAME);
      }
      return resourcesRoot;
    }

    const projectRoot = path.resolve(__dirname, '..');
    return path.resolve(projectRoot, METAAPPS_DIR_NAME);
  }

  syncBundledMetaAppsToUserData(): void {
    if (!this.runtimeApp?.isPackaged) {
      return;
    }

    const userRoot = this.ensureMetaAppsRoot();
    const bundledRoot = this.getBundledMetaAppsRoot();
    if (!bundledRoot || bundledRoot === userRoot || !fs.existsSync(bundledRoot)) {
      return;
    }

    try {
      const bundledConfigPath = resolveMetaAppsConfigPath(bundledRoot);
      const userConfigPath = resolveMetaAppsConfigPath(userRoot);
      const bundledDirs = listMetaAppDirs(bundledRoot);
      bundledDirs.forEach((dir) => {
        const appId = path.basename(dir);
        const targetDir = path.join(userRoot, appId);
        if (fs.existsSync(targetDir)) {
          return;
        }
        fs.cpSync(dir, targetDir, {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: false,
        });
      });

      if (fs.existsSync(bundledConfigPath) && !fs.existsSync(userConfigPath)) {
        fs.cpSync(bundledConfigPath, userConfigPath, { force: false, errorOnExist: false });
      }
    } catch (error) {
      console.warn('[metaapps] Failed to sync bundled METAAPPs:', error);
    }
  }

  listMetaApps(): MetaAppRecord[] {
    const root = this.ensureMetaAppsRoot();
    const defaults = loadMetaAppDefaultsFromRoot(root);
    const dirs = listMetaAppDirs(root);
    const result: MetaAppRecord[] = [];

    dirs.forEach((dir) => {
      const appFile = path.join(dir, METAAPP_FILE_NAME);
      if (!fs.existsSync(appFile)) return;
      try {
        const raw = fs.readFileSync(appFile, 'utf8');
        const { frontmatter, content } = parseFrontmatter(raw);
        const id = path.basename(dir);
        const name = (frontmatter.name || id).trim() || id;
        const description = (frontmatter.description || extractDescription(content) || name).trim();
        const entry = String(frontmatter.entry || '').trim();
        const appDefaults = defaults[id] ?? {};
        const version = String(frontmatter.version || appDefaults.version || '0').trim() || '0';
        const creatorMetaId = String(frontmatter['creator-metaid'] || appDefaults['creator-metaid'] || '').trim();
        const sourceType = normalizeSourceType(frontmatter['source-type'] || appDefaults['source-type'] || 'manual');
        const entryFilePath = resolveEntryFilePath(id, dir, entry);
        if (!entryFilePath) {
          return;
        }
        result.push({
          id,
          name,
          description,
          isOfficial: isTruthy(frontmatter.official),
          updatedAt: fs.statSync(appFile).mtimeMs,
          entry,
          appPath: appFile,
          appRoot: dir,
          prompt: content.trim(),
          version,
          creatorMetaId,
          sourceType,
          managedByIdbots: isIdbotsManagedSource(sourceType),
        });
      } catch (error) {
        console.warn('[metaapps] Failed to parse APP.md:', dir, error);
      }
    });

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  buildCoworkAutoRoutingPrompt(): string | null {
    const apps = this.listMetaApps();
    if (apps.length === 0) return null;

    const entries = apps
      .map((metaApp) => [
        '  <metaapp>',
        `    <id>${metaApp.id}</id>`,
        `    <name>${metaApp.name}</name>`,
        `    <description>${metaApp.description}</description>`,
        `    <entry>${metaApp.entry}</entry>`,
        `    <location>${metaApp.appPath}</location>`,
        '  </metaapp>',
      ].join('\n'))
      .join('\n');

    return [
      '## MetaApps (Cowork)',
      'Before replying: scan <available_metaapps> entries.',
      '- If the user asks to open/use/start a local app or MetaApp, evaluate <available_metaapps> before any SKILL routing.',
      '- If one metaapp clearly matches, read its APP.md at <location> and use `open_metaapp`; do not route that request to a SKILL first.',
      '- If multiple metaapps could match, choose the most specific one and open at most one unless the user explicitly asks for more.',
      '- If user asks for explanation/analysis only, do not open a metaapp.',
      '- Never invent external URLs; only use local metaapp entry/paths from APP.md.',
      '',
      '<available_metaapps>',
      entries,
      '</available_metaapps>',
    ].join('\n');
  }

  startWatching(): void {
    this.stopWatching();
    const root = this.ensureMetaAppsRoot();
    if (!fs.existsSync(root)) return;

    const watchHandler = () => this.scheduleNotify();
    try {
      this.watchers.push(fs.watch(root, watchHandler));
    } catch (error) {
      console.warn('[metaapps] Failed to watch METAAPPs root:', root, error);
    }

    const appDirs = listMetaAppDirs(root);
    appDirs.forEach((dir) => {
      try {
        this.watchers.push(fs.watch(dir, watchHandler));
      } catch (error) {
        console.warn('[metaapps] Failed to watch METAAPP directory:', dir, error);
      }
    });
  }

  stopWatching(): void {
    this.watchers.forEach((watcher) => watcher.close());
    this.watchers = [];
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.startWatching();
      this.notifyMetaAppsChanged();
    }, WATCH_DEBOUNCE_MS);
  }

  private notifyMetaAppsChanged(): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('metaapps:changed');
      }
    });
  }
}
