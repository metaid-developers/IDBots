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
  if (errorCode === 'self_order_not_allowed') {
    return 'gigSquareSelfOrderNotAllowed';
  }
  if (errorCode === 'order_request_too_long') {
    return 'gigSquarePromptTooLong';
  }
  return null;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMrc20Id(value) {
  return normalizeText(value);
}

function parseDecimalToAtomic(value, decimal) {
  const text = String(value ?? '').trim();
  const normalizedDecimal = Number.isInteger(Number(decimal)) && Number(decimal) >= 0
    ? Number(decimal)
    : 0;
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) {
    return null;
  }

  const [wholePart, fractionalPart = ''] = text.split('.');
  if (fractionalPart.length > normalizedDecimal) {
    const overflow = fractionalPart.slice(normalizedDecimal);
    if (/[^0]/.test(overflow)) {
      return null;
    }
  }

  const whole = BigInt(wholePart || '0');
  const scale = 10n ** BigInt(normalizedDecimal);
  const fractional = (fractionalPart.slice(0, normalizedDecimal)).padEnd(normalizedDecimal, '0');
  const fractionalAtomic = fractional ? BigInt(fractional) : 0n;
  return whole * scale + fractionalAtomic;
}

export function findGigSquareMrc20PaymentAsset(assets, mrc20Id) {
  const targetMrc20Id = normalizeMrc20Id(mrc20Id);
  if (!targetMrc20Id) return null;
  return (Array.isArray(assets) ? assets : []).find((asset) => (
    normalizeMrc20Id(asset?.mrc20Id) === targetMrc20Id
  )) || null;
}

export function formatGigSquareMrc20PaymentBalance(asset, loading) {
  if (loading) return '...';
  if (!asset) return '—';
  const display = normalizeText(asset?.balance?.display || asset?.balance?.confirmed);
  const symbol = normalizeText(asset?.symbol).toUpperCase() || 'MRC20';
  return display ? `${display} ${symbol}` : `— ${symbol}`;
}

export function getGigSquareMrc20PaymentReadiness(input) {
  const paymentAddress = normalizeText(input?.paymentAddress);
  if (!paymentAddress) {
    return { ok: false, reason: 'missing_payment_address' };
  }

  const targetMrc20Id = normalizeMrc20Id(input?.mrc20Id);
  if (!targetMrc20Id) {
    return { ok: false, reason: 'missing_token_id' };
  }

  const asset = input?.asset || null;
  if (!asset || normalizeMrc20Id(asset.mrc20Id) !== targetMrc20Id) {
    return { ok: false, reason: 'missing_token' };
  }

  const decimal = Number(asset.decimal);
  const expectedAtomic = parseDecimalToAtomic(input?.amount, decimal);
  if (expectedAtomic === null) {
    return { ok: false, reason: 'invalid_amount' };
  }

  const balanceAtomic = parseDecimalToAtomic(
    asset?.balance?.display || asset?.balance?.confirmed || '0',
    decimal,
  );
  if (balanceAtomic === null || balanceAtomic < expectedAtomic) {
    return { ok: false, reason: 'insufficient_token_balance' };
  }

  return { ok: true, reason: null };
}
