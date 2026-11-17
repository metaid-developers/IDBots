// payment_emit_card — the S3 fiat payment-card emitter as an agent tool (G1).
// Run through `pnpm run test:s3-payment` (tsx, no compile step needed).
//
// Pins:
//   1. no saved receiving info          → refused, no fence
//   2. unreadable cipher                → refused, no fence
//   3. stored info failing validation   → refused, no fence, value never echoed
//   4. stored info without an Alipay QR → refused, no fence
//   5. invalid orderId / amount / deadline → refused, no fence
//   6. happy path: the emitted fence is parsed by the REAL renderer parser
//      (src/renderer/components/chat/paymentCardSyntax.ts) and every field
//      equals the input, with the display name masked and the archived QR
//      image never leaving the store
//   7. the module imports exactly zod + the payment-info crypto helpers — no
//      wallet, no transfer, no chain write (zero funds flow, statically)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  buildPaymentCardAgentTools,
  MAX_PAY_CARD_AMOUNT_CENTS,
} from '../src/main/libs/paymentCardAgentTools';
import {
  decryptPaymentInfo,
  derivePaymentInfoKey,
  encryptPaymentInfo,
} from '../src/main/services/paymentInfoCrypto';
import {
  parsePayCardFence,
  PAY_CARD_FENCE_TAG,
} from '../src/renderer/components/chat/paymentCardSyntax';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const QR = 'https://qr.alipay.com/abc123xyz';
const PID = '2088000000000000'; // 2088 + 12 digits

/** A stored row as main.ts decrypts it (the archived image included). */
const storedInfo = (overrides: Record<string, unknown> = {}) => ({
  payeeDisplayName: '张三丰',
  qrContent: QR,
  qrImageDataUrl: 'data:image/png;base64,AAAA',
  ...overrides,
});

type ReadResult =
  | { status: 'ok'; info: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: string };

/** Build the tool for one control answer and return its handler + schema. */
function buildTool(read: ReadResult) {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  let schema: Record<string, unknown> = {};
  const tool = (name: string, _description: string, toolSchema: Record<string, unknown>, handler: (args: any) => Promise<any>) => {
    handlers[name] = handler;
    schema = toolSchema;
    return { name };
  };
  buildPaymentCardAgentTools({ tool, control: { readReceivingInfo: () => read } });
  return { handlers, schema, names: Object.keys(handlers) };
}

const textOf = (result: any): string => result.content[0].text;

/** Extract the pay-card fence body from a tool result, or null. */
function fenceBody(text: string): string | null {
  const opener = '```' + PAY_CARD_FENCE_TAG + '\n';
  const start = text.indexOf(opener);
  if (start < 0) return null;
  const bodyStart = start + opener.length;
  const end = text.indexOf('\n```', bodyStart);
  if (end < 0) return null;
  return text.slice(bodyStart, end);
}

/** Assert the result is a refusal that produced no card at all. */
function assertRefused(result: any) {
  assert.equal(result.isError, true, 'refusal must be flagged isError');
  const text = textOf(result);
  assert.equal(fenceBody(text), null, 'a refusal must never carry a pay-card fence');
  assert.ok(text.startsWith('未发卡'), `refusal text should start with 未发卡, got: ${text}`);
  return text;
}

const emit = async (read: ReadResult, args: Record<string, unknown>) =>
  buildTool(read).handlers.payment_emit_card(args);

// ---------------------------------------------------------------------------

test('registers exactly one tool named payment_emit_card', () => {
  const { names, handlers } = buildTool({ status: 'missing' });
  assert.deepEqual(names, ['payment_emit_card']);
  assert.equal(typeof handlers.payment_emit_card, 'function');
});

test('refuses when no receiving info is saved', async () => {
  const result = await emit({ status: 'missing' }, { orderId: 'G1-1', amountCents: 1 });
  const text = assertRefused(result);
  assert.match(text, /设置 → 收款信息/);
});

test('refuses when the saved cipher cannot be decrypted', async () => {
  const result = await emit(
    { status: 'unavailable', reason: 'the saved receiving info could not be decrypted on this machine' },
    { orderId: 'G1-2', amountCents: 1 },
  );
  const text = assertRefused(result);
  assert.match(text, /读不出来/);
});

test('refuses a stored QR that fails the qr.alipay.com prefix gate, without echoing it', async () => {
  const hostileQr = 'https://weixin.qq.com/not-alipay-9f2';
  const result = await emit(
    { status: 'ok', info: storedInfo({ qrContent: hostileQr }) },
    { orderId: 'G1-3', amountCents: 1 },
  );
  const text = assertRefused(result);
  assert.match(text, /INVALID_QR_CONTENT/);
  assert.equal(text.includes(hostileQr), false, 'the rejected stored value must not be echoed');
});

test('refuses a PID-only receiving info (no payable QR channel in this slice)', async () => {
  const result = await emit(
    { status: 'ok', info: { payeeDisplayName: '张三丰', alipayPid: PID } },
    { orderId: 'G1-4', amountCents: 1 },
  );
  const text = assertRefused(result);
  assert.match(text, /没有可用的支付宝收款码/);
});

test('refuses a stored blob with no receiving channel at all', async () => {
  const result = await emit(
    { status: 'ok', info: { payeeDisplayName: '张三丰', qrImageDataUrl: 'data:image/png;base64,AAAA' } },
    { orderId: 'G1-5', amountCents: 1 },
  );
  assertRefused(result);
});

for (const amountCents of [0, -100, 1.5, MAX_PAY_CARD_AMOUNT_CENTS + 1, undefined]) {
  test(`refuses amountCents=${String(amountCents)}`, async () => {
    const result = await emit({ status: 'ok', info: storedInfo() }, { orderId: 'G1-AMT', amountCents });
    const text = assertRefused(result);
    assert.match(text, /amountCents/);
  });
}

for (const orderId of ['', '   ', 'has space', '中文单号', '-leading-dash', 'x'.repeat(65)]) {
  test(`refuses orderId=${JSON.stringify(orderId)}`, async () => {
    const result = await emit({ status: 'ok', info: storedInfo() }, { orderId, amountCents: 1 });
    const text = assertRefused(result);
    assert.match(text, /orderId/);
  });
}

for (const deadline of [0, -1, 1.5, 'tomorrow']) {
  test(`refuses deadline=${String(deadline)}`, async () => {
    const result = await emit({ status: 'ok', info: storedInfo() }, { orderId: 'G1-DL', amountCents: 1, deadline });
    const text = assertRefused(result);
    assert.match(text, /deadline/);
  });
}

test('happy path: fence parses through the real renderer parser, field by field', async () => {
  const deadline = 1794894709380;
  const call = { orderId: 'G1-20261117-0001', amountCents: 1234, deadline };
  const result = await emit({ status: 'ok', info: storedInfo() }, call);

  assert.notEqual(result.isError, true);
  const text = textOf(result);

  const body = fenceBody(text);
  assert.ok(body, 'the result must carry a ```pay-card fence');

  // 1) The REAL renderer parser must accept it…
  const parsed = parsePayCardFence(body!);
  assert.ok(parsed, 'parsePayCardFence must accept the emitted payload');

  // 2) …and produce exactly the contracted fields.
  assert.deepEqual(parsed, {
    orderId: call.orderId,
    amountCents: call.amountCents,
    currency: 'CNY',
    payee: { displayName: '张*丰', qrContent: QR },
    deadline,
  });

  // 3) Raw JSON: exact key sets, no extra field sneaking in.
  const raw = JSON.parse(body!);
  assert.deepEqual(Object.keys(raw).sort(), ['amountCents', 'currency', 'deadline', 'orderId', 'payee']);
  assert.deepEqual(Object.keys(raw.payee).sort(), ['displayName', 'qrContent']);
  assert.equal(raw.orderId, call.orderId);
  assert.equal(raw.amountCents, call.amountCents);
  assert.equal(raw.currency, 'CNY');
  assert.equal(raw.payee.qrContent, QR);
  assert.equal(raw.deadline, deadline);

  // 4) Privacy: masked name only; the archived QR image never leaves.
  assert.equal(text.includes('张三丰'), false, 'the unmasked display name must never appear');
  assert.equal(text.includes('data:image'), false, 'the archived QR image must never appear');
  assert.equal(text.includes('qrImageDataUrl'), false);

  // 5) The human line states the same amount the fence charges.
  assert.match(text, /¥12\.34（1234 分）/);
  assert.ok(text.includes(call.orderId));
});

test('happy path keeps optional fields absent instead of inventing them', async () => {
  const result = await emit(
    { status: 'ok', info: { qrContent: QR } },
    { orderId: 'G1-NO-OPTIONALS', amountCents: 1 },
  );
  const body = fenceBody(textOf(result));
  assert.ok(body);
  const raw = JSON.parse(body!);
  assert.deepEqual(Object.keys(raw).sort(), ['amountCents', 'currency', 'orderId', 'payee']);
  assert.deepEqual(Object.keys(raw.payee), ['qrContent'], 'no displayName invented when the owner saved none');

  const parsed = parsePayCardFence(body!);
  assert.ok(parsed);
  assert.deepEqual(parsed, {
    orderId: 'G1-NO-OPTIONALS',
    amountCents: 1,
    currency: 'CNY',
    payee: { qrContent: QR },
  });
});

test('the tool schema itself rejects a zero / fractional amount (defense in depth)', () => {
  const { schema } = buildTool({ status: 'missing' });
  const contract = z.object(schema as Record<string, z.ZodTypeAny>);
  assert.throws(() => contract.parse({ orderId: 'G1-Z', amountCents: 0 }));
  assert.throws(() => contract.parse({ orderId: 'G1-Z', amountCents: 1.5 }));
  assert.doesNotThrow(() => contract.parse({ orderId: 'G1-Z', amountCents: 1 }));
});

test('zero funds flow: the module imports only zod + the payment-info crypto helpers', () => {
  const source = fs.readFileSync(path.join(HERE, '../src/main/libs/paymentCardAgentTools.ts'), 'utf8');
  const importSpecifiers = [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(importSpecifiers.sort(), ['../services/paymentInfoCrypto', 'zod']);
});

test('end to end over a REAL encrypted blob: derive key → decrypt → card', async () => {
  // Fixture identity (the BIP-39 published test vector) — never the owner's.
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const globalMetaId = 'idq1g1fixture0000000000000000000000000000';

  const key = derivePaymentInfoKey(mnemonic, globalMetaId);
  const cipher = encryptPaymentInfo(key, { payeeDisplayName: '李四', qrContent: QR });

  // The control mirrors main.ts: read the row, derive the at-rest key, decrypt.
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const tool = (name: string, _d: string, _s: Record<string, unknown>, handler: (args: any) => Promise<any>) => {
    handlers[name] = handler;
    return { name };
  };
  buildPaymentCardAgentTools({
    tool,
    control: {
      readReceivingInfo: () => ({
        status: 'ok',
        info: decryptPaymentInfo(derivePaymentInfoKey(mnemonic, globalMetaId), cipher),
      }),
    },
  });

  const result = await handlers.payment_emit_card({ orderId: 'G1-E2E-1', amountCents: 1 });
  assert.notEqual(result.isError, true);
  const body = fenceBody(textOf(result));
  assert.ok(body);
  const parsed = parsePayCardFence(body!);
  assert.deepEqual(parsed, {
    orderId: 'G1-E2E-1',
    amountCents: 1,
    currency: 'CNY',
    payee: { displayName: '李*', qrContent: QR },
  });

  // A tampered ciphertext must surface as 'unavailable' rather than a card.
  const tampered = Buffer.from(cipher);
  tampered[tampered.length - 1] ^= 0xff;
  const badHandlers: Record<string, (args: any) => Promise<any>> = {};
  buildPaymentCardAgentTools({
    tool: (name, _d, _s, handler) => { badHandlers[name] = handler; return { name }; },
    control: {
      readReceivingInfo: () => {
        try {
          return { status: 'ok', info: decryptPaymentInfo(derivePaymentInfoKey(mnemonic, globalMetaId), tampered) };
        } catch {
          return { status: 'unavailable', reason: 'the saved receiving info could not be decrypted on this machine' };
        }
      },
    },
  });
  const refused = await badHandlers.payment_emit_card({ orderId: 'G1-E2E-2', amountCents: 1 });
  assertRefused(refused);
});
