import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shortenGigSquareProviderGlobalMetaId,
  copyGigSquareProviderIdToClipboard,
} from '../src/renderer/components/gigSquare/gigSquareProviderPresentation.js';
import {
  shouldHideRiskyGigSquareService,
  getGigSquareRefundRiskBadge,
} from '../src/renderer/components/gigSquare/gigSquareRefundRiskPresentation.js';

test('shortenGigSquareProviderGlobalMetaId renders first 6 chars, 6 dots, and last 4 chars', () => {
  assert.equal(
    shortenGigSquareProviderGlobalMetaId('idq14h1234567890abcdg9xz'),
    'idq14h......g9xz'
  );
});

test('copyGigSquareProviderIdToClipboard copies the full trimmed value and reports success', async () => {
  const writes = [];
  const clipboard = {
    async writeText(value) {
      writes.push(value);
    },
  };

  const copied = await copyGigSquareProviderIdToClipboard('  idq14h1234567890abcdg9xz  ', clipboard);

  assert.equal(copied, true);
  assert.deepEqual(writes, ['idq14h1234567890abcdg9xz']);
});

test('copyGigSquareProviderIdToClipboard returns false when clipboard support is unavailable', async () => {
  const copied = await copyGigSquareProviderIdToClipboard('idq14h1234567890abcdg9xz', null);

  assert.equal(copied, false);
});

test('shouldHideRiskyGigSquareService keeps risky providers visible for transparency', () => {
  const hidden = shouldHideRiskyGigSquareService({
    hasUnresolvedRefund: true,
    unresolvedRefundAgeHours: 999,
    hidden: true,
  });

  assert.equal(hidden, false);
});

test('getGigSquareRefundRiskBadge still marks unresolved refund risk', () => {
  const badge = getGigSquareRefundRiskBadge({
    hasUnresolvedRefund: true,
    unresolvedRefundAgeHours: 999,
  });

  assert.equal(badge, 'REFUND RISK');
});
