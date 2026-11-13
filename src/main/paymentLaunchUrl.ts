/**
 * Payment-app launch URL gate (S3 fiat slice).
 *
 * The PaymentCard's「前往支付宝付款」button assigns
 * `location.href = alipays://…` (variant C, built by buildAlipayVariantCUrl).
 * Electron's navigation guards only hand http/https/mailto/tel to the OS, so
 * on desktop that assignment was a silent no-op: the window never navigated,
 * no external app opened, and the 2s watchdog degraded to the QR card.
 *
 * This gate is deliberately narrower than "allow the alipays: scheme". The
 * scheme addresses far more than a receiving code (transfer pages, mini
 * programs, account screens), and card payloads arrive from arbitrary chat
 * peers, so only the exact shape the PaymentCard itself builds is allowed:
 *
 *   alipays://platformapi/startapp?saId=10000007&clientVersion=…&qrcode=…
 *
 *   - scheme alipays:, host platformapi, path /startapp, no port/userinfo/hash
 *   - saId fixed to 10000007 (the scan entry — not an arbitrary mini-program id)
 *   - qrcode must pass the https://qr.alipay.com/ receiving-code gate the card
 *     itself enforces before it may enter a scheme
 *   - parameter names limited to saId / clientVersion / qrcode, each at most
 *     once (a `qrcode` we validate but Alipay reads second is a real bypass)
 *   - no whitespace or control characters anywhere in the raw string: URL
 *     parsing strips tabs/newlines, so `alipays:\n//…` would validate against
 *     the parsed form while the OS receives the raw one
 *
 * Everything else — other alipays: URLs and every other custom scheme — stays
 * blocked. DOM-free and electron-free so unit tests drive it directly.
 */

const ALIPAY_LAUNCH_PREFIX = 'alipays://platformapi/startapp?';
const ALIPAY_SCAN_ENTRY_SA_ID = '10000007';
const ALIPAY_QR_PREFIX = 'https://qr.alipay.com/';
const ALLOWED_PARAM_KEYS = new Set(['saId', 'clientVersion', 'qrcode']);
const MAX_URL_LENGTH = 2048;

/** Same receiving-code rule as paymentCardSyntax.isValidAlipayQrContent. */
const isAlipayReceivingCode = (value: string): boolean => {
  if (value.length > 512) return false;
  if (!value.startsWith(ALIPAY_QR_PREFIX)) return false;
  const code = value.slice(ALIPAY_QR_PREFIX.length);
  return /^[A-Za-z0-9_-]+$/.test(code) && code.length >= 6;
};

/**
 * True only for the variant-C Alipay launch URL. Callers hand a hit to
 * shell.openExternal and keep blocking everything else.
 */
export const isAllowedPaymentLaunchUrl = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  if (!value.startsWith(ALIPAY_LAUNCH_PREFIX)) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'alipays:') return false;
  if (parsed.hostname !== 'platformapi') return false;
  if (parsed.pathname !== '/startapp') return false;
  if (parsed.port || parsed.username || parsed.password) return false;
  if (parsed.hash) return false;

  const seen = new Set<string>();
  for (const [key] of parsed.searchParams) {
    if (!ALLOWED_PARAM_KEYS.has(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
  }

  if (parsed.searchParams.get('saId') !== ALIPAY_SCAN_ENTRY_SA_ID) return false;
  const qrcode = parsed.searchParams.get('qrcode');
  if (!qrcode || !isAlipayReceivingCode(qrcode)) return false;

  return true;
};
