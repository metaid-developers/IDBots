const TXID_RE = /txid\s*[:：=]?\s*([0-9a-fA-F]{64})/i;

function extractOrderTxid(plaintext) {
  const match = String(plaintext || '').match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

export function resolveOrderSessionId(input) {
  const directSessionId = normalizeString(input?.directSessionId);
  if (directSessionId) {
    return directSessionId;
  }
  const fallbackSessionId = normalizeString(input?.fallbackSessionId);
  return fallbackSessionId || null;
}

export function findMatchingOrderSessionId(sessions, order) {
  if (!Array.isArray(sessions) || !order || typeof order !== 'object') {
    return null;
  }

  const paymentTxid = normalizeString(order.paymentTxid);
  const localMetabotId = normalizeNumber(order.localMetabotId);
  const counterpartyGlobalMetaid = normalizeString(order.counterpartyGlobalMetaid);
  if (!paymentTxid || localMetabotId == null || localMetabotId <= 0) {
    return null;
  }

  const candidates = sessions
    .filter((session) => {
      if (!session || typeof session !== 'object') {
        return false;
      }

      const sessionType = normalizeString(session.sessionType);
      if (sessionType && sessionType !== 'a2a') {
        return false;
      }

      if (normalizeNumber(session.metabotId) !== localMetabotId) {
        return false;
      }

      const sessionPeerGlobalMetaId = normalizeString(session.peerGlobalMetaId);
      if (
        counterpartyGlobalMetaid
        && sessionPeerGlobalMetaId
        && sessionPeerGlobalMetaId !== counterpartyGlobalMetaid
      ) {
        return false;
      }

      return extractSessionOrderTxid(session.messages) === paymentTxid;
    })
    .sort((left, right) => {
      const updatedDiff = (normalizeNumber(right?.updatedAt) ?? 0) - (normalizeNumber(left?.updatedAt) ?? 0);
      if (updatedDiff !== 0) {
        return updatedDiff;
      }
      return normalizeString(right?.id).localeCompare(normalizeString(left?.id));
    });

  return normalizeString(candidates[0]?.id) || null;
}
