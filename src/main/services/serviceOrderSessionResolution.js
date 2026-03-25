const TXID_RE = /txid\s*[:：=]?\s*([0-9a-fA-F]{64})/i;

function extractOrderTxid(plaintext) {
  const match = String(plaintext || '').match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function selectProtocolPinContent(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidates = [
    item.content,
    item.contentSummary,
    item.contentBody,
    item.originalContentBody,
    item.originalContentSummary,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
    if (isNonEmptyString(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function extractSessionOrderTxid(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (const message of messages) {
    const txid = extractOrderTxid(typeof message?.content === 'string' ? message.content : '');
    if (txid) {
      return txid;
    }
  }

  return null;
}
