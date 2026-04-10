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
  icon?: string;
  cover?: string;
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
  icon?: string;
  cover?: string;
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

type ParsedVersionIdentifier = number | string;

const compareVersionIdentifierStrings = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const removeMetaAppDirBestEffort = (targetDir: string): void => {
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
  } catch (error) {
    console.warn('[metaapps] Failed to remove temporary MetaApp dir:', targetDir, error);
  }
};

const compareVersions = (a?: string, b?: string): number => {
  const parse = (value: string | undefined): { core: number[]; prerelease: ParsedVersionIdentifier[] } => {
    const normalized = String(value || '0').trim().replace(/^v/i, '');
    const withoutBuild = normalized.split('+', 1)[0];
    const dashIndex = withoutBuild.indexOf('-');
    const mainPart = dashIndex >= 0 ? withoutBuild.slice(0, dashIndex) : withoutBuild;
    const prereleasePart = dashIndex >= 0 ? withoutBuild.slice(dashIndex + 1) : '';
    const core = (mainPart || '0')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
    const prerelease = prereleasePart
      ? prereleasePart.split('.').map((part) => {
          if (/^\d+$/.test(part)) {
            return parseInt(part, 10);
          }
          return part;
        })
      : [];
    return { core, prerelease };
  };

  const aa = parse(a);
  const bb = parse(b);
  const coreLength = Math.max(aa.core.length, bb.core.length);
  for (let i = 0; i < coreLength; i += 1) {
    const va = aa.core[i] ?? 0;
    const vb = bb.core[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }

  if (aa.prerelease.length === 0 && bb.prerelease.length === 0) {
    return 0;
  }
  if (aa.prerelease.length === 0) {
    return 1;
  }
  if (bb.prerelease.length === 0) {
    return -1;
  }

  const prereleaseLength = Math.max(aa.prerelease.length, bb.prerelease.length);
  for (let i = 0; i < prereleaseLength; i += 1) {
    const va = aa.prerelease[i];
    const vb = bb.prerelease[i];
    if (va === undefined) return -1;
    if (vb === undefined) return 1;
    if (va === vb) continue;

    const vaIsNumber = typeof va === 'number';
    const vbIsNumber = typeof vb === 'number';
    if (vaIsNumber && vbIsNumber) {
      return va < vb ? -1 : 1;
    }
    if (vaIsNumber) return -1;
    if (vbIsNumber) return 1;
    return compareVersionIdentifierStrings(String(va), String(vb));
  }

  return 0;
};

const buildMetaAppTempDirPath = (targetDir: string, suffix: 'stage' | 'backup'): string => {
  const uniqueSuffix = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.${suffix}-${uniqueSuffix}`);
};

const restoreMetaAppBackup = (backupDir: string, targetDir: string): void => {
  if (fs.existsSync(targetDir) || !fs.existsSync(backupDir)) {
    return;
  }

  try {
    fs.renameSync(backupDir, targetDir);
    return;
  } catch (error) {
    if (fs.existsSync(targetDir) || !fs.existsSync(backupDir)) {
      throw error;
    }
  }

  fs.cpSync(backupDir, targetDir, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: false,
  });
  removeMetaAppDirBestEffort(backupDir);
};

const replaceMetaAppDirSafely = (sourceDir: string, targetDir: string): void => {
  const stageDir = buildMetaAppTempDirPath(targetDir, 'stage');
  const backupDir = buildMetaAppTempDirPath(targetDir, 'backup');
  const targetExists = fs.existsSync(targetDir);

  try {
    fs.cpSync(sourceDir, stageDir, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: false,
    });
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }

  if (!targetExists) {
    try {
      fs.renameSync(stageDir, targetDir);
    } catch (error) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      throw error;
    }
    return;
  }

  try {
    fs.renameSync(targetDir, backupDir);
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }

  try {
    fs.renameSync(stageDir, targetDir);
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    if (!fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      restoreMetaAppBackup(backupDir, targetDir);
    }
    throw error;
  }

  removeMetaAppDirBestEffort(backupDir);
};

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

const writeMetaAppsConfigToRoot = (root: string, config: MetaAppsConfig): void => {
  const configPath = resolveMetaAppsConfigPath(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

const readMetaAppFile = (appFilePath: string): FrontmatterParseResult | null => {
  if (!fs.existsSync(appFilePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(appFilePath, 'utf8');
    return parseFrontmatter(raw);
  } catch (error) {
    console.warn('[metaapps] Failed to read APP.md:', appFilePath, error);
    return null;
  }
};

const loadMetaAppDefaultFromDir = (appDir: string): MetaAppDefaultConfig => {
  const parsed = readMetaAppFile(path.join(appDir, METAAPP_FILE_NAME));
  const frontmatter = parsed?.frontmatter ?? {};
  return {
    version: String(frontmatter.version ?? '0').trim() || '0',
    'creator-metaid': String(frontmatter['creator-metaid'] ?? '').trim(),
    'source-type': normalizeSourceType(frontmatter['source-type'] ?? 'manual'),
    icon: String(frontmatter.icon ?? '').trim(),
    cover: String(frontmatter.cover ?? '').trim(),
  };
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
      const bundledDefaults = loadMetaAppDefaultsFromRoot(bundledRoot);
      const userDefaults = loadMetaAppDefaultsFromRoot(userRoot);
      const syncedAppIds = new Set<string>();
      const bundledDirs = listMetaAppDirs(bundledRoot);

      bundledDirs.forEach((dir) => {
        try {
          const appId = path.basename(dir);
          const targetDir = path.join(userRoot, appId);
          const bundledDefault = bundledDefaults[appId] ?? loadMetaAppDefaultFromDir(dir);
          const bundledVersion = String(bundledDefault.version ?? '0').trim() || '0';
          const bundledCreatorMetaId = String(bundledDefault['creator-metaid'] ?? '').trim();
          const bundledSourceType = normalizeSourceType(bundledDefault['source-type'] ?? 'manual');
          const localDefault = userDefaults[appId];

          if (!isIdbotsManagedSource(bundledSourceType)) {
            return;
          }

          if (!fs.existsSync(targetDir)) {
            if (localDefault) {
              const localCreatorMetaId = String(localDefault['creator-metaid'] ?? '').trim();
              if (localCreatorMetaId !== bundledCreatorMetaId) {
                return;
              }

              const localSourceType = normalizeSourceType(localDefault['source-type'] ?? 'manual');
              if (!isIdbotsManagedSource(localSourceType)) {
                return;
              }

              const localVersion = String(localDefault.version ?? '0').trim() || '0';
              if (compareVersions(bundledVersion, localVersion) < 0) {
                return;
              }
            }

            replaceMetaAppDirSafely(dir, targetDir);
            syncedAppIds.add(appId);
            return;
          }

          if (!localDefault) {
            const currentDefault = loadMetaAppDefaultFromDir(targetDir);
            const currentCreatorMetaId = String(currentDefault['creator-metaid'] ?? '').trim();
            const currentSourceType = normalizeSourceType(currentDefault['source-type'] ?? 'manual');
            if (
              currentCreatorMetaId === bundledCreatorMetaId
              && currentSourceType === bundledSourceType
              && isIdbotsManagedSource(currentSourceType)
            ) {
              const currentVersion = String(currentDefault.version ?? '0').trim() || '0';
              if (compareVersions(bundledVersion, currentVersion) > 0) {
                replaceMetaAppDirSafely(dir, targetDir);
              }
              syncedAppIds.add(appId);
            }
            return;
          }

          const localCreatorMetaId = String(localDefault['creator-metaid'] ?? '').trim();
          if (localCreatorMetaId !== bundledCreatorMetaId) {
            return;
          }

          const localSourceType = normalizeSourceType(localDefault['source-type'] ?? 'manual');
          if (!isIdbotsManagedSource(localSourceType)) {
            return;
          }

          const localVersion = String(localDefault.version ?? '0').trim() || '0';
          if (compareVersions(bundledVersion, localVersion) <= 0) {
            return;
          }

          replaceMetaAppDirSafely(dir, targetDir);
          syncedAppIds.add(appId);
        } catch (error) {
          console.warn('[metaapps] Failed to sync bundled MetaApp:', dir, error);
        }
      });

      this.mergeBundledMetaAppDefaults(userRoot, bundledRoot, syncedAppIds);
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
        const hasRegistryEntry = Object.prototype.hasOwnProperty.call(defaults, id);
        const appDefaults = defaults[id] ?? {};
        const version = hasRegistryEntry
          ? String(appDefaults.version ?? '0').trim() || '0'
          : String(frontmatter.version || '0').trim() || '0';
        const creatorMetaId = hasRegistryEntry
          ? String(appDefaults['creator-metaid'] ?? '').trim()
          : String(frontmatter['creator-metaid'] || '').trim();
        const sourceType = hasRegistryEntry
          ? normalizeSourceType(appDefaults['source-type'] ?? 'manual')
          : normalizeSourceType(frontmatter['source-type'] || 'manual');
        const icon = hasRegistryEntry
          ? String(appDefaults.icon ?? frontmatter.icon ?? '').trim()
          : String(frontmatter.icon || '').trim();
        const cover = hasRegistryEntry
          ? String(appDefaults.cover ?? frontmatter.cover ?? '').trim()
          : String(frontmatter.cover || '').trim();
        const entryFilePath = resolveEntryFilePath(id, dir, entry);
        if (!entryFilePath) {
          return;
        }
        result.push({
          id,
          name,
          description,
          icon: icon || undefined,
          cover: cover || undefined,
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
      'Before replying: scan <available_metaapps> entries only when the current user turn explicitly asks to open/use/start a local app or MetaApp.',
      '- Generic confirmations such as "好的" / "确定" / "继续" are not MetaApp requests.',
      '- If the current turn is approving a previously proposed remote service or delegation, do not call `open_metaapp` or `resolve_metaapp_url`.',
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

  private writeMetaAppsConfig(root: string, config: MetaAppsConfig): void {
    writeMetaAppsConfigToRoot(root, config);
  }

  private mergeBundledMetaAppDefaults(
    userRoot: string,
    bundledRoot: string,
    syncedAppIds: Set<string>
  ): void {
    if (syncedAppIds.size === 0) {
      return;
    }

    const bundledConfig = loadMetaAppsConfigFromRoot(bundledRoot);
    const userConfig = loadMetaAppsConfigFromRoot(userRoot);
    const bundledDefaults = bundledConfig?.defaults ?? {};
    const defaults: Record<string, MetaAppDefaultConfig> = {
      ...(userConfig?.defaults ?? {}),
    };
    const now = Date.now();

    syncedAppIds.forEach((appId) => {
      const bundledDefault = bundledDefaults[appId] ?? loadMetaAppDefaultFromDir(path.join(bundledRoot, appId));
      const existing = defaults[appId] ?? {};
      defaults[appId] = {
        ...existing,
        version: String(bundledDefault.version ?? existing.version ?? '0').trim() || '0',
        'creator-metaid': String(
          bundledDefault['creator-metaid'] ?? existing['creator-metaid'] ?? ''
        ).trim(),
        'source-type': normalizeSourceType(bundledDefault['source-type'] ?? existing['source-type'] ?? 'manual'),
        icon: String(bundledDefault.icon ?? existing.icon ?? '').trim(),
        cover: String(bundledDefault.cover ?? existing.cover ?? '').trim(),
        installedAt: typeof existing.installedAt === 'number' ? existing.installedAt : now,
        updatedAt: now,
      };
    });

    this.writeMetaAppsConfig(userRoot, {
      version: userConfig?.version ?? bundledConfig?.version,
      description: userConfig?.description ?? bundledConfig?.description,
      defaults,
    });
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
