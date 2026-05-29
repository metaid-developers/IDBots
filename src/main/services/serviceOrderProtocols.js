const ORDER_STATUS_TAG = 'ORDER_STATUS';
const DELIVERY_TAG = 'DELIVERY';
const NEEDS_RATING_TAG = 'NeedsRating';
const ORDER_END_TAG = 'ORDER_END';
const ORDER_TXID_RE = /^[0-9a-f]{64}$/i;
const ORDER_TAG_RE = /^\[([A-Za-z_]+)(?::([0-9a-fA-F]{64})(?:\s+([A-Za-z0-9_-]+))?)?\]/;
const ORDER_PIN_LINE_RE = /^\s*order\s+pin\s+id\s*[:：=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{5,127})\s*$/im;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+/;
const EXCLUDED_RESULT_SECTION_RE = /(服务订单确认|订单确认|order confirmation|payment confirmation|payment details|交易信息|付款信息|支付信息)/i;
const RESULT_METADATA_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(支付金额|交易ID|交易Id|txid|service id|服务ID|技能名称|skill name|payment(?: amount)?|transaction id|service name)\s*[:：]/i;
const INTRO_CHATTER_RE = /(你好|您好|我是|数字主分身|收到你的服务订单|成功处理了你的服务订单|已经成功处理|链上远端服务)/i;
const CLOSING_CHATTER_RE = /(?:服务已完成|感谢.*使用|如有其他需求|欢迎随时联系|欢迎再次使用|希望.*体验|欢迎.*评价|欢迎.*反馈|期待.*再次)/i;

export function normalizeOrderProtocolTxid(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ORDER_TXID_RE.test(normalized) ? normalized : '';
}

function buildOrderProtocolPrefix(tag, orderTxid) {
  const normalizedTxid = normalizeOrderProtocolTxid(orderTxid);
  return normalizedTxid ? `[${tag}:${normalizedTxid}]` : `[${tag}]`;
}

function normalizeOrderProtocolPinId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOrderPinIdArg(value) {
  if (typeof value === 'string') return normalizeOrderProtocolPinId(value);
  if (value && typeof value === 'object') {
    return normalizeOrderProtocolPinId(value.orderPinId)
      || normalizeOrderProtocolPinId(value.serviceOrderPinId);
  }
  return '';
}

function extractOrderProtocolPinId(content) {
  const match = String(content || '').match(ORDER_PIN_LINE_RE);
  return typeof match?.[1] === 'string' ? match[1].trim() : '';
}

function stripOrderProtocolPinLine(content) {
  return String(content || '')
    .split(/\r?\n/)
    .filter((line) => !ORDER_PIN_LINE_RE.test(line))
    .join('\n')
    .trim();
}

function appendOrderProtocolPinLine(content, orderPinId) {
  const text = stripOrderProtocolPinLine(content);
  const normalizedOrderPinId = normalizeOrderProtocolPinId(orderPinId);
  if (!normalizedOrderPinId) return text;
  return [text, `order pin id: ${normalizedOrderPinId}`].filter(Boolean).join('\n');
}

function parseOrderProtocolTag(content) {
  const trimmed = String(content || '').trim();
  const match = trimmed.match(ORDER_TAG_RE);
  if (!match) {
    const legacyOrderEndMatch = trimmed.match(/^\[(ORDER_END)(?:\s+([A-Za-z0-9_-]+))?\]/i);
    if (!legacyOrderEndMatch) return null;
    const rest = trimmed.slice(legacyOrderEndMatch[0].length).trim();
    return {
      tag: legacyOrderEndMatch[1],
      orderTxid: '',
      reason: String(legacyOrderEndMatch[2] || '').trim(),
      orderPinId: extractOrderProtocolPinId(rest),
      rest: stripOrderProtocolPinLine(rest),
    };
  }
  const rest = trimmed.slice(match[0].length).trim();
  return {
    tag: String(match[1] || ''),
    orderTxid: normalizeOrderProtocolTxid(match[2]),
    reason: String(match[3] || '').trim(),
    orderPinId: extractOrderProtocolPinId(rest),
    rest: stripOrderProtocolPinLine(rest),
  };
}

export function buildOrderStatusMessage(orderTxid, content, orderPinId) {
  const text = appendOrderProtocolPinLine(content, resolveOrderPinIdArg(orderPinId));
  return `${buildOrderProtocolPrefix(ORDER_STATUS_TAG, orderTxid)}${text ? ` ${text}` : ''}`;
}

export function parseOrderStatusMessage(content) {
  const parsed = parseOrderProtocolTag(content);
  if (!parsed || parsed.tag.toUpperCase() !== ORDER_STATUS_TAG) return null;
  return {
    orderTxid: parsed.orderTxid || undefined,
    orderPinId: parsed.orderPinId || undefined,
    content: parsed.rest,
  };
}

export function buildNeedsRatingMessage(orderTxid, content, orderPinId) {
  const text = appendOrderProtocolPinLine(content, resolveOrderPinIdArg(orderPinId));
  return `${buildOrderProtocolPrefix(NEEDS_RATING_TAG, orderTxid)}${text ? ` ${text}` : ''}`;
}

export function parseNeedsRatingMessage(content) {
  const parsed = parseOrderProtocolTag(content);
  if (!parsed || parsed.tag.toUpperCase() !== NEEDS_RATING_TAG.toUpperCase()) return null;
  return {
    orderTxid: parsed.orderTxid || undefined,
    orderPinId: parsed.orderPinId || undefined,
    content: parsed.rest,
  };
}

export function buildOrderEndMessage(orderTxid, reason = '', content = '', orderPinId = '') {
  const normalizedTxid = normalizeOrderProtocolTxid(orderTxid);
  const normalizedReason = String(reason || '').trim().replace(/\s+/g, '_');
  const tagSuffix = [
    normalizedTxid ? `:${normalizedTxid}` : '',
    normalizedReason ? ` ${normalizedReason}` : '',
  ].join('');
  const text = appendOrderProtocolPinLine(content, resolveOrderPinIdArg(orderPinId));
  return `[${ORDER_END_TAG}${tagSuffix}]${text ? ` ${text}` : ''}`;
}

export function parseOrderEndMessage(content) {
  const parsed = parseOrderProtocolTag(content);
  if (!parsed || parsed.tag.toUpperCase() !== ORDER_END_TAG) return null;
  return {
    orderTxid: parsed.orderTxid || undefined,
    orderPinId: parsed.orderPinId || undefined,
    reason: parsed.reason || '',
    content: parsed.rest,
  };
}

export function parseOrderScopedProtocolMessage(content) {
  return parseOrderStatusMessage(content)
    || parseDeliveryMessage(content)
    || parseNeedsRatingMessage(content)
    || parseOrderEndMessage(content);
}

export function buildDeliveryMessage(payload, orderTxid) {
  return `${buildOrderProtocolPrefix(DELIVERY_TAG, orderTxid)} ${JSON.stringify(payload ?? {})}`;
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function compactBlankLines(value) {
  return value
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitMarkdownSections(value) {
  const lines = value.split('\n');
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (MARKDOWN_HEADING_RE.test(line) && current.length > 0) {
      sections.push(current.join('\n').trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n').trim());
  }
  return sections.filter(Boolean);
}

function getSectionHeading(sectionText) {
  const firstLine = sectionText.split('\n')[0]?.trim() || '';
  return MARKDOWN_HEADING_RE.test(firstLine) ? firstLine : '';
}

function shouldDropIntroLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  return INTRO_CHATTER_RE.test(trimmed) || RESULT_METADATA_LINE_RE.test(trimmed);
}

function shouldDropTrailingLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  return RESULT_METADATA_LINE_RE.test(trimmed) || CLOSING_CHATTER_RE.test(trimmed);
}

function cleanupResidualLines(value) {
  const lines = normalizeMultilineText(value).split('\n');
  if (lines.length === 0) return '';

  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (!line) {
      start += 1;
      continue;
    }
    if (shouldDropIntroLine(line)) {
      start += 1;
      continue;
    }
    break;
  }

  let end = lines.length;
  while (end > start) {
    const line = lines[end - 1].trim();
    if (!line) {
      end -= 1;
      continue;
    }
    if (shouldDropTrailingLine(line)) {
      end -= 1;
      continue;
    }
    break;
  }

  const kept = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (RESULT_METADATA_LINE_RE.test(line.trim())) {
      continue;
    }
    kept.push(line);
  }

  return compactBlankLines(kept.join('\n'));
}

export function cleanServiceResultText(content) {
  const raw = normalizeMultilineText(content);
  if (!raw) return '';

  const sections = splitMarkdownSections(raw);
  if (sections.length > 1) {
    const keptSections = sections.filter((section, index) => {
      const heading = getSectionHeading(section);
      if (!heading) {
        // Drop free-form preamble when the reply already has structured result sections.
        return index !== 0;
      }
      return !EXCLUDED_RESULT_SECTION_RE.test(heading);
    });
    const cleanedSections = keptSections
      .map((section) => cleanupResidualLines(section))
      .filter(Boolean);
    const combined = compactBlankLines(cleanedSections.join('\n\n'));
    if (combined) {
      return combined;
    }
  }

  const cleaned = cleanupResidualLines(raw);
  return cleaned || raw;
}

export function buildCoworkDeliveryResultMessage(resultText) {
  const cleaned = cleanServiceResultText(resultText);
  return `以下为链上服务方返回结果：\n\n${cleaned || '服务方已返回，但结果为空。'}`;
}

export function buildRefundRequestPayload(input) {
  return {
    version: '1.0.0',
    paymentTxid: input.paymentTxid,
    servicePinId: input.servicePinId ?? null,
    serviceName: input.serviceName,
    refundAmount: input.refundAmount,
    refundCurrency: input.refundCurrency,
    paymentChain: input.paymentChain ?? null,
    settlementKind: input.settlementKind ?? null,
    mrc20Ticker: input.mrc20Ticker ?? null,
    mrc20Id: input.mrc20Id ?? null,
    paymentCommitTxid: input.paymentCommitTxid ?? null,
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
    paymentChain: input.paymentChain ?? null,
    settlementKind: input.settlementKind ?? null,
    mrc20Ticker: input.mrc20Ticker ?? null,
    mrc20Id: input.mrc20Id ?? null,
    paymentCommitTxid: input.paymentCommitTxid ?? null,
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
  const tag = parseOrderProtocolTag(trimmed);
  if (!tag || tag.tag.toUpperCase() !== DELIVERY_TAG) {
    return null;
  }

  const jsonText = tag.rest;
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    if (tag.orderTxid) {
      parsed.orderTxid = tag.orderTxid;
    }
    return parsed;
  } catch {
    return null;
  }
}
