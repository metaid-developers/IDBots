(() => {
  const remoteOrigin = __IDBOTS_REMOTE_ORIGIN_JSON__;
  const platform = __IDBOTS_PLATFORM_JSON__;
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
  const readNativeFile = async (descriptor) => {
    if (!descriptor || typeof descriptor.uri !== 'string' || !hasNativeMethod('readFile')) {
      throw nativeFailure('Native file reading is unavailable', 'UNAVAILABLE');
    }
    const payload = await nativeCapabilitiesPlugin().readFile({
      uri: descriptor.uri,
      temporary: descriptor.temporary === true,
    });
    const binary = atob(payload.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], payload.name || descriptor.name || 'file', {
      type: payload.mime || descriptor.mime || 'application/octet-stream',
      lastModified: Date.now(),
    });
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
  const approvedExternalUrl = (value) => {
    const parsed = new URL(value.trim());
    const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'alipays:';
    if (!allowed || !parsed.host || parsed.username || parsed.password) throw new Error('External URL is not allowed');
    return value.trim();
  };
  const isProductRootRoute = () => ['/', '/app', '/app/', '/login', '/login/'].includes(window.location.pathname);
  const bridge = Object.freeze({
    nativeBridgeVersion: 1,
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
