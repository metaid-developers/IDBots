import { DEFAULT_MANAPI_BASE_URL } from './manapiPinService';
import { restoreMetabotFromMnemonicCore, type MetaidRestoreProfile } from './metabotRestoreService';
import { chainBackupObjectId, decryptJson, deriveBackupKey, objectId } from './chainBackupCrypto';
import { materializeBackupObjects } from './chainBackupSegments';
import {
  importBackupObjects,
  rebuildChainBackupStateFromManifest,
  selectLatestBackupObjects,
  type ChainBackupObject,
} from './chainBackupData';
import {
  CHAIN_BACKUP_CIPHER,
  CHAIN_BACKUP_KDF,
  CHAIN_BACKUP_MANIFEST_PATH,
  type ChainBackupSegmentRef,
} from './chainBackupService';
import type { SqliteDatabase } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { Metabot, MetabotUpdate } from '../types/metabot';

const USER_BOTS_PATH = '/info/bots';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_INDEXER_PAGES = 50;

export interface ChainBackupRestoreProgress {
  phase: 'discover' | 'manifest' | 'segments' | 'skeleton' | 'import' | 'done' | 'error';
  botName?: string;
  botIndex?: number;
  botCount?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  message?: string;
}

export interface ChainBackupRestoreBotResult {
  globalMetaId: string;
  name: string;
  restored: boolean;
  imported: number;
  skipped: number;
  error?: string;
  warnings?: string[];
}

export interface ChainBackupRestoreResult {
  success: boolean;
  bots: ChainBackupRestoreBotResult[];
  error?: string;
}

interface FetchOptions {
  baseUrl?: string;
}

interface PinCandidate {
  pinId: string;
  timestamp: number;
  address: string;
  globalMetaId: string;
  modifyHistory: string[];
}

interface UserBotsManifestEntry {
  globalMetaId: string;
  name: string;
  type: string;
  mvcAddress: string;
}

interface BackupManifest {
  bot: string;
  botName: string;
  updatedAt?: number;
  segments: ChainBackupSegmentRef[];
}

interface SegmentEnvelope {
  version: number;
  bot: string;
  segment: string;
  cipher: string;
  kdf: string;
  payload: string;
}

interface PendingRestore {
  entry: UserBotsManifestEntry;
  botResult: ChainBackupRestoreBotResult;
  botIndex: number;
  manifestHit: { pinId: string; manifest: BackupManifest };
  objects: ChainBackupObject[];
  warnings: string[];
  metabot?: Metabot;
}

async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`indexer returned an invalid response (HTTP ${response.status})`);
    }
    if (Number(body.code) !== 1) {
      throw new Error(`indexer error ${String(body.code)}: ${typeof body.message === 'string' ? body.message : 'unknown'}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPinContentText(
  pinId: string,
  options?: { baseUrl?: string; timeoutMs?: number },
): Promise<string> {
  const baseUrl = (options?.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/content/${encodeURIComponent(pinId)}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`pin content fetch failed: HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCandidate(raw: unknown): PinCandidate {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pinId = text(record.id);
  const history = Array.isArray(record.modify_history)
    ? record.modify_history.map(text).filter(Boolean)
    : [];
  return {
    pinId,
    timestamp: Number(record.timestamp) || 0,
    address: text(record.address),
    globalMetaId: text(record.globalMetaId),
    modifyHistory: history.length > 0 ? history : [pinId],
  };
}

function readCandidatePage(body: Record<string, unknown>): { pins: PinCandidate[]; nextCursor: string | null } {
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const list = Array.isArray(data.list) ? data.list : [];
  return {
    pins: list.map(normalizeCandidate).filter((pin) => pin.pinId),
    nextCursor: text(data.nextCursor) || null,
  };
}

async function listPinsByAddress(address: string, path: string, options?: FetchOptions): Promise<PinCandidate[]> {
  const normalizedAddress = address.trim();
  if (!normalizedAddress) return [];
  const baseUrl = (options?.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const pins: PinCandidate[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_INDEXER_PAGES; page += 1) {
    const query = new URLSearchParams({ path, size: '100' });
    if (cursor) query.set('cursor', cursor);
    const body = await fetchJson(`${baseUrl}/api/address/pin/list/${encodeURIComponent(normalizedAddress)}?${query.toString()}`);
    const pageResult = readCandidatePage(body);
    pins.push(...pageResult.pins);
    if (!pageResult.nextCursor || pageResult.pins.length === 0) break;
    cursor = pageResult.nextCursor;
  }
  return pins;
}

async function listPinsByGlobalPath(path: string, options?: FetchOptions): Promise<PinCandidate[]> {
  const baseUrl = (options?.baseUrl || DEFAULT_MANAPI_BASE_URL).replace(/\/+$/, '');
  const pins: PinCandidate[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_INDEXER_PAGES; page += 1) {
    const query = new URLSearchParams({ path, size: '100' });
    if (cursor) query.set('cursor', cursor);
    const body = await fetchJson(`${baseUrl}/api/pin/path/list?${query.toString()}`);
    const pageResult = readCandidatePage(body);
    pins.push(...pageResult.pins);
    if (!pageResult.nextCursor || pageResult.pins.length === 0) break;
    cursor = pageResult.nextCursor;
  }
  return pins;
}

async function listOwnedPins(input: {
  address: string;
  globalMetaId: string;
  path: string;
}, options?: FetchOptions): Promise<PinCandidate[]> {
  let scopedError: unknown = null;
  try {
    const scoped = await listPinsByAddress(input.address, input.path, options);
    if (scoped.length > 0) return scoped;
  } catch (error) {
    scopedError = error;
  }
  const address = input.address.trim().toLowerCase();
  const globalMetaId = input.globalMetaId.trim();
  try {
    const globalPins = await listPinsByGlobalPath(input.path, options);
    return globalPins.filter((pin) => (
      (address && pin.address.toLowerCase() === address)
      || (globalMetaId && pin.globalMetaId === globalMetaId)
    ));
  } catch (error) {
    if (scopedError) throw scopedError;
    throw error;
  }
}

function headPinId(candidate: PinCandidate): string {
  return candidate.modifyHistory[candidate.modifyHistory.length - 1]?.trim() || candidate.pinId;
}

function parseUserBotsManifest(rawText: string): UserBotsManifestEntry[] {
  const parsed = JSON.parse(rawText) as { bots?: unknown };
  const bots = Array.isArray(parsed.bots) ? parsed.bots : [];
  return bots.map((raw) => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      globalMetaId: text(record.globalMetaId),
      name: typeof record.name === 'string' ? record.name : '',
      type: typeof record.type === 'string' ? record.type : 'worker',
      mvcAddress: text(record.mvcAddress),
    };
  }).filter((entry) => entry.globalMetaId);
}

async function fetchUserBotsEntries(
  identity: { globalMetaId: string; mvcAddress: string },
  options?: FetchOptions,
): Promise<UserBotsManifestEntry[]> {
  const pins = await listOwnedPins({
    address: identity.mvcAddress,
    globalMetaId: identity.globalMetaId,
    path: USER_BOTS_PATH,
  }, options);
  for (const pin of pins) {
    try {
      const entries = parseUserBotsManifest(await fetchPinContentText(headPinId(pin), options));
      if (entries.length > 0) return entries;
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchLatestBackupManifest(
  entry: UserBotsManifestEntry,
  options?: FetchOptions,
  strict = false,
): Promise<{ pinId: string; manifest: BackupManifest } | null> {
  const pins = await listOwnedPins({
    address: entry.mvcAddress,
    globalMetaId: entry.globalMetaId,
    path: CHAIN_BACKUP_MANIFEST_PATH,
  }, options);
  let lastError: unknown = null;
  for (const pin of pins) {
    try {
      const pinId = headPinId(pin);
      const parsed = JSON.parse(await fetchPinContentText(pinId, options)) as BackupManifest;
      if (
        parsed
        && parsed.bot === entry.globalMetaId
        && Array.isArray(parsed.segments)
        && parsed.segments.every((ref) => (
          text(ref?.pinId)
          && text(ref?.segment)
          && Array.isArray(ref?.objectIds)
        ))
      ) {
        return { pinId, manifest: parsed };
      }
    } catch (error) {
      lastError = error;
      continue;
    }
  }
  if (strict && lastError) throw lastError;
  return null;
}

export interface ChainBackupAvailability {
  success: boolean;
  hasBackup: boolean;
  botCount: number;
  backupBotCount: number;
  error?: string;
}

export async function probeChainBackupAvailability(deps: {
  userStore: UserIdentityStore;
  baseUrl?: string;
}): Promise<ChainBackupAvailability> {
  const identity = deps.userStore.get();
  if (!identity?.globalmetaid?.trim()) {
    return { success: false, hasBackup: false, botCount: 0, backupBotCount: 0, error: 'USER_IDENTITY_MISSING' };
  }
  let entries: UserBotsManifestEntry[];
  try {
    entries = await fetchUserBotsEntries(
      { globalMetaId: identity.globalmetaid.trim(), mvcAddress: identity.mvc_address },
      deps.baseUrl ? { baseUrl: deps.baseUrl } : undefined,
    );
  } catch (error) {
    return {
      success: false,
      hasBackup: false,
      botCount: 0,
      backupBotCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let nextIndex = 0;
  let backupBotCount = 0;
  let failure: unknown = null;
  const workerCount = Math.min(4, entries.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < entries.length) {
      const entry = entries[nextIndex];
      nextIndex += 1;
      try {
        const manifestHit = await fetchLatestBackupManifest(
          entry,
          deps.baseUrl ? { baseUrl: deps.baseUrl } : undefined,
          true,
        );
        if (manifestHit && manifestHit.manifest.segments.length > 0) backupBotCount += 1;
      } catch (error) {
        failure = error;
      }
    }
  }));

  if (failure) {
    return {
      success: false,
      hasBackup: backupBotCount > 0,
      botCount: entries.length,
      backupBotCount,
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
  return { success: true, hasBackup: backupBotCount > 0, botCount: entries.length, backupBotCount };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function profileOf(objects: ChainBackupObject[]): Record<string, unknown> | null {
  return objects.find((obj) => obj.kind === 'bot_profile')?.data ?? null;
}

function profileOverride(
  profile: Record<string, unknown> | null,
  entry: UserBotsManifestEntry,
): MetaidRestoreProfile | undefined {
  if (!profile) return undefined;
  const name = typeof profile.name === 'string' && profile.name.trim() ? profile.name : entry.name;
  return {
    name,
    avatarDataUrl: nullableString(profile.avatar),
    metabotInfoPinId: nullableString(profile.metabot_info_pinid),
    chatpubkeyPinId: nullableString(profile.chat_public_key_pin_id),
    bio: {
      role: typeof profile.role === 'string' ? profile.role : '',
      soul: typeof profile.soul === 'string' ? profile.soul : '',
      goal: nullableString(profile.goal),
      bio: nullableString(profile.bio),
      background: nullableString(profile.background),
      llm_id: nullableString(profile.llm_id),
      llm_provider: nullableString(profile.llm_provider),
      llm_effort: nullableString(profile.llm_effort),
      tools: stringArray(profile.tools),
      skills: stringArray(profile.skills),
      allowChatSkills: stringArray(profile.allow_chat_skills),
      boss_id: null,
      boss_global_metaid: nullableString(profile.boss_global_metaid),
      created_by: typeof profile.created_by === 'string' && profile.created_by ? profile.created_by : '0000',
    },
    raw: { name },
  };
}

const PROFILE_UPDATE_FIELDS = [
  'name',
  'avatar',
  'enabled',
  'globalmetaid',
  'metabot_info_pinid',
  'chat_public_key_pin_id',
  'created_by',
  'role',
  'soul',
  'goal',
  'bio',
  'background',
  'boss_global_metaid',
  'owner_binding_pinid',
  'llm_id',
  'llm_provider',
  'llm_effort',
  'fallback_llm_id',
  'fallback_llm_provider',
  'fallback_llm_effort',
  'tools',
  'skills',
  'allow_chat_skills',
  'a2a_max_incoming_turns',
  'a2a_bye_cooldown_ms',
  'a2a_auto_reply_enabled',
  'homepage',
] as const;

function applyBackupProfile(
  db: SqliteDatabase,
  metabotStore: MetabotStore,
  metabotId: number,
  profile: Record<string, unknown>,
  metabotIdMap: ReadonlyMap<number, number>,
): void {
  const rawPatch: Record<string, unknown> = {};
  for (const key of PROFILE_UPDATE_FIELDS) {
    if (profile[key] !== undefined) rawPatch[key] = profile[key];
  }
  const sourceBossId = Number(profile.boss_id);
  rawPatch.boss_id = Number.isInteger(sourceBossId) && sourceBossId > 0
    ? metabotIdMap.get(sourceBossId) ?? null
    : null;
  metabotStore.updateMetabot(metabotId, rawPatch as MetabotUpdate);

  if ('a2a_max_incoming_turns' in profile) {
    db.run('UPDATE metabots SET a2a_max_incoming_turns = ? WHERE id = ?', [
      profile.a2a_max_incoming_turns == null ? null : Number(profile.a2a_max_incoming_turns),
      metabotId,
    ]);
  }
  if ('a2a_bye_cooldown_ms' in profile) {
    db.run('UPDATE metabots SET a2a_bye_cooldown_ms = ? WHERE id = ?', [
      profile.a2a_bye_cooldown_ms == null ? null : Number(profile.a2a_bye_cooldown_ms),
      metabotId,
    ]);
  }
  if ('a2a_auto_reply_enabled' in profile) {
    const enabled = profile.a2a_auto_reply_enabled;
    db.run('UPDATE metabots SET a2a_auto_reply_enabled = ? WHERE id = ?', [
      enabled == null ? null : (enabled === false || enabled === 0 ? 0 : 1),
      metabotId,
    ]);
  }
}

function sourceMetabotId(profile: Record<string, unknown> | null): number | null {
  const value = Number(profile?.source_metabot_id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isTwinTarget(pending: PendingRestore): boolean {
  const profileType = profileOf(pending.objects)?.metabot_type;
  return profileType === 'twin' || (profileType === undefined && pending.entry.type === 'twin');
}

export interface RunChainBackupRestoreDeps {
  db: SqliteDatabase;
  metabotStore: MetabotStore;
  userStore: UserIdentityStore;
  saveDb?: () => void;
  onProgress?: (progress: ChainBackupRestoreProgress) => void;
  applyAssignedSkills?: (metabotId: number, skills: string[]) => void;
  baseUrl?: string;
}

export async function runChainBackupRestore(deps: RunChainBackupRestoreDeps): Promise<ChainBackupRestoreResult> {
  const { db, metabotStore, userStore } = deps;
  const emit = (progress: ChainBackupRestoreProgress) => deps.onProgress?.(progress);
  const fetchOptions = deps.baseUrl ? { baseUrl: deps.baseUrl } : undefined;

  const identity = userStore.get();
  if (!identity?.mnemonic || !identity.globalmetaid?.trim()) {
    return { success: false, bots: [], error: 'USER_IDENTITY_MISSING' };
  }
  const userGlobalMetaId = identity.globalmetaid.trim();
  const backupKey = deriveBackupKey(identity.mnemonic, userGlobalMetaId);

  emit({ phase: 'discover' });
  let entries: UserBotsManifestEntry[];
  try {
    entries = await fetchUserBotsEntries(
      { globalMetaId: userGlobalMetaId, mvcAddress: identity.mvc_address },
      fetchOptions,
    );
  } catch (error) {
    return { success: false, bots: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!entries.length) {
    return { success: false, bots: [], error: 'NO_BOTS_MANIFEST' };
  }

  const result: ChainBackupRestoreResult = { success: true, bots: [] };
  const pending: PendingRestore[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const botResult: ChainBackupRestoreBotResult = {
      globalMetaId: entry.globalMetaId,
      name: entry.name,
      restored: false,
      imported: 0,
      skipped: 0,
    };
    result.bots.push(botResult);
    try {
      emit({ phase: 'manifest', botName: entry.name, botIndex: i, botCount: entries.length });
      const manifestHit = await fetchLatestBackupManifest(entry, fetchOptions);
      if (!manifestHit) throw new Error('NO_BACKUP_MANIFEST');
      const objects: ChainBackupObject[] = [];
      const warnings: string[] = [];

      for (let s = 0; s < manifestHit.manifest.segments.length; s += 1) {
        const ref = manifestHit.manifest.segments[s];
        try {
          const envelope = JSON.parse(await fetchPinContentText(ref.pinId, fetchOptions)) as SegmentEnvelope;
          if (envelope.cipher !== CHAIN_BACKUP_CIPHER || envelope.kdf !== CHAIN_BACKUP_KDF) {
            throw new Error(`unsupported backup envelope (cipher=${envelope.cipher}, kdf=${envelope.kdf})`);
          }
          if (text(envelope.bot) !== entry.globalMetaId) throw new Error('SEGMENT_BOT_MISMATCH');
          if (text(envelope.segment) && envelope.segment !== ref.segment) {
            throw new Error(`segment reference mismatch for pin ${ref.pinId}`);
          }
          const plaintext = decryptJson(backupKey, Buffer.from(envelope.payload, 'base64'));
          if (objectId(plaintext) !== ref.segment) {
            throw new Error(`segment hash mismatch for pin ${ref.pinId}`);
          }
          const segment = plaintext as {
            bot?: unknown;
            objects?: Array<{ id: string; kind: ChainBackupObject['kind']; data: Record<string, unknown> }>;
          };
          if (text(segment.bot) !== entry.globalMetaId) throw new Error('SEGMENT_BOT_MISMATCH');
          for (const obj of segment.objects ?? []) {
            if (!obj?.id || !obj.kind || !obj.data || typeof obj.data !== 'object') {
              throw new Error(`invalid backup object in pin ${ref.pinId}`);
            }
            if (
              objectId({ kind: obj.kind, data: obj.data }) !== obj.id
              && chainBackupObjectId(obj.kind, obj.data) !== obj.id
            ) {
              throw new Error(`object hash mismatch for pin ${ref.pinId}`);
            }
            if (ref.objectIds.length > 0 && !ref.objectIds.includes(obj.id)) {
              throw new Error(`object ${obj.id} is not listed by the manifest`);
            }
            objects.push({ id: obj.id, kind: obj.kind, data: obj.data });
          }
        } catch (error) {
          warnings.push(`segment ${s + 1}/${manifestHit.manifest.segments.length} (${ref.pinId}): ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        emit({
          phase: 'segments',
          botName: entry.name,
          botIndex: i,
          botCount: entries.length,
          segmentsDone: s + 1,
          segmentsTotal: manifestHit.manifest.segments.length,
        });
      }

      if (warnings.length > 0) botResult.warnings = warnings;
      if (objects.length === 0 && warnings.length > 0) {
        throw new Error(warnings[warnings.length - 1] ?? 'ALL_SEGMENTS_FAILED');
      }
      pending.push({
        entry,
        botResult,
        botIndex: i,
        manifestHit,
        objects: selectLatestBackupObjects(materializeBackupObjects(objects)),
        warnings,
      });
    } catch (error) {
      botResult.error = error instanceof Error ? error.message : String(error);
      emit({ phase: 'error', botName: entry.name, botIndex: i, botCount: entries.length, message: botResult.error });
    }
  }

  // Name-conflict pre-pass. A device that ran the welcome flow already holds a
  // placeholder Twin (random pool name), and the user may have created other
  // bots before importing their mnemonic. `restoreMetabotFromMnemonicCore`
  // refuses duplicate names, so a restored Bot whose name collides with a
  // purely-local bot would otherwise fail its whole skeleton (and with it the
  // data import). The incoming name is the user's real on-chain data and wins:
  // the local placeholder is renamed with a " (local)" suffix instead. Bots
  // that belong to the backup set (same globalmetaid) are matched later by id
  // and never renamed here.
  const backupGids = new Set(pending.map((candidate) => candidate.entry.globalMetaId));
  for (const item of pending) {
    try {
      const profile = profileOf(item.objects);
      const incomingName = (typeof profile?.name === 'string' && profile.name.trim())
        || item.entry.name.trim();
      if (!incomingName) continue;
      const lowerIncoming = incomingName.toLowerCase();
      for (const local of metabotStore.listMetabots()) {
        if (backupGids.has((local.globalmetaid ?? '').trim())) continue;
        if (local.name.trim().toLowerCase() !== lowerIncoming) continue;
        let suffix = 2;
        let renamed = `${incomingName} (local)`;
        while (metabotStore.listMetabots().some((m) => m.name.trim().toLowerCase() === renamed.toLowerCase())) {
          renamed = `${incomingName} (local ${suffix})`;
          suffix += 1;
        }
        metabotStore.updateMetabot(local.id, { name: renamed });
        deps.saveDb?.();
      }
    } catch (error) {
      // Best-effort: the skeleton restore below still reports NAME_DUPLICATE
      // plainly if the rename could not go through.
      console.warn('[ChainBackup] restore name-conflict rename failed:', error instanceof Error ? error.message : String(error));
    }
  }

  for (const item of pending) {
    try {
      emit({ phase: 'skeleton', botName: item.entry.name, botIndex: item.botIndex, botCount: entries.length });
      let metabot = metabotStore.listMetabots().find(
        (candidate) => (candidate.globalmetaid ?? '').trim() === item.entry.globalMetaId,
      ) ?? null;
      if (!metabot) {
        const envelope = item.objects.find((obj) => obj.kind === 'key_envelope');
        const mnemonic = typeof envelope?.data.mnemonic === 'string' ? envelope.data.mnemonic : '';
        if (!mnemonic) throw new Error('KEY_ENVELOPE_MISSING');
        const profile = profileOf(item.objects);
        const restored = await restoreMetabotFromMnemonicCore(
          metabotStore,
          {
            mnemonic,
            path: typeof envelope?.data.path === 'string' ? envelope.data.path : undefined,
            boss_global_metaid: nullableString(profile?.boss_global_metaid),
            expectedGlobalMetaId: item.entry.globalMetaId,
            metabotType: 'worker',
            profileOverride: profileOverride(profile, item.entry),
          },
          { applyAssignedSkills: deps.applyAssignedSkills },
        );
        if (!restored.success) throw new Error('error' in restored ? restored.error : 'RESTORE_FAILED');
        metabot = restored.metabot;
        item.botResult.restored = true;
      }
      item.metabot = metabot;
    } catch (error) {
      item.botResult.error = error instanceof Error ? error.message : String(error);
      emit({ phase: 'error', botName: item.entry.name, botIndex: item.botIndex, botCount: entries.length, message: item.botResult.error });
    }
  }

  const metabotIdMap = new Map<number, number>();
  for (const item of pending) {
    if (!item.metabot) continue;
    const sourceId = sourceMetabotId(profileOf(item.objects));
    if (sourceId != null) metabotIdMap.set(sourceId, item.metabot.id);
  }

  for (const item of pending) {
    if (!item.metabot || item.botResult.error) continue;
    try {
      const profile = profileOf(item.objects);
      if (profile) {
        applyBackupProfile(db, metabotStore, item.metabot.id, profile, metabotIdMap);
        if (deps.applyAssignedSkills) {
          deps.applyAssignedSkills(item.metabot.id, stringArray(profile.allow_chat_skills));
        }
      }
      if (!isTwinTarget(item) && item.metabot.metabot_type !== 'welcome') {
        metabotStore.updateMetabot(item.metabot.id, { metabot_type: 'worker' });
      }
      item.metabot = metabotStore.getMetabotById(item.metabot.id) ?? item.metabot;
    } catch (error) {
      item.botResult.error = error instanceof Error ? error.message : String(error);
      emit({ phase: 'error', botName: item.entry.name, botIndex: item.botIndex, botCount: entries.length, message: item.botResult.error });
    }
  }

  // Twin finalization. Every restore-capable device already holds a Twin —
  // the welcome flow creates one before the user can import a mnemonic, and
  // with no Twin at all `ensureTwinExists` inside the skeleton restore
  // promotes the first restored bot. Promoting the backup's Twin onto either
  // of those throws TWIN_ALREADY_EXISTS and used to abort the whole restore.
  // The backup's Twin carries the user's real persona and memories, so it
  // wins: demote the local placeholder Twin(s) and retry the promotion.
  try {
    const twinTarget = pending.find((item) => item.metabot && !item.botResult.error && isTwinTarget(item));
    if (twinTarget?.metabot) {
      try {
        twinTarget.metabot = metabotStore.updateMetabot(twinTarget.metabot.id, { metabot_type: 'twin' }) ?? twinTarget.metabot;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== 'TWIN_ALREADY_EXISTS') throw error;
        metabotStore.demoteOtherTwins(twinTarget.metabot.id);
        twinTarget.metabot = metabotStore.updateMetabot(twinTarget.metabot.id, { metabot_type: 'twin' }) ?? twinTarget.metabot;
      }
    } else {
      metabotStore.ensureTwinExists();
    }
    deps.saveDb?.();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  for (const item of pending) {
    if (!item.metabot || item.botResult.error) continue;
    try {
      emit({ phase: 'import', botName: item.entry.name, botIndex: item.botIndex, botCount: entries.length });
      const { imported, skipped, errors } = importBackupObjects(db, item.metabot.id, item.objects, { metabotIdMap });
      item.botResult.imported = imported;
      item.botResult.skipped = skipped;
      if (errors.length > 0) throw new Error(`IMPORT_FAILED: ${errors.join('; ')}`);
      if (item.warnings.length === 0) {
        rebuildChainBackupStateFromManifest(db, {
          botGlobalMetaId: item.entry.globalMetaId,
          manifestPinId: item.manifestHit.pinId,
          segments: item.manifestHit.manifest.segments,
          manifestUpdatedAt: item.manifestHit.manifest.updatedAt ?? Math.floor(Date.now() / 1000),
        });
      }
      deps.saveDb?.();
    } catch (error) {
      item.botResult.error = error instanceof Error ? error.message : String(error);
      emit({ phase: 'error', botName: item.entry.name, botIndex: item.botIndex, botCount: entries.length, message: item.botResult.error });
    }
  }

  try {
    deps.saveDb?.();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.success = !result.error && result.bots.length > 0 && result.bots.every((bot) => !bot.error);
  emit({ phase: 'done', botCount: entries.length });
  return result;
}
