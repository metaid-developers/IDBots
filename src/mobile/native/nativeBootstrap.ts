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

/**
 * A native shell whose bridge is missing or unusable must not brick the PWA.
 * Older shells (0.1.6 and earlier) cannot inject the document-start script;
 * throwing here left them stuck on the launch splash forever. Record the
 * reason for diagnostics and let the app run with its web fallbacks.
 */
function degrade(reason: string): null {
  if (typeof window !== 'undefined') {
    window.idbotsNativeBootstrapError = reason;
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[native-bootstrap] ${reason}; continuing with web fallbacks`);
  }
  return null;
}

export function confirmNativeBootstrap(): IdbotsNativeBridge | null {
  if (typeof window === 'undefined') return null;
  const capacitor = window.Capacitor;
  let isNative = false;
  try {
    isNative = typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform() === true;
  } catch {
    return degrade('NATIVE_PLATFORM_CHECK_FAILED');
  }
  if (!isNative) return null;

  const bridge = window.idbotsNative;
  if (!bridge) return degrade('NATIVE_BRIDGE_MISSING');
  if (bridge.nativeBridgeVersion !== 1) return degrade('NATIVE_BRIDGE_VERSION_UNSUPPORTED');
  if (bridge.bootstrap?.phase !== 'document-start') return degrade('NATIVE_BOOTSTRAP_TOO_LATE');
  if (bridge.bootstrap.origin !== window.location.origin) return degrade('NATIVE_ORIGIN_MISMATCH');
  if (bridge.bootstrap.platform !== detectedPlatform()) return degrade('NATIVE_PLATFORM_MISMATCH');
  if (typeof bridge.getCapabilities !== 'function') return degrade('NATIVE_CAPABILITIES_MISSING');

  let capabilities: ReturnType<IdbotsNativeBridge['getCapabilities']>;
  try {
    capabilities = bridge.getCapabilities();
  } catch {
    return degrade('NATIVE_CAPABILITIES_UNREADABLE');
  }
  if (!capabilities || typeof capabilities !== 'object') return degrade('NATIVE_CAPABILITIES_INVALID');
  for (const key of CAPABILITY_KEYS) {
    if (typeof capabilities[key] !== 'boolean') return degrade(`NATIVE_CAPABILITY_INVALID:${key}`);
  }
  if (capabilities.haptics !== undefined && typeof capabilities.haptics !== 'boolean') {
    return degrade('NATIVE_CAPABILITY_INVALID:haptics');
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
