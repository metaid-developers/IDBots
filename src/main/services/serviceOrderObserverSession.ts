import type { CoworkMessage, CoworkStore } from '../coworkStore';
import { generateSessionTitle } from '../libs/coworkUtil';

export type ServiceOrderObserverRole = 'buyer' | 'seller';

export interface EnsureServiceOrderObserverSessionInput {
  role: ServiceOrderObserverRole;
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
  orderPayload?: string | null;
  recoveryNotice?: string | null;
}

export interface EnsureServiceOrderObserverSessionResult {
  created: boolean;
  recreated: boolean;
  coworkSessionId: string;
  externalConversationId: string;
  initialMessage: CoworkMessage | null;
  recoveryMessage: CoworkMessage | null;
}

export interface ServiceOrderObserverMetadata {
  role: ServiceOrderObserverRole;
  peerGlobalMetaId: string;
  peerName: string | null;
  peerAvatar: string | null;
  serviceId: string | null;
  servicePrice: string | null;
  serviceCurrency: string | null;
  servicePaymentChain: string | null;
  serviceSettlementKind: string | null;
  serviceMrc20Ticker: string | null;
  serviceMrc20Id: string | null;
  servicePaymentCommitTxid: string | null;
  serviceSkill: string | null;
  serviceOutputType: string | null;
  serverBotGlobalMetaId: string | null;
  servicePaidTx: string | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getOrderMessageDirection(role: ServiceOrderObserverRole): 'incoming' | 'outgoing' {
  return role === 'seller' ? 'incoming' : 'outgoing';
}

export function buildServiceOrderObserverConversationId(input: {
  role: ServiceOrderObserverRole;
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
}): string {
  const txidPart = normalizeText(input.paymentTxid).slice(0, 16) || 'pending';
  return `metaweb_order:${input.role}:${input.metabotId}:${normalizeText(input.peerGlobalMetaId)}:${txidPart}`;
}

export function buildServiceOrderFallbackPayload(input: {
  servicePaidTx?: string | null;
  servicePrice?: string | null;
  serviceCurrency?: string | null;
  servicePaymentChain?: string | null;
  serviceSettlementKind?: string | null;
  serviceMrc20Ticker?: string | null;
  serviceMrc20Id?: string | null;
  servicePaymentCommitTxid?: string | null;
  serviceId?: string | null;
  serviceSkill?: string | null;
  serviceOutputType?: string | null;
  peerGlobalMetaId?: string | null;
}): string {
  const txid = normalizeText(input.servicePaidTx);
  const lines = [
    '[ORDER] Restored service order context.',
    input.servicePrice || input.serviceCurrency
      ? `支付金额 ${normalizeText(input.servicePrice) || '0'} ${normalizeText(input.serviceCurrency) || 'SPACE'}`
      : '',
    txid ? `txid: ${txid}` : 'txid: pending',
    normalizeText(input.servicePaymentCommitTxid) ? `commit txid: ${normalizeText(input.servicePaymentCommitTxid)}` : '',
    normalizeText(input.servicePaymentChain) ? `payment chain: ${normalizeText(input.servicePaymentChain)}` : '',
    normalizeText(input.serviceSettlementKind) ? `settlement kind: ${normalizeText(input.serviceSettlementKind)}` : '',
    normalizeText(input.serviceMrc20Ticker) ? `mrc20 ticker: ${normalizeText(input.serviceMrc20Ticker)}` : '',
    normalizeText(input.serviceMrc20Id) ? `mrc20 id: ${normalizeText(input.serviceMrc20Id)}` : '',
    normalizeText(input.serviceId) ? `service id: ${normalizeText(input.serviceId)}` : '',
    normalizeText(input.serviceSkill) ? `skill name: ${normalizeText(input.serviceSkill)}` : '',
    normalizeText(input.serviceOutputType) ? `output type: ${normalizeText(input.serviceOutputType)}` : '',
    normalizeText(input.peerGlobalMetaId) ? `peer globalmetaid: ${normalizeText(input.peerGlobalMetaId)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildServiceOrderObserverMetadata(
  input: EnsureServiceOrderObserverSessionInput
): ServiceOrderObserverMetadata {
  return {
    role: input.role,
    peerGlobalMetaId: normalizeText(input.peerGlobalMetaId),
    peerName: normalizeText(input.peerName) || null,
    peerAvatar: normalizeText(input.peerAvatar) || null,
    serviceId: normalizeText(input.serviceId) || null,
    servicePrice: normalizeText(input.servicePrice) || null,
    serviceCurrency: normalizeText(input.serviceCurrency) || null,
    servicePaymentChain: normalizeText(input.servicePaymentChain) || null,
    serviceSettlementKind: normalizeText(input.serviceSettlementKind) || null,
    serviceMrc20Ticker: normalizeText(input.serviceMrc20Ticker) || null,
    serviceMrc20Id: normalizeText(input.serviceMrc20Id) || null,
    servicePaymentCommitTxid: normalizeText(input.servicePaymentCommitTxid) || null,
    serviceSkill: normalizeText(input.serviceSkill) || null,
    serviceOutputType: normalizeText(input.serviceOutputType) || null,
    serverBotGlobalMetaId: normalizeText(input.serverBotGlobalMetaId) || null,
    servicePaidTx: normalizeText(input.servicePaidTx) || null,
  };
}

export async function ensureServiceOrderObserverSession(
  coworkStore: CoworkStore,
  input: EnsureServiceOrderObserverSessionInput
): Promise<EnsureServiceOrderObserverSessionResult> {
  const externalConversationId = buildServiceOrderObserverConversationId({
    role: input.role,
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
        recreated: false,
        coworkSessionId: existing.coworkSessionId,
        externalConversationId,
        initialMessage: null,
        recoveryMessage: null,
      };
    }
    coworkStore.deleteConversationMapping('metaweb_order', externalConversationId, input.metabotId);
  }

  const config = coworkStore.getConfig();
  const workspaceRoot = normalizeText(config.workingDirectory) || process.cwd();
  const orderPayload = normalizeText(input.orderPayload) || buildServiceOrderFallbackPayload({
    servicePaidTx: input.servicePaidTx,
    servicePrice: input.servicePrice,
    serviceCurrency: input.serviceCurrency,
    servicePaymentChain: input.servicePaymentChain,
    serviceSettlementKind: input.serviceSettlementKind,
    serviceMrc20Ticker: input.serviceMrc20Ticker,
    serviceMrc20Id: input.serviceMrc20Id,
    servicePaymentCommitTxid: input.servicePaymentCommitTxid,
    serviceId: input.serviceId,
    serviceSkill: input.serviceSkill,
    serviceOutputType: input.serviceOutputType,
    peerGlobalMetaId: input.peerGlobalMetaId,
  });
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
    normalizeText(input.peerAvatar) || null,
  );

  coworkStore.upsertConversationMapping({
    channel: 'metaweb_order',
    externalConversationId,
    metabotId: input.metabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify(buildServiceOrderObserverMetadata(input)),
  });

  const initialMessage = coworkStore.addMessage(session.id, {
    type: 'user',
    content: orderPayload,
    metadata: {
      sourceChannel: 'metaweb_order',
      externalConversationId,
      direction: getOrderMessageDirection(input.role),
      txid: normalizeText(input.servicePaidTx) || undefined,
      paymentTxid: normalizeText(input.servicePaidTx) || undefined,
    },
  });

  let recoveryMessage: CoworkMessage | null = null;
  const recoveryNotice = normalizeText(input.recoveryNotice);
  if (recoveryNotice) {
    recoveryMessage = coworkStore.addMessage(session.id, {
      type: 'system',
      content: recoveryNotice,
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId,
        refreshSessionSummary: true,
      },
    });
  }

  return {
    created: true,
    recreated: Boolean(existing),
    coworkSessionId: session.id,
    externalConversationId,
    initialMessage,
    recoveryMessage,
  };
}
