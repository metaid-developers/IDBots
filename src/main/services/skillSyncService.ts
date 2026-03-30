/**
 * Skill Sync Service: fetch official skills from MetaWeb and install/update them.
 * Fetches from /protocols/metabot-skill, compares with local config, and installs via metafile ZIP.
 */

import { app, session } from 'electron';
import fs from 'fs';
import path from 'path';
import { fetchContentWithFallback, fetchJsonWithFallbackOnMiss, isEmptyListDataPayload } from './localIndexerProxy';

// Dynamically require AdmZip to avoid crash if not installed
let AdmZip: typeof import('adm-zip') | null = null;
try {
  AdmZip = require('adm-zip');
} catch {
  // adm-zip not installed; install operations will fail gracefully
}

const MANAPI_BASE = 'https://manapi.metaid.io';
const MAN_CONTENT_BASE = 'https://man.metaid.io/content';
const SKILLS_DIR_NAME = 'SKILLs';
const SKILLS_CONFIG_FILE = 'skills.config.json';

export const FEATURED_SKILL_ADDRESSES = [
  '1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY',
  '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
  '12ghVWG1yAgNjzXj4mr3qK9DgyornMUikZ',
] as const;

export type OfficialSkillStatus = 'download' | 'update' | 'installed' | 'conflict';

export type OfficialSkillItem = {
  name: string;
  remoteVersion: string;
  skillFileUri: string;
  remoteCreator: string;
  description?: string;
  status: OfficialSkillStatus;
  localVersion?: string;
  localCreator?: string;
};

type SkillsConfig = {
  version?: number;
  description?: string;
  defaults: Record<string, { order?: number; enabled?: boolean; version?: string; 'creator-metaid'?: string; installedAt?: number }>;
};

type ParsedOfficialSkillDefinition = {
  name: string;
  remoteVersion: string;
  skillFileUri: string;
  remoteCreator: string;
  description?: string;
  priority: number;
};

/**
 * Compare two version strings (semver-like). Returns: -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const parts = String(v || '0').replace(/^v/i, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
    return parts;
  };
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const va = aa[i] ?? 0;
    const vb = bb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Resolve SKILLs root: in dev use project SKILLs so edits (add/delete) in repo take effect;
 * in production use userData/SKILLs.
 */
function getSkillsRoot(): string {
  const envOverride = process.env.IDBOTS_SKILLS_ROOT?.trim() || process.env.SKILLS_ROOT?.trim();
  if (envOverride) {
    return path.resolve(envOverride);
  }
  if (app.isPackaged) {
    return path.resolve(app.getPath('userData'), SKILLS_DIR_NAME);
  }
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.resolve(projectRoot, SKILLS_DIR_NAME);
}

function getConfigPath(): string {
  return path.join(getSkillsRoot(), SKILLS_CONFIG_FILE);
}

function loadSkillsConfig(): SkillsConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { defaults: {} };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as SkillsConfig;
    if (parsed && typeof parsed.defaults === 'object') {
      return parsed;
    }
    return { defaults: {} };
  } catch {
    return { defaults: {} };
  }
}

function ensureConfigExists(): void {
  const root = getSkillsRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    const initial: SkillsConfig = { version: 1, description: 'Default skill configuration for IDBots', defaults: {} };
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Extract pinId from metafile://<pinid>. Pinid may include suffix like i0 (e.g. xxx...i0).
 */
function extractPinIdFromUri(uri: string): string | null {
  const trimmed = String(uri || '').trim();
  if (trimmed.startsWith('metafile://')) {
    return trimmed.replace(/^metafile:\/\//, '').trim() || null;
  }
  return trimmed || null;
}

function extractSkillListFromPayload(data: { data?: { list?: unknown[] }; list?: unknown[]; pins?: unknown[] }): unknown[] {
  return Array.isArray(data.data?.list)
    ? data.data.list
    : Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.pins)
        ? data.pins
        : [];
}

function parseOfficialSkillDefinition(
  pin: unknown,
  addressPriority: Map<string, number>,
): ParsedOfficialSkillDefinition | null {
  const pinObj = pin as Record<string, unknown>;
  const contentSummary = pinObj.contentSummary ?? pinObj.content ?? pinObj.body ?? '';
  let parsed: Record<string, unknown> = {};
  try {
    if (typeof contentSummary === 'string') {
      parsed = JSON.parse(contentSummary) as Record<string, unknown>;
    } else if (contentSummary && typeof contentSummary === 'object') {
      parsed = contentSummary as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  const name = String(parsed.name ?? parsed.skillName ?? parsed.id ?? '').trim();
  const skillFileUri = String(
    parsed['skill-file'] ?? parsed.skillFileUri ?? parsed.skill_file_uri ?? parsed.uri ?? ''
  ).trim();
  const remoteVersion = String(parsed.version ?? parsed.skillVersion ?? '0').trim();
  const remoteCreator = String(
    pinObj.globalMetaId ?? parsed.creator ?? parsed['creator-metaid'] ?? parsed.creatorMetaid ?? ''
  ).trim();
  const description = typeof parsed.description === 'string' ? parsed.description : undefined;
  const address = String(pinObj.address ?? pinObj.create_address ?? '').trim();
  const priority = addressPriority.get(address) ?? FEATURED_SKILL_ADDRESSES.length;

  if (!name || !skillFileUri) {
    return null;
  }

  return {
    name,
    remoteVersion,
    skillFileUri,
    remoteCreator,
    description,
    priority,
  };
}

function shouldReplaceOfficialSkillDefinition(
  current: ParsedOfficialSkillDefinition,
  candidate: ParsedOfficialSkillDefinition,
): boolean {
  const versionComparison = compareVersions(candidate.remoteVersion, current.remoteVersion);
  if (versionComparison !== 0) {
    return versionComparison > 0;
  }
  return candidate.priority < current.priority;
}

export function buildOfficialSkillStatuses(
  rawPins: unknown[],
  options: {
    config: SkillsConfig;
    skillsRoot: string;
  },
): OfficialSkillItem[] {
  const addressPriority = new Map(FEATURED_SKILL_ADDRESSES.map((address, index) => [address, index]));
  const preferredByName = new Map<string, ParsedOfficialSkillDefinition>();

  for (const pin of rawPins) {
    const parsed = parseOfficialSkillDefinition(pin, addressPriority);
    if (!parsed) {
      continue;
    }
    const current = preferredByName.get(parsed.name);
    if (!current || shouldReplaceOfficialSkillDefinition(current, parsed)) {
      preferredByName.set(parsed.name, parsed);
    }
  }

  const skills: OfficialSkillItem[] = [];
  for (const preferred of preferredByName.values()) {
    const skillDir = path.join(options.skillsRoot, preferred.name);
    const skillDirExists = fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory();
    const localSkill = options.config.defaults[preferred.name];
    const localVersion = (localSkill?.version ?? '').trim() || '0';
    const localCreator = localSkill?.['creator-metaid'];

    let status: OfficialSkillStatus;
    if (!skillDirExists) {
      status = 'download';
    } else if (!localSkill) {
      status = 'download';
    } else if (localCreator && localCreator !== preferred.remoteCreator) {
      status = 'conflict';
    } else if (compareVersions(preferred.remoteVersion, localVersion) > 0) {
      status = 'update';
    } else {
      status = 'installed';
    }

    skills.push({
      name: preferred.name,
      remoteVersion: preferred.remoteVersion,
      skillFileUri: preferred.skillFileUri,
      remoteCreator: preferred.remoteCreator,
      description: preferred.description,
      status,
      localVersion: localSkill?.version,
      localCreator,
    });
  }

  return skills;
}

async function fetchOfficialSkillPinsForAddress(address: string): Promise<unknown[]> {
  const url = `${MANAPI_BASE}/address/pin/list/${address}?cursor=0&size=200&path=/protocols/metabot-skill`;
  const localPath = `/api/address/pin/list/${address}?cursor=0&size=200&path=/protocols/metabot-skill`;
  const response = await fetchJsonWithFallbackOnMiss(localPath, url, isEmptyListDataPayload);
  if (!response.ok) {
    throw new Error(`MetaWeb API error (${address}): ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { data?: { list?: unknown[] }; list?: unknown[]; pins?: unknown[] };
  return extractSkillListFromPayload(data);
}

/**
 * Fetch official skills list from MetaWeb and compute status for each.
 */
export async function getOfficialSkillsStatus(): Promise<{
  success: boolean;
  skills?: OfficialSkillItem[];
  error?: string;
}> {
  try {
    const rawPins: unknown[] = [];
    const errors: string[] = [];

    for (const address of FEATURED_SKILL_ADDRESSES) {
      try {
        rawPins.push(...await fetchOfficialSkillPinsForAddress(address));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
      }
    }

    if (rawPins.length === 0 && errors.length > 0) {
      return { success: false, error: errors.join(' | ') };
    }

    ensureConfigExists();
    const config = loadSkillsConfig();
    const skills = buildOfficialSkillStatuses(rawPins, {
      config,
      skillsRoot: getSkillsRoot(),
    });

    if (errors.length > 0) {
      console.warn('[skill-sync] partial featured skill fetch failure:', errors.join(' | '));
    }

    return { success: true, skills };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Install or update a single official skill from metafile URI.
 */
export async function installOfficialSkill(
  name: string,
  skillFileUri: string,
  remoteVersion: string,
  remoteCreator: string
): Promise<{ success: boolean; error?: string }> {
  if (!AdmZip) {
    return { success: false, error: 'adm-zip is not installed. Run: npm install adm-zip' };
  }

  const pinId = extractPinIdFromUri(skillFileUri);
  if (!pinId) {
    return { success: false, error: 'Invalid skillFileUri: expected metafile://<pinid>' };
  }

  try {
    const url = `${MAN_CONTENT_BASE}/${pinId}`;
    const response = await fetchContentWithFallback(pinId, url);
    if (!response.ok) {
      return { success: false, error: `Download failed: ${response.status} ${response.statusText}` };
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const root = getSkillsRoot();
    ensureDir(root);
    const targetDir = path.join(root, name);

    const zip = new AdmZip(buffer);
    const tempDir = path.join(root, `.tmp-${name}-${Date.now()}`);
    zip.extractAllTo(tempDir, true);

    // Find SKILL.md in extracted tree; its parent dir is the content root (handles any nesting)
    const SKILL_FILE = 'SKILL.md';
    const findSkillMdDir = (dir: string): string | null => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const found = findSkillMdDir(full);
          if (found) return found;
        } else if (e.name === SKILL_FILE) {
          return dir;
        }
      }
      return null;
    };
    const contentRoot = findSkillMdDir(tempDir);
    if (!contentRoot) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error('ZIP does not contain SKILL.md');
    }

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    ensureDir(targetDir);
    const moveAll = (from: string, to: string) => {
      const items = fs.readdirSync(from, { withFileTypes: true });
      for (const e of items) {
        const src = path.join(from, e.name);
        const dest = path.join(to, e.name);
        if (e.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          moveAll(src, dest);
          fs.rmSync(src, { recursive: true, force: true });
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(src, dest);
        }
      }
    };
    moveAll(contentRoot, targetDir);
    fs.rmSync(tempDir, { recursive: true, force: true });

    ensureConfigExists();
    const configPath = getConfigPath();
    const config = loadSkillsConfig();
    const existing = config.defaults[name];
    const order = existing?.order ?? 0;
    const installedAt = Date.now();
    config.defaults[name] = {
      order,
      version: remoteVersion,
      'creator-metaid': remoteCreator,
      installedAt,
      enabled: true,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Sync all skills with status 'download' or 'update'. Returns first error if any fails.
 */
export async function syncAllOfficialSkills(): Promise<{ success: boolean; error?: string }> {
  const statusResult = await getOfficialSkillsStatus();
  if (!statusResult.success || !statusResult.skills) {
    return { success: false, error: statusResult.error ?? 'Failed to fetch official skills status' };
  }

  const toInstall = statusResult.skills.filter(s => s.status === 'download' || s.status === 'update');
  for (const skill of toInstall) {
    const result = await installOfficialSkill(
      skill.name,
      skill.skillFileUri,
      skill.remoteVersion,
      skill.remoteCreator
    );
    if (!result.success) {
      return { success: false, error: `${skill.name}: ${result.error}` };
    }
  }

  return { success: true };
}
