/**
 * Memory gateway route logic — pure functions, no Electron, no I/O.
 *
 * These helpers back the two HTTP routes registered in metaidRpcServer.ts:
 *   POST /api/idbots/memory/list    (SDD R4.1 — read `user_memories`)
 *   POST /api/idbots/memory/create  (SDD R4.1 — write `user_memories`)
 *
 * Keeping the handlers here (instead of inline in the big route chain) makes
 * the validation and mapping rules unit-testable under plain `node` without
 * booting Electron or binding a port. The route chain only parses the raw
 * body string, delegates here, and writes back `{ status, body }`.
 *
 * Field naming follows the MemoryBackend contract (memoryBackend.ts): requests
 * use snake_case (gateway JSON convention), responses map to the camelCase
 * `MemoryUserMemory` shape as returned by the backend.
 */

import type { MemoryBackend, MemoryUserMemory } from '../memory/memoryBackend';
import {
  OWNER_SCOPE_KEY,
  type MemoryOrigin,
  type MemoryScopeKind,
  type MemoryUsageClass,
  type MemoryVisibility,
} from '../memory/memoryScope';

export type MemoryGatewayRouteResult = {
  status: number;
  body: Record<string, unknown>;
};

const MEMORY_SCOPE_KINDS: ReadonlySet<string> = new Set(['owner', 'contact', 'conversation']);
const MEMORY_LIST_STATUSES: ReadonlySet<string> = new Set(['created', 'stale', 'deleted', 'all']);
const MEMORY_USAGE_CLASSES: ReadonlySet<string> = new Set([
  'profile_fact',
  'preference',
  'operational_preference',
  'self_identity',
  'work_review',
  'value_boundary',
]);
const MEMORY_VISIBILITIES: ReadonlySet<string> = new Set(['local_only', 'external_safe']);
const MEMORY_ORIGINS: ReadonlySet<string> = new Set(['conversation', 'dream']);
const MEMORY_SOURCE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool', 'system']);

const MAX_LIST_LIMIT = 200;

function jsonError(status: number, error: string): MemoryGatewayRouteResult {
  return { status, body: { success: false, error } };
}

function jsonOk(body: Record<string, unknown>): MemoryGatewayRouteResult {
  return { status: 200, body: { success: true, ...body } };
}

function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeRequiredMetabotId(value: unknown): number | null {
  const metabotId = Number(value);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    return null;
  }
  return metabotId;
}

/**
 * Normalize the optional `scope` body field ({ kind, key? }) into the
 * `scopeKind`/`scopeKey` pair the MemoryBackend selector expects.
 *
 * - No scope -> no fields (the backend defaults to the owner scope).
 * - `kind: 'owner'` without a key -> explicit `owner:self`.
 * - `contact`/`conversation` without a key -> error (a peer/conversation
 *   scope key is the identity anchor and cannot be guessed).
 */
function normalizeMemoryScopeInput(
  value: unknown,
): { scopeKind: MemoryScopeKind; scopeKey: string } | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('scope must be an object with kind and optional key');
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
  if (!kind) {
    if (typeof record.key === 'string' && record.key.trim()) {
      throw new Error('scope.kind is required when scope.key is provided');
    }
    return null;
  }
  if (!MEMORY_SCOPE_KINDS.has(kind)) {
    throw new Error('scope.kind must be one of owner, contact, conversation');
  }
  const key = typeof record.key === 'string' ? record.key.trim() : '';
  if (kind === 'owner') {
    return { scopeKind: 'owner', scopeKey: key || OWNER_SCOPE_KEY };
  }
  if (!key) {
    throw new Error('scope.key is required for contact/conversation scopes');
  }
  return { scopeKind: kind as MemoryScopeKind, scopeKey: key };
}

function normalizeOptionalUsageClass(value: unknown): MemoryUsageClass | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const usageClass = String(value).trim();
  if (!MEMORY_USAGE_CLASSES.has(usageClass)) {
    throw new Error(
      'usage_class must be one of profile_fact, preference, operational_preference, self_identity, work_review, value_boundary',
    );
  }
  return usageClass as MemoryUsageClass;
}

function normalizeOptionalVisibility(value: unknown): MemoryVisibility | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const visibility = String(value).trim();
  if (!MEMORY_VISIBILITIES.has(visibility)) {
    throw new Error('visibility must be one of local_only, external_safe');
  }
  return visibility as MemoryVisibility;
}

function normalizeOptionalOrigin(value: unknown): MemoryOrigin | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const origin = String(value).trim();
  if (!MEMORY_ORIGINS.has(origin)) {
    throw new Error('origin must be one of conversation, dream');
  }
  return origin as MemoryOrigin;
}

function normalizeOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return number;
}

function normalizeOptionalStatus(value: unknown): 'created' | 'stale' | 'deleted' | 'all' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const status = String(value).trim();
  if (!MEMORY_LIST_STATUSES.has(status)) {
    throw new Error('status must be one of created, stale, deleted, all');
  }
  return status as 'created' | 'stale' | 'deleted' | 'all';
}

/** Pick known string fields from the optional `source` provenance object. */
function normalizeMemorySourceInput(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('source must be an object');
  }
  const record = value as Record<string, unknown>;
  const source: Record<string, string> = {};
  const stringField = (key: string, target: string): void => {
    const raw = record[key];
    if (typeof raw === 'string' && raw.trim()) {
      source[target] = raw.trim();
    }
  };
  stringField('session_id', 'sessionId');
  stringField('message_id', 'messageId');
  stringField('source_channel', 'sourceChannel');
  stringField('source_type', 'sourceType');
  stringField('external_conversation_id', 'externalConversationId');
  stringField('source_id', 'sourceId');
  stringField('dream_date', 'dreamDate');
  const role = record.role;
  if (role !== undefined && role !== null) {
    const roleValue = String(role).trim();
    if (!MEMORY_SOURCE_ROLES.has(roleValue)) {
      throw new Error('source.role must be one of user, assistant, tool, system');
    }
    source.role = roleValue;
  }
  return Object.keys(source).length > 0 ? source : undefined;
}

/**
 * POST /api/idbots/memory/list
 * Body: { metabot_id: number, scope?: { kind, key? }, status?: 'created'|'stale'|'deleted'|'all',
 *         usage_class?: string, query?: string, limit?: number, offset?: number }
 * Success: { success: true, memories: MemoryUserMemory[] } (camelCase, R4.1).
 */
export function handleMemoryListRoute(
  getMemoryBackend: () => MemoryBackend,
  rawBody: string,
): MemoryGatewayRouteResult {
  const parsed = parseJsonBody(rawBody);
  if (!parsed) {
    return jsonError(400, 'Invalid JSON body');
  }

  const metabotId = normalizeRequiredMetabotId(parsed.metabot_id);
  if (metabotId === null) {
    return jsonError(400, 'metabot_id is required');
  }

  let scope: { scopeKind: MemoryScopeKind; scopeKey: string } | null;
  try {
    scope = normalizeMemoryScopeInput(parsed.scope);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  let status: 'created' | 'stale' | 'deleted' | 'all' | undefined;
  let usageClass: MemoryUsageClass | undefined;
  let limit: number | undefined;
  let offset: number | undefined;
  try {
    status = normalizeOptionalStatus(parsed.status);
    usageClass = normalizeOptionalUsageClass(parsed.usage_class);
    limit = normalizeOptionalPositiveInt(parsed.limit, 'limit');
    offset = normalizeOptionalPositiveInt(parsed.offset, 'offset');
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const memories = getMemoryBackend().listUserMemories({
      metabotId,
      ...(scope ?? {}),
      status,
      usageClass,
      query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : undefined,
      limit: limit !== undefined ? Math.min(limit, MAX_LIST_LIMIT) : undefined,
      offset,
    });
    return jsonOk({ memories: memories as MemoryUserMemory[] });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

/**
 * POST /api/idbots/memory/create
 * Body: { metabot_id: number, text: string, scope?: { kind, key? },
 *         usage_class?: string, visibility?: 'local_only'|'external_safe',
 *         is_explicit?: boolean, origin?: 'conversation'|'dream', source?: {...} }
 * Success: { success: true, memory: MemoryUserMemory } (camelCase, R4.1).
 */
export function handleMemoryCreateRoute(
  getMemoryBackend: () => MemoryBackend,
  rawBody: string,
): MemoryGatewayRouteResult {
  const parsed = parseJsonBody(rawBody);
  if (!parsed) {
    return jsonError(400, 'Invalid JSON body');
  }

  const metabotId = normalizeRequiredMetabotId(parsed.metabot_id);
  if (metabotId === null) {
    return jsonError(400, 'metabot_id is required');
  }

  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!text) {
    return jsonError(400, 'text is required');
  }

  let scope: { scopeKind: MemoryScopeKind; scopeKey: string } | null;
  let usageClass: MemoryUsageClass | undefined;
  let visibility: MemoryVisibility | undefined;
  let origin: MemoryOrigin | undefined;
  let source: Record<string, string> | undefined;
  try {
    scope = normalizeMemoryScopeInput(parsed.scope);
    usageClass = normalizeOptionalUsageClass(parsed.usage_class);
    visibility = normalizeOptionalVisibility(parsed.visibility);
    origin = normalizeOptionalOrigin(parsed.origin);
    source = normalizeMemorySourceInput(parsed.source);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const memory = getMemoryBackend().createUserMemory({
      metabotId,
      text,
      ...(scope ?? {}),
      usageClass,
      visibility,
      isExplicit: parsed.is_explicit === true,
      origin,
      source,
    });
    return jsonOk({ memory: memory as MemoryUserMemory });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}
