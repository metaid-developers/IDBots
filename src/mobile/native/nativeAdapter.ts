import type { IdbotsNativeBridge, MobileNativeCapabilities, MobileNativeHapticStyle } from './idbotsNative';

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
  'haptics',
] as const;

const WEB_CAPABILITIES: Required<MobileNativeCapabilities> = Object.freeze({
  camera: false,
  photos: false,
  files: false,
  share: false,
  appState: false,
  backButton: false,
  externalUrls: false,
  secureScreen: false,
  pushNotifications: false,
  haptics: false,
});

export interface MobileNativeAdapter {
  readonly isNative: boolean;
  getCapabilities(): Required<MobileNativeCapabilities>;
  getAppVersion(): { versionName: string; versionCode: number } | null;
  pickPhoto(source: 'camera' | 'photos'): Promise<File | null>;
  pickFiles(multi: boolean): Promise<File[]>;
  shareArtifact(input: { url: string; filename: string }): Promise<'shared' | 'cancelled'>;
  setSecureScreen(enabled: boolean): Promise<void>;
  triggerHaptic(style?: MobileNativeHapticStyle): void;
  openExternal(url: string): Promise<void>;
  onAppStateChange(callback: (active: boolean) => void): () => void;
  onBackButton(callback: () => boolean): () => void;
  getPushPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unavailable'>;
  requestPushPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unavailable'>;
  registerForPush(): Promise<string>;
  onPushNotificationOpen(callback: (eventId: string) => void): () => void;
  openNotificationSettings(): Promise<void>;
}

export type MobileNativeErrorCode = 'CANCELLED' | 'PERMISSION_DENIED' | 'UNAVAILABLE' | 'TOO_LARGE' | 'NATIVE_FAILED';

export interface MobileNativeError extends Error {
  code: MobileNativeErrorCode;
}

function nativeError(code: MobileNativeErrorCode, message: string): MobileNativeError {
  const error = new Error(message) as MobileNativeError;
  error.code = code;
  return error;
}

function normalizeNativeError(error: unknown): MobileNativeError {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : '';
  if (code === 'CANCELLED' || candidate?.name === 'AbortError') return nativeError('CANCELLED', 'Selection was cancelled');
  if (code === 'PERMISSION_DENIED') return nativeError(code, 'Permission was denied');
  if (code === 'UNAVAILABLE') return nativeError(code, 'Native capability is unavailable');
  if (code === 'TOO_LARGE') return nativeError(code, 'File exceeds the 25 MB limit');
  return nativeError('NATIVE_FAILED', typeof candidate?.message === 'string' ? candidate.message : 'Native operation failed');
}

function nativeBridge(target: Window): IdbotsNativeBridge | null {
  try {
    if (target.Capacitor?.isNativePlatform?.() !== true) return null;
  } catch {
    return null;
  }
  const bridge = target.idbotsNative;
  if (bridge?.nativeBridgeVersion !== 1 || typeof bridge.getCapabilities !== 'function') return null;
  return bridge;
}

function readCapabilities(bridge: IdbotsNativeBridge | null): Required<MobileNativeCapabilities> {
  if (!bridge) return { ...WEB_CAPABILITIES };
  try {
    const value = bridge.getCapabilities();
    return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, value?.[key] === true])) as unknown as Required<MobileNativeCapabilities>;
  } catch {
    return { ...WEB_CAPABILITIES };
  }
}

function vibrateWebFallback(target: Window, style: MobileNativeHapticStyle): void {
  if (style === 'prepare') return;
  const nav = (target as { navigator?: { vibrate?: (pattern: number | number[]) => boolean } }).navigator
    ?? (typeof navigator !== 'undefined' ? (navigator as { vibrate?: (pattern: number | number[]) => boolean }) : undefined);
  if (typeof nav?.vibrate !== 'function') return;
  const durationMs = style === 'ready' || style === 'heavy' ? 35 : style === 'light' ? 10 : 22;
  try {
    nav.vibrate(durationMs);
  } catch {
    // Web Vibration API is best-effort and may be blocked by OS battery saver.
  }
}

function approvedExternalUrl(value: string): { url: string; protocol: string } {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'alipays:';
  if (!allowed || !parsed.host || parsed.username || parsed.password) throw new Error('External URL is not allowed');
  return { url: trimmed, protocol: parsed.protocol };
}

function openWithWebFallback(target: Window, url: string, protocol: string): void {
  if (protocol === 'alipays:') {
    target.location.assign(url);
    return;
  }
  target.open?.(url, '_blank', 'noopener,noreferrer');
}

function unavailable(): () => void {
  return () => undefined;
}

export function createNativeAdapter(target: Window): MobileNativeAdapter {
  const bridge = nativeBridge(target);
  const hasCapability = (key: keyof Required<MobileNativeCapabilities>): boolean => readCapabilities(bridge)[key];
  return {
    isNative: bridge !== null,
    getCapabilities: () => readCapabilities(bridge),
    getAppVersion: () => {
      const versionName = bridge?.appVersion;
      const versionCode = bridge?.appVersionCode;
      if (typeof versionName !== 'string' || versionName.trim() === '') return null;
      if (typeof versionCode !== 'number' || !Number.isInteger(versionCode) || versionCode <= 0) return null;
      return { versionName, versionCode };
    },
    pickPhoto: async (source) => {
      const capability = source === 'camera' ? 'camera' : 'photos';
      if (!bridge || !hasCapability(capability) || typeof bridge.pickPhoto !== 'function') {
        throw nativeError('UNAVAILABLE', 'Native photo selection is unavailable');
      }
      try {
        return await bridge.pickPhoto(source);
      } catch (error) {
        const normalized = normalizeNativeError(error);
        if (normalized.code === 'CANCELLED') return null;
        throw normalized;
      }
    },
    pickFiles: async (multi) => {
      if (!bridge || !hasCapability('files') || typeof bridge.pickFiles !== 'function') {
        throw nativeError('UNAVAILABLE', 'Native file selection is unavailable');
      }
      try {
        return await bridge.pickFiles(multi);
      } catch (error) {
        const normalized = normalizeNativeError(error);
        if (normalized.code === 'CANCELLED') return [];
        throw normalized;
      }
    },
    shareArtifact: async (input) => {
      if (!bridge || !hasCapability('share') || typeof bridge.shareArtifact !== 'function') {
        throw nativeError('UNAVAILABLE', 'Native sharing is unavailable');
      }
      try {
        return await bridge.shareArtifact(input);
      } catch (error) {
        const normalized = normalizeNativeError(error);
        if (normalized.code === 'CANCELLED') return 'cancelled';
        throw normalized;
      }
    },
    setSecureScreen: async (enabled) => {
      if (!bridge || !hasCapability('secureScreen') || typeof bridge.setSecureScreen !== 'function') {
        throw nativeError('UNAVAILABLE', 'Secure screen is unavailable');
      }
      try {
        await bridge.setSecureScreen(enabled);
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    triggerHaptic: (style = 'medium') => {
      if (bridge && hasCapability('haptics') && typeof bridge.haptic === 'function') {
        try {
          void Promise.resolve(bridge.haptic(style)).catch(() => vibrateWebFallback(target, style));
          return;
        } catch {
          // Fall through to web vibration fallback.
        }
      }
      vibrateWebFallback(target, style);
    },
    openExternal: async (value) => {
      const { url, protocol } = approvedExternalUrl(value);
      if (bridge && hasCapability('externalUrls') && typeof bridge.openExternal === 'function') {
        await bridge.openExternal(url);
        return;
      }
      openWithWebFallback(target, url, protocol);
    },
    onAppStateChange: (callback) => {
      if (!bridge || !hasCapability('appState') || typeof bridge.onAppStateChange !== 'function') return unavailable();
      try {
        return bridge.onAppStateChange(callback);
      } catch {
        return unavailable();
      }
    },
    onBackButton: (callback) => {
      if (!bridge || !hasCapability('backButton') || typeof bridge.onBackButton !== 'function') return unavailable();
      try {
        return bridge.onBackButton(callback);
      } catch {
        return unavailable();
      }
    },
    getPushPermission: async () => {
      if (!bridge || !hasCapability('pushNotifications') || typeof bridge.getPushPermission !== 'function') return 'unavailable';
      try {
        return await bridge.getPushPermission();
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    requestPushPermission: async () => {
      if (!bridge || !hasCapability('pushNotifications') || typeof bridge.requestPushPermission !== 'function') return 'unavailable';
      try {
        return await bridge.requestPushPermission();
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    registerForPush: async () => {
      if (!bridge || !hasCapability('pushNotifications') || typeof bridge.registerForPush !== 'function') {
        throw nativeError('UNAVAILABLE', 'Push notifications are unavailable');
      }
      try {
        const token = await bridge.registerForPush();
        if (typeof token !== 'string' || !token || token.length > 4096) throw nativeError('NATIVE_FAILED', 'Push registration returned no token');
        return token;
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    onPushNotificationOpen: (callback) => {
      if (!bridge || !hasCapability('pushNotifications') || typeof bridge.onPushNotificationOpen !== 'function') return unavailable();
      try {
        return bridge.onPushNotificationOpen(callback);
      } catch {
        return unavailable();
      }
    },
    openNotificationSettings: async () => {
      if (!bridge || !hasCapability('pushNotifications') || typeof bridge.openNotificationSettings !== 'function') {
        throw nativeError('UNAVAILABLE', 'System notification settings are unavailable');
      }
      await bridge.openNotificationSettings();
    },
  };
}

let adapter: MobileNativeAdapter | null = null;

export function getNativeAdapter(): MobileNativeAdapter {
  if (!adapter) adapter = createNativeAdapter(window);
  return adapter;
}
