import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkOrderPaymentStatus,
  extractOrderReferenceId,
  extractOrderRequestText,
  extractOrderSkillId,
  extractOrderSkillName,
} from '../src/main/services/orderPayment';

test('extractOrderSkillId parses explicit service metadata lines appended to order messages', () => {
  const text = [
    '[ORDER] 请帮我查一下香港天气。',
    '支付金额 0.0001 SPACE',
    `txid: ${'a'.repeat(64)}`,
    'service id: svc-weather-v2',
    'skill name: weather',
  ].join('\n');

  assert.equal(extractOrderSkillId(text), 'svc-weather-v2');
  assert.equal(extractOrderSkillName(text), 'weather');
});

test('extractOrderSkillId tolerates service pin id labels and Chinese punctuation', () => {
  const text = [
    '[ORDER] 帮我发一条链上消息。',
    `txid：${'b'.repeat(64)}`,
    'service pin id：svc-post-buzz',
    '技能名称：metabot-post-buzz',
  ].join('\n');

  assert.equal(extractOrderSkillId(text), 'svc-post-buzz');
  assert.equal(extractOrderSkillName(text), 'metabot-post-buzz');
});

test('extractOrderReferenceId parses free-order structured order id metadata', () => {
  const text = [
    '[ORDER] 帮我整理一段文本。',
    '支付金额 0 SPACE',
    `order id: ${'c'.repeat(64)}`,
    'service id: svc-free-note',
    'skill name: summarizer',
  ].join('\n');

  assert.equal(extractOrderReferenceId(text), 'c'.repeat(64));
});

test('extractOrderRequestText prefers the explicit raw_request block over the display summary line', () => {
  const rawRequest = [
    '请帮我查询一下东京今天从早到晚的天气变化，并告诉我是否适合晚上外出散步。',
    '如果会下雨，也请补充携带雨具的建议。',
  ].join('\n');
  const text = [
    '[ORDER] 想请你帮我处理这个天气需求。',
    '<raw_request>',
    rawRequest,
    '</raw_request>',
    '支付金额 0.0001 SPACE',
    `txid: ${'c'.repeat(64)}`,
    'service id: svc-weather-v3',
    'skill name: weather',
  ].join('\n');

  assert.equal(extractOrderRequestText(text), rawRequest);
});

test('checkOrderPaymentStatus allows free order messages without on-chain txid', async () => {
  const text = [
    '[ORDER] 帮我整理一段文本。',
    '支付金额 0 SPACE',
  ].join('\n');

  const result = await checkOrderPaymentStatus({
    txid: null,
    plaintext: text,
    source: 'metaweb_private',
    metabotId: 1,
    metabotStore: {} as any,
  });

  assert.equal(result.paid, true);
  assert.equal(result.reason, 'free_order_no_payment_required');
  assert.equal(result.amountSats, 0);
  assert.equal(result.chain, 'mvc');
});

test('checkOrderPaymentStatus allows free order messages with an order id but without txid', async () => {
  const text = [
    '[ORDER] 帮我整理一段文本。',
    '支付金额 0 SPACE',
    `order id: ${'d'.repeat(64)}`,
  ].join('\n');

  const result = await checkOrderPaymentStatus({
    txid: null,
    plaintext: text,
    source: 'metaweb_private',
    metabotId: 1,
    metabotStore: {} as any,
  });

  assert.equal(result.paid, true);
  assert.equal(result.reason, 'free_order_no_payment_required');
  assert.equal(result.amountSats, 0);
});

test('checkOrderPaymentStatus still requires txid for paid orders', async () => {
  const text = [
    '[ORDER] 帮我整理一段文本。',
    '支付金额 0.1 SPACE',
  ].join('\n');

  const result = await checkOrderPaymentStatus({
    txid: null,
    plaintext: text,
    source: 'metaweb_private',
    metabotId: 1,
    metabotStore: {} as any,
  });

  assert.equal(result.paid, false);
  assert.equal(result.reason, 'invalid_or_missing_txid');
});
