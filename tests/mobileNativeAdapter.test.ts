import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeAdapter } from '../src/mobile/native/nativeAdapter.ts';
import type { IdbotsNativeBridge, MobileNativeCapabilities } from '../src/mobile/native/idbotsNative.ts';

function capabilities(overrides: Partial<MobileNativeCapabilities> = {}): MobileNativeCapabilities {
  return {
    camera: false,
    photos: false,
    files: false,
    share: false,
    appState: true,
    backButton: true,
    externalUrls: true,
    secureScreen: false,
    ...overrides,
  };
}

function nativeBridge(overrides: Partial<IdbotsNativeBridge> = {}): IdbotsNativeBridge {
  return {
    nativeBridgeVersion: 1,
    bootstrap: { phase: 'document-start', origin: 'https://staging.idbots.world', platform: 'android' },
    getCapabilities: () => capabilities(),
    ...overrides,
  };
}

function target(bridge?: IdbotsNativeBridge) {
  const opened: string[] = [];
  const assigned: string[] = [];
  const value = {
    Capacitor: { isNativePlatform: () => bridge !== undefined },
    idbotsNative: bridge,
    open: (url: string) => {
      opened.push(url);
      return null;
    },
    location: {
      assign: (url: string) => assigned.push(url),
    },
  } as unknown as Window;
  return { value, opened, assigned };
}

test('browser and PWA adapters need no native bridge and retain web external behavior', async () => {
  const fake = target();
  const adapter = createNativeAdapter(fake.value);
  assert.equal(adapter.isNative, false);
  assert.deepEqual(adapter.getCapabilities(), capabilities({
    appState: false,
    backButton: false,
    externalUrls: false,
  }));
  await adapter.openExternal(' https://example.com/path ');
  assert.deepEqual(fake.opened, ['https://example.com/path']);
  await adapter.openExternal('alipays://platformapi/startapp?saId=10000007');
  assert.deepEqual(fake.assigned, ['alipays://platformapi/startapp?saId=10000007']);
  assert.equal(adapter.onAppStateChange(() => undefined)(), undefined);
  assert.equal(adapter.onBackButton(() => false)(), undefined);
});

test('an absent or mismatched native version cannot capture web fallback behavior', async () => {
  const mismatched = nativeBridge({ nativeBridgeVersion: 2 as unknown as 1 });
  const fake = target(mismatched);
  const adapter = createNativeAdapter(fake.value);
  assert.equal(adapter.isNative, false);
  await adapter.openExternal('https://example.com/');
  assert.deepEqual(fake.opened, ['https://example.com/']);
});

test('native external URLs use the local bridge only when its capability and method exist', async () => {
  const opened: string[] = [];
  const fake = target(nativeBridge({ openExternal: async (url) => opened.push(url) }));
  const adapter = createNativeAdapter(fake.value);
  assert.equal(adapter.isNative, true);
  await adapter.openExternal('https://example.com/');
  await adapter.openExternal('alipays://platformapi/startapp?saId=10000007');
  assert.deepEqual(opened, ['https://example.com/', 'alipays://platformapi/startapp?saId=10000007']);
  assert.deepEqual(fake.opened, []);
  assert.deepEqual(fake.assigned, []);
});

test('missing external capability or method falls back without throwing', async () => {
  const noCapability = target(nativeBridge({
    getCapabilities: () => capabilities({ externalUrls: false }),
    openExternal: async () => assert.fail('disabled native capability must not be called'),
  }));
  await createNativeAdapter(noCapability.value).openExternal('https://example.com/');
  assert.deepEqual(noCapability.opened, ['https://example.com/']);

  const noMethod = target(nativeBridge({ getCapabilities: () => capabilities({ externalUrls: true }) }));
  await createNativeAdapter(noMethod.value).openExternal('https://example.com/');
  assert.deepEqual(noMethod.opened, ['https://example.com/']);
});

test('external URL validation rejects dangerous schemes and userinfo before either path', async () => {
  const opened: string[] = [];
  const fake = target(nativeBridge({ openExternal: async (url) => opened.push(url) }));
  const adapter = createNativeAdapter(fake.value);
  for (const value of ['javascript:alert(1)', 'file:///tmp/private', 'https://user@example.com/']) {
    await assert.rejects(adapter.openExternal(value), /External URL is not allowed/);
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(fake.opened, []);
});

test('app-state and back subscriptions honor capability absence and unsubscribe', () => {
  const states: boolean[] = [];
  let appCallback: ((active: boolean) => void) | undefined;
  let appUnsubscribed = 0;
  const appFake = target(nativeBridge({
    onAppStateChange: (callback) => {
      appCallback = callback;
      return () => { appUnsubscribed += 1; };
    },
  }));
  const unsubscribeApp = createNativeAdapter(appFake.value).onAppStateChange((active) => states.push(active));
  appCallback?.(false);
  appCallback?.(true);
  unsubscribeApp();
  assert.deepEqual(states, [false, true]);
  assert.equal(appUnsubscribed, 1);

  let backCallback: (() => boolean) | undefined;
  let backUnsubscribed = 0;
  const backFake = target(nativeBridge({
    onBackButton: (callback) => {
      backCallback = callback;
      return () => { backUnsubscribed += 1; };
    },
  }));
  const unsubscribeBack = createNativeAdapter(backFake.value).onBackButton(() => true);
  assert.equal(backCallback?.(), true);
  unsubscribeBack();
  assert.equal(backUnsubscribed, 1);

  const unavailable = target(nativeBridge({
    getCapabilities: () => capabilities({ appState: false, backButton: false }),
    onAppStateChange: () => assert.fail('disabled app-state capability must not be called'),
    onBackButton: () => assert.fail('disabled back capability must not be called'),
  }));
  const adapter = createNativeAdapter(unavailable.value);
  assert.equal(adapter.onAppStateChange(() => undefined)(), undefined);
  assert.equal(adapter.onBackButton(() => false)(), undefined);
});

test('malformed capabilities degrade to false instead of crashing feature detection', () => {
  const fake = target(nativeBridge({
    getCapabilities: () => ({ appState: true }) as MobileNativeCapabilities,
  }));
  assert.deepEqual(createNativeAdapter(fake.value).getCapabilities(), capabilities({
    appState: true,
    backButton: false,
    externalUrls: false,
  }));
  const throwing = target(nativeBridge({
    getCapabilities: () => { throw new Error('unknown capability'); },
  }));
  assert.equal(createNativeAdapter(throwing.value).getCapabilities().externalUrls, false);
});

test('native media, sharing and secure-screen methods preserve inputs and ordering', async () => {
  const first = new File(['first'], 'first.txt', { type: 'text/plain' });
  const second = new File(['second'], 'second.pdf', { type: 'application/pdf' });
  const sources: string[] = [];
  const shared: Array<{ url: string; filename: string }> = [];
  const secure: boolean[] = [];
  const bridge = nativeBridge({
    getCapabilities: () => capabilities({ camera: true, photos: true, files: true, share: true, secureScreen: true }),
    pickPhoto: async (source) => { sources.push(source); return first; },
    pickFiles: async (multi) => { sources.push(`files:${multi}`); return [first, second]; },
    shareArtifact: async (input) => { shared.push(input); return 'shared'; },
    setSecureScreen: async (enabled) => { secure.push(enabled); },
  });
  const adapter = createNativeAdapter(target(bridge).value);
  assert.equal(await adapter.pickPhoto('camera'), first);
  assert.equal(await adapter.pickPhoto('photos'), first);
  assert.deepEqual(await adapter.pickFiles(true), [first, second]);
  assert.deepEqual(sources, ['camera', 'photos', 'files:true']);
  assert.equal(await adapter.shareArtifact({ url: 'https://app.example/files/signed', filename: 'report.pdf' }), 'shared');
  assert.deepEqual(shared, [{ url: 'https://app.example/files/signed', filename: 'report.pdf' }]);
  await adapter.setSecureScreen(true);
  await adapter.setSecureScreen(false);
  assert.deepEqual(secure, [true, false]);
});

test('native cancellation is not an error for pickers or system share', async () => {
  const cancelled = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  const bridge = nativeBridge({
    getCapabilities: () => capabilities({ camera: true, photos: true, files: true, share: true }),
    pickPhoto: async () => { throw cancelled; },
    pickFiles: async () => { throw cancelled; },
    shareArtifact: async () => { throw cancelled; },
  });
  const adapter = createNativeAdapter(target(bridge).value);
  assert.equal(await adapter.pickPhoto('camera'), null);
  assert.deepEqual(await adapter.pickFiles(true), []);
  assert.equal(await adapter.shareArtifact({ url: 'https://app.example/files/signed', filename: 'report.pdf' }), 'cancelled');
});

test('native permission, size and unavailable failures remain typed', async () => {
  const bridge = nativeBridge({
    getCapabilities: () => capabilities({ camera: true, files: true }),
    pickPhoto: async () => { throw Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }); },
    pickFiles: async () => { throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' }); },
  });
  const adapter = createNativeAdapter(target(bridge).value);
  await assert.rejects(adapter.pickPhoto('camera'), (error) => (error as { code?: string }).code === 'PERMISSION_DENIED');
  await assert.rejects(adapter.pickFiles(true), (error) => (error as { code?: string }).code === 'TOO_LARGE');
  const unavailable = createNativeAdapter(target(nativeBridge()).value);
  await assert.rejects(unavailable.pickPhoto('camera'), (error) => (error as { code?: string }).code === 'UNAVAILABLE');
  await assert.rejects(unavailable.shareArtifact({ url: 'https://app.example/f', filename: 'f' }), (error) => (error as { code?: string }).code === 'UNAVAILABLE');
  await assert.rejects(unavailable.setSecureScreen(true), (error) => (error as { code?: string }).code === 'UNAVAILABLE');
});
