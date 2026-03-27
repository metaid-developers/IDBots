import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GIG_SQUARE_PROVIDER_AVATAR,
  formatGigSquareProviderId,
  getGigSquareProviderAvatarSrc,
  getGigSquareProviderDisplayName,
} from '../src/renderer/components/gigSquare/gigSquareProviderPresentation.js';
import { getDefaultMetabotAvatarUrl } from '../src/renderer/utils/rendererAssetPaths.js';

test('Gig Square provider display name falls back to truncated GlobalMetaID', () => {
  assert.equal(formatGigSquareProviderId('1234567890abcdefghij'), '12345678...efghij');
  assert.equal(
    getGigSquareProviderDisplayName({}, '1234567890abcdefghij'),
    '12345678...efghij',
  );
});

test('Gig Square provider display name prefers fetched provider name', () => {
  assert.equal(
    getGigSquareProviderDisplayName({ name: 'Sunny MetaBot' }, '1234567890abcdefghij'),
    'Sunny MetaBot',
  );
});

test('Gig Square provider avatar falls back to default metabot artwork', () => {
  assert.equal(DEFAULT_GIG_SQUARE_PROVIDER_AVATAR, getDefaultMetabotAvatarUrl());
  assert.equal(getGigSquareProviderAvatarSrc({}), getDefaultMetabotAvatarUrl());
  assert.equal(
    getGigSquareProviderAvatarSrc({ avatarUrl: 'https://example.com/avatar.png' }),
    'https://example.com/avatar.png',
  );
});
