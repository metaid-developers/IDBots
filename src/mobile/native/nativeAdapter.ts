import type { IdbotsNativeBridge, MobileNativeCapabilities } from './idbotsNative';

const CAPABILITY_KEYS = [
  'camera',
  'photos',
  'files',
  'share',
  'appState',
  'backButton',
  'externalUrls',
  'secureScreen',
] as const;

const WEB_CAPABILITIES: MobileNativeCapabilities = Object.freeze({
  camera: false,
  photos: false,
  files: false,
  share: false,
  appState: false,
  backButton: false,
  externalUrls: false,
  secureScreen: false,
});

export interface MobileNativeAdapter {
  readonly isNative: boolean;
  getCapabilities(): MobileNativeCapabilities;
  pickPhoto(source: 'camera' | 'photos'): Promise<File | null>;
  pickFiles(multi: boolean): Promise<File[]>;
  shareArtifact(input: { url: string; filename: string }): Promise<'shared' | 'cancelled'>;
  setSecureScreen(enabled: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  onAppStateChange(callback: (active: boolean) => void): () => void;
  onBackButton(callback: () => boolean): () => void;
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

function readCapabilities(bridge: IdbotsNativeBridge | null): MobileNativeCapabilities {
  if (!bridge) return { ...WEB_CAPABILITIES };
  try {
    const value = bridge.getCapabilities();
    return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, value?.[key] === true])) as unknown as MobileNativeCapabilities;
  } catch {
    return { ...WEB_CAPABILITIES };
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
  const hasCapability = (key: keyof MobileNativeCapabilities): boolean => readCapabilities(bridge)[key];
  return {
    isNative: bridge !== null,
    getCapabilities: () => readCapabilities(bridge),
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
  };
}

let adapter: MobileNativeAdapter | null = null;

export function getNativeAdapter(): MobileNativeAdapter {
  if (!adapter) adapter = createNativeAdapter(window);
  return adapter;
}
