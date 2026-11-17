import { z } from 'zod';
import {
  describeMeChargeError,
  type MeChargeBalanceView,
  type MeFreezeView,
  type MeSettlementView,
} from '../services/meChargeService';

/**
 * me_charge — the buyer-side ME (MetaID Energy) payment tool.
 *
 * One tool, five actions, because a purchase is a SEQUENCE the agent has to
 * drive in order and the receipts must read as one ledger story:
 *
 *   status   balance + open freezes (is the money there, is a hold dangling?)
 *   freeze   hold `amount_me` ME against one explicit payee (idempotent on order_id)
 *   capture  after the goods moved, turn the hold into payer-debit / payee-earned
 *   release  give the hold back (timeout, failed delivery, buyer abort)
 *   pay      atomic one-shot charge (paid chat / skill call — the S8 leg)
 *
 * Identity: every action signs with THIS session MetaBot's own wallet; the
 * host resolves the wallet by metabotId and passes only an id across the tool
 * boundary, so no key material reaches this file. ME movement is off-chain
 * ledger bookkeeping — there is no chain transaction and therefore no
 * chain-write budget; the ledger's own bot daily pay limit is the cap.
 *
 * Guardrails enforced here (the server enforces almost none of them —
 * measured 2026-11-17: an arbitrary payee string is accepted and frozen):
 *   - amount and payee are mandatory; amount must be a positive ME value
 *   - payee must be an MVC address and must differ from the payer
 *   - order_id is mandatory and is the freeze idempotency key; a replay
 *     reports applied=false instead of double-charging
 *   - for ref_type "mrc721_purchase" the payee must be the item's CURRENT
 *     holder per the index (an unverifiable item is refused unless the caller
 *     explicitly accepts the risk), which is what turns "someone said this
 *     NFT is for sale" into a checkable payment
 *   - capture may carry expected_amount_me / expected_payee and refuses on a
 *     mismatch BEFORE the settlement call
 */

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => Promise<unknown> | unknown;

/** Best-effort item facts for the mrc721_purchase payee check. */
export interface MeChargeItemFacts {
  pinId: string;
  collectionName?: string;
  ownerAddress?: string;
  itemNumber?: string;
}

export type MeChargeToolsControl = {
  getMetabotMvcAddress(metabotId: number): string | null;
  balance(input: { metabotId: number }): Promise<MeChargeBalanceView>;
  freeze(input: {
    metabotId: number;
    orderId: string;
    amountMilli: number;
    payee: string;
    refType?: string;
    refId?: string;
  }): Promise<MeFreezeView>;
  capture(input: { metabotId: number; orderId: string }): Promise<MeSettlementView>;
  release(input: { metabotId: number; orderId: string }): Promise<MeFreezeView>;
  pay(input: {
    metabotId: number;
    payee: string;
    amountMilli: number;
    idempotencyKey: string;
    refType?: string;
    refId?: string;
    reason?: string;
  }): Promise<MeSettlementView>;
  listFreezes(input: { metabotId: number; limit?: number }): Promise<MeFreezeView[]>;
  /** Index read; absent → the purchase guard requires confirm_unverified. */
  fetchItemInfo?(pinId: string): Promise<MeChargeItemFacts | null>;
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 1 ME = 1000 milliME; the tool speaks ME, the API speaks milliME. */
function toMilliMe(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const milli = Math.round(value * 1000);
  if (Math.abs(milli - value * 1000) > 1e-6) return null; // >3 decimal places
  return milli;
}

const ME_FREEZE_LABEL: Record<number, string> = {
  1: 'frozen',
  2: 'captured',
  3: 'released',
  4: 'expired',
};

const ITEM_PIN_PATTERN = /^[0-9a-f]{64}i\d+$/;

function isoOf(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  return new Date(ms).toISOString();
}

function formatFreeze(freeze: MeFreezeView, now = Date.now()): string {
  const state = ME_FREEZE_LABEL[freeze.status] ?? `status ${freeze.status}`;
  const expiresInMin = freeze.expiresAt > now ? Math.round((freeze.expiresAt - now) / 60000) : 0;
  const splits = freeze.splits;
  const splitLine = [splits.grantMilli, splits.bonusMilli, splits.topupMilli, splits.earnedMilli]
    .some((value) => value > 0)
    ? ` (grant ${splits.grantMilli / 1000} · bonus ${splits.bonusMilli / 1000} · topup ${splits.topupMilli / 1000} · earned ${splits.earnedMilli / 1000} ME)`
    : '';
  return [
    `- orderId ${freeze.orderId}: ${state}${freeze.applied ? '' : ' (idempotent replay — nothing was re-applied)'}`,
    `  amount ${freeze.amountMilli / 1000} ME${splitLine}`,
    freeze.payee
      ? `  payee ${freeze.payee}`
      : '  payee not echoed by this response — confirm with action=status before capture',
    `  ref ${freeze.refType || 'freeze_order'}${freeze.refId ? ' / ' + freeze.refId : ''}`,
    freeze.status === 1 && freeze.expiresAt
      ? `  hold expires ${isoOf(freeze.expiresAt)} (~${expiresInMin} min); release any time before capture`
      : freeze.expiresAt ? `  closed at/after ${isoOf(freeze.expiresAt)}` : '',
  ].filter(Boolean).join('\n');
}

function formatSettlement(settlement: MeSettlementView): string {
  return [
    settlement.applied
      ? 'ME settlement applied (this call moved ledger rows).'
      : 'Idempotent replay: the settlement already existed, no second charge was made.',
    `- entryId ${settlement.entryId || '(none)'} (the ledger口径 both sides reconcile on)`,
    `- amount ${settlement.amountMilli / 1000} ME`,
    `- payer ${settlement.payer || 'unknown'} → payee ${settlement.payee || 'unknown'}`,
    settlement.payeeEarnedAfter != null
      ? `- payee earned pool after credit: ${settlement.payeeEarnedAfter / 1000} ME`
      : '',
  ].filter(Boolean).join('\n');
}

export function buildMeChargeAgentTools(deps: {
  tool: SdkToolFactory;
  control: MeChargeToolsControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const requireSessionMetabot = (toolLabel: string): number | string => {
    const id = resolveMetabotId(sessionId);
    if (id == null) {
      return `${toolLabel} could not determine which MetaBot owns this session; ME must be spent by a bot's own identity.`;
    }
    return id;
  };

  const meCharge = tool(
    'me_charge',
    [
      'Pay in ME (MetaID Energy) as THIS session MetaBot — the buyer-side spend leg. Freeze → capture for anything with a delivery step (NFT purchase, escrow-style service), pay for a one-shot charge (paid chat, skill call).',
      'Flow for a purchase: me_charge status → me_charge freeze (order_id, amount_me, payee, ref_type, ref_id) → the seller delivers → me_charge capture (order_id). If delivery fails or times out, me_charge release (order_id) gives the ME back. A hold is deducted from the balance immediately but becomes a payment only at capture.',
      'Guardrails: amount_me and payee are mandatory; payee must be an MVC address that differs from yours; order_id is mandatory and is the idempotency key (same order_id never freezes or captures twice); for ref_type "mrc721_purchase" the payee must be the item\'s current holder per the index — pass ref_id as the item pinId (64hex+iN), or item_pin_id explicitly, otherwise the call asks for confirm_unverified.',
      'Receipts carry the orderId / entryId ledger口径 so both sides can reconcile in /v1/me/history. No platform money flow: ME moves only between the two identities\' ledgers.',
    ].join(' '),
    {
      action: z.enum(['status', 'freeze', 'capture', 'release', 'pay']).describe('status = balance + open freezes; freeze = hold ME for a payee; capture = settle the hold after delivery; release = give the hold back; pay = atomic one-shot transfer (no delivery gate).'),
      order_id: z.string().optional().describe('Business order id: 1-80 chars of A-Z a-z 0-9 _ - . : — doubles as the ME idempotency key. Required for freeze/capture/release; for pay it is used as the idempotency key when idempotency_key is omitted.'),
      amount_me: z.number().optional().describe('Amount in ME (not milliME), up to 3 decimals. Required for freeze/pay; for capture it is checked against the hold when provided.'),
      payee: z.string().optional().describe('Payee MVC address (starts with 1). Required for freeze/pay. Must differ from this bot\'s own address.'),
      ref_type: z.string().optional().describe('Business reference type, e.g. mrc721_purchase | service | paid_chat. Recorded on the freeze row and echoed in ledger rows.'),
      ref_id: z.string().optional().describe('Business reference id, e.g. the item pinId for mrc721_purchase, a service key, or <collection>#<number>.'),
      item_pin_id: z.string().optional().describe('MRC-721 item pinId (64hex+iN) — when given (or when ref_id is one), the payee is verified against the item\'s current holder before any ME is held.'),
      expected_amount_me: z.number().optional().describe('capture only: refuse if the hold\'s amount differs from this value (checked before the settlement call).'),
      expected_payee: z.string().optional().describe('capture only: refuse if the hold\'s payee differs from this address.'),
      confirm_unverified: z.boolean().optional().describe('freeze only: accept an mrc721_purchase whose item owner could NOT be verified (index unavailable). Never set this just to make the call pass.'),
      note: z.string().optional().describe('pay only: human-readable reason stored on the ledger row.'),
    },
    async (args: {
      action: 'status' | 'freeze' | 'capture' | 'release' | 'pay';
      order_id?: string;
      amount_me?: number;
      payee?: string;
      ref_type?: string;
      ref_id?: string;
      item_pin_id?: string;
      expected_amount_me?: number;
      expected_payee?: string;
      confirm_unverified?: boolean;
      note?: string;
    }) => {
      const owner = requireSessionMetabot('me_charge');
      if (typeof owner === 'string') return textResult(owner, true);
      const ownAddress = control.getMetabotMvcAddress(owner) ?? '';
      const orderId = asString(args.order_id);
      const payee = asString(args.payee);
      const refType = asString(args.ref_type);
      let refId = asString(args.ref_id);

      try {
        if (args.action === 'status') {
          const [balance, freezes] = await Promise.all([
            control.balance({ metabotId: owner }),
            control.listFreezes({ metabotId: owner, limit: 20 }),
          ]);
          const open = freezes.filter((row) => row.status === 1);
          const closed = freezes.filter((row) => row.status !== 1);
          const lines = [
            `ME balance of this bot (${balance.identityAddress || ownAddress || 'unknown'}):`,
            `- spendable now: ${(balance.spendableMilli ?? balance.totalAvailableMilli) / 1000} ME`,
            `- frozen: ${balance.frozenMilli / 1000} ME · total available ${balance.totalAvailableMilli / 1000} ME`,
            `- weekly grant left ${balance.weeklyRemainingMilli / 1000} ME · earned ${balance.earnedMilli / 1000} ME · topup ${balance.topupMilli / 1000} ME · bonus ${balance.bonusMilli / 1000} ME`,
            open.length
              ? `Open freezes (${open.length}) — each one is a dangling hold until captured or released:`
              : 'Open freezes: none.',
            ...open.map((row) => formatFreeze(row)),
            closed.length ? `Recent closed freezes (${closed.length}):` : '',
            ...closed.slice(0, 5).map((row) => formatFreeze(row)),
          ].filter(Boolean);
          return textResult(lines.join('\n'));
        }

        if (args.action === 'freeze') {
          const amountMilli = toMilliMe(args.amount_me);
          if (!orderId) return textResult('me_charge freeze refused: order_id is required (it is the idempotency key that makes a retry safe).', true);
          if (amountMilli == null) return textResult('me_charge freeze refused: amount_me must be a positive ME amount (max 3 decimals).', true);
          if (!payee) return textResult('me_charge freeze refused: payee (the seller\'s MVC address) is required — ME is never frozen without a named recipient.', true);
          if (ownAddress && payee === ownAddress) {
            return textResult('me_charge freeze refused: payee equals this bot\'s own address; the ME service rejects self-payment.', true);
          }
          if (amountMilli > 10_000_000) {
            return textResult('me_charge freeze refused: the ME service caps autonomous bot payments at 10,000 ME per day; split the order or pay from a user identity.', true);
          }

          // Purchase guard: the payee must BE the item's current holder.
          const itemPin = asString(args.item_pin_id) || (ITEM_PIN_PATTERN.test(refId) ? refId : '');
          if (refType === 'mrc721_purchase') {
            if (!itemPin) {
              return textResult(
                'me_charge freeze refused: ref_type=mrc721_purchase needs the item pinId (item_pin_id, or ref_id as the pinId) so the payee can be checked against the item\'s current holder. Add the pin, or set confirm_unverified=true only if you already verified ownership off-band.',
                true,
              );
            }
            let facts: MeChargeItemFacts | null = null;
            let lookupError = '';
            try {
              facts = control.fetchItemInfo ? await control.fetchItemInfo(itemPin) : null;
            } catch (error) {
              lookupError = error instanceof Error ? error.message : String(error);
            }
            if (!facts) {
              if (args.confirm_unverified !== true) {
                return textResult(
                  `me_charge freeze refused: could not verify item ${itemPin} on the index${lookupError ? ` (${lookupError})` : ''}. Refusing to hold ME for an unverified item; retry when the index answers, or set confirm_unverified=true if ownership was verified off-band.`,
                  true,
                );
              }
            } else if (facts.ownerAddress && facts.ownerAddress !== payee) {
              return textResult(
                `me_charge freeze refused: item ${itemPin} is held by ${facts.ownerAddress}, not by payee ${payee} — the item has moved or the address is wrong. Nothing was frozen.`,
                true,
              );
            }
            // Prefer a human-readable ledger ref; the pinId stays in the receipt.
            if (facts?.collectionName && (!refId || refId === itemPin)) {
              refId = `${facts.collectionName}#${facts.itemNumber || itemPin}`;
            } else if (!refId) {
              refId = itemPin;
            }
          }

          const freeze = await control.freeze({
            metabotId: owner,
            orderId,
            amountMilli,
            payee,
            ...(refType ? { refType } : {}),
            ...(refId ? { refId } : {}),
          });
          // The freeze response carries the split/expiry but NOT the payee or
          // ref (server FreezeResult shape), so read the stored row back: the
          // receipt must state what the ledger actually holds, and a stored
          // payee that differs from the requested one is a hard stop.
          let stored: MeFreezeView | null = null;
          try {
            const rows = await control.listFreezes({ metabotId: owner, limit: 50 });
            stored = rows.find((row) => row.orderId === orderId) ?? null;
          } catch {
            stored = null;
          }
          if (stored?.payee && stored.payee !== payee) {
            return textResult(
              `me_charge freeze ALIGNMENT ERROR: order ${orderId} is stored with payee ${stored.payee}, not the requested ${payee}. Release it (action=release, order_id=${orderId}) before doing anything else.`,
              true,
            );
          }
          return textResult([
            freeze.applied
              ? `Froze ${amountMilli / 1000} ME for payee ${payee}.`
              : `Order ${orderId} already exists — reused the existing hold (no second freeze).`,
            formatFreeze(stored ?? freeze),
            'Next: let the seller deliver, then me_charge action=capture with the same order_id. If the deal dies, me_charge action=release returns the hold.',
            ...(itemPin ? [`Item ${itemPin} verified on the index against the payee.`] : []),
          ].join('\n'));
        }

        if (args.action === 'capture') {
          if (!orderId) return textResult('me_charge capture refused: order_id is required.', true);
          // Pre-resolve the hold so a mismatch is refused BEFORE settlement.
          let known: MeFreezeView | null = null;
          try {
            const rows = await control.listFreezes({ metabotId: owner, limit: 50 });
            known = rows.find((row) => row.orderId === orderId) ?? null;
          } catch {
            known = null; // the server stays authoritative; capture will report
          }
          if (known && known.status !== 1) {
            return textResult(
              `me_charge capture refused: order ${orderId} is ${ME_FREEZE_LABEL[known.status] ?? 'not frozen'} (status ${known.status}), so there is nothing to settle. Nothing was charged.`,
              true,
            );
          }
          const expectedMilli = args.expected_amount_me == null ? null : toMilliMe(args.expected_amount_me);
          if (expectedMilli != null && known && known.amountMilli !== expectedMilli) {
            return textResult(
              `me_charge capture refused: the hold is ${known.amountMilli / 1000} ME but expected_amount_me is ${args.expected_amount_me} ME. Nothing was charged — fix the amount or release the hold.`,
              true,
            );
          }
          const expectedPayee = asString(args.expected_payee);
          if (expectedPayee && known && known.payee && known.payee !== expectedPayee) {
            return textResult(
              `me_charge capture refused: the hold pays ${known.payee}, not the expected ${expectedPayee}. Nothing was charged.`,
              true,
            );
          }
          const settlement = await control.capture({ metabotId: owner, orderId });
          return textResult([
            formatSettlement(settlement),
            known ? `Held for: ${known.refType || 'freeze_order'}${known.refId ? ' / ' + known.refId : ''} → payee ${known.payee || 'none'}.` : '',
          ].filter(Boolean).join('\n'));
        }

        if (args.action === 'release') {
          if (!orderId) return textResult('me_charge release refused: order_id is required.', true);
          const freeze = await control.release({ metabotId: owner, orderId });
          const state = ME_FREEZE_LABEL[freeze.status] ?? `status ${freeze.status}`;
          // Same read-back as freeze: the release response omits payee/ref.
          let stored: MeFreezeView | null = null;
          try {
            const rows = await control.listFreezes({ metabotId: owner, limit: 50 });
            stored = rows.find((row) => row.orderId === orderId) ?? null;
          } catch {
            stored = null;
          }
          return textResult([
            freeze.applied
              ? `Released the ME hold for order ${orderId}; the amount is back in the payer's balance.`
              : `Order ${orderId} was already ${state} — release is idempotent, nothing changed.`,
            formatFreeze(stored ?? freeze),
          ].join('\n'));
        }

        // pay — atomic one-shot charge
        const amountMilli = toMilliMe(args.amount_me);
        if (!payee) return textResult('me_charge pay refused: payee is required.', true);
        if (amountMilli == null) return textResult('me_charge pay refused: amount_me must be a positive ME amount (max 3 decimals).', true);
        if (ownAddress && payee === ownAddress) {
          return textResult('me_charge pay refused: payee equals this bot\'s own address.', true);
        }
        if (!orderId) return textResult('me_charge pay refused: order_id (or an explicit idempotency key) is required so a retry cannot charge twice.', true);
        const settlement = await control.pay({
          metabotId: owner,
          payee,
          amountMilli,
          idempotencyKey: orderId,
          ...(refType ? { refType } : {}),
          ...(refId ? { refId } : {}),
          ...(asString(args.note) ? { reason: asString(args.note) } : {}),
        });
        return textResult(formatSettlement(settlement));
      } catch (error) {
        return textResult(`me_charge ${args.action} failed: ${describeMeChargeError(error)}`, true);
      }
    },
  );

  return [meCharge];
}
