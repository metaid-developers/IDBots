/**
 * Fee-channel receipt helpers shared by the chain-write agent tools
 * (post_buzz, post_simplenote, post_simpleanswer/question, upload_file, …).
 *
 * D3/R2.2 of the 2026-09-08 host-fix RFP: the tool receipt — the only layer
 * the bot session can see — must state which fee channel paid for the write
 * (MVC fee sponsor vs the bot's own wallet), whether a fallback happened and
 * why, and, when both channels failed, the structured sponsor + self-paid
 * error pair instead of a bare message.
 */

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readFeeAssistRecord(feeAssist: unknown): Record<string, unknown> | null {
  return feeAssist != null && typeof feeAssist === 'object' && !Array.isArray(feeAssist)
    ? feeAssist as Record<string, unknown>
    : null;
}

/**
 * Success-receipt lines describing the fee channel. Mirrors the wording the
 * upload_file tool already shipped ("- sponsor: applied / unavailable, fell
 * back …") so every chain-write tool reads the same way. Returns [] when the
 * write never touched the sponsor path (plain self-paid mode) — receipts of
 * non-sponsored writes stay unchanged.
 *
 * Every fallback-to-self-paid outcome is additionally prefixed with a
 * machine-readable `- WARN sponsor_fallback: true (…)` marker line so budget
 * monitors can alert on the WARN level instead of parsing the prose line
 * (GitHub issue #61).
 */
export function feeAssistReceiptLines(feeAssist: unknown): string[] {
  const fa = readFeeAssistRecord(feeAssist);
  if (!fa) return [];
  const used = fa.used === true;
  const attempted = fa.attempted === true;
  if (!used && !attempted) return [];
  const reason = asString(fa.reason) || 'unknown';
  const stage = asString(fa.stage);
  const orderId = asString(fa.orderId);
  const outcome = asString(fa.commitOrderOutcome);
  const orderSuffix = orderId ? `, order ${orderId}${outcome ? `: ${outcome}` : ''}` : '';
  if (used) {
    const recovered = fa.commitRecovered === true;
    const billedBy = asString(fa.billedBy);
    const meAmountMilli = typeof fa.meAmountMilli === 'number' && Number.isFinite(fa.meAmountMilli)
      ? fa.meAmountMilli
      : undefined;
    const txSize = typeof fa.txSize === 'number' && Number.isFinite(fa.txSize)
      ? fa.txSize
      : undefined;
    const sponsoredMinerFee = typeof fa.sponsoredMinerFee === 'number' && Number.isFinite(fa.sponsoredMinerFee)
      ? fa.sponsoredMinerFee
      : undefined;
    const paidParts: string[] = [];
    if (orderId) paidParts.push(`order=${orderId}`);
    if (billedBy) paidParts.push(`billed_by=${billedBy}`);
    if (meAmountMilli !== undefined) {
      paidParts.push(`points=${meAmountMilli / 1000}`);
      paidParts.push(`me_milli=${meAmountMilli}`);
    }
    if (txSize !== undefined) paidParts.push(`bytes=${txSize}`);
    if (sponsoredMinerFee !== undefined) paidParts.push(`fee_sats=${sponsoredMinerFee}`);
    const paidMarker = `- SPONSOR paid: ${paidParts.length ? paidParts.join(' ') : 'true'}`;
    return [
      paidMarker,
      `- sponsor: applied (MVC fee sponsor covered this write${orderId ? `, order ${orderId}` : ''}${recovered ? '; commit response was lost but the order broadcast' : ''})`,
    ];
  }
  const warnMarker =
    `- WARN sponsor_fallback: true (reason=${reason}` +
    `${stage ? ` stage=${stage}` : ''}${orderId ? ` order=${orderId}` : ''}${outcome ? ` outcome=${outcome}` : ''})`;
  if (reason === 'circuit_open') {
    return [
      warnMarker,
      "- sponsor: skipped — circuit breaker open after repeated broadcast failures, paid by the bot's own wallet",
    ];
  }
  return [
    warnMarker,
    `- sponsor: unavailable, fell back to the bot's own wallet (reason: ${reason}${stage ? ` at ${stage}` : ''}${orderSuffix})`,
  ];
}

/**
 * Failure detail suffix for chain-write errors. Reads the structured
 * error.code + error.data.feeAssist (present whenever the sponsor path was
 * involved) so the receipt shows both channels' fates instead of a bare
 * message. Empty string when nothing structured is attached — existing
 * failure receipts stay unchanged.
 */
export function chainWriteFailureDetail(error: unknown): string {
  const record = error as { code?: unknown; data?: { feeAssist?: unknown } } | null;
  const fa = readFeeAssistRecord(record?.data?.feeAssist);
  if (!fa) return '';
  const parts: string[] = [];
  const code = asString(record?.code);
  if (code) parts.push(`code=${code}`);
  const reason = asString(fa.reason);
  const stage = asString(fa.stage);
  if (reason) parts.push(`sponsor=${reason}${stage ? `@${stage}` : ''}`);
  const orderId = asString(fa.orderId);
  if (orderId) parts.push(`order=${orderId}`);
  const outcome = asString(fa.commitOrderOutcome);
  if (outcome) parts.push(`outcome=${outcome}`);
  const selfPaidError = asString(fa.selfPaidError);
  if (selfPaidError) parts.push(`selfpay_error=${selfPaidError}`);
  return parts.length ? ` [fee assist: ${parts.join('; ')}]` : '';
}
