import { z } from 'zod';
import {
  isValidAlipayQrContent,
  maskDisplayName,
  validatePaymentReceivingInfo,
  type PaymentReceivingInfo,
} from '../services/paymentInfoCrypto';

/**
 * payment_emit_card — the S3 fiat payment-card emitter as an agent tool (G1).
 *
 * Before this tool the ONLY way to emit a real card was a one-off script: a
 * bot session could not read the owner's locally stored (encrypted) Alipay
 * receiving info, so "any supplier bot can hand out a card" did not hold. This
 * tool closes that gap for every cowork session on the machine:
 *
 *   control.readReceivingInfo()  →  validate args + receiving info  →  fence
 *
 * Zero-funds-flow red line (same as the escrow tools): this module NEVER
 * imports or calls a wallet, a transfer, a chain write, or an indexer. It reads
 * one local encrypted row, decrypts it (in main.ts, which owns the identity),
 * checks it, and returns text. The fiat money moves point-to-point between the
 * payer and the payee's own Alipay account; the platform is not a party.
 *
 * Output contract: a ```pay-card fenced block whose JSON body is EXACTLY the
 * payload the renderer contract validates
 * (src/renderer/components/chat/paymentCardSyntax.ts → parsePayCardFence):
 * orderId (also the payment memo), amountCents (integer cents), currency 'CNY',
 * payee{displayName?, qrContent}, optional deadline (unix ms). The emitter is
 * DOM-free and main-side, so it mirrors that contract instead of importing the
 * renderer module; tests/paymentCardAgentTools.test.ts pins the mirror against
 * the real parser field by field.
 *
 * Privacy: the encrypted blob also archives the receiving-code IMAGE
 * (qrImageDataUrl). That image never enters a fence, a tool result, or a log —
 * the card carries qrContent only, which the renderer needs to launch/degrade.
 * The decrypted display name is always masked (maskDisplayName) before it
 * leaves this module: a card may be forwarded to a counterparty.
 */

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => Promise<unknown> | unknown;

export const PAYMENT_CARD_FENCE_TAG = 'pay-card';

/**
 * Mirrors the renderer contract's order-id rule — the orderId IS the payment
 * memo, so an id the renderer would reject must never produce a fence.
 */
const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Mirrors paymentCardSyntax's sanity ceiling: ¥1,000,000 in integer cents. */
export const MAX_PAY_CARD_AMOUNT_CENTS = 100_000_000_00;

/**
 * The one host dependency of this tool: a local, decrypting read of the
 * owner's saved receiving info. Implemented in main.ts (identity-derived key +
 * PaymentInfoStore); the plaintext never travels further than this call.
 */
export type PaymentCardReceivingInfoReadResult =
  | { status: 'ok'; info: PaymentReceivingInfo }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: string };

export type PaymentCardAgentToolsControl = {
  /**
   * - 'missing': the owner never saved receiving info on this machine
   * - 'unavailable': identity/cipher unusable (details in `reason`, never
   *   containing the plaintext, the ciphertext, or the mnemonic)
   * - 'ok': the decrypted receiving info
   */
  readReceivingInfo(): PaymentCardReceivingInfoReadResult;
};

/** The renderer-validated pay-card payload, already masked and gated. */
export interface PayCardEmitFields {
  orderId: string;
  amountCents: number;
  /** Already masked via maskDisplayName; omitted when the owner saved none. */
  payeeDisplayName?: string;
  /** Passed the qr.alipay.com prefix gate — safe for scheme + QR regen. */
  qrContent: string;
  deadline?: number;
}

/**
 * Serialize the fence. Key order is fixed for readable diffs; the renderer
 * parses by key name, never by order.
 */
export function buildPayCardFence(fields: PayCardEmitFields): string {
  const payee: Record<string, string> = {};
  if (fields.payeeDisplayName) payee.displayName = fields.payeeDisplayName;
  payee.qrContent = fields.qrContent;
  const payload: Record<string, unknown> = {
    orderId: fields.orderId,
    amountCents: fields.amountCents,
    currency: 'CNY',
    payee,
    ...(fields.deadline !== undefined ? { deadline: fields.deadline } : {}),
  };
  return ['```' + PAYMENT_CARD_FENCE_TAG, JSON.stringify(payload), '```'].join('\n');
}

export type PayCardEmitValidation =
  | { ok: true; fields: PayCardEmitFields }
  | { ok: false; error: string };

/**
 * Validate the caller's args against the renderer contract AND the stored
 * receiving info. Refuses (never repairs, never fills placeholders):
 * a bad memo/orderId, a non-integer or out-of-range amount, a non-numeric
 * deadline, a stored blob that fails validatePaymentReceivingInfo, and a
 * stored blob with no usable Alipay receiving QR (a PID-only card has no
 * payable channel in this slice — the renderer's launch/degrade paths are
 * both qrContent-based).
 */
export function validatePayCardEmit(
  input: { orderId: unknown; amountCents: unknown; deadline: unknown },
  info: PaymentReceivingInfo | null,
): PayCardEmitValidation {
  const orderId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  if (!orderId) {
    return { ok: false, error: '未发卡：orderId 必填，它同时是付款备注（对账锚点），不能为空。' };
  }
  if (!ORDER_ID_RE.test(orderId)) {
    return {
      ok: false,
      error: `未发卡：orderId 同时是付款备注，必须匹配 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（不能含空格、中文或斜杠），收到的是「${orderId.slice(0, 64)}」。`,
    };
  }

  const amountCents = input.amountCents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents)) {
    return { ok: false, error: `未发卡：amountCents 必须是整数分（¥0.01 → 1），收到的是 ${String(amountCents)}。` };
  }
  if (amountCents < 1 || amountCents > MAX_PAY_CARD_AMOUNT_CENTS) {
    return {
      ok: false,
      error: `未发卡：amountCents 必须在 1 到 ${MAX_PAY_CARD_AMOUNT_CENTS} 之间（¥0.01–¥1,000,000.00），收到的是 ${amountCents}。`,
    };
  }

  let deadline: number | undefined;
  if (input.deadline != null) {
    if (typeof input.deadline !== 'number' || !Number.isInteger(input.deadline) || input.deadline <= 0) {
      return { ok: false, error: `未发卡：deadline 必须是 unix 毫秒时间戳（正整数），收到的是 ${String(input.deadline)}。` };
    }
    deadline = input.deadline;
  }

  if (!info) {
    return { ok: false, error: '未发卡：没有可用的收款信息。' };
  }
  const validated = validatePaymentReceivingInfo(info);
  if (!validated.ok || !validated.value) {
    // Error codes only — the stored value itself must never be echoed.
    return {
      ok: false,
      error: `未发卡：已保存的收款信息未通过校验（${validated.errors.join(', ') || 'INVALID'}）。`,
    };
  }
  const stored = validated.value;
  if (!stored.qrContent || !isValidAlipayQrContent(stored.qrContent)) {
    return {
      ok: false,
      error: '未发卡：已保存的收款信息里没有可用的支付宝收款码（qr.alipay.com）。这张卡没有可付款通道，请主人先在「设置 → 收款信息」补齐收款码。',
    };
  }

  const masked = stored.payeeDisplayName ? maskDisplayName(stored.payeeDisplayName) : '';
  return {
    ok: true,
    fields: {
      orderId,
      amountCents,
      qrContent: stored.qrContent,
      ...(masked ? { payeeDisplayName: masked } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
    },
  };
}

const NO_PAYMENT_INFO_HINT = [
  '未发卡：这台机器上还没有保存收款信息，我不会用占位数据编一张卡。',
  '请主人先在「设置 → 收款信息」里填写支付宝收款码（https://qr.alipay.com/…），然后再让我发卡。',
].join('\n');

/**
 * Build the payment_emit_card tool. One tool, one local read, one fence —
 * mounted for every cowork session (any supplier bot on this machine emits a
 * card that pays the OWNER, which is the G1 reuse requirement).
 */
export function buildPaymentCardAgentTools(deps: {
  tool: SdkToolFactory;
  control: PaymentCardAgentToolsControl;
}): unknown[] {
  const { tool, control } = deps;

  const emitCard = tool(
    'payment_emit_card',
    [
      'Emit a REAL fiat payment card (Alipay point-to-point) for the human owner of this machine, as the ```pay-card fenced block that chat renders as a PaymentCard.',
      'It reads the owner\'s locally stored, encrypted receiving info (Settings → 收款信息), decrypts it in the main process, checks it, and returns the card. Use it whenever a buyer must pay: NFT purchase, paid consultation, skill/service delivery, escrow order payment.',
      '',
      'Args:',
      '- orderId (required): the order id AND the payment memo (reconciliation anchor). [A-Za-z0-9][A-Za-z0-9._-]{0,63}.',
      '- amountCents (required): integer cents (¥0.01 → 1). Never guess or round — take it from the agreed price.',
      '- deadline (optional): unix MILLISECONDS timestamp shown as the payment deadline.',
      '',
      'Refusals (no card is produced, never with placeholder data): no receiving info saved, unreadable cipher, stored info failing validation, no Alipay receiving QR, invalid orderId/amount/deadline. Relay the refusal to the user and ask them to fix Settings → 收款信息; do not retry with invented values.',
      'Privacy: the receiving-code IMAGE never enters the reply; the payee display name is always masked. Zero funds flow: this tool does not move money, does not call a wallet, and writes nothing on-chain — the payer\'s Alipay pays the payee directly.',
    ].join('\n'),
    {
      orderId: z.string().min(1).describe('Order id and payment memo; [A-Za-z0-9][A-Za-z0-9._-]{0,63}.'),
      amountCents: z.number().int().min(1).describe('Amount in integer cents (¥0.01 → 1).'),
      deadline: z.number().int().positive().optional().describe('Optional payment deadline, unix milliseconds.'),
    },
    async (args: { orderId: string; amountCents: number; deadline?: number }) => {
      const read = control.readReceivingInfo();
      if (read.status === 'missing') {
        return { content: [{ type: 'text' as const, text: NO_PAYMENT_INFO_HINT }], isError: true } as any;
      }
      if (read.status === 'unavailable') {
        return {
          content: [{
            type: 'text' as const,
            text: `未发卡：已保存的收款信息读不出来（${read.reason}）。请在「设置 → 收款信息」里重新保存一次再试。`,
          }],
          isError: true,
        } as any;
      }

      const validated = validatePayCardEmit(
        { orderId: args?.orderId, amountCents: args?.amountCents, deadline: args?.deadline },
        read.info,
      );
      // `in` guard, not `!validated.ok`: this project compiles with
      // strictNullChecks off, where boolean-literal discriminated unions do
      // not narrow (electron-tsconfig.json).
      if ('error' in validated) {
        return { content: [{ type: 'text' as const, text: validated.error }], isError: true } as any;
      }

      const { fields } = validated;
      const yuan = `${Math.floor(fields.amountCents / 100)}.${String(fields.amountCents % 100).padStart(2, '0')}`;
      const payeeLine = fields.payeeDisplayName ? `收款方 ${fields.payeeDisplayName}。` : '';
      const lines = [
        buildPayCardFence(fields),
        '',
        `支付卡已生成：¥${yuan}（${fields.amountCents} 分），付款备注 ${fields.orderId}。${payeeLine}`,
        '点按卡片可唤起支付宝；唤起失败时用卡片上的收款码扫码支付。资金由付款方直接付给收款方，本工具不经过平台账户、不调用钱包、不写链。',
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] } as any;
    },
  );

  return [emitCard];
}
