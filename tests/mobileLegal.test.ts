import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileLegalUrl } from '../src/mobile/legal';

test('legal links follow the deployed environment instead of pinning production to staging', () => {
  assert.equal(mobileLegalUrl('terms', 'app.idbots.world'), 'https://app.idbots.world/terms');
  assert.equal(mobileLegalUrl('privacy', 'staging.idbots.world'), 'https://staging.idbots.world/privacy');
  assert.equal(mobileLegalUrl('custody', 'localhost'), 'https://staging.idbots.world/custody');
  assert.equal(mobileLegalUrl('support', 'app.idbots.world'), 'https://app.idbots.world/support');
});
