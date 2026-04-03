import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildDelegationOrderPayload,
} = await import('../dist-electron/services/delegationOrderMessage.js');

test('buildDelegationOrderPayload emits an [ORDER] message that preserves providerSkill metadata', () => {
  const payload = buildDelegationOrderPayload({
    rawRequest: '请完整查询北京今天的天气，并告诉我是否适合晚上出门散步。',
    taskContext: '用户请求查询北京天气，已确认同意使用远程MetaBot服务，支付0.0001 SPACE费用',
    userTask: '查询北京天气',
    serviceName: '获取天气服务',
    providerSkill: 'weather',
    servicePinId: 'service-pin-weather',
    paymentTxid: 'a'.repeat(64),
    price: '0.0001',
    currency: 'SPACE',
  });

  assert.match(payload, /^\[ORDER\]\s+/);
  assert.match(payload, /用户请求查询北京天气/);
  assert.match(
    payload,
    /<raw_request>\n请完整查询北京今天的天气，并告诉我是否适合晚上出门散步。\n<\/raw_request>/
  );
  assert.doesNotMatch(payload, /\[ORDER\][^\n]*支付0\.0001 SPACE费用/);
  assert.match(payload, /支付金额 0\.0001 SPACE/);
  assert.match(payload, new RegExp(`txid: ${'a'.repeat(64)}`));
  assert.match(payload, /service id: service-pin-weather/);
  assert.match(payload, /skill name: weather/);
  assert.doesNotMatch(payload, /skill name: 获取天气服务/);
});

test('buildDelegationOrderPayload omits txid for free orders and keeps an order id reference', () => {
  const orderId = 'f'.repeat(64);
  const payload = buildDelegationOrderPayload({
    rawRequest: '帮我查询北京天气',
    taskContext: '查询北京天气',
    userTask: '查询北京天气',
    serviceName: '获取天气服务',
    providerSkill: 'weather',
    servicePinId: 'service-pin-weather',
    paymentTxid: '',
    orderReference: orderId,
    price: '0',
    currency: 'SPACE',
  });

  assert.match(payload, /^\[ORDER\]\s+/);
  assert.match(payload, /支付金额 0 SPACE/);
  assert.match(payload, new RegExp(`order id: ${orderId}`));
  assert.doesNotMatch(payload, /txid:/i);
});

test('buildDelegationOrderPayload falls back to the service name when providerSkill is unavailable', () => {
  const payload = buildDelegationOrderPayload({
    taskContext: '',
    userTask: '帮我总结今天的会议',
    serviceName: '会议总结服务',
    providerSkill: '',
    servicePinId: 'service-pin-summary',
    paymentTxid: 'b'.repeat(64),
    price: '1.5',
    currency: 'SPACE',
  });

  assert.match(payload, /^\[ORDER\] 帮我总结今天的会议/);
  assert.match(payload, /<raw_request>\n帮我总结今天的会议\n<\/raw_request>/);
  assert.match(payload, /service id: service-pin-summary/);
  assert.match(payload, /skill name: 会议总结服务/);
});

test('buildDelegationOrderPayload keeps the original rawRequest even when the summary fields are shortened', () => {
  const payload = buildDelegationOrderPayload({
    rawRequest: '请帮我把这段会议纪要整理成：1）三点摘要；2）行动项；3）需要老板确认的风险点。',
    taskContext: '整理会议纪要',
    userTask: '会议纪要整理',
    serviceName: '会议总结服务',
    providerSkill: 'meeting-summary',
    servicePinId: 'service-pin-meeting',
    paymentTxid: 'd'.repeat(64),
    price: '0.2',
    currency: 'SPACE',
  });

  assert.match(payload, /^\[ORDER\] 整理会议纪要/);
  assert.match(
    payload,
    /<raw_request>\n请帮我把这段会议纪要整理成：1）三点摘要；2）行动项；3）需要老板确认的风险点。\n<\/raw_request>/
  );
});
