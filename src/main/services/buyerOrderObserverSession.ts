import type { CoworkMessage, CoworkStore } from '../coworkStore';
import {
  buildServiceOrderObserverConversationId,
  ensureServiceOrderObserverSession,
} from './serviceOrderObserverSession';

export interface EnsureBuyerOrderObserverSessionInput {
  metabotId: number;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
  serviceId?: string | null;
  servicePrice?: string | null;
  serviceCurrency?: string | null;
  servicePaymentChain?: string | null;
  serviceSettlementKind?: string | null;
  serviceMrc20Ticker?: string | null;
  serviceMrc20Id?: string | null;
  servicePaymentCommitTxid?: string | null;
  serviceSkill?: string | null;
  serviceOutputType?: string | null;
  serverBotGlobalMetaId?: string | null;
  servicePaidTx?: string | null;
  orderTxid?: string | null;
  orderMessagePinId?: string | null;
  orderMessageTxid?: string | null;
  orderMessageTxids?: string[] | null;
  orderPayload?: string | null;
}

export interface EnsureBuyerOrderObserverSessionResult {
  created: boolean;
  coworkSessionId: string;
  externalConversationId: string;
  initialMessage: CoworkMessage | null;
}

export interface ReindexBuyerOrderObserverSessionByOrderTxidInput {
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
  orderTxid: string;
  currentExternalConversationId?: string | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTxid(value: unknown): string {
  const normalized = normalizeText(value).toLowerCase();
  return /^[0-9a-f]{64}$/i.test(normalized) ? normalized : normalizeText(value);
}

function parseMetadataJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function buildBuyerOrderObserverConversationId(input: {
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
  orderTxid?: string | null;
}): string {
  return buildServiceOrderObserverConversationId({
    role: 'buyer',
    metabotId: input.metabotId,
    peerGlobalMetaId: input.peerGlobalMetaId,
    paymentTxid: input.paymentTxid,
    orderTxid: input.orderTxid,
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
    servicePaymentChain: input.servicePaymentChain,
    serviceSettlementKind: input.serviceSettlementKind,
    serviceMrc20Ticker: input.serviceMrc20Ticker,
    serviceMrc20Id: input.serviceMrc20Id,
    servicePaymentCommitTxid: input.servicePaymentCommitTxid,
    serviceSkill: input.serviceSkill,
    serviceOutputType: input.serviceOutputType,
    serverBotGlobalMetaId: input.serverBotGlobalMetaId,
    servicePaidTx: input.servicePaidTx,
    orderTxid: input.orderTxid || input.orderMessageTxid,
    orderMessagePinId: input.orderMessagePinId,
    orderMessageTxid: input.orderMessageTxid,
    orderMessageTxids: input.orderMessageTxids,
    orderPayload: input.orderPayload,
  });

  return {
    created: result.created,
    coworkSessionId: result.coworkSessionId,
    externalConversationId: result.externalConversationId,
    initialMessage: result.initialMessage as CoworkMessage | null,
  };
}

export function reindexBuyerOrderObserverSessionByOrderTxid(
  coworkStore: CoworkStore,
  input: ReindexBuyerOrderObserverSessionByOrderTxidInput
): string {
  const orderTxid = normalizeTxid(input.orderTxid);
  const nextExternalConversationId = buildBuyerOrderObserverConversationId({
    metabotId: input.metabotId,
    peerGlobalMetaId: input.peerGlobalMetaId,
    paymentTxid: input.paymentTxid,
    orderTxid,
  });
  if (!orderTxid) {
    return normalizeText(input.currentExternalConversationId) || nextExternalConversationId;
  }

  const paymentExternalConversationId = buildBuyerOrderObserverConversationId({
    metabotId: input.metabotId,
    peerGlobalMetaId: input.peerGlobalMetaId,
    paymentTxid: input.paymentTxid,
  });
  const candidateExternalConversationIds = Array.from(new Set([
    normalizeText(input.currentExternalConversationId),
    paymentExternalConversationId,
    nextExternalConversationId,
  ].filter(Boolean)));

  let sourceMapping: ReturnType<CoworkStore['getConversationMapping']> | null = null;
  let sourceExternalConversationId: string | null = null;
  for (const candidate of candidateExternalConversationIds) {
    const mapping = coworkStore.getConversationMapping('metaweb_order', candidate, input.metabotId);
    if (mapping) {
      sourceMapping = mapping;
      sourceExternalConversationId = candidate;
      break;
    }
  }
  if (!sourceMapping) {
    return nextExternalConversationId;
  }

  const metadata = parseMetadataJson(sourceMapping.metadataJson);
  coworkStore.upsertConversationMapping({
    channel: 'metaweb_order',
    externalConversationId: nextExternalConversationId,
    metabotId: input.metabotId,
    coworkSessionId: sourceMapping.coworkSessionId,
    metadataJson: JSON.stringify({
      ...metadata,
      orderTxid,
    }),
  });

  if (sourceExternalConversationId && sourceExternalConversationId !== nextExternalConversationId) {
    coworkStore.deleteConversationMapping('metaweb_order', sourceExternalConversationId, input.metabotId);
  }

  return nextExternalConversationId;
}
