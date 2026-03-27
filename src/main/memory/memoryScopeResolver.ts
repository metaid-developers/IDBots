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
  allowOwnerOperationalPreferences: boolean;
  resolutionReason: 'owner_default' | 'contact_direct' | 'conversation_fallback';
}

const GROUP_OR_SHARED_CHANNEL_HINTS = ['group', 'order', 'shared', 'orchestrator'];

function isGroupOrSharedChannel(sourceChannel: string): boolean {
  return GROUP_OR_SHARED_CHANNEL_HINTS.some((hint) => sourceChannel.includes(hint));
}

function withOwnerOperationalPreferences(writeScope: MemoryScope): ResolvedMemoryScopes {
  return {
    writeScope,
    readScopes: [writeScope, createOwnerMemoryScope()],
    allowOwnerOperationalPreferences: true,
    resolutionReason: writeScope.kind === 'contact' ? 'contact_direct' : 'conversation_fallback',
  };
}

function ownerOnlyResolution(): ResolvedMemoryScopes {
  const ownerScope = createOwnerMemoryScope();
  return {
    writeScope: ownerScope,
    readScopes: [ownerScope],
    allowOwnerOperationalPreferences: false,
    resolutionReason: 'owner_default',
  };
}

export function resolveMemoryScopes(input: ResolveMemoryScopesInput): ResolvedMemoryScopes {
  const sourceChannel = normalizeScopeChannel(input.sourceChannel);
  if (!sourceChannel || sourceChannel === 'cowork_ui') {
    return ownerOnlyResolution();
  }

  const groupOrShared = isGroupOrSharedChannel(sourceChannel);

  if (!groupOrShared) {
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
