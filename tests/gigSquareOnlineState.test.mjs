import test from 'node:test';
import assert from 'node:assert/strict';

test('gig square online-state helpers treat provider ids case-insensitively for badges and sorting', async () => {
  const {
    isGigSquareProviderOnline,
    sortGigSquareServicesByOnline,
  } = await import('../dist-electron/shared/gigSquareOnlineState.js');

  const onlineBots = { idq1providera: 123 };
  const services = [
    { displayName: 'offline newer', providerGlobalMetaId: 'idq1providerb', updatedAt: 200, ratingCount: 2 },
    { displayName: 'online older', providerGlobalMetaId: ' IDQ1ProviderA ', updatedAt: 100, ratingCount: 1 },
  ];

  assert.equal(isGigSquareProviderOnline(onlineBots, 'IDQ1ProviderA'), true);
  assert.equal(isGigSquareProviderOnline(onlineBots, 'idq1providerb'), false);

  const sorted = sortGigSquareServicesByOnline(services, onlineBots, 'updated');
  assert.equal(sorted[0].displayName, 'online older');
});

test('gig square online-state helpers preserve fallback matching for non-raw legacy provider ids', async () => {
  const {
    isGigSquareProviderOnline,
    sortGigSquareServicesByOnline,
  } = await import('../dist-electron/shared/gigSquareOnlineState.js');

  const onlineBots = { 'legacy-provider': 456 };
  const services = [
    { displayName: 'legacy offline newer', providerGlobalMetaId: 'legacy-offline', updatedAt: 200, ratingCount: 2 },
    { displayName: 'legacy online older', providerGlobalMetaId: 'legacy-provider', updatedAt: 100, ratingCount: 1 },
  ];

  assert.equal(isGigSquareProviderOnline(onlineBots, 'legacy-provider'), true);

  const sorted = sortGigSquareServicesByOnline(services, onlineBots, 'updated');
  assert.equal(sorted[0].displayName, 'legacy online older');
});
