import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildModifyMetaidPayload,
  buildRevokeMetaidPayload,
} = require('../dist-electron/services/metaidPinMutationService.js');

test('buildRevokeMetaidPayload creates a generic MetaID revoke tuple', () => {
  const payload = buildRevokeMetaidPayload('pin-1');

  assert.equal(payload.operation, 'revoke');
  assert.equal(payload.path, '@pin-1');
  assert.equal(payload.encryption, '0');
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.contentType, 'application/json');
  assert.equal(payload.payload, '');
});

test('buildModifyMetaidPayload creates a generic MetaID modify tuple', () => {
  const payload = buildModifyMetaidPayload({
    targetPinId: 'pin-2',
    payload: '{"hello":"world"}',
  });

  assert.equal(payload.operation, 'modify');
  assert.equal(payload.path, '@pin-2');
  assert.equal(payload.encryption, '0');
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.contentType, 'application/json');
  assert.equal(payload.payload, '{"hello":"world"}');
});

test('buildModifyMetaidPayload allows overriding contentType for non-json payloads', () => {
  const payload = buildModifyMetaidPayload({
    targetPinId: 'pin-3',
    payload: 'plain text',
    contentType: 'text/plain',
  });

  assert.equal(payload.contentType, 'text/plain');
  assert.equal(payload.payload, 'plain text');
});
