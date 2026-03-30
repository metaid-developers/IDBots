import type { CoworkMessage, CoworkStore } from '../coworkStore';
import { generateSessionTitle } from '../libs/coworkUtil';

export interface EnsureBuyerOrderObserverSessionInput {
  metabotId: number;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
  serviceId?: string | null;
  servicePrice?: string | null;
  serviceCurrency?: string | null;
  serviceSkill?: string | null;
  serverBotGlobalMetaId?: string | null;
  servicePaidTx?: string | null;
  orderPayload?: string | null;
}

export interface EnsureBuyerOrderObserverSessionResult {
  created: boolean;
  coworkSessionId: string;
  externalConversationId: string;
  initialMessage: CoworkMessage | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildBuyerOrderObserverConversationId(input: {
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
}): string {
  const txidPart = normalizeText(input.paymentTxid).slice(0, 16) || 'pending';
  return `metaweb_order:buyer:${input.metabotId}:${normalizeText(input.peerGlobalMetaId)}:${txidPart}`;
}

export async function ensureBuyerOrderObserverSession(
  coworkStore: CoworkStore,
  input: EnsureBuyerOrderObserverSessionInput
): Promise<EnsureBuyerOrderObserverSessionResult> {
  const externalConversationId = buildBuyerOrderObserverConversationId({
    metabotId: input.metabotId,
    peerGlobalMetaId: input.peerGlobalMetaId,
    paymentTxid: input.servicePaidTx,
  });
  const existing = coworkStore.getConversationMapping('metaweb_order', externalConversationId, input.metabotId);
  if (existing) {
    const existingSession = coworkStore.getSession(existing.coworkSessionId);
    if (existingSession) {
      return {
        created: false,
        coworkSessionId: existing.coworkSessionId,
        externalConversationId,
        initialMessage: null,
      };
    }
    coworkStore.deleteConversationMapping('metaweb_order', externalConversationId, input.metabotId);
  }

  const config = coworkStore.getConfig();
  const workspaceRoot = normalizeText(config.workingDirectory) || process.cwd();
  const orderPayload = normalizeText(input.orderPayload);
  const fallbackTitle = orderPayload.split('\n')[0].slice(0, 50)
    || `Order-${(normalizeText(input.peerName) || normalizeText(input.peerGlobalMetaId)).slice(0, 20)}`;
  const generatedTitle = await generateSessionTitle(
    orderPayload || normalizeText(input.serviceSkill) || normalizeText(input.serviceId) || fallbackTitle
  ).catch(() => null);
  const sessionTitle = generatedTitle?.trim() || fallbackTitle;

  const session = coworkStore.createSession(
    sessionTitle,
    workspaceRoot,
    '',
    'local',
    [],
    input.metabotId,
    'a2a',
    normalizeText(input.peerGlobalMetaId) || null,
    normalizeText(input.peerName) || null,
    normalizeText(input.peerAvatar) || null
  );

  coworkStore.upsertConversationMapping({
    channel: 'metaweb_order',
    externalConversationId,
    metabotId: input.metabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      role: 'buyer',
      peerGlobalMetaId: normalizeText(input.peerGlobalMetaId),
      peerName: normalizeText(input.peerName) || null,
      peerAvatar: normalizeText(input.peerAvatar) || null,
      serviceId: normalizeText(input.serviceId) || null,
      servicePrice: normalizeText(input.servicePrice) || null,
      serviceCurrency: normalizeText(input.serviceCurrency) || null,
      serviceSkill: normalizeText(input.serviceSkill) || null,
      serverBotGlobalMetaId: normalizeText(input.serverBotGlobalMetaId) || null,
      servicePaidTx: normalizeText(input.servicePaidTx) || null,
    }),
  });

  let initialMessage: CoworkMessage | null = null;
  if (orderPayload) {
    initialMessage = coworkStore.addMessage(session.id, {
      type: 'user',
      content: orderPayload,
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        direction: 'outgoing',
      },
    });
  }

  return {
    created: true,
    coworkSessionId: session.id,
    externalConversationId,
    initialMessage,
  };
}
