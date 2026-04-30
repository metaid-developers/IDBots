import type { CoworkMessage, CoworkStore } from '../coworkStore';
import { generateSessionTitle } from '../libs/coworkUtil';
import { buildA2AChainMetadata, normalizeA2AChainTxid } from './a2aChainMetadata';
import {
  buildCanonicalPrivateConversationExternalConversationId,
  buildOrderProtocolDisplayMetadata,
} from './simplemsgPeerConversation';

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
  orderTxid?: string | null;
  orderMessagePinId?: string | null;
  orderMessageTxid?: string | null;
  orderMessageTxids?: string[] | null;
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
  orderTxid: string | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getOrderMessageDirection(role: ServiceOrderObserverRole): 'incoming' | 'outgoing' {
  return role === 'seller' ? 'incoming' : 'outgoing';
}

function getMessageTxids(message: CoworkMessage): Set<string> {
  const txids = new Set<string>();
  const metadata = message.metadata ?? {};
  const txid = normalizeA2AChainTxid(metadata.txid);
  if (txid) txids.add(txid);
  if (Array.isArray(metadata.txids)) {
    for (const item of metadata.txids) {
      const normalized = normalizeA2AChainTxid(item);
      if (normalized) txids.add(normalized);
    }
  }
  return txids;
}

function hasMessageWithChainIdentity(
  messages: CoworkMessage[],
  chainMetadata: ReturnType<typeof buildA2AChainMetadata>
): boolean {
  const pinId = normalizeText(chainMetadata.pinId);
  const txidSet = new Set<string>();
  const txid = normalizeA2AChainTxid(chainMetadata.txid);
  if (txid) txidSet.add(txid);
  if (Array.isArray(chainMetadata.txids)) {
    for (const item of chainMetadata.txids) {
      const normalized = normalizeA2AChainTxid(item);
      if (normalized) txidSet.add(normalized);
    }
  }
  if (!pinId && txidSet.size === 0) return false;

  return messages.some((message) => {
    const metadata = message.metadata ?? {};
    if (pinId && normalizeText(metadata.pinId) === pinId) return true;
    if (txidSet.size === 0) return false;
    const messageTxids = getMessageTxids(message);
    for (const candidate of txidSet) {
      if (messageTxids.has(candidate)) return true;
    }
    return false;
  });
}

async function ensureCanonicalPeerSession(
  coworkStore: CoworkStore,
  input: EnsureServiceOrderObserverSessionInput,
  firstMessage: string
): Promise<{ created: boolean; coworkSessionId: string; externalConversationId: string }> {
  const peerGlobalMetaId = normalizeText(input.peerGlobalMetaId) || 'unknown-peer';
  const externalConversationId = buildCanonicalPrivateConversationExternalConversationId(peerGlobalMetaId);
  const existing = coworkStore.getConversationMapping('metaweb_private', externalConversationId, input.metabotId);
  if (existing) {
    const session = coworkStore.getSession(existing.coworkSessionId);
    if (session) {
      const repaired = coworkStore.ensureCanonicalPeerSessionShape({
        sessionId: existing.coworkSessionId,
        metabotId: input.metabotId,
        peerGlobalMetaId,
        peerName: normalizeText(input.peerName) || null,
        peerAvatar: normalizeText(input.peerAvatar) || null,
      });
      if (repaired) {
        coworkStore.touchConversationMapping('metaweb_private', externalConversationId, input.metabotId);
        return { created: false, coworkSessionId: existing.coworkSessionId, externalConversationId };
      }
      coworkStore.deleteConversationMapping('metaweb_private', externalConversationId, input.metabotId);
    } else {
      coworkStore.deleteConversationMapping('metaweb_private', externalConversationId, input.metabotId);
    }
  }

  const config = coworkStore.getConfig();
  const workspaceRoot = normalizeText(config.workingDirectory) || process.cwd();
  const fallbackTitle = normalizeText(input.peerName)
    || firstMessage.split('\n')[0].slice(0, 50)
    || `Private-${peerGlobalMetaId.slice(0, 12)}`;
  const generatedTitle = await generateSessionTitle(firstMessage || fallbackTitle).catch(() => null);
  const sessionTitle = generatedTitle?.trim() || fallbackTitle;
  const session = coworkStore.createSession(
    sessionTitle,
    workspaceRoot,
    '',
    'local',
    [],
    input.metabotId,
    'a2a',
    peerGlobalMetaId,
    normalizeText(input.peerName) || null,
    normalizeText(input.peerAvatar) || null,
  );

  coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: input.metabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      peerGlobalMetaId,
      peerName: normalizeText(input.peerName) || null,
      peerAvatar: normalizeText(input.peerAvatar) || null,
    }),
  });

  return { created: true, coworkSessionId: session.id, externalConversationId };
}

export function buildServiceOrderObserverConversationId(input: {
  role: ServiceOrderObserverRole;
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
  orderTxid?: string | null;
}): string {
  const txidPart = (
    normalizeText(input.orderTxid)
    || normalizeText(input.paymentTxid)
  ).slice(0, 16) || 'pending';
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
    orderTxid: normalizeText(input.orderTxid) || normalizeText(input.orderMessageTxid) || null,
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
    orderTxid: input.orderTxid || input.orderMessageTxid,
  });
  let existing = coworkStore.getConversationMapping('metaweb_order', externalConversationId, input.metabotId);
  if (existing) {
    const existingSession = coworkStore.getSession(existing.coworkSessionId);
    if (!existingSession) {
      coworkStore.deleteConversationMapping('metaweb_order', externalConversationId, input.metabotId);
      existing = null;
    }
  }

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

  const canonicalSession = await ensureCanonicalPeerSession(coworkStore, input, orderPayload);
  const existingWasCanonical = existing?.coworkSessionId === canonicalSession.coworkSessionId;

  coworkStore.upsertConversationMapping({
    channel: 'metaweb_order',
    externalConversationId,
    metabotId: input.metabotId,
    coworkSessionId: canonicalSession.coworkSessionId,
    metadataJson: JSON.stringify(buildServiceOrderObserverMetadata(input)),
  });

  const chainMetadata = buildA2AChainMetadata({
    txId: input.orderMessageTxid,
    txids: input.orderMessageTxids,
    pinId: input.orderMessagePinId,
  });
  const canonicalStoreSession = coworkStore.getSession(canonicalSession.coworkSessionId);
  const shouldAddInitialMessage = !hasMessageWithChainIdentity(
    canonicalStoreSession?.messages ?? [],
    chainMetadata,
  ) && !existingWasCanonical;
  const orderTxid = normalizeText(input.orderTxid)
    || normalizeA2AChainTxid(input.orderMessageTxid)
    || normalizeA2AChainTxid(chainMetadata.txid)
    || null;
  const initialMessage = shouldAddInitialMessage
    ? coworkStore.addMessage(canonicalSession.coworkSessionId, {
      type: 'user',
      content: orderPayload,
      metadata: {
        ...buildOrderProtocolDisplayMetadata({
          peerGlobalMetaId: input.peerGlobalMetaId,
          direction: getOrderMessageDirection(input.role),
          tag: 'ORDER',
          orderTxid,
          orderRole: input.role,
          paymentTxid: input.servicePaidTx,
          orderMappingExternalConversationId: externalConversationId,
        }),
        ...chainMetadata,
      },
    })
    : null;

  let recoveryMessage: CoworkMessage | null = null;
  const recoveryNotice = normalizeText(input.recoveryNotice);
  if (recoveryNotice) {
    recoveryMessage = coworkStore.addMessage(canonicalSession.coworkSessionId, {
      type: 'system',
      content: recoveryNotice,
      metadata: {
        sourceChannel: 'metaweb_private',
        externalConversationId: canonicalSession.externalConversationId,
        orderMappingExternalConversationId: externalConversationId,
        refreshSessionSummary: true,
      },
    });
  }

  return {
    created: canonicalSession.created,
    recreated: Boolean(existing),
    coworkSessionId: canonicalSession.coworkSessionId,
    externalConversationId,
    initialMessage,
    recoveryMessage,
  };
}
