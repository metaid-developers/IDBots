import type {
  CoworkMessageMetadata,
  CoworkSession,
  CoworkStore,
} from '../coworkStore';
import type { Metabot } from '../types/metabot';
import { buildCanonicalPrivateConversationExternalConversationId } from './simplemsgPeerConversation';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import { normalizeGlobalMetaID } from '../shared/globalMetaId';
/** Keep context segmentation aligned with the runtime's definition of a new A2A conversation round. */
export const A2A_SESSION_CONVERSATION_GAP_MS = 5 * 60 * 1000;

export interface CoworkA2ASessionInput {
  actorId?: unknown;
  localMetabotId?: unknown;
  peerGlobalMetaId?: unknown;
  peerName?: unknown;
  peerAvatar?: unknown;
}

export interface NormalizedCoworkA2ASessionInput {
  localMetabotId: number;
  peerGlobalMetaId: string;
  peerName: string | null;
  peerAvatar: string | null;
}

export interface EnsureCoworkA2ASessionParams {
  coworkStore: CoworkStore;
  getMetabotById: (metabotId: number) => Pick<Metabot, 'id' | 'name' | 'globalmetaid'> | null;
  input: CoworkA2ASessionInput;
  /** Runtime-causal parent: the chat session that triggered this A2A session, when one exists. */
  parentSessionId?: string | null;
}

export interface EnsureCoworkA2ASessionResult {
  created: boolean;
  externalConversationId: string;
  session: CoworkSession;
}

function parseMappingMetadata(value: string | null | undefined): CoworkMessageMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CoworkMessageMetadata
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseLocalMetabotActorId(actorId: unknown): number | null {
  const match = /^idbots-metabot-(\d+)$/.exec(text(actorId));
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const textValue = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!/^[1-9]\d*$/.test(textValue)) return null;
  const parsed = Number.parseInt(textValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeCoworkA2ASessionInput(
  input: CoworkA2ASessionInput,
): NormalizedCoworkA2ASessionInput {
  const localMetabotId = parseLocalMetabotActorId(input.actorId)
    ?? normalizePositiveInteger(input.localMetabotId);
  if (!localMetabotId) {
    throw new Error('A valid local Bot actor is required');
  }

  const peerGlobalMetaId = normalizeGlobalMetaID(input.peerGlobalMetaId);
  if (!peerGlobalMetaId) {
    throw new Error('A valid peer GlobalMetaID is required');
  }

  return {
    localMetabotId,
    peerGlobalMetaId,
    peerName: text(input.peerName) || null,
    peerAvatar: text(input.peerAvatar) || null,
  };
}

export function ensureCoworkA2ASession(
  params: EnsureCoworkA2ASessionParams,
): EnsureCoworkA2ASessionResult {
  const normalized = normalizeCoworkA2ASessionInput(params.input);
  const localMetabot = params.getMetabotById(normalized.localMetabotId);
  if (!localMetabot) {
    throw new Error('Local Bot not found');
  }

  const localGlobalMetaId = normalizeGlobalMetaID(localMetabot.globalmetaid);
  if (!localGlobalMetaId) {
    throw new Error('Local Bot GlobalMetaID is missing');
  }
  if (localGlobalMetaId === normalized.peerGlobalMetaId) {
    throw new Error('A Bot cannot open an A2A session with itself');
  }

  const externalConversationId = buildCanonicalPrivateConversationExternalConversationId(
    normalized.peerGlobalMetaId,
  );
  const existing = params.coworkStore.getConversationMapping(
    'metaweb_private',
    externalConversationId,
    normalized.localMetabotId,
  );
  if (existing) {
    const session = params.coworkStore.getSessionWithoutMessages(existing.coworkSessionId);
    if (session) {
      const repaired = params.coworkStore.ensureCanonicalPeerSessionShape({
        sessionId: existing.coworkSessionId,
        metabotId: normalized.localMetabotId,
        peerGlobalMetaId: normalized.peerGlobalMetaId,
        peerName: normalized.peerName,
        peerAvatar: normalized.peerAvatar,
      });
      if (repaired) {
        const repairedSession = params.coworkStore.getSessionWithoutMessages(existing.coworkSessionId) ?? session;
        const existingMetadata = parseMappingMetadata(existing.metadataJson);
        params.coworkStore.registerA2AEpisode({
          sessionId: repairedSession.id,
          localMetabotId: normalized.localMetabotId,
          localGlobalMetaId,
          peerGlobalMetaId: normalized.peerGlobalMetaId,
          episodeIndex: positiveInteger(existingMetadata.episodeIndex, 1),
          previousSessionId: typeof existingMetadata.previousEpisodeSessionId === 'string'
            ? existingMetadata.previousEpisodeSessionId
            : null,
          startedAt: positiveInteger(existingMetadata.episodeStartedAt, repairedSession.createdAt),
        });
        if (params.coworkStore.isSessionArchived(repairedSession.id)) {
          params.coworkStore.unarchiveSession(repairedSession.id);
        }
        params.coworkStore.touchConversationMapping(
          'metaweb_private',
          externalConversationId,
          normalized.localMetabotId,
        );
        return {
          created: false,
          externalConversationId,
          session: params.coworkStore.getSessionView(existing.coworkSessionId) ?? repairedSession,
        };
      }
    }
    params.coworkStore.deleteConversationMapping(
      'metaweb_private',
      externalConversationId,
      normalized.localMetabotId,
    );
  }

  const config = params.coworkStore.getConfig();
  const workspaceRoot = resolveSessionWorkingDirectory(
    text(config.workingDirectory) || process.cwd(),
    normalized.localMetabotId,
  );
  const title = normalized.peerName || `Private-${normalized.peerGlobalMetaId.slice(0, 12)}`;
  const session = params.coworkStore.createSession(
    title,
    workspaceRoot,
    '',
    config.executionMode || 'local',
    [],
    normalized.localMetabotId,
    'a2a',
    normalized.peerGlobalMetaId,
    normalized.peerName,
    normalized.peerAvatar,
    'default',
    null,
    null,
    null,
    null,
    null,
    params.parentSessionId ?? null,
  );

  params.coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: normalized.localMetabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      peerGlobalMetaId: normalized.peerGlobalMetaId,
      peerName: normalized.peerName,
      peerAvatar: normalized.peerAvatar,
      source: 'bot_browser',
      a2aConversationId: externalConversationId,
      episodeIndex: 1,
      episodeStartedAt: session.createdAt,
    }),
  });
  const registeredEpisode = params.coworkStore.registerA2AEpisode({
    sessionId: session.id,
    localMetabotId: normalized.localMetabotId,
    localGlobalMetaId,
    peerGlobalMetaId: normalized.peerGlobalMetaId,
    episodeIndex: 1,
    startedAt: session.createdAt,
  });
  params.coworkStore.updateConversationMappingMetadata(
    'metaweb_private',
    externalConversationId,
    normalized.localMetabotId,
    {
      peerGlobalMetaId: normalized.peerGlobalMetaId,
      peerName: normalized.peerName,
      peerAvatar: normalized.peerAvatar,
      source: 'bot_browser',
      a2aConversationId: externalConversationId,
      a2aThreadId: registeredEpisode.threadId,
      episodeIndex: 1,
      episodeStartedAt: session.createdAt,
    },
  );
  params.coworkStore.updateConversationMappingMetadata('cowork_ui', session.id, normalized.localMetabotId, {
    a2aConversationId: externalConversationId,
    a2aThreadId: registeredEpisode.threadId,
    episodeIndex: 1,
    episodeStartedAt: session.createdAt,
    peerGlobalMetaId: normalized.peerGlobalMetaId,
  });

  return {
    created: true,
    externalConversationId,
    session: params.coworkStore.getSessionView(session.id) ?? session,
  };
}
