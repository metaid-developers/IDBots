import path from 'node:path';

export interface SessionTraceSessionInput {
  id: string;
  title?: string | null;
  type?: string | null;
  metabotId?: number | null;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  externalConversationId?: string | null;
}

export interface SessionTraceOrderInput {
  id?: string | null;
  role?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  paymentTxid?: string | null;
  paymentCurrency?: string | null;
  paymentAmount?: string | null;
}

export interface BuildSessionTraceInput {
  traceId: string;
  channel: string;
  exportRoot: string;
  createdAt?: number;
  session: SessionTraceSessionInput;
  order?: SessionTraceOrderInput | null;
}

export interface SessionTraceArtifacts {
  transcriptMarkdownPath: string;
  traceMarkdownPath: string;
  traceJsonPath: string;
}

export interface SessionTraceRecord {
  traceId: string;
  channel: string;
  createdAt: number;
  session: {
    id: string;
    title: string | null;
    type: string | null;
    metabotId: number | null;
    peerGlobalMetaId: string | null;
    peerName: string | null;
    externalConversationId: string | null;
  };
  order: {
    id: string | null;
    role: string | null;
    serviceId: string | null;
    serviceName: string | null;
    paymentTxid: string | null;
    paymentCurrency: string | null;
    paymentAmount: string | null;
  } | null;
  artifacts: SessionTraceArtifacts;
}

export type ServiceOrderObserverRole = 'buyer' | 'seller';

export interface BuildServiceOrderObserverConversationIdInput {
  role: ServiceOrderObserverRole;
  metabotId: number;
  peerGlobalMetaId: string;
  paymentTxid?: string | null;
}

export interface BuildServiceOrderFallbackPayloadInput {
  servicePaidTx?: string | null;
  servicePrice?: string | null;
  serviceCurrency?: string | null;
  serviceId?: string | null;
  serviceSkill?: string | null;
  peerGlobalMetaId?: string | null;
}

export interface ServiceOrderEventMessageInput {
  role: ServiceOrderObserverRole;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizePathSegment(value: string, fallback: string): string {
  const normalized = normalizeText(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalized || fallback;
}

export function buildServiceOrderObserverConversationId(
  input: BuildServiceOrderObserverConversationIdInput
): string {
  const txidPart = normalizeText(input.paymentTxid).slice(0, 16) || 'pending';
  return `metaweb_order:${input.role}:${input.metabotId}:${normalizeText(input.peerGlobalMetaId)}:${txidPart}`;
}

export function buildServiceOrderFallbackPayload(
  input: BuildServiceOrderFallbackPayloadInput
): string {
  const txid = normalizeText(input.servicePaidTx);
  const lines = [
    '[ORDER] Restored service order context.',
    input.servicePrice || input.serviceCurrency
      ? `支付金额 ${normalizeText(input.servicePrice) || '0'} ${normalizeText(input.serviceCurrency) || 'SPACE'}`
      : '',
    txid ? `txid: ${txid}` : 'txid: pending',
    normalizeText(input.serviceId) ? `service id: ${normalizeText(input.serviceId)}` : '',
    normalizeText(input.serviceSkill) ? `skill name: ${normalizeText(input.serviceSkill)}` : '',
    normalizeText(input.peerGlobalMetaId)
      ? `peer globalmetaid: ${normalizeText(input.peerGlobalMetaId)}`
      : '',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildServiceOrderEventMessage(
  type: 'refund_requested' | 'refunded',
  order: ServiceOrderEventMessageInput
): string {
  if (type === 'refund_requested') {
    if (order.role === 'seller') {
      const pinId = order.refundRequestPinId ? ` 申请凭证：${order.refundRequestPinId}` : '';
      return `系统提示：买家已发起全额退款申请，请人工处理。${pinId}`.trim();
    }
    const pinId = order.refundRequestPinId ? ` 申请凭证：${order.refundRequestPinId}` : '';
    return `系统提示：服务订单已超时，已自动发起全额退款申请。${pinId}`.trim();
  }

  const refundTxid = order.refundTxid ? ` 退款 txid：${order.refundTxid}` : '';
  return `系统提示：退款已处理完成。${refundTxid}`.trim();
}

export function buildSessionTrace(input: BuildSessionTraceInput): SessionTraceRecord {
  const traceId = normalizeText(input.traceId);
  const exportRoot = normalizeText(input.exportRoot);
  const sessionId = normalizeText(input.session.id);
  if (!traceId) {
    throw new Error('Trace ID is required');
  }
  if (!exportRoot) {
    throw new Error('Export root is required');
  }
  if (!sessionId) {
    throw new Error('Session ID is required');
  }

  const safeTraceId = sanitizePathSegment(traceId, 'trace');
  const safeSessionId = sanitizePathSegment(sessionId, 'session');
  const transcriptMarkdownPath = path.join(exportRoot, 'chats', `${safeSessionId}.md`);
  const traceMarkdownPath = path.join(exportRoot, 'traces', `${safeTraceId}.md`);
  const traceJsonPath = path.join(exportRoot, 'traces', `${safeTraceId}.json`);

  return {
    traceId,
    channel: normalizeText(input.channel),
    createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : Date.now(),
    session: {
      id: sessionId,
      title: normalizeText(input.session.title) || null,
      type: normalizeText(input.session.type) || null,
      metabotId: Number.isFinite(input.session.metabotId)
        ? Number(input.session.metabotId)
        : null,
      peerGlobalMetaId: normalizeText(input.session.peerGlobalMetaId) || null,
      peerName: normalizeText(input.session.peerName) || null,
      externalConversationId: normalizeText(input.session.externalConversationId) || null,
    },
    order: input.order
      ? {
          id: normalizeText(input.order.id) || null,
          role: normalizeText(input.order.role) || null,
          serviceId: normalizeText(input.order.serviceId) || null,
          serviceName: normalizeText(input.order.serviceName) || null,
          paymentTxid: normalizeText(input.order.paymentTxid) || null,
          paymentCurrency: normalizeText(input.order.paymentCurrency) || null,
          paymentAmount: normalizeText(input.order.paymentAmount) || null,
        }
      : null,
    artifacts: {
      transcriptMarkdownPath,
      traceMarkdownPath,
      traceJsonPath,
    },
  };
}
