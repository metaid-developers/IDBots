import type { IdbotsNativeBridge } from './idbotsNative';

const CAPABILITY_KEYS = [
  'camera',
  'photos',
  'files',
  'share',
  'appState',
  'backButton',
  'externalUrls',
  'secureScreen',
  'pushNotifications',
] as const;

function detectedPlatform(): 'android' | 'ios' | 'web' {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'web';
}

function invalid(reason: string): Error {
  return new Error(`[native-bootstrap] ${reason}`);
}

export function confirmNativeBootstrap(): IdbotsNativeBridge | null {
  if (typeof window === 'undefined') return null;
  const capacitor = window.Capacitor;
  const isNative = typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform();
  if (!isNative) return null;

  const bridge = window.idbotsNative;
  if (!bridge) throw invalid('NATIVE_BRIDGE_MISSING');
  if (bridge.nativeBridgeVersion !== 1) throw invalid('NATIVE_BRIDGE_VERSION_UNSUPPORTED');
  if (bridge.bootstrap?.phase !== 'document-start') throw invalid('NATIVE_BOOTSTRAP_TOO_LATE');
  if (bridge.bootstrap.origin !== window.location.origin) throw invalid('NATIVE_ORIGIN_MISMATCH');
  if (bridge.bootstrap.platform !== detectedPlatform()) throw invalid('NATIVE_PLATFORM_MISMATCH');
  if (typeof bridge.getCapabilities !== 'function') throw invalid('NATIVE_CAPABILITIES_MISSING');

  const capabilities = bridge.getCapabilities();
  if (!capabilities || typeof capabilities !== 'object') throw invalid('NATIVE_CAPABILITIES_INVALID');
  for (const key of CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== 'boolean') throw invalid(`NATIVE_CAPABILITY_INVALID:${key}`);
  }

  if (!window.idbotsMobile) {
    window.idbotsMobile = { isMobile: true, os: bridge.bootstrap.platform, shell: 'capacitor' };
  }

  if (!window.idbotsNativeProof) {
    const proof = Object.freeze({
      phase: 'before-react' as const,
      origin: window.location.origin,
      platform: bridge.bootstrap.platform,
      nativeBridgeVersion: 1 as const,
      confirmedAtMs: typeof performance === 'undefined' ? 0 : performance.now(),
    });
    Object.defineProperty(window, 'idbotsNativeProof', {
      value: proof,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return bridge;
}
