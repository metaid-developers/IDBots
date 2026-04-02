import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('[DELEGATE_REMOTE_SERVICE] pattern parsing', () => {
  it('detects delegation control prefix anywhere in assistant content', async () => {
    const { containsDelegationControlPrefix } = await import('../dist-electron/libs/coworkRunner.js');
    assert.equal(containsDelegationControlPrefix('normal reply'), false);
    assert.equal(
      containsDelegationControlPrefix('I will hand this off now.\n[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"p1"}'),
      true
    );
  });

  it('parses valid delegation message', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    const content = `[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"pin123","serviceName":"Test Service","providerGlobalMetaid":"gm456","price":"200","currency":"SPACE","userTask":"translate article","taskContext":"article text"}`;
    const result = parseDelegationMessage(content);
    assert.ok(result);
    assert.equal(result.servicePinId, 'pin123');
    assert.equal(result.serviceName, 'Test Service');
    assert.equal(result.price, '200');
    assert.equal(result.currency, 'SPACE');
    assert.equal(result.userTask, 'translate article');
  });

  it('normalizes decorated price strings before payment', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    const content = `[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"pin123","serviceName":"Test Service","providerGlobalMetaid":"gm456","price":"0.00001 SPACE","currency":"SPACE","userTask":"translate article","taskContext":"article text"}`;
    const result = parseDelegationMessage(content);
    assert.ok(result);
    assert.equal(result.price, '0.00001');
    assert.equal(result.currency, 'SPACE');
  });

  it('backfills currency from decorated price when currency field is blank', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    const content = `[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"pin123","serviceName":"Test Service","providerGlobalMetaid":"gm456","price":"0.01 DOGE","currency":"","userTask":"translate article","taskContext":"article text"}`;
    const result = parseDelegationMessage(content);
    assert.ok(result);
    assert.equal(result.price, '0.01');
    assert.equal(result.currency, 'DOGE');
  });

  it('returns null for non-delegation messages', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    assert.equal(parseDelegationMessage('Hello, how are you?'), null);
    assert.equal(parseDelegationMessage('[ORDER] some order'), null);
  });

  it('handles JSON embedded in surrounding text', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    const content = `I will delegate this task.\n[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"p1","serviceName":"Svc","providerGlobalMetaid":"gm","price":"100","currency":"SPACE","userTask":"task","taskContext":"ctx"}`;
    const result = parseDelegationMessage(content);
    assert.ok(result);
    assert.equal(result.servicePinId, 'p1');
  });

  it('returns null for malformed JSON', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    const content = `[DELEGATE_REMOTE_SERVICE]\n{not valid json}`;
    assert.equal(parseDelegationMessage(content), null);
  });

  it('returns null when required fields are missing', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');
    const content = `[DELEGATE_REMOTE_SERVICE]\n{"price":"200","currency":"SPACE"}`;
    assert.equal(parseDelegationMessage(content), null);
  });

  it('hides a trailing partial delegation control prefix from the displayed assistant text', async () => {
    const { getDelegationDisplayText } = await import('../dist-electron/libs/coworkRunner.js');
    const content = '好的，我现在为你委托这个塔罗牌占卜服务。\n\n[DELEGATE_REMOTE_S';
    assert.equal(
      getDelegationDisplayText(content),
      '好的，我现在为你委托这个塔罗牌占卜服务。'
    );
  });

  it('keeps only the natural-language preamble when the full delegation control block is present', async () => {
    const { getDelegationDisplayText } = await import('../dist-electron/libs/coworkRunner.js');
    const content = '好的，我现在为你委托这个塔罗牌占卜服务。\n\n[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"p1","serviceName":"塔罗牌占卜","providerGlobalMetaid":"gm","price":"0.00005","currency":"SPACE","userTask":"塔罗牌占卜","taskContext":"塔罗牌占卜"}';
    assert.equal(
      getDelegationDisplayText(content),
      '好的，我现在为你委托这个塔罗牌占卜服务。'
    );
  });

  it('treats generic confirmations as non-metaapp requests', async () => {
    const { isExplicitMetaAppUserRequest } = await import('../dist-electron/libs/coworkRunner.js');
    assert.equal(isExplicitMetaAppUserRequest('好的', 'buzz'), false);
    assert.equal(isExplicitMetaAppUserRequest('确定', 'buzz'), false);
    assert.equal(isExplicitMetaAppUserRequest('继续', 'buzz'), false);
  });

  it('allows metaapp routing only for explicit app-opening requests', async () => {
    const { isExplicitMetaAppUserRequest } = await import('../dist-electron/libs/coworkRunner.js');
    assert.equal(isExplicitMetaAppUserRequest('打开 buzz app', 'buzz'), true);
    assert.equal(isExplicitMetaAppUserRequest('请使用 buzz 这个 MetaApp', 'buzz'), true);
    assert.equal(isExplicitMetaAppUserRequest('帮我查一下东京天气', 'buzz'), false);
  });
});
