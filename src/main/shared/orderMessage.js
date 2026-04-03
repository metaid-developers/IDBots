export const ORDER_PREFIX = '[ORDER]';
export const ORDER_RAW_REQUEST_OPEN_TAG = '<raw_request>';
export const ORDER_RAW_REQUEST_CLOSE_TAG = '</raw_request>';
export const ORDER_RAW_REQUEST_MAX_CHARS = 4000;

const ORDER_PREFIX_RE = /^\s*\[ORDER\]\s*/i;
const RAW_REQUEST_BLOCK_RE = /<raw_request>\s*\n?([\s\S]*?)\n?\s*<\/raw_request>/i;

function normalizeMultilineText(value) {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').trim()
    : '';
}

function normalizeSingleLineText(value) {
  return normalizeMultilineText(value).replace(/\s+/g, ' ').trim();
}

function getFallbackDisplaySummary(rawRequest) {
  const normalized = normalizeMultilineText(rawRequest);
  if (!normalized) return '';
  const firstLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || normalized;
}

export function normalizeOrderRawRequest(value) {
  return normalizeMultilineText(value);
}

export function extractOrderRawRequest(plaintext) {
  const source = String(plaintext || '').replace(/\r\n?/g, '\n');
  const match = source.match(RAW_REQUEST_BLOCK_RE);
  return match?.[1] ? match[1].trim() : '';
}

export function extractOrderDisplaySummary(plaintext) {
  const source = String(plaintext || '').replace(/\r\n?/g, '\n');
  const firstLine = source.split('\n')[0] || '';
  return firstLine.replace(ORDER_PREFIX_RE, '').trim();
}

export function validateOrderRawRequest(value, maxChars = ORDER_RAW_REQUEST_MAX_CHARS) {
  const rawRequest = normalizeOrderRawRequest(value);
  if (!rawRequest) {
    return {
      ok: false,
      reason: 'required',
      rawRequest,
      maxChars,
    };
  }
  if (rawRequest.length > maxChars) {
    return {
      ok: false,
      reason: 'too_long',
      rawRequest,
      maxChars,
    };
  }
  return {
    ok: true,
    rawRequest,
    maxChars,
  };
}

export function buildOrderRawRequestBlock(rawRequest) {
  const normalized = normalizeOrderRawRequest(rawRequest);
  return `${ORDER_RAW_REQUEST_OPEN_TAG}\n${normalized}\n${ORDER_RAW_REQUEST_CLOSE_TAG}`;
}

export function buildOrderPayload(input) {
  const rawRequest = normalizeOrderRawRequest(input?.rawRequest);
  const displaySummary = normalizeSingleLineText(input?.displayText)
    || getFallbackDisplaySummary(rawRequest)
    || normalizeSingleLineText(input?.serviceName)
    || normalizeSingleLineText(input?.skillName)
    || 'Service Order';
  const effectiveRawRequest = rawRequest
    || getFallbackDisplaySummary(displaySummary)
    || normalizeSingleLineText(input?.serviceName)
    || normalizeSingleLineText(input?.skillName)
    || 'Service Order';
  const paymentTxid = normalizeSingleLineText(input?.paymentTxid);
  const orderReference = normalizeSingleLineText(input?.orderReference);

  const metadataLines = [
    `支付金额 ${String(input?.price || '').trim()} ${String(input?.currency || '').trim()}`,
  ];
  if (paymentTxid) {
    metadataLines.push(`txid: ${paymentTxid}`);
  } else if (orderReference) {
    metadataLines.push(`order id: ${orderReference}`);
  }
  metadataLines.push(
    `service id: ${String(input?.serviceId || '').trim()}`,
    `skill name: ${String(input?.skillName || '').trim()}`,
  );

  return [
    `${ORDER_PREFIX} ${displaySummary}`,
    buildOrderRawRequestBlock(effectiveRawRequest),
    ...metadataLines,
  ].join('\n');
}
