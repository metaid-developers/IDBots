(() => {
  const remoteOrigin = __IDBOTS_REMOTE_ORIGIN_JSON__;
  const platform = __IDBOTS_PLATFORM_JSON__;
  const appVersion = __IDBOTS_APP_VERSION_JSON__;
  const appVersionCode = __IDBOTS_APP_VERSION_CODE_JSON__;
  if (window.top !== window || window.location.origin !== remoteOrigin) return;

  if (!window.idbotsMobile) {
    window.idbotsMobile = { isMobile: true, os: platform, shell: 'capacitor' };
  }

  const appPlugin = () => window.Capacitor?.Plugins?.App;
  const nativeBackPlugin = () => window.Capacitor?.Plugins?.NativeBack;
  const nativeCapabilitiesPlugin = () => window.Capacitor?.Plugins?.NativeCapabilities;
  const hasNativeMethod = (name) => typeof nativeCapabilitiesPlugin()?.[name] === 'function';
  const nativeFailure = (message, code) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  const MAX_NATIVE_FILE_BYTES = 25 * 1024 * 1024;
  const NATIVE_FILE_CHUNK_BYTES = 256 * 1024;
  const decodeBase64 = (value) => {
    const binary = atob(value || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const readNativeFile = async (descriptor) => {
    if (!descriptor || typeof descriptor.uri !== 'string' || !hasNativeMethod('readFile')) {
      throw nativeFailure('Native file reading is unavailable', 'UNAVAILABLE');
    }
    if (Number.isFinite(descriptor.size) && descriptor.size > MAX_NATIVE_FILE_BYTES) {
      throw nativeFailure('File exceeds the 25 MB limit', 'TOO_LARGE');
    }
    const readChunk = (offset) => nativeCapabilitiesPlugin().readFile({
      uri: descriptor.uri,
      temporary: descriptor.temporary === true,
      offset,
      length: NATIVE_FILE_CHUNK_BYTES,
    });
    let payload = await readChunk(0);
    if (payload?.chunked !== true) {
      const bytes = decodeBase64(payload.data);
      return new File([bytes], payload.name || descriptor.name || 'file', {
        type: payload.mime || descriptor.mime || 'application/octet-stream',
        lastModified: Date.now(),
      });
    }
    const declaredSize = Number.isFinite(descriptor.size) && descriptor.size >= 0
      ? descriptor.size
      : (Number.isFinite(payload.size) && payload.size >= 0 ? payload.size : null);
    const bytes = declaredSize === null || declaredSize === 0 ? null : new Uint8Array(declaredSize);
    const parts = [];
    let offset = 0;
    while (true) {
      if (payload.offset !== undefined && Number(payload.offset) !== offset) {
        throw nativeFailure('Native file chunk offset mismatch', 'NATIVE_FAILED');
      }
      const chunk = decodeBase64(payload.data);
      if (offset + chunk.length > MAX_NATIVE_FILE_BYTES || (bytes && offset + chunk.length > bytes.length)) {
        throw nativeFailure('File exceeds the 25 MB limit', 'TOO_LARGE');
      }
      if (bytes) bytes.set(chunk, offset);
      else parts.push(chunk);
      offset += chunk.length;
      if (payload.end === true) break;
      if (chunk.length === 0) throw nativeFailure('Native file reading made no progress', 'NATIVE_FAILED');
      payload = await readChunk(offset);
      if (payload?.chunked !== true) throw nativeFailure('Native file chunking is unavailable', 'NATIVE_FAILED');
    }
    let content = bytes;
    if (!content) {
      content = new Uint8Array(offset);
      let position = 0;
      for (const part of parts) {
        content.set(part, position);
        position += part.length;
      }
    }
    return new File([content], payload.name || descriptor.name || 'file', {
      type: payload.mime || descriptor.mime || 'application/octet-stream',
      lastModified: Date.now(),
    });
  };
  const pushPlugin = () => window.Capacitor?.Plugins?.PushNotifications;
  const hasPush = () => typeof pushPlugin()?.register === 'function' && typeof pushPlugin()?.addListener === 'function';
  const addPluginListener = (plugin, eventName, listener) => {
    if (typeof plugin?.addListener !== 'function') return noop;
    let active = true;
    let handle = null;
    try {
      Promise.resolve(plugin.addListener(eventName, listener)).then((registration) => {
        if (!active) {
          void registration.remove().catch(noop);
          return;
        }
        handle = registration;
      }).catch(noop);
    } catch {
      return noop;
    }
    return () => {
      active = false;
      if (handle) void handle.remove().catch(noop);
    };
  };
  const hasAppListeners = () => typeof appPlugin()?.addListener === 'function';
  const exitAndroidApp = () => {
    const plugin = nativeBackPlugin();
    if (typeof plugin?.exitApp !== 'function') return false;
    void Promise.resolve(plugin.exitApp()).catch(noop);
    return true;
  };
  const noop = () => {};
  const addAppListener = (eventName, listener) => {
    const plugin = appPlugin();
    if (typeof plugin?.addListener !== 'function') return noop;
    let active = true;
    let handle = null;
    try {
      Promise.resolve(plugin.addListener(eventName, listener)).then((registration) => {
        if (!active) {
          void registration.remove().catch(noop);
          return;
        }
        handle = registration;
      }).catch(noop);
    } catch {
      return noop;
    }
    return () => {
      active = false;
      if (handle) void handle.remove().catch(noop);
    };
  };
  let pushRegistration = null;
  let latestPushToken = null;
  let latestPushError = null;
  if (hasPush()) {
    addPluginListener(pushPlugin(), 'registration', (event) => {
      latestPushToken = typeof event?.value === 'string' ? event.value : null;
    });
    addPluginListener(pushPlugin(), 'registrationError', () => {
      latestPushError = nativeFailure('Push registration failed', 'UNAVAILABLE');
    });
  }
  const approvedExternalUrl = (value) => {
    const parsed = new URL(value.trim());
    const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'alipays:';
    if (!allowed || !parsed.host || parsed.username || parsed.password) throw new Error('External URL is not allowed');
    return value.trim();
  };
  const isProductRootRoute = () => ['/', '/app', '/app/', '/login', '/login/'].includes(window.location.pathname);
  const bridge = Object.freeze({
    nativeBridgeVersion: 1,
    appVersion,
    appVersionCode,
    bootstrap: Object.freeze({ phase: 'document-start', origin: remoteOrigin, platform }),
    getCapabilities: () => ({
      camera: hasNativeMethod('pickPhoto'),
      photos: hasNativeMethod('pickPhoto'),
      files: hasNativeMethod('pickFiles') && hasNativeMethod('readFile'),
      share: hasNativeMethod('shareArtifact'),
      appState: hasAppListeners(),
      backButton: platform === 'android' && hasAppListeners(),
      externalUrls: true,
      secureScreen: hasNativeMethod('setSecureScreen'),
      pushNotifications: hasPush(),
    }),
    pickPhoto: async (source = 'photos') => {
      if (!hasNativeMethod('pickPhoto')) throw nativeFailure('Native photo selection is unavailable', 'UNAVAILABLE');
      const result = await nativeCapabilitiesPlugin().pickPhoto({ source });
      return result?.file ? readNativeFile(result.file) : null;
    },
    pickFiles: async (multi = true) => {
      if (!hasNativeMethod('pickFiles') || !hasNativeMethod('readFile')) {
        throw nativeFailure('Native file selection is unavailable', 'UNAVAILABLE');
      }
      const result = await nativeCapabilitiesPlugin().pickFiles({ allowMultiple: multi === true });
      const descriptors = Array.isArray(result?.files) ? result.files : [];
      const files = [];
      for (const descriptor of descriptors) files.push(await readNativeFile(descriptor));
      return files;
    },
    shareArtifact: async ({ url, filename }) => {
      if (!hasNativeMethod('shareArtifact')) throw nativeFailure('Native sharing is unavailable', 'UNAVAILABLE');
      const parsed = new URL(String(url).trim());
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.host || parsed.username || parsed.password) {
        throw nativeFailure('Only HTTP(S) artifact URLs can be shared', 'NATIVE_FAILED');
      }
      const result = await nativeCapabilitiesPlugin().shareArtifact({ url: parsed.toString(), filename });
      return result?.result === 'cancelled' ? 'cancelled' : 'shared';
    },
    setSecureScreen: async (enabled) => {
      if (!hasNativeMethod('setSecureScreen')) throw nativeFailure('Secure screen is unavailable', 'UNAVAILABLE');
      await nativeCapabilitiesPlugin().setSecureScreen({ enabled: enabled === true });
    },
    openExternal: async (value) => {
      const url = approvedExternalUrl(value);
      window.location.assign(url);
    },
    getPushPermission: async () => {
      if (!hasPush()) throw nativeFailure('Push notifications are unavailable', 'UNAVAILABLE');
      const result = await pushPlugin().checkPermissions();
      return result?.receive || 'prompt';
    },
    requestPushPermission: async () => {
      if (!hasPush()) throw nativeFailure('Push notifications are unavailable', 'UNAVAILABLE');
      const result = await pushPlugin().requestPermissions();
      return result?.receive || 'denied';
    },
    registerForPush: async () => {
      if (!hasPush()) throw nativeFailure('Push notifications are unavailable', 'UNAVAILABLE');
      if (pushRegistration) return pushRegistration;
      latestPushToken = null;
      latestPushError = null;
      pushRegistration = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pushRegistration = null;
          reject(nativeFailure('Push registration timed out', 'UNAVAILABLE'));
        }, 15000);
        const offToken = addPluginListener(pushPlugin(), 'registration', (event) => {
          const token = typeof event?.value === 'string' ? event.value : latestPushToken;
          if (!token) return;
          clearTimeout(timeout);
          offToken();
          offError();
          pushRegistration = null;
          resolve(token);
        });
        const offError = addPluginListener(pushPlugin(), 'registrationError', () => {
          clearTimeout(timeout);
          offToken();
          offError();
          pushRegistration = null;
          reject(latestPushError || nativeFailure('Push registration failed', 'UNAVAILABLE'));
        });
        Promise.resolve(pushPlugin().register()).catch(() => {
          clearTimeout(timeout);
          offToken();
          offError();
          pushRegistration = null;
          reject(nativeFailure('Push registration failed', 'UNAVAILABLE'));
        });
      });
      return pushRegistration;
    },
    onPushNotificationOpen: (callback) => {
      if (!hasPush()) return noop;
      return addPluginListener(pushPlugin(), 'pushNotificationActionPerformed', (event) => {
        const eventId = event?.notification?.data?.eventId;
        if (typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 200) callback(eventId);
      });
    },
    openNotificationSettings: async () => {
      if (!hasNativeMethod('openNotificationSettings')) throw nativeFailure('System notification settings are unavailable', 'UNAVAILABLE');
      await nativeCapabilitiesPlugin().openNotificationSettings();
    },
    onAppStateChange: (callback) => addAppListener('appStateChange', (event) => {
      callback(event?.isActive === true);
    }),
    onBackButton: (callback) => {
      if (platform !== 'android') return noop;
      return addAppListener('backButton', (event) => {
        let handled = false;
        try {
          handled = callback() === true;
        } catch {
          handled = false;
        }
        if (handled) return;
        if (event?.canGoBack && !isProductRootRoute() && typeof window.history?.back === 'function') {
          window.history.back();
          return;
        }
        if (exitAndroidApp()) return;
        const plugin = appPlugin();
        if (typeof plugin?.exitApp === 'function') void plugin.exitApp().catch(noop);
      });
    },
  });
  Object.defineProperty(window, 'idbotsNative', {
    value: bridge,
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();
