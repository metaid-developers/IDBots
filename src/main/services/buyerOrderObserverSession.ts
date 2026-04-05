import type { CoworkMessage, CoworkStore } from '../coworkStore';
import { buildSharedServiceOrderObserverConversationId } from '../shared/metabotChatBridge';
import { ensureServiceOrderObserverSession } from './serviceOrderObserverSession';

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

export function buildBuyerOrderObserverConversationId(input: {
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
}): string {
  return buildSharedServiceOrderObserverConversationId({
    role: 'buyer',
    metabotId: input.metabotId,
    peerGlobalMetaId: input.peerGlobalMetaId,
    paymentTxid: input.paymentTxid,
  });
}

export async function ensureBuyerOrderObserverSession(
  coworkStore: CoworkStore,
  input: EnsureBuyerOrderObserverSessionInput
): Promise<EnsureBuyerOrderObserverSessionResult> {
  const result = await ensureServiceOrderObserverSession(coworkStore, {
    role: 'buyer',
    metabotId: input.metabotId,
    peerGlobalMetaId: input.peerGlobalMetaId,
    peerName: input.peerName,
    peerAvatar: input.peerAvatar,
    serviceId: input.serviceId,
    servicePrice: input.servicePrice,
    serviceCurrency: input.serviceCurrency,
    serviceSkill: input.serviceSkill,
    serverBotGlobalMetaId: input.serverBotGlobalMetaId,
    servicePaidTx: input.servicePaidTx,
    orderPayload: input.orderPayload,
  });

  return {
    created: result.created,
    coworkSessionId: result.coworkSessionId,
    externalConversationId: result.externalConversationId,
    initialMessage: result.initialMessage as CoworkMessage | null,
  };
}
