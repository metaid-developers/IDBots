import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmNativeBootstrap } from '../src/mobile/native/nativeBootstrap.ts';
import { detectMobileOs, detectMobileShell } from '../src/mobile/bridge/installShim.ts';

const ORIGIN = 'https://staging.idbots.world';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';

function capabilities() {
  return {
    camera: false,
    photos: false,
    files: false,
    share: false,
    appState: true,
    backButton: true,
    externalUrls: true,
    secureScreen: false,
    pushNotifications: false,
  };
}

function nativeBridge(platform: 'android' | 'ios') {
  return {
    nativeBridgeVersion: 1 as const,
    bootstrap: { phase: 'document-start' as const, origin: ORIGIN, platform },
    getCapabilities: capabilities,
  };
}

function withGlobals(value: Record<string, unknown>, run: () => void): void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: value.userAgent },
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as Record<string, unknown>).window;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete (globalThis as Record<string, unknown>).navigator;
  }
}

function nativeWindow(platform: 'android' | 'ios') {
  return {
    Capacitor: { isNativePlatform: () => true },
    location: { origin: ORIGIN },
    userAgent: platform === 'android' ? ANDROID_UA : IOS_UA,
    idbotsNative: nativeBridge(platform),
  } as Record<string, unknown>;
}

test('browser and PWA paths need no native adapter and create no proof', () => {
  const window: Record<string, unknown> = { location: { origin: ORIGIN }, userAgent: ANDROID_UA };
  withGlobals(window, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(window.idbotsNativeProof, undefined);
    assert.equal(window.idbotsMobile, undefined);
    assert.equal(detectMobileShell(), 'browser');
  });
});

test('Android accepts a document-start bridge before client facts and React use', () => {
  const window = nativeWindow('android');
  withGlobals(window, () => {
    assert.equal(confirmNativeBootstrap(), window.idbotsNative);
    assert.equal((window.idbotsNativeProof as IdbotsNativeProof).phase, 'before-react');
    assert.equal((window.idbotsMobile as { shell: string }).shell, 'capacitor');
    assert.equal(detectMobileShell(), 'capacitor');
    assert.equal(detectMobileOs(), 'android');
  });
});

test('iOS accepts a document-start bridge and detects the platform', () => {
  const window = nativeWindow('ios');
  withGlobals(window, () => {
    assert.equal(confirmNativeBootstrap(), window.idbotsNative);
    assert.equal((window.idbotsNativeProof as IdbotsNativeProof).platform, 'ios');
    assert.equal((window.idbotsMobile as { shell: string }).shell, 'capacitor');
    assert.equal(detectMobileShell(), 'capacitor');
    assert.equal(detectMobileOs(), 'ios');
  });
});

test('native shell without a bridge falls back instead of bricking the launch', () => {
  const window = nativeWindow('android');
  delete window.idbotsNative;
  withGlobals(window, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(window.idbotsNativeBootstrapError, 'NATIVE_BRIDGE_MISSING');
    assert.equal(window.idbotsNativeProof, undefined);
    assert.equal(window.idbotsMobile, undefined);
  });
});

test('late document-start injection from an older shell falls back to web mode', () => {
  const late = nativeWindow('android');
  (late.idbotsNative as unknown as { bootstrap: IdbotsNativeBridge['bootstrap'] }).bootstrap = { phase: 'after-load' as never, origin: ORIGIN, platform: 'android' };
  withGlobals(late, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(late.idbotsNativeBootstrapError, 'NATIVE_BOOTSTRAP_TOO_LATE');
  });
});

test('origin and version mismatches fall back and are recorded', () => {
  const wrongOrigin = nativeWindow('android');
  (wrongOrigin.idbotsNative as unknown as { bootstrap: IdbotsNativeBridge['bootstrap'] }).bootstrap = { phase: 'document-start', origin: 'https://evil.example', platform: 'android' };
  withGlobals(wrongOrigin, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(wrongOrigin.idbotsNativeBootstrapError, 'NATIVE_ORIGIN_MISMATCH');
  });

  const wrongVersion = nativeWindow('ios');
  (wrongVersion.idbotsNative as unknown as { nativeBridgeVersion: number }).nativeBridgeVersion = 2;
  withGlobals(wrongVersion, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(wrongVersion.idbotsNativeBootstrapError, 'NATIVE_BRIDGE_VERSION_UNSUPPORTED');
  });
});

test('platform and capability mismatches fall back and are recorded', () => {
  const wrongPlatform = nativeWindow('android');
  (wrongPlatform.idbotsNative as unknown as { bootstrap: IdbotsNativeBridge['bootstrap'] }).bootstrap = { phase: 'document-start', origin: ORIGIN, platform: 'ios' };
  withGlobals(wrongPlatform, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(wrongPlatform.idbotsNativeBootstrapError, 'NATIVE_PLATFORM_MISMATCH');
  });

  const malformed = nativeWindow('android');
  (malformed.idbotsNative as IdbotsNativeBridge).getCapabilities = () => ({ ...capabilities(), camera: undefined }) as unknown as MobileNativeCapabilities;
  withGlobals(malformed, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(malformed.idbotsNativeBootstrapError, 'NATIVE_CAPABILITY_INVALID:camera');
  });

  const withHaptics = nativeWindow('ios');
  (withHaptics.idbotsNative as IdbotsNativeBridge).getCapabilities = () => ({ ...capabilities(), haptics: true });
  withGlobals(withHaptics, () => {
    assert.equal(confirmNativeBootstrap(), withHaptics.idbotsNative);
  });

  const invalidHaptics = nativeWindow('ios');
  (invalidHaptics.idbotsNative as IdbotsNativeBridge).getCapabilities = () =>
    ({ ...capabilities(), haptics: 'yes' }) as unknown as MobileNativeCapabilities;
  withGlobals(invalidHaptics, () => {
    assert.equal(confirmNativeBootstrap(), null);
    assert.equal(invalidHaptics.idbotsNativeBootstrapError, 'NATIVE_CAPABILITY_INVALID:haptics');
  });
});
