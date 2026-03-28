export type MemoryScopeKind = 'owner' | 'contact' | 'conversation';
export type MemoryUsageClass = 'profile_fact' | 'preference' | 'operational_preference';
export type MemoryVisibility = 'local_only' | 'external_safe';

export interface MemoryScope {
  kind: MemoryScopeKind;
  key: string;
}

export interface MemoryScopeSelectorInputLike {
  scope?: MemoryScope | null;
  scopeKind?: MemoryScopeKind | null;
  scopeKey?: string | null;
}

export const OWNER_SCOPE_KEY = 'owner:self';

function normalizeScopePart(value?: string | null): string {
  return String(value ?? '').trim();
}

export function normalizeScopeChannel(channel?: string | null): string {
  return normalizeScopePart(channel).replace(/\s+/g, '_').toLowerCase();
}

export function normalizeScopeIdentity(value?: string | null): string {
  // Preserve caller-provided casing because some upstream IDs may be case-sensitive.
  return normalizeScopePart(value);
}

export function createOwnerMemoryScope(): MemoryScope {
  return {
    kind: 'owner',
    key: OWNER_SCOPE_KEY,
  };
}

export function buildContactScopeKey(input: {
  sourceChannel?: string | null;
  peerGlobalMetaId?: string | null;
}): string | null {
  const channel = normalizeScopeChannel(input.sourceChannel);
  const peerGlobalMetaId = normalizeScopeIdentity(input.peerGlobalMetaId);
  if (!channel || !peerGlobalMetaId) {
    return null;
  }
  return `${channel}:peer:${peerGlobalMetaId}`;
}

export function createContactMemoryScope(input: {
  sourceChannel?: string | null;
  peerGlobalMetaId?: string | null;
}): MemoryScope | null {
  const key = buildContactScopeKey(input);
  if (!key) {
    return null;
  }
  return {
    kind: 'contact',
    key,
  };
}

export function buildConversationScopeKey(input: {
  sourceChannel?: string | null;
  externalConversationId?: string | null;
}): string | null {
  const channel = normalizeScopeChannel(input.sourceChannel);
  const externalConversationId = normalizeScopeIdentity(input.externalConversationId);
  if (!channel || !externalConversationId) {
    return null;
  }
  return `${channel}:conversation:${externalConversationId}`;
}

export function createConversationMemoryScope(input: {
  sourceChannel?: string | null;
  externalConversationId?: string | null;
}): MemoryScope | null {
  const key = buildConversationScopeKey(input);
  if (!key) {
    return null;
  }
  return {
    kind: 'conversation',
    key,
  };
}

export function normalizeMemoryScopeSelector(input: MemoryScopeSelectorInputLike): MemoryScope | null {
  const scope = input.scope ?? null;
  const scopeKind = input.scopeKind ?? null;
  const scopeKey = normalizeScopeIdentity(input.scopeKey);

  if (scope) {
    const normalizedScope: MemoryScope = {
      kind: scope.kind,
      key: normalizeScopeIdentity(scope.key),
    };
    if (scopeKind && scopeKind !== normalizedScope.kind) {
      throw new Error('Conflicting memory scope selector kind');
    }
    if (scopeKey && scopeKey !== normalizedScope.key) {
      throw new Error('Conflicting memory scope selector key');
    }
    return normalizedScope;
  }

  if (!scopeKind && !scopeKey) {
    return null;
  }
  if (!scopeKind || !scopeKey) {
    throw new Error('Both scopeKind and scopeKey are required when scope is omitted');
  }

  return {
    kind: scopeKind,
    key: scopeKey,
  };
}
