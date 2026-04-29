import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBuyerRatingSystemPrompt,
  deliveryResultHasExpectedArtifact,
  isOrderDeliveryFailureNotice,
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

test('isOrderDeliveryFailureNotice detects explicit missing media delivery notices', () => {
  assert.equal(
    isOrderDeliveryFailureNotice('服务方未能按约定交付 image 数字成果。\n系统将自动转入退款流程，请勿对本次服务进行好评确认。'),
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
