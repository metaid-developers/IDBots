const BASE_PAY_ACTION_CLASS =
  'btn-idchat-primary px-4 py-2 text-sm font-medium transition-opacity';

export function isGigSquarePayActionEnabled(status, handshake) {
  return status === 'idle' && handshake === 'online';
}

export function getGigSquarePayActionClassName(status, handshake) {
  if (isGigSquarePayActionEnabled(status, handshake)) {
    return BASE_PAY_ACTION_CLASS;
  }
  return `${BASE_PAY_ACTION_CLASS} opacity-50 cursor-not-allowed pointer-events-none shadow-none`;
}

export function getGigSquarePayActionBlockedMessageKey(handshake) {
  if (handshake === 'online') return null;
  if (handshake === 'offline') return 'gigSquareHandshakeOffline';
  return 'gigSquareHandshaking';
}

export function getGigSquareOrderErrorMessageKey(errorCode) {
  if (errorCode === 'open_order_exists') {
    return 'gigSquareOpenOrderExists';
  }
  return null;
}
