/**
 * payment_card_emit — the G1 agent tool: a bot session emits the local owner's
 * REAL point-to-point Alipay payment card from the S3 encrypted receiving info.
 *
 * Why a tool: S3 shipped the encrypted store and the `pay-card` renderer
 * contract, but the only emitter was a one-off script — "any supply-side bot
 * can issue a card" did not hold. This tool is that missing surface, so the
 * path is 设置 → 收款信息 (owner saves) → payment_card_emit (bot emits).
 *
 * Zero funds flow, red line: the tool never touches a wallet, never writes
 * on-chain and never settles anything — a card only tells the payer where to
 * send money point-to-point. The control only reads + decrypts locally.
 *
 * The payee block cannot be supplied by the caller: it is derived inside the
 * emitter from the owner's stored receiving info, so a caller cannot name a
 * different payee, inject a foreign QR code, or leak the saved image/PID.
 *
 * Per-emit owner gate (red line): a card discloses the owner's payee identity
 * and receiving code to EVERY participant of the conversation it is emitted
 * into, with a caller-chosen amount and order id. Every emit therefore asks
 * the owner first (`confirm` must resolve true ONLY for an explicit owner
 * approval — timeout, refusal, missing owner seat and any gate error all
 * resolve false and nothing is emitted). Same fail-closed family as the
 * me_charge per-charge gate and the btc multisig sign/broadcast gates.
 */

import { z } from 'zod';
import {
  emitPaymentCard,
  type PaymentCardReadResult,
  type PaymentCardRefusalCode,
} from '../services/paymentCardEmitter';
import { formatCentsToYuan } from '../../renderer/components/chat/paymentCardSyntax';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => Promise<unknown> | unknown;

/**
 * Host control surface, wired in main.ts next to the escrowTools control.
 * `readReceivingInfo` runs in the main process: it reads the single encrypted
 * row, derives the payment key from the local identity and decrypts. Nothing
 * about the cipher, the key or the mnemonic crosses this boundary.
 */
export type PaymentCardAgentToolsControl = {
  readReceivingInfo: () => PaymentCardReadResult;
};

/** One card emission awaiting the owner's confirmation (see the gate above). */
export interface PaymentCardEmitConfirmationInfo {
  orderId: string;
  amountCents: number;
  /** Raw saved display name; null when the owner saved no display name. */
  payeeDisplayName: string | null;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** The fence must reach the chat verbatim; the model is told so explicitly. */
export const PAYMENT_CARD_RESULT_HINT =
  'Chat payment card — include this fenced block verbatim in your reply so every chat client (CoWork, private chat, group chat) renders the payment card:';

const refuse = (toolName: string, code: PaymentCardRefusalCode, message: string) =>
  textResult(`${toolName} refused: ${code} — ${message} Nothing was emitted.`, true);

export function buildPaymentCardAgentTools(deps: {
  tool: SdkToolFactory;
  control: PaymentCardAgentToolsControl;
  /** Owner gate: MUST be wired by the host (coworkRunner.confirmPaymentCardEmit).
   * Resolve true ONLY for an explicit owner approval; false refuses the emit. */
  confirm: (info: PaymentCardEmitConfirmationInfo) => Promise<boolean>;
}): unknown[] {
  const { tool, control, confirm } = deps;

  const paymentCardEmit = tool(
    'payment_card_emit',
    [
      'Emit a REAL point-to-point Alipay payment card for this machine\'s owner, built from the receiving info the owner saved in 设置 → 收款信息 (decrypted in the main process).',
      'Use it whenever a payer needs to know where to send fiat money: NFT sales, service fees, deposits — the card carries the amount, the order id (the payment memo) and the payee.',
      'Zero funds flow: nothing moves through IDBots, no wallet is touched, and nothing is written on-chain — the payer transfers point-to-point in Alipay.',
      'The payee block is derived ONLY from the owner\'s stored receiving info; you cannot pass a payee, a receiving code or an account id. order_id and amount_cents are required and must come from you: order_id is both the memo and the reconciliation anchor the buyer\'s「我已支付」record and the seller\'s「待核验」panel key on.',
      'Pass amount_yuan and/or memo to get a hard cross-check: amount_yuan must equal amount_cents to the cent and memo must equal order_id — any disagreement refuses the card (amount/face drift is how a payment silently goes wrong).',
      'Refusals, each with a fix: NO_RECEIVING_INFO (owner never saved receiving info), DECRYPT_FAILED (local identity missing or blob unreadable — re-save in settings), NO_QR_CHANNEL (only a PID saved; this card pays by receiving code), OWNER_CONFIRMATION_DENIED (the owner did not approve this card — do not retry the same card without asking the owner directly), INVALID_ORDER_ID, INVALID_AMOUNT, AMOUNT_MISMATCH, MEMO_MISMATCH, CARD_INVALID.',
      'The owner\'s saved QR image, Alipay PID and the ciphertext are deliberately never part of the emitted card.',
      'Every emit asks the owner for confirmation first: an unanswered or refused confirmation card means the card was NOT emitted — treat OWNER_CONFIRMATION_DENIED as final for that card.',
    ].join(' '),
    {
      order_id: z.string().min(1).describe('Order id / payment memo / reconciliation anchor (1-64 chars: letters, digits, dot, dash, underscore; must start with a letter or digit).'),
      amount_cents: z.number().int().positive().describe('Amount in integer cents (¥0.01 → 1). Required — never inferred from context.'),
      amount_yuan: z.string().optional().describe('Optional declared yuan string (e.g. "0.01"); must equal amount_cents exactly or the card is refused.'),
      memo: z.string().optional().describe('Optional declared memo; must equal order_id (the card forces memo = order id) or the card is refused.'),
    },
    async (args: { order_id: string; amount_cents: number; amount_yuan?: string; memo?: string }) => {
      const read = control.readReceivingInfo();
      if (read.status === 'refused') return refuse('payment_card_emit', read.code, read.message);

      // Per-emit owner gate BEFORE anything is emitted. Any throw inside the
      // gate is a denial too — fail closed, never emit on a broken gate.
      let approved = false;
      try {
        approved = (await confirm({
          orderId: args.order_id,
          amountCents: args.amount_cents,
          payeeDisplayName: read.info.payeeDisplayName ?? null,
        })) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        return refuse(
          'payment_card_emit',
          'OWNER_CONFIRMATION_DENIED',
          'the owner did not approve emitting this card (refused, unanswered, or no owner seat).',
        );
      }

      const emitted = emitPaymentCard(read.info, {
        orderId: args.order_id,
        amountCents: args.amount_cents,
        amountYuan: args.amount_yuan,
        memo: args.memo,
      });
      if (emitted.status === 'refused') return refuse('payment_card_emit', emitted.code, emitted.message);

      const { card, fence, launchUrl } = emitted;
      const lines = [
        `Payment card ready — ¥${formatCentsToYuan(card.amountCents)} (${card.amountCents} cents), order/memo ${card.orderId}.`,
        `- payee: ${card.payee.displayName ?? 'Alipay receiving code'} (derived from the owner's saved 收款信息)`,
        `- payment rail: Alipay receiving code — in-app launch ${launchUrl ? 'available (variant C)' : 'unavailable'}, QR degrade always rendered from the code`,
        '- funds flow: point-to-point payer → payee; IDBots moves no money and nothing is written on-chain',
        '- not included on purpose: the owner\'s saved QR image, Alipay PID and the stored ciphertext',
        '- the buyer pays this exact amount with the order id as memo; the buyer\'s「我已支付」and the seller\'s「待核验」panel key on that order id',
      ];
      return textResult(`${lines.join('\n')}\n\n${PAYMENT_CARD_RESULT_HINT}\n${fence}`);
    }
  );

  return [paymentCardEmit];
}
