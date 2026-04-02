import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildDelegationOrderPayload,
} = await import('../dist-electron/services/delegationOrderMessage.js');

test('buildDelegationOrderPayload emits an [ORDER] message that preserves providerSkill metadata', () => {
  const payload = buildDelegationOrderPayload({
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
  assert.doesNotMatch(payload, /\[ORDER\][^\n]*支付0\.0001 SPACE费用/);
  assert.match(payload, /支付金额 0\.0001 SPACE/);
  assert.match(payload, new RegExp(`txid: ${'a'.repeat(64)}`));
  assert.match(payload, /service id: service-pin-weather/);
  assert.match(payload, /skill name: weather/);
  assert.doesNotMatch(payload, /skill name: 获取天气服务/);
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
  assert.match(payload, /service id: service-pin-summary/);
  assert.match(payload, /skill name: 会议总结服务/);
});
