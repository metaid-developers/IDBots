import {
  createContactMemoryScope,
  createConversationMemoryScope,
  createOwnerMemoryScope,
  normalizeScopeChannel,
  type MemoryScope,
} from './memoryScope';

export interface ResolveMemoryScopesInput {
  metabotId?: number | null;
  sourceChannel?: string | null;
  externalConversationId?: string | null;
  peerGlobalMetaId?: string | null;
  sessionType?: 'standard' | 'a2a' | string | null;
}

export interface ResolvedMemoryScopes {
  writeScope: MemoryScope;
  readScopes: MemoryScope[];
  ownerReadPolicy: 'none' | 'operational_preference_only' | 'all';
  resolutionReason: 'owner_default' | 'contact_direct' | 'conversation_fallback';
}

const GROUP_OR_SHARED_CHANNEL_HINTS = ['group', 'order', 'shared', 'orchestrator'];
const DIRECT_EXTERNAL_CHANNELS = new Set(['metaweb_private']);

function isGroupOrSharedChannel(sourceChannel: string): boolean {
  return GROUP_OR_SHARED_CHANNEL_HINTS.some((hint) => sourceChannel.includes(hint));
}

function hasValidMetabotId(metabotId?: number | null): boolean {
  return typeof metabotId === 'number' && Number.isFinite(metabotId) && metabotId > 0;
}

function isDirectExternalSession(
  sourceChannel: string,
  groupOrShared: boolean
): boolean {
  if (groupOrShared) {
    return false;
  }
  return DIRECT_EXTERNAL_CHANNELS.has(sourceChannel);
}

function withOwnerOperationalPreferences(writeScope: MemoryScope): ResolvedMemoryScopes {
  return {
    writeScope,
    readScopes: [writeScope],
    ownerReadPolicy: 'operational_preference_only',
    resolutionReason: writeScope.kind === 'contact' ? 'contact_direct' : 'conversation_fallback',
  };
}

function ownerOnlyResolution(): ResolvedMemoryScopes {
  const ownerScope = createOwnerMemoryScope();
  return {
    writeScope: ownerScope,
    readScopes: [ownerScope],
    ownerReadPolicy: 'all',
    resolutionReason: 'owner_default',
  };
}

export function resolveMemoryScopes(input: ResolveMemoryScopesInput): ResolvedMemoryScopes {
  const sourceChannel = normalizeScopeChannel(input.sourceChannel);
  if (!hasValidMetabotId(input.metabotId)) {
    return ownerOnlyResolution();
  }
  if (!sourceChannel || sourceChannel === 'cowork_ui') {
    return ownerOnlyResolution();
  }

  const groupOrShared = isGroupOrSharedChannel(sourceChannel);

  if (isDirectExternalSession(sourceChannel, groupOrShared)) {
    const contactScope = createContactMemoryScope({
      sourceChannel,
      peerGlobalMetaId: input.peerGlobalMetaId,
    });
    if (contactScope) {
      return withOwnerOperationalPreferences(contactScope);
    }
  }

  const conversationScope = createConversationMemoryScope({
    sourceChannel,
    externalConversationId: input.externalConversationId,
  });
  if (conversationScope) {
    return withOwnerOperationalPreferences(conversationScope);
  }

  return ownerOnlyResolution();
}
