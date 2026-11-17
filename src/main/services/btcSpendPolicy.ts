/**
 * BTC inscription-carrier protection — one floor shared by every plain-BTC
 * flow (UTXO list, BTC send, multisig PSBT). Mirrors Metalet's shipped rule:
 *
 *   e266b9c — never SPEND a sub-1000-sat UTXO as plain BTC. A 546-sat output
 *             may be an MRC20 / Pin inscription carrier; spending it as
 *             fees destroys the asset it carries.
 *   b31d645 → 1b3f93a — the transfer-output floor sits at exactly 1000 sats:
 *             999 is refused, 1000 is spendable. 1b3f93a deliberately moved
 *             b31d645's `lte(1000)` down to `lt(1000)` so the send boundary
 *             matches the >=1000 spend filter instead of contradicting it.
 *
 * Protocol-mandated carrier outputs (inscription reveal, MRC20 reveal) are not
 * normal transfers and are deliberately outside this gate.
 */
export const BTC_MIN_SPENDABLE_SATS = 1000;

/** True when a value may be spent or created as a plain BTC input/output. */
export function isBtcSpendableSats(value: number): boolean {
  return Number.isFinite(value) && value >= BTC_MIN_SPENDABLE_SATS;
}
