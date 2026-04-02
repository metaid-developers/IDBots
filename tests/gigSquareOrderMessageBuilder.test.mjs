import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBuyerOrderMessageSystemPrompt,
  buildBuyerOrderNaturalFallback,
  generateBuyerOrderNaturalText,
  normalizeBuyerOrderNaturalText,
} from '../src/renderer/components/gigSquare/gigSquareOrderMessageBuilder.mjs';
import {
  buildGigSquareOrderPayload,
  validateGigSquareOrderPrompt,
} from '../src/renderer/components/gigSquare/gigSquareOrderPayloadBuilder.mjs';

test('buildBuyerOrderMessageSystemPrompt keeps the LLM in buyer perspective and pushes transport metadata into structured fields only', () => {
  const prompt = buildBuyerOrderMessageSystemPrompt({
    buyerPersona: {
      name: 'Sky',
      role: 'Travel concierge',
      soul: 'Warm and concise',
      background: 'Helps users plan trips',
    },
    price: '0.00005',
    currency: 'SPACE',
    txid: 'a'.repeat(64),
    serviceId: 'service-weather',
    skillName: 'weather',
    requestText: '查询东京现在的天气',
  });

  assert.match(prompt, /buyer MetaBot/i);
  assert.match(prompt, /Do not restate any of those metadata fields/i);
  assert.match(prompt, /Do not say that you received payment/i);
  assert.match(prompt, /Do not use phrases like "已收到你xx的付款", "你收到一笔订单", "马上处理", or "正在处理"/);
  assert.match(prompt, /Focus only on the task the seller should perform/i);
  assert.match(prompt, /查询东京现在的天气/);
});

test('normalizeBuyerOrderNaturalText falls back when the generated text sounds like seller-side payment handling chatter', () => {
  const requestText = '查询北京天气';
  const normalized = normalizeBuyerOrderNaturalText(
    '[ORDER] 嘿，已收到你0.00005 SPACE的付款（交易ID: c5d434b5...），我需要调用weather技能来帮你查询北京天气。马上处理！\n支付金额 0.00005 SPACE\ntxid: c5d434b5cf68ea4f6dfb5f4b8da66c76027acbd90e89d7060dc523a5c04ee9ee\nservice id: svc-weather\nskill name: weather',
    requestText
  );

  assert.equal(normalized, buildBuyerOrderNaturalFallback(requestText));
});

test('normalizeBuyerOrderNaturalText falls back when the generated text says the seller received an order', () => {
  const requestText = '东京现在的天气';
  const normalized = normalizeBuyerOrderNaturalText(
    '嘿，你收到一笔0.00005 SPACE的订单啦！交易ID是 e896cb49ee740a963b623b77237def8c357f1fa3dfa385ec3625b7c979b10e58，需要你调用 weather 这个技能，帮忙查询一下"东京现在的天气"～',
    requestText
  );

  assert.equal(normalized, buildBuyerOrderNaturalFallback(requestText));
});

test('normalizeBuyerOrderNaturalText keeps a clean request-focused sentence intact', () => {
  const requestText = '查询东京现在的天气';
  const normalized = normalizeBuyerOrderNaturalText(
    '想请你帮我查询一下东京现在的天气。',
    requestText
  );

  assert.equal(normalized, '想请你帮我查询一下东京现在的天气。');
});

test('generateBuyerOrderNaturalText uses the LLM response when it resolves before the timeout', async () => {
  let cancelCalls = 0;

  const naturalText = await generateBuyerOrderNaturalText({
    buyerPersona: {
      name: 'Sky',
      role: 'Travel concierge',
    },
    price: '0.00005',
    currency: 'SPACE',
    txid: 'a'.repeat(64),
    serviceId: 'service-weather',
    skillName: 'weather',
    requestText: '查询东京现在的天气',
  }, {
    timeoutMs: 30,
    cancel: () => {
      cancelCalls += 1;
    },
    chat: async () => ({ content: '想请你帮我查询一下东京现在的天气。' }),
  });

  assert.equal(naturalText, '想请你帮我查询一下东京现在的天气。');
  assert.equal(cancelCalls, 0);
});

test('generateBuyerOrderNaturalText falls back and cancels when the LLM call hangs past timeout', async () => {
  let cancelCalls = 0;
  const requestText = '查询东京现在的天气';

  const naturalText = await generateBuyerOrderNaturalText({
    buyerPersona: {
      name: 'Sky',
    },
    price: '0.00005',
    currency: 'SPACE',
    txid: 'b'.repeat(64),
    serviceId: 'service-weather',
    skillName: 'weather',
    requestText,
  }, {
    timeoutMs: 20,
    cancel: () => {
      cancelCalls += 1;
    },
    chat: async () => new Promise(() => {}),
  });

  assert.equal(naturalText, buildBuyerOrderNaturalFallback(requestText));
  assert.equal(cancelCalls, 1);
});

test('buildGigSquareOrderPayload keeps the buyer-facing natural sentence and preserves the exact raw request block', () => {
  const payload = buildGigSquareOrderPayload({
    naturalOrderText: '想请你帮我查询一下东京今晚到明早的天气。',
    rawRequest: '请帮我查询东京今晚到明早的天气，并告诉我是否需要带伞和外套。',
    price: '0.00005',
    currency: 'SPACE',
    txid: 'a'.repeat(64),
    serviceId: 'service-weather',
    skillName: 'weather',
  });

  assert.match(payload, /^\[ORDER\] 想请你帮我查询一下东京今晚到明早的天气。/);
  assert.match(
    payload,
    /<raw_request>\n请帮我查询东京今晚到明早的天气，并告诉我是否需要带伞和外套。\n<\/raw_request>/
  );
  assert.match(payload, /支付金额 0\.00005 SPACE/);
  assert.match(payload, /service id: service-weather/);
  assert.match(payload, /skill name: weather/);
});

test('validateGigSquareOrderPrompt rejects requests longer than 4000 characters', () => {
  const valid = validateGigSquareOrderPrompt('x'.repeat(4000));
  const invalid = validateGigSquareOrderPrompt('x'.repeat(4001));

  assert.equal(valid.ok, true);
  assert.equal(valid.rawRequest.length, 4000);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'too_long');
  assert.equal(invalid.maxChars, 4000);
});
