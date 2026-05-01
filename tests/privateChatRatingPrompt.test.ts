import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBuyerRatingSystemPrompt,
  deliveryResultHasExpectedArtifact,
  isOrderDeliveryFailureNotice,
  resolveBuyerRatingContext,
  resolveBuyerOrderOutputType,
  resolveSellerOrderOutputType,
} from '../src/main/services/privateChatDaemon';

test('buildBuyerRatingSystemPrompt instructs buyer to reject missing image delivery artifacts', () => {
  const prompt = buildBuyerRatingSystemPrompt({
    personaLines: 'Your name is Sunny.',
    originalRequest: '请生成火箭发射图片',
    serviceResult: '火箭发射图片已生成，保存在 rocket_launch.png。',
    expectedOutputType: 'image',
  });

  assert.match(prompt, /Expected output type:\s*image/i);
  assert.match(prompt, /metafile:\/\/.*image/i);
  assert.match(prompt, /reject/i);
  assert.match(prompt, /refund/i);
});

test('buildBuyerRatingSystemPrompt includes complete medium-length text delivery for rating', () => {
  const days = Array.from({ length: 5 }, (_, index) => {
    const day = index + 1;
    return [
      `## Day ${day}`,
      `Weather details for day ${day}.`,
      `Temperature range ${10 + day}C to ${20 + day}C.`,
      `Travel advice for day ${day}.`,
      'Extra details: '.padEnd(140, String(day)),
    ].join('\n');
  }).join('\n\n');

  assert.ok(days.length > 500, 'fixture should exceed the old 500 character prompt limit');

  const prompt = buildBuyerRatingSystemPrompt({
    originalRequest: 'I need a complete five day forecast for my trip.',
    serviceResult: days,
    expectedOutputType: 'text',
  });

  assert.match(prompt, /Day 1/);
  assert.match(prompt, /Day 5/);
  assert.match(prompt, /Travel advice for day 5/);
});

test('buildBuyerRatingSystemPrompt marks prompt-side excerpts without hiding the delivery ending', () => {
  const serviceResult = [
    'BEGIN COMPLETE DELIVERY',
    'A'.repeat(7000),
    'END COMPLETE DELIVERY WITH FINAL DAY SUMMARY',
  ].join('\n');

  const prompt = buildBuyerRatingSystemPrompt({
    originalRequest: 'Please review a long complete delivery.',
    serviceResult,
    expectedOutputType: 'text',
  });

  assert.match(prompt, /BEGIN COMPLETE DELIVERY/);
  assert.match(prompt, /END COMPLETE DELIVERY WITH FINAL DAY SUMMARY/);
  assert.match(prompt, /prompt-side omission/i);
  assert.match(prompt, /Do not treat this prompt-side omission as missing or incomplete delivery/i);
});

test('isOrderDeliveryFailureNotice detects explicit missing media delivery notices', () => {
  assert.equal(
    isOrderDeliveryFailureNotice('服务方未能按约定交付 image 数字成果。\n系统将自动转入退款流程，请勿对本次服务进行好评确认。'),
    true
  );
  assert.equal(
    isOrderDeliveryFailureNotice('服务方未能按约定交付 text 服务结果。\n技能执行结束，但没有生成可交付的最终回复。\n系统将自动转入退款流程，请勿对本次服务进行好评确认。'),
    true
  );
  assert.equal(
    isOrderDeliveryFailureNotice('数字成果已生成并上传链上交付。\nPINID: abc123i0'),
    false
  );
});

test('deliveryResultHasExpectedArtifact requires a matching metafile for non-text deliveries', () => {
  assert.equal(
    deliveryResultHasExpectedArtifact('图片已生成，保存在 /tmp/rocket.png。', 'image'),
    false
  );
  assert.equal(
    deliveryResultHasExpectedArtifact('交付文件: metafile://abc123i0.png\nPINID: abc123i0', 'image'),
    true
  );
  assert.equal(
    deliveryResultHasExpectedArtifact('交付文件: metafile://abc123i0.mp4\nPINID: abc123i0', 'image'),
    false
  );
  assert.equal(
    deliveryResultHasExpectedArtifact('普通文字结果', 'text'),
    true
  );
});

test('resolveBuyerOrderOutputType falls back to service metadata for legacy buyer orders', () => {
  const orderPayload = [
    '[ORDER] 请生成一张历史插图。',
    '支付金额 0.001 SPACE',
    `txid: ${'a'.repeat(64)}`,
    'service id: svc-image-pin',
    'skill name: seedream',
  ].join('\n');

  const outputType = resolveBuyerOrderOutputType({
    buyerOrderMeta: {
      serviceId: 'svc-image-pin',
      serviceSkill: 'seedream',
    },
    orderPayload,
    resolveLocalServiceOutputType: ({ serviceId }) => (
      serviceId === 'svc-image-pin' ? 'image' : null
    ),
  });

  assert.equal(outputType, 'image');
  assert.equal(deliveryResultHasExpectedArtifact('图片已生成，保存在 /tmp/local.png。', outputType), false);
});

test('resolveSellerOrderOutputType falls back to the local service output type for old orders', () => {
  const plaintext = [
    '[ORDER] 请生成一张历史插图。',
    '支付金额 0.001 SPACE',
    `txid: ${'a'.repeat(64)}`,
    'service id: svc-image-pin',
    'skill name: seedream',
  ].join('\n');

  const outputType = resolveSellerOrderOutputType({
    plaintext,
    serviceId: 'svc-image-pin',
    serviceName: 'seedream',
    resolveLocalServiceOutputType: ({ serviceId }) => (
      serviceId === 'svc-image-pin' ? 'image' : null
    ),
  });

  assert.equal(outputType, 'image');
});

test('resolveBuyerRatingContext scopes request and delivery by order txid in a unified peer session', () => {
  const oldWeatherOrderTxid = '1'.repeat(64);
  const currentWeatherOrderTxid = '2'.repeat(64);
  const oldImageOrderTxid = '3'.repeat(64);
  const currentImageOrderTxid = '4'.repeat(64);
  const messages = [
    {
      id: 'old-weather-order',
      type: 'user',
      content: '[ORDER] 查询广州天气',
      metadata: { direction: 'outgoing', orderTxid: oldWeatherOrderTxid },
    },
    {
      id: 'old-weather-delivery',
      type: 'assistant',
      content: `[DELIVERY:${oldWeatherOrderTxid}] {"result":"广州天气：晴，30°C"} `,
      metadata: { direction: 'incoming', orderTxid: oldWeatherOrderTxid },
    },
    {
      id: 'old-image-order',
      type: 'user',
      content: '[ORDER] 生成火箭发射图片',
      metadata: { direction: 'outgoing', orderTxid: oldImageOrderTxid },
    },
    {
      id: 'old-image-delivery',
      type: 'assistant',
      content: `[DELIVERY:${oldImageOrderTxid}] {"result":"火箭发射图片：metafile://rocketi0.png"} `,
      metadata: { direction: 'incoming', orderTxid: oldImageOrderTxid },
    },
    {
      id: 'current-weather-order',
      type: 'user',
      content: '[ORDER] 查询新加坡天气',
      metadata: { direction: 'outgoing', orderTxid: currentWeatherOrderTxid },
    },
    {
      id: 'current-weather-delivery',
      type: 'assistant',
      content: `[DELIVERY:${currentWeatherOrderTxid}] {"result":"新加坡天气：多云，29°C"} `,
      metadata: { direction: 'incoming', orderTxid: currentWeatherOrderTxid },
    },
    {
      id: 'current-image-order',
      type: 'user',
      content: '[ORDER] 生成一张小狗跳舞图片',
      metadata: { direction: 'outgoing', orderTxid: currentImageOrderTxid },
    },
    {
      id: 'current-image-delivery',
      type: 'assistant',
      content: `[DELIVERY:${currentImageOrderTxid}] {"result":"小狗跳舞图片：metafile://dogi0.png"} `,
      metadata: { direction: 'incoming', orderTxid: currentImageOrderTxid },
    },
    {
      id: 'current-image-needs-rating',
      type: 'assistant',
      content: `[NeedsRating:${currentImageOrderTxid}] 请评价本次服务`,
      metadata: { direction: 'incoming', orderTxid: currentImageOrderTxid },
    },
  ];

  const weatherContext = resolveBuyerRatingContext({
    messages,
    orderTxid: currentWeatherOrderTxid,
  });
  assert.match(weatherContext.originalRequest, /新加坡天气/);
  assert.match(weatherContext.serviceResult, /新加坡天气/);
  assert.doesNotMatch(weatherContext.originalRequest, /广州天气/);
  assert.doesNotMatch(weatherContext.serviceResult, /广州天气/);

  const imageContext = resolveBuyerRatingContext({
    messages,
    orderTxid: currentImageOrderTxid,
  });
  assert.match(imageContext.originalRequest, /小狗跳舞/);
  assert.match(imageContext.serviceResult, /小狗跳舞/);
  assert.doesNotMatch(imageContext.originalRequest, /火箭发射/);
  assert.doesNotMatch(imageContext.serviceResult, /火箭发射/);
});

test('resolveBuyerRatingContext does not fall back to unrelated orders when an order txid is provided', () => {
  const knownOrderTxid = '5'.repeat(64);
  const missingOrderTxid = '6'.repeat(64);
  const context = resolveBuyerRatingContext({
    orderTxid: missingOrderTxid,
    messages: [
      {
        id: 'known-order',
        type: 'user',
        content: '[ORDER] 查询广州天气',
        metadata: { direction: 'outgoing', orderTxid: knownOrderTxid },
      },
      {
        id: 'known-delivery',
        type: 'assistant',
        content: `[DELIVERY:${knownOrderTxid}] {"result":"广州天气：晴，30°C"} `,
        metadata: { direction: 'incoming', orderTxid: knownOrderTxid },
      },
    ],
  });

  assert.equal(context.originalRequest, '');
  assert.equal(context.serviceResult, '');
});
