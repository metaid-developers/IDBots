const DELIVERY_PREFIX = '[DELIVERY]';

export function buildDeliveryMessage(payload) {
  return `${DELIVERY_PREFIX} ${JSON.stringify(payload ?? {})}`;
}

export function buildRefundRequestPayload(input) {
  return {
    version: '1.0.0',
    paymentTxid: input.paymentTxid,
    servicePinId: input.servicePinId ?? null,
    serviceName: input.serviceName,
    refundAmount: input.refundAmount,
    refundCurrency: input.refundCurrency,
    refundToAddress: input.refundToAddress,
    buyerGlobalMetaId: input.buyerGlobalMetaId,
    sellerGlobalMetaId: input.sellerGlobalMetaId,
    orderMessagePinId: input.orderMessagePinId ?? null,
    failureReason: input.failureReason,
    failureDetectedAt: input.failureDetectedAt,
    reasonComment: input.reasonComment ?? '服务超时',
    evidencePinIds: Array.isArray(input.evidencePinIds) ? input.evidencePinIds : [],
  };
}

export function buildRefundFinalizePayload(input) {
  return {
    version: '1.0.0',
    refundRequestPinId: input.refundRequestPinId,
    paymentTxid: input.paymentTxid,
    servicePinId: input.servicePinId ?? null,
    refundTxid: input.refundTxid,
    refundAmount: input.refundAmount,
    refundCurrency: input.refundCurrency,
    buyerGlobalMetaId: input.buyerGlobalMetaId,
    sellerGlobalMetaId: input.sellerGlobalMetaId,
    comment: input.comment ?? '',
  };
}

export function parseRefundRequestPayload(content) {
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const payload = parsed;
  if (typeof payload.paymentTxid !== 'string') {
    return null;
  }

  return payload;
}

export function parseRefundFinalizePayload(content) {
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const payload = parsed;
  if (
    typeof payload.refundRequestPinId !== 'string' ||
    typeof payload.refundTxid !== 'string' ||
    typeof payload.paymentTxid !== 'string'
  ) {
    return null;
  }

  return payload;
}

export function parseDeliveryMessage(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed.toUpperCase().startsWith(DELIVERY_PREFIX)) {
    return null;
  }

  const jsonText = trimmed.slice(DELIVERY_PREFIX.length).trim();
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
