import { chainBackupObjectId } from './chainBackupCrypto';
import type { SqliteDatabase } from '../sqliteTypes';
import type { Metabot } from '../types/metabot';
import type { ChainBackupObject, ChainBackupImportOptions } from './chainBackupData';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Conversation window: the most recent month of messages rides the backup. */
const CONVERSATION_WINDOW_DAYS = 30;

/**
 * Conversation slimming. Messages are the dominant share of a real backup
 * (measured: >95% of plaintext bytes on an active install), and most of that
 * is machine-generated bulk that is useless on restore: full tool inputs
 * (whole files passed to write/edit, shell scripts), duplicated tool results
 * (metadata.toolResult repeats content verbatim), and inline base64 payloads.
 * Caps keep the human-readable transcript intact while bounding worst-case
 * rows; everything removed here stays in the local DB — only the on-chain
 * copy is slimmed.
 */
const MESSAGE_CONTENT_LIMITS: Record<string, number> = {
  user: 64 * 1024,
  assistant: 64 * 1024,
  tool_use: 8 * 1024,
  tool_result: 8 * 1024,
  system: 8 * 1024,
};
const DEFAULT_MESSAGE_CONTENT_LIMIT = 16 * 1024;
const TOOL_INPUT_LIMIT = 2 * 1024;
/** Matches inline base64 data URIs with a payload of >=512 chars. */
const INLINE_DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{512,}/gi;

function stripInlineBinaryPayloads(value: string): string {
  INLINE_DATA_URI_RE.lastIndex = 0;
  return value.replace(INLINE_DATA_URI_RE, '[binary payload omitted from chain backup]');
}

function capUtf8(value: string, limit: number): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= limit) return value;
  const head = Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8').replace(/\uFFFD+$/, '');
  return `${head}\n\n[chain-backup: truncated, original ${bytes} bytes]`;
}

function slimMessageMetadata(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return raw;
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return stripInlineBinaryPayloads(raw);
  }
  if (!parsed) return stripInlineBinaryPayloads(raw);
  let changed = false;
  if ('toolResult' in parsed) {
    delete parsed.toolResult;
    changed = true;
  }
  if (parsed.toolInput && typeof parsed.toolInput === 'object') {
    const serialized = JSON.stringify(parsed.toolInput);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > TOOL_INPUT_LIMIT) {
      parsed.toolInput = {
        backupTrimmed: true,
        originalBytes: bytes,
        preview: capUtf8(serialized, TOOL_INPUT_LIMIT),
      };
      changed = true;
    }
  }
  return stripInlineBinaryPayloads(changed ? JSON.stringify(parsed) : raw);
}

function slimConversationMessage(row: Record<string, unknown>): Record<string, unknown> {
  const type = typeof row.type === 'string' ? row.type : '';
  const limit = MESSAGE_CONTENT_LIMITS[type] ?? DEFAULT_MESSAGE_CONTENT_LIMIT;
  const content = typeof row.content === 'string' ? row.content : '';
  return {
    ...row,
    content: capUtf8(stripInlineBinaryPayloads(content), limit),
    metadata: slimMessageMetadata(row.metadata),
  };
}

export interface ExtractExtendedBackupOptions {
  bot?: Metabot;
  includeShared?: boolean;
  now?: number;
}

export interface ExtendedImportResult {
  handled: boolean;
  imported: number;
  skipped: number;
}

function queryRows(db: SqliteDatabase, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const out: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      out[column] = row[index];
    });
    return out;
  });
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return queryRows(db, 'SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1', ['table', table]).length > 0;
}

const tableColumnsCache = new WeakMap<SqliteDatabase, Map<string, string[]>>();
function tableColumns(db: SqliteDatabase, table: string): string[] {
  let perDb = tableColumnsCache.get(db);
  if (!perDb) {
    perDb = new Map();
    tableColumnsCache.set(db, perDb);
  }
  let columns = perDb.get(table);
  if (!columns) {
    columns = queryRows(db, `PRAGMA table_xinfo(${table})`)
      .filter((row) => Number(row.hidden ?? 0) === 0)
      .map((row) => String(row.name));
    perDb.set(table, columns);
  }
  return columns;
}

function ensureMetabotSettingsTable(db: SqliteDatabase): void {
  if (tableExists(db, 'metabot_settings')) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS metabot_settings (
      metabot_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (metabot_id, key)
    )
  `);
  tableColumnsCache.get(db)?.delete('metabot_settings');
}

function makeObject(kind: ChainBackupObject['kind'], data: Record<string, unknown>): ChainBackupObject {
  return { id: chainBackupObjectId(kind, data), kind, data };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function avatarFromRow(row: Record<string, unknown>): string | null {
  const blob = row.avatar_blob ?? row.avatar;
  if (blob instanceof Uint8Array && blob.length > 0) {
    return `data:image/png;base64,${Buffer.from(blob).toString('base64')}`;
  }
  return typeof row.avatar === 'string' && row.avatar ? row.avatar : null;
}

const PROFILE_FIELDS = [
  'name',
  'enabled',
  'globalmetaid',
  'metabot_info_pinid',
  'chat_public_key_pin_id',
  'metabot_type',
  'created_by',
  'role',
  'soul',
  'goal',
  'bio',
  'background',
  'boss_id',
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

function extractBotProfile(db: SqliteDatabase, metabotId: number, bot?: Metabot): Record<string, unknown> {
  const raw = queryRows(db, 'SELECT * FROM metabots WHERE id = ? LIMIT 1', [metabotId])[0] ?? {};
  const source = (bot ?? raw) as Record<string, unknown>;
  const profile: Record<string, unknown> = { source_metabot_id: metabotId };
  for (const key of PROFILE_FIELDS) {
    if (key === 'tools' || key === 'skills' || key === 'allow_chat_skills') {
      profile[key] = parseStringArray(source[key]);
    } else if (key === 'enabled') {
      profile[key] = source[key] === undefined ? true : Boolean(source[key]);
    } else if (source[key] !== undefined) {
      profile[key] = source[key];
    }
  }
  profile.avatar = bot ? bot.avatar : avatarFromRow(raw);
  return profile;
}

function rowsForTable(db: SqliteDatabase, table: string, where = '', params: unknown[] = []): Record<string, unknown>[] {
  if (!tableExists(db, table)) return [];
  return queryRows(db, `SELECT * FROM ${table}${where}`, params);
}

function extractExperiences(
  db: SqliteDatabase,
  botGlobalMetaId: string,
  cutoffMs: number,
  requiredEvidenceIds: ReadonlySet<string> = new Set(),
): ChainBackupObject[] {
  const objects: ChainBackupObject[] = [];
  for (const episode of rowsForTable(db, 'metaid_experience_episodes', ' WHERE owner_globalmetaid = ?', [botGlobalMetaId])) {
    const episodeId = episode.id;
    const participants = rowsForTable(db, 'metaid_experience_participants', ' WHERE episode_id = ?', [episodeId]);
    const evidence = rowsForTable(db, 'metaid_experience_evidence', ' WHERE episode_id = ?', [episodeId])
      .filter((row) => Number(row.occurred_at) >= cutoffMs || requiredEvidenceIds.has(String(row.id ?? '')));
    objects.push(makeObject('experience', { ...episode, participants, evidence }));
  }
  return objects;
}

interface ImpressionExtraction {
  objects: ChainBackupObject[];
  requiredEvidenceIds: Set<string>;
}

function extractImpressions(db: SqliteDatabase, botGlobalMetaId: string, cutoffMs: number): ImpressionExtraction {
  const objects: ChainBackupObject[] = [];
  const requiredEvidenceIds = new Set<string>();
  const snapshots = rowsForTable(db, 'metaid_impression_snapshots', ' WHERE observer_globalmetaid = ?', [botGlobalMetaId]);
  const observations = rowsForTable(db, 'metaid_impression_observations', ' WHERE observer_globalmetaid = ?', [botGlobalMetaId]);
  const includedObservationIds = new Set(
    observations
      .filter((observation) => Number(observation.created_at) >= cutoffMs)
      .map((observation) => String(observation.id ?? ''))
      .filter(Boolean),
  );
  for (const snapshot of snapshots) {
    const latestId = String(snapshot.latest_observation_id ?? '');
    if (latestId) includedObservationIds.add(latestId);
  }
  let followedSupersedes = true;
  while (followedSupersedes) {
    followedSupersedes = false;
    for (const observation of observations) {
      const id = String(observation.id ?? '');
      const supersedesId = String(observation.supersedes_observation_id ?? '');
      if (id && supersedesId && includedObservationIds.has(supersedesId) && !includedObservationIds.has(id)) {
        includedObservationIds.add(id);
        followedSupersedes = true;
      }
    }
  }

  for (const observation of observations) {
    const observationId = String(observation.id ?? '');
    if (!includedObservationIds.has(observationId)) continue;
    const evidence = rowsForTable(db, 'metaid_impression_observation_evidence', ' WHERE observation_id = ?', [observation.id]);
    for (const link of evidence) requiredEvidenceIds.add(String(link.evidence_id ?? ''));
    objects.push(makeObject('impression_observation', { ...observation, evidence }));
  }
  for (const snapshot of snapshots) {
    objects.push(makeObject('impression_snapshot', snapshot));
  }
  return { objects, requiredEvidenceIds };
}

function extractSchedules(db: SqliteDatabase, metabotId: number): ChainBackupObject[] {
  return rowsForTable(db, 'scheduled_tasks', ' WHERE metabot_id = ?', [metabotId])
    .map((row) => makeObject('schedule', row));
}

function extractConversations(db: SqliteDatabase, metabotId: number, cutoffMs: number): ChainBackupObject[] {
  if (!tableExists(db, 'cowork_sessions') || !tableExists(db, 'cowork_messages')) return [];
  const sessions = rowsForTable(db, 'cowork_sessions', ' WHERE metabot_id = ? AND updated_at >= ?', [metabotId, cutoffMs]);
  return sessions.flatMap((session) => {
    const messages = rowsForTable(db, 'cowork_messages', ' WHERE session_id = ? AND created_at >= ? ORDER BY created_at ASC, sequence ASC', [session.id, cutoffMs]);
    const mappings = tableExists(db, 'cowork_conversation_mappings')
      ? rowsForTable(
        db,
        'cowork_conversation_mappings',
        " WHERE cowork_session_id = ? AND (channel = 'cowork_ui' OR channel LIKE 'im:%')",
        [session.id],
      )
      : [];
    return [
      makeObject('conversation', { ...session, mappings }),
      ...messages.map((message) => makeObject('conversation_message', slimConversationMessage(message))),
    ];
  });
}

function extractShared(db: SqliteDatabase): ChainBackupObject[] {
  const objects: ChainBackupObject[] = [];
  const globalMetaIdFor = (metabotId: unknown): string => (
    String(queryRows(db, 'SELECT globalmetaid FROM metabots WHERE id = ? LIMIT 1', [metabotId])[0]?.globalmetaid ?? '')
  );
  for (const entry of rowsForTable(db, 'team_culture_entries')) {
    const revisions = rowsForTable(db, 'team_culture_revisions', ' WHERE entry_id = ?', [entry.id]);
    const sources = rowsForTable(db, 'team_culture_sources', ' WHERE entry_id = ?', [entry.id]);
    objects.push(makeObject('culture', { ...entry, revisions, sources }));
  }
  for (const task of rowsForTable(db, 'long_term_tasks', " WHERE stage NOT IN ('done', 'cancelled')")) {
    const subtasks = rowsForTable(db, 'long_term_subtasks', ' WHERE task_id = ?', [task.id]);
    const events = rowsForTable(db, 'long_term_events', ' WHERE task_id = ?', [task.id]);
    objects.push(makeObject('longterm', { ...task, subtasks, events }));
  }
  for (const task of rowsForTable(db, 'orchestration_tasks', " WHERE status NOT IN ('completed', 'failed', 'cancelled')")) {
    const steps = rowsForTable(db, 'orchestration_steps', ' WHERE task_id = ?', [task.id]).map((step) => ({
      ...step,
      assignee_global_metaid: globalMetaIdFor(step.assignee_metabot_id),
      attempts: rowsForTable(db, 'orchestration_attempts', ' WHERE step_id = ?', [step.id]).map((attempt) => ({
        ...attempt,
        worker_global_metaid: globalMetaIdFor(attempt.worker_metabot_id),
      })),
    }));
    objects.push(makeObject('orchestration', {
      ...task,
      twin_global_metaid: globalMetaIdFor(task.twin_metabot_id),
      steps,
    }));
  }
  for (const row of rowsForTable(db, 'cowork_config', " WHERE key = 'memoryHygiene'")) {
    objects.push(makeObject('shared_config', row));
  }
  for (const row of rowsForTable(db, 'kv', " WHERE key = 'skills_scope'")) {
    objects.push(makeObject('skill_scope', row));
  }
  return objects;
}

export function extractExtendedBackupObjects(
  db: SqliteDatabase,
  metabotId: number,
  options: ExtractExtendedBackupOptions = {},
): ChainBackupObject[] {
  const profile = extractBotProfile(db, metabotId, options.bot);
  const botGlobalMetaId = typeof profile.globalmetaid === 'string' ? profile.globalmetaid.trim() : '';
  const cutoffMs = (options.now ?? Date.now()) - CONVERSATION_WINDOW_DAYS * DAY_MS;
  const objects: ChainBackupObject[] = [makeObject('bot_profile', profile)];

  for (const row of rowsForTable(db, 'metabot_settings', ' WHERE metabot_id = ?', [metabotId])) {
    objects.push(makeObject('setting', row));
  }
  for (const row of rowsForTable(db, 'metabot_memory_policies', ' WHERE metabot_id = ?', [metabotId])) {
    objects.push(makeObject('memory_policy', row));
  }
  if (botGlobalMetaId) {
    const impressions = extractImpressions(db, botGlobalMetaId, cutoffMs);
    objects.push(...extractExperiences(db, botGlobalMetaId, cutoffMs, impressions.requiredEvidenceIds));
    objects.push(...impressions.objects);
  }
  objects.push(...extractSchedules(db, metabotId));
  objects.push(...extractConversations(db, metabotId, cutoffMs));
  if (options.includeShared) objects.push(...extractShared(db));
  return objects;
}

export function extendedBackupRowKey(obj: ChainBackupObject): string | null {
  const id = typeof obj.data.id === 'string' && obj.data.id.trim() ? obj.data.id.trim() : null;
  switch (obj.kind) {
    case 'bot_profile': return 'bot_profile';
    case 'setting': return `setting:${String(obj.data.key ?? obj.id)}`;
    case 'memory_policy': return 'memory_policy';
    case 'experience': return id ? `experience:${id}` : `experience@${obj.id}`;
    case 'impression_observation': return id ? `impression_observation:${id}` : `impression_observation@${obj.id}`;
    case 'impression_snapshot': {
      const key = `${String(obj.data.observer_globalmetaid ?? '')}:${String(obj.data.subject_globalmetaid ?? '')}`;
      return `impression_snapshot:${key}`;
    }
    case 'culture': return id ? `culture:${id}` : `culture@${obj.id}`;
    case 'schedule': return id ? `schedule:${id}` : `schedule@${obj.id}`;
    case 'longterm': return id ? `longterm:${id}` : `longterm@${obj.id}`;
    case 'orchestration': return id ? `orchestration:${id}` : `orchestration@${obj.id}`;
    case 'conversation': return id ? `conversation:${id}` : `conversation@${obj.id}`;
    case 'conversation_message': return id ? `conversation_message:${id}` : `conversation_message@${obj.id}`;
    case 'shared_config': return `shared_config:${String(obj.data.key ?? obj.id)}`;
    case 'skill_scope': return 'skill_scope';
    default: return null;
  }
}

function writeRow(
  db: SqliteDatabase,
  table: string,
  input: Record<string, unknown>,
  conflictColumns: string[] = [],
): boolean {
  const columns = tableColumns(db, table);
  const keys = Object.keys(input).filter((key) => input[key] !== undefined && columns.includes(key));
  if (!keys.length) throw new Error(`no writable columns for ${table}`);
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map((key) => input[key] ?? null);
  let sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  if (conflictColumns.length > 0) {
    const updates = keys.filter((key) => !conflictColumns.includes(key));
    sql += updates.length > 0
      ? ` ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${updates.map((key) => `${key} = excluded.${key}`).join(', ')}`
      : ` ON CONFLICT (${conflictColumns.join(', ')}) DO NOTHING`;
  } else {
    sql = sql.replace('INSERT INTO', 'INSERT OR IGNORE INTO');
  }
  db.run(sql, values);
  return typeof db.getRowsModified === 'function' ? db.getRowsModified() > 0 : true;
}

function remapMetabotId(value: unknown, options: ChainBackupImportOptions, fallback: number | null): number | null {
  const source = Number(value);
  if (Number.isInteger(source) && source > 0) {
    return options.metabotIdMap?.get(source) ?? fallback;
  }
  return fallback;
}

export function importExtendedBackupObject(
  db: SqliteDatabase,
  newMetabotId: number,
  obj: ChainBackupObject,
  options: ChainBackupImportOptions = {},
): ExtendedImportResult {
  let imported = 0;
  const count = (written: boolean) => {
    if (written) imported += 1;
  };
  const data = obj.data;

  switch (obj.kind) {
    case 'bot_profile':
      return { handled: true, imported: 0, skipped: 1 };
    case 'setting':
      ensureMetabotSettingsTable(db);
      count(writeRow(db, 'metabot_settings', { ...data, metabot_id: newMetabotId }, ['metabot_id', 'key']));
      break;
    case 'memory_policy':
      count(writeRow(db, 'metabot_memory_policies', { ...data, metabot_id: newMetabotId }, ['metabot_id']));
      break;
    case 'experience': {
      const { participants, evidence, ...episode } = data as Record<string, unknown> & { participants?: unknown[]; evidence?: unknown[] };
      count(writeRow(db, 'metaid_experience_episodes', episode, ['id']));
      for (const raw of Array.isArray(participants) ? participants : []) {
        count(writeRow(db, 'metaid_experience_participants', raw as Record<string, unknown>, ['episode_id', 'participant_key', 'role']));
      }
      for (const raw of Array.isArray(evidence) ? evidence : []) {
        count(writeRow(db, 'metaid_experience_evidence', raw as Record<string, unknown>, ['id']));
      }
      break;
    }
    case 'impression_observation': {
      const { evidence, ...observation } = data as Record<string, unknown> & { evidence?: unknown[] };
      count(writeRow(db, 'metaid_impression_observations', observation, ['id']));
      for (const raw of Array.isArray(evidence) ? evidence : []) {
        count(writeRow(db, 'metaid_impression_observation_evidence', raw as Record<string, unknown>, ['observation_id', 'evidence_id']));
      }
      break;
    }
    case 'impression_snapshot':
      count(writeRow(db, 'metaid_impression_snapshots', data, ['observer_globalmetaid', 'subject_globalmetaid']));
      break;
    case 'culture': {
      const { revisions, sources, ...entry } = data as Record<string, unknown> & { revisions?: unknown[]; sources?: unknown[] };
      count(writeRow(db, 'team_culture_entries', entry, ['id']));
      for (const raw of Array.isArray(revisions) ? revisions : []) {
        count(writeRow(db, 'team_culture_revisions', raw as Record<string, unknown>, ['id']));
      }
      for (const raw of Array.isArray(sources) ? sources : []) {
        count(writeRow(db, 'team_culture_sources', raw as Record<string, unknown>, ['id']));
      }
      break;
    }
    case 'schedule':
      count(writeRow(db, 'scheduled_tasks', { ...data, metabot_id: newMetabotId, running_at_ms: null }, ['id']));
      break;
    case 'longterm': {
      const { subtasks, events, ...task } = data as Record<string, unknown> & { subtasks?: unknown[]; events?: unknown[] };
      count(writeRow(db, 'long_term_tasks', task, ['id']));
      for (const raw of Array.isArray(subtasks) ? subtasks : []) {
        count(writeRow(db, 'long_term_subtasks', raw as Record<string, unknown>, ['id']));
      }
      for (const raw of Array.isArray(events) ? events : []) {
        count(writeRow(db, 'long_term_events', raw as Record<string, unknown>, ['id']));
      }
      break;
    }
    case 'orchestration': {
      const { steps, ...task } = data as Record<string, unknown> & { steps?: unknown[] };
      count(writeRow(db, 'orchestration_tasks', {
        ...task,
        twin_metabot_id: remapMetabotId(task.twin_metabot_id, options, newMetabotId),
      }, ['id']));
      for (const rawStep of Array.isArray(steps) ? steps : []) {
        const { attempts, ...step } = rawStep as Record<string, unknown> & { attempts?: unknown[] };
        count(writeRow(db, 'orchestration_steps', {
          ...step,
          assignee_metabot_id: step.assignee_metabot_id == null
            ? null
            : remapMetabotId(step.assignee_metabot_id, options, null),
          active_attempt_id: null,
        }, ['id']));
        for (const rawAttempt of Array.isArray(attempts) ? attempts : []) {
          const attempt = rawAttempt as Record<string, unknown>;
          const workerId = remapMetabotId(attempt.worker_metabot_id, options, null);
          if (workerId == null) continue;
          count(writeRow(db, 'orchestration_attempts', { ...attempt, worker_metabot_id: workerId }, ['id']));
        }
      }
      break;
    }
    case 'conversation': {
      const { messages, mappings, ...session } = data as Record<string, unknown> & { messages?: unknown[]; mappings?: unknown[] };
      count(writeRow(db, 'cowork_sessions', {
        ...session,
        metabot_id: newMetabotId,
        claude_session_id: null,
        status: 'idle',
      }, ['id']));
      for (const raw of Array.isArray(messages) ? messages : []) {
        count(writeRow(db, 'cowork_messages', raw as Record<string, unknown>, ['id']));
      }
      for (const raw of Array.isArray(mappings) ? mappings : []) {
        const mapping = raw as Record<string, unknown>;
        count(writeRow(db, 'cowork_conversation_mappings', {
          ...mapping,
          metabot_id: remapMetabotId(mapping.metabot_id, options, newMetabotId),
        }, ['channel', 'external_conversation_id', 'metabot_id']));
      }
      break;
    }
    case 'conversation_message':
      count(writeRow(db, 'cowork_messages', data, ['id']));
      break;
    case 'shared_config':
      count(writeRow(db, 'cowork_config', data, ['key']));
      break;
    case 'skill_scope':
      count(writeRow(db, 'kv', data, ['key']));
      break;
    default:
      return { handled: false, imported: 0, skipped: 0 };
  }
  return { handled: true, imported, skipped: imported === 0 ? 1 : 0 };
}
