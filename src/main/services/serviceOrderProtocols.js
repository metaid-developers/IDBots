const DELIVERY_PREFIX = '[DELIVERY]';

export function buildDeliveryMessage(payload) {
  return `${DELIVERY_PREFIX} ${JSON.stringify(payload ?? {})}`;
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
