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
});
