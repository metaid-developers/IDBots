const TXID_RE = /txid\s*[:：=]?\s*([0-9a-fA-F]{64})/i;

function extractOrderTxid(plaintext) {
  const match = String(plaintext || '').match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function looksLikeContentUrl(value) {
  return /^https?:\/\/[^/\s]+\/content\//i.test(String(value || '').trim());
}

function decodeBase64Utf8(value) {
  try {
    return Buffer.from(String(value || '').trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function selectProtocolPinContent(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidates = [
    item.contentSummary,
    item.contentBody,
    item.content,
    item.originalContentBody,
    item.originalContentSummary,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate;
    }
    if (isNonEmptyString(candidate)) {
      if (looksLikeContentUrl(candidate)) {
        continue;
      }
      if (candidate === item.contentBody || candidate === item.originalContentBody) {
        const decoded = decodeBase64Utf8(candidate);
        if (isNonEmptyString(decoded)) {
          return decoded;
        }
      }
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
