/**
 * IDFramework - Core Framework for MetaWeb Applications
 * 
 * A lightweight, decentralized SPA framework following Cairngorm MVC philosophy.
 * Designed for MetaID Protocol-based blockchain internet applications.
 * 
 * Core Philosophy:
 * - Single Source of Truth: All application state in global singleton Model layer
 * - View is "Dumb": Views only display data and dispatch events
 * - Command Pattern: Business logic atomized into independent Commands
 * - Separation of Concerns: View, Model, Command, Delegate strictly separated
 * - Event-Driven: Components communicate through events, not direct calls
 * 
 * Data Flow:
 * View -> Event -> IDController -> Command -> BusinessDelegate (Service) -> Model -> View (Binding)
 * 
 * @namespace IDFramework
 */

class IDFramework {
  static getAlpine() {
    return typeof window !== 'undefined' ? window.Alpine : undefined;
  }

  static getStore(name) {
    const alpine = this.getAlpine();
    if (!alpine || typeof alpine.store !== 'function') return undefined;
    return alpine.store(name);
  }

  /**
   * ============================================
   * I18N LAYER - Lightweight runtime translation
   * ============================================
   */
  static I18n = {
    storageKey: 'idframework.locale',
    fallbackLocale: 'en',
    locale: 'en',
    catalogs: {
      en: {},
      zh: {},
    },
    _initialized: false,

    _normalizeLocale(rawLocale) {
      const text = String(rawLocale || '').trim().toLowerCase();
      if (!text) return 'en';
      if (text === 'zh' || text.indexOf('zh-') === 0 || text === 'zh_cn' || text === 'zh-hans') return 'zh';
      if (text === 'en' || text.indexOf('en-') === 0) return 'en';
      return 'en';
    },

    _isObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    },

    _deepMerge(target, source) {
      if (!this._isObject(target) || !this._isObject(source)) return target;
      Object.keys(source).forEach((key) => {
        const sourceValue = source[key];
        if (this._isObject(sourceValue)) {
          if (!this._isObject(target[key])) target[key] = {};
          this._deepMerge(target[key], sourceValue);
          return;
        }
        target[key] = sourceValue;
      });
      return target;
    },

    _ensurePath(root, path) {
      const segments = String(path || '').split('.').map((item) => String(item || '').trim()).filter(Boolean);
      if (!segments.length) return root;
      let cursor = root;
      for (let i = 0; i < segments.length; i += 1) {
        const key = segments[i];
        if (!this._isObject(cursor[key])) cursor[key] = {};
        cursor = cursor[key];
      }
      return cursor;
    },

    _getByPath(root, keyPath) {
      const segments = String(keyPath || '').split('.').map((item) => String(item || '').trim()).filter(Boolean);
      if (!segments.length) return undefined;
      let cursor = root;
      for (let i = 0; i < segments.length; i += 1) {
        const key = segments[i];
        if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return undefined;
        cursor = cursor[key];
      }
      return cursor;
    },

    _formatTemplate(template, params) {
      const text = String(template == null ? '' : template);
      const payload = params && typeof params === 'object' ? params : {};
      return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, token) => {
        if (Object.prototype.hasOwnProperty.call(payload, token)) {
          const value = payload[token];
          return value == null ? '' : String(value);
        }
        return match;
      });
    },

    init(options = {}) {
      const opts = options && typeof options === 'object' ? options : {};
      const shouldPersist = opts.persist !== false;
      let preferred = opts.locale;

      if (!preferred && typeof window !== 'undefined') {
        try {
          preferred = window.localStorage
            ? window.localStorage.getItem(this.storageKey)
            : '';
        } catch (_) {
          preferred = '';
        }
      }

      if (!preferred && typeof navigator !== 'undefined') {
        preferred = navigator.language || (Array.isArray(navigator.languages) ? navigator.languages[0] : '');
      }

      this.locale = this._normalizeLocale(preferred);
      this._initialized = true;

      if (shouldPersist && typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(this.storageKey, this.locale);
        } catch (_) {}
      }
      return this.locale;
    },

    registerMessages(namespaceOrCatalogs, maybeCatalogs) {
      const hasNamespace = typeof namespaceOrCatalogs === 'string';
      const namespace = hasNamespace ? String(namespaceOrCatalogs || '').trim() : '';
      const catalogs = hasNamespace ? maybeCatalogs : namespaceOrCatalogs;
      const payload = this._isObject(catalogs) ? catalogs : {};

      ['en', 'zh'].forEach((localeKey) => {
        const locale = this._normalizeLocale(localeKey);
        const localePayload = payload[locale];
        if (!this._isObject(localePayload)) return;
        if (!this._isObject(this.catalogs[locale])) this.catalogs[locale] = {};
        if (namespace) {
          const root = this._ensurePath(this.catalogs[locale], namespace);
          this._deepMerge(root, localePayload);
          return;
        }
        this._deepMerge(this.catalogs[locale], localePayload);
      });
    },

    setLocale(rawLocale, options = {}) {
      const nextLocale = this._normalizeLocale(rawLocale);
      const previousLocale = this.locale;
      const opts = options && typeof options === 'object' ? options : {};
      const shouldPersist = opts.persist !== false;
      this.locale = nextLocale;
      this._initialized = true;

      if (shouldPersist && typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(this.storageKey, nextLocale);
        } catch (_) {}
      }

      if (opts.silent) return nextLocale;
      if (previousLocale === nextLocale) return nextLocale;

      if (
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function' &&
        typeof CustomEvent === 'function'
      ) {
        window.dispatchEvent(new CustomEvent('id:i18n:changed', {
          detail: {
            locale: nextLocale,
            previousLocale: previousLocale,
          },
        }));
      }
      if (
        typeof document !== 'undefined' &&
        typeof document.dispatchEvent === 'function' &&
        typeof CustomEvent === 'function'
      ) {
        document.dispatchEvent(new CustomEvent('id:i18n:changed', {
          detail: {
            locale: nextLocale,
            previousLocale: previousLocale,
          },
        }));
      }
      return nextLocale;
    },

    getLocale() {
      if (!this._initialized) this.init();
      return this.locale;
    },

    t(key, params, fallback) {
      if (!this._initialized) this.init();
      const path = String(key || '').trim();
      if (!path) return typeof fallback === 'string' ? fallback : '';

      const useParams = params && typeof params === 'object' ? params : {};
      const fallbackText = typeof fallback === 'string' ? fallback : '';
      const locale = this._normalizeLocale(this.locale || this.fallbackLocale);

      const fromLocale = this._getByPath(this.catalogs[locale], path);
      const fromFallback = this._getByPath(this.catalogs[this.fallbackLocale], path);
      const resolved = fromLocale != null ? fromLocale : fromFallback;

      if (typeof resolved === 'string' || typeof resolved === 'number') {
        return this._formatTemplate(String(resolved), useParams);
      }
      if (fallbackText) return this._formatTemplate(fallbackText, useParams);
      return path;
    },
  };

  /**
   * ============================================
   * MODEL LAYER - Single Source of Truth
   * ============================================
   * 
   * The Model layer provides a global singleton store for all application state.
   * It includes built-in models (wallet, app) and allows dynamic model registration.
   * All models are managed through Alpine.js stores for reactive updates.
   */

  /**
   * Initialize Model Layer with built-in models
   * 
   * Built-in Models:
   * - wallet: User wallet information and connection status
   * - app: Application-level global state
   * 
   * Additional models can be registered dynamically via Alpine.store()
   * 
   * Note: This method will NOT overwrite existing stores. If a store already exists,
   * it will be preserved. This allows stores to be registered in index.html
   * before the framework loads, ensuring they're available when Alpine processes the DOM.
   * 
   * @param {Object} customModels - Optional custom models to register
   * @example
   * IDFramework.initModels({
   *   user: { name: '', email: '' },
   *   settings: { theme: 'light' }
   * });
   */
  static initModels(customModels = {}) {
    const alpine = this.getAlpine();
    if (!alpine || typeof alpine.store !== 'function') {
      throw new Error('Alpine.js is not loaded. Please include Alpine.js before initializing IDFramework.');
    }

    // Built-in Wallet Model
    // Only register if it doesn't already exist (to preserve any existing state)
    if (!alpine.store('wallet')) {
      alpine.store('wallet', {
        isConnected: false,
        address: null,
        metaid: null,
        globalMetaId: null, // GlobalMetaID for cross-chain identity
        globalMetaIdInfo: null, // Full GlobalMetaID info (mvc, btc, doge)
        publicKey: null,
        network: null, // 'mainnet' | 'testnet'
      });
    }

    // Built-in App Model
    // Only register if it doesn't already exist (to preserve any existing state)
    if (!alpine.store('app')) {
      alpine.store('app', {
        isLogin: false,
        userAddress: null,
        // Additional app-level state can be added here
      });
    }

    // Register custom models if provided
    // Only register if they don't already exist
    Object.keys(customModels).forEach(modelName => {
      if (!alpine.store(modelName)) {
        alpine.store(modelName, customModels[modelName]);
      }
    });
  }

  /**
   * Ensure Alpine.js is available.
   * Allows applications to include only idframework.js + app.js in HTML.
   *
   * @returns {Promise<void>}
   */
  static async ensureAlpineLoaded() {
    if (typeof window === 'undefined') return;
    if (window.Alpine && typeof window.Alpine.store === 'function') return;
    if (this._alpineLoadingPromise) return this._alpineLoadingPromise;

    const alpineCdnUrl = 'https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js';

    this._alpineLoadingPromise = new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      const installAlpineStoreShim = () => {
        if (window.Alpine && typeof window.Alpine.store === 'function') {
          finish();
          return;
        }

        const stores = {};
        const alpineShim = window.Alpine || {};
        alpineShim.store = function store(name, value) {
          if (arguments.length === 1) {
            return stores[name];
          }
          stores[name] = value;
          return stores[name];
        };
        window.Alpine = alpineShim;

        try {
          window.dispatchEvent(new Event('alpine:init'));
        } catch (error) {
          console.warn('Failed to dispatch alpine:init from store shim:', error);
        }

        console.warn('IDFramework: Alpine.js unavailable, using lightweight Alpine.store shim.');
        finish();
      };

      const waitForAlpine = () => {
        const timeoutMs = 3000;
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (window.Alpine && typeof window.Alpine.store === 'function') {
            clearInterval(timer);
            finish();
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            clearInterval(timer);
            installAlpineStoreShim();
          }
        }, 50);
      };

      const existingScript = document.querySelector('script[data-idframework-alpine="true"]');
      if (existingScript) {
        waitForAlpine();
        return;
      }

      const script = document.createElement('script');
      script.src = alpineCdnUrl;
      script.async = true;
      script.setAttribute('data-idframework-alpine', 'true');
      script.onerror = () => installAlpineStoreShim();
      script.onload = () => waitForAlpine();
      document.head.appendChild(script);

      // Network-hang safety: if script neither loads nor errors promptly, fallback to shim.
      setTimeout(() => {
        if (!resolved && !(window.Alpine && typeof window.Alpine.store === 'function')) {
          installAlpineStoreShim();
        }
      }, 3000);
    });

    return this._alpineLoadingPromise;
  }

  /**
   * ============================================
   * DELEGATE LAYER - Service Abstraction
   * ============================================
   * 
   * Delegate layer abstracts the complexity of remote service communication.
   * It handles API calls, error handling, and returns raw data to Commands.
   * Commands use DataAdapters to transform raw data into Model format.
   * 
   * The Delegate object contains multiple delegate methods for different purposes:
   * - BusinessDelegate: Generic API communication handler
   * - UserDelegate: User-related API calls (e.g., avatar, profile)
   */

  /**
   * Delegate - Service abstraction object
   * 
   * Contains various delegate methods for different types of service communication.
   */
  static Delegate = {
    /**
     * BusinessDelegate - Generic API communication handler
     * 
     * This method abstracts service communication, allowing Commands to focus on business logic
     * rather than HTTP details. It uses ServiceLocator to resolve service base URLs.
     * 
     * @param {string} serviceKey - Key to look up BaseURL from ServiceLocator (e.g., 'metaid_man')
     * @param {string} endpoint - API endpoint path (e.g., '/pin/path/list')
     * @param {Object} options - Fetch options (method, headers, body, etc.)
     * @returns {Promise<Object>} Raw JSON response from the service
     * 
     * @example
     * const data = await IDFramework.Delegate.BusinessDelegate('metaid_man', '/pin/path/list', {
     *   method: 'GET',
     *   headers: { 'Authorization': 'Bearer token' }
     * });
     */
    async BusinessDelegate(serviceKey, endpoint, options = {}) {
      // Validate ServiceLocator exists
      if (!window.ServiceLocator || !window.ServiceLocator[serviceKey]) {
        throw new Error(`Service '${serviceKey}' not found in ServiceLocator. Please define it in app.js`);
      }

      const buildServiceUrl = (base, path) => {
        const baseText = String(base || '').replace(/\/+$/, '');
        let normalizedPath = String(path || '');
        if (!normalizedPath) normalizedPath = '/';
        if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
        if (/\/v1$/i.test(baseText) && /^\/v1(?:\/|$)/i.test(normalizedPath)) {
          normalizedPath = normalizedPath.replace(/^\/v1(?=\/|$)/i, '');
          if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
        }
        return `${baseText}${normalizedPath}`;
      };

      const baseURL = window.ServiceLocator[serviceKey];
      const url = buildServiceUrl(baseURL, endpoint);

      // Default fetch options
      const defaultOptions = {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      };

      const fetchOptions = { ...defaultOptions, ...options };

      try {
        const response = await fetch(url, fetchOptions);
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data;
      } catch (error) {
        console.error(`BusinessDelegate error for ${serviceKey}${endpoint}:`, error);
        throw error;
      }
    },

    /**
     * UserDelegate - User-related API communication handler with IndexedDB caching
     * 
     * This method handles user-related API calls, such as fetching user avatar,
     * profile information, etc. from remote services.
     * 
     * It implements a cache-first strategy:
     * 1. Check IndexedDB for cached user data
     * 2. If found, return cached data
     * 3. If not found, fetch from remote API and cache in IndexedDB
     * 
     * @param {string} serviceKey - Key to look up BaseURL from ServiceLocator (e.g., 'metafs')
     * @param {string} endpoint - API endpoint path (e.g., '/info/metaid/xxx' or '/users/address/xxx')
     * @param {Object} options - Fetch options (method, headers, body, etc.)
     * @param {string} [options.metaid] - MetaID (optional when using address)
     * @param {string} [options.address] - Address (optional when using metaid)
     * @returns {Promise<Object>} User data object with avatar image
     * 
     * @example
     * const userData = await IDFramework.Delegate.UserDelegate('metafs', '/users/address/' + address, { address });
     */
    async UserDelegate(serviceKey, endpoint, options = {}) {
      const buildV1Url = (base, path) => {
        const baseText = String(base || '').replace(/\/+$/, '');
        if (!baseText) return '';
        let normalizedPath = String(path || '');
        if (!normalizedPath) normalizedPath = '/';
        if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
        if (baseText.toLowerCase().endsWith('/v1')) return `${baseText}${normalizedPath}`;
        return `${baseText}/v1${normalizedPath}`;
      };

      const buildServiceUrl = (base, path) => {
        const baseText = String(base || '').replace(/\/+$/, '');
        let normalizedPath = String(path || '');
        if (!normalizedPath) normalizedPath = '/';
        if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
        if (/\/v1$/i.test(baseText) && /^\/v1(?:\/|$)/i.test(normalizedPath)) {
          normalizedPath = normalizedPath.replace(/^\/v1(?=\/|$)/i, '');
          if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
        }
        return `${baseText}${normalizedPath}`;
      };

      // Extract metaid from options or from endpoint (/info/metaid/xxx)
      let metaid = options.metaid;
      if (!metaid && endpoint) {
        const metaidMatch = endpoint.match(/\/info\/metaid\/([^\/]+)/);
        if (metaidMatch) metaid = metaidMatch[1];
      }

      // Extract globalMetaId from options or from endpoint (/info/globalmetaid/xxx)
      let globalMetaId = options.globalMetaId;
      if (!globalMetaId && endpoint) {
        const gmidMatch = endpoint.match(/\/info\/globalmetaid\/([^\/]+)/);
        if (gmidMatch) globalMetaId = gmidMatch[1];
      }

      // Extract address from options or from endpoint (/info/address/xxx or /users/address/xxx)
      let address = options.address;
      if (!address && endpoint) {
        const addressMatch = endpoint.match(/\/(?:info\/address|(?:v1\/)?users\/address)\/([^\/]+)/);
        if (addressMatch) address = addressMatch[1];
      }

      if (!metaid && !globalMetaId && !address) {
        throw new Error('UserDelegate: metaid, globalMetaId or address is required (provide in options or endpoint)');
      }

      if (!window.ServiceLocator || !window.ServiceLocator[serviceKey]) {
        throw new Error(`Service '${serviceKey}' not found in ServiceLocator. Please define it in app.js`);
      }
      const baseURL = window.ServiceLocator[serviceKey];

      const toText = (value) => String(value || '').trim();

      const extractUserInfo = (payload) => {
        if (!payload || typeof payload !== 'object') return null;
        if (payload.code === 1 && payload.data) return payload.data;
        if (payload.code === 0 && payload.data) return payload.data;
        if (payload.data != null) return payload.data;
        if (payload.metaid != null || payload.metaId != null || payload.address != null || payload.name != null) {
          return payload;
        }
        return null;
      };

      const extractPinId = (input) => {
        const raw = toText(input);
        if (!raw) return '';
        const match = raw.match(/([a-fA-F0-9]{64}i\d+)/);
        return match ? match[1] : '';
      };

      const normalizeAvatarUrl = (avatarRaw, avatarIdRaw) => {
        const avatar = toText(avatarRaw);
        const avatarId = toText(avatarIdRaw);
        const pinIdFromAvatar = extractPinId(avatar);
        const pinId = avatarId || pinIdFromAvatar;
        const buildAvatarThumbnailUrl = (candidatePinId) => {
          const normalizedPinId = extractPinId(candidatePinId) || toText(candidatePinId);
          if (!normalizedPinId) return null;
          return buildV1Url(baseURL, `/users/avatar/accelerate/${normalizedPinId}?process=thumbnail`);
        };

        if (avatar && /^https?:\/\//i.test(avatar)) {
          if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/content\//i.test(avatar) && pinIdFromAvatar) {
            return buildAvatarThumbnailUrl(pinIdFromAvatar);
          }
          if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/content\//i.test(avatar) && pinIdFromAvatar) {
            return buildAvatarThumbnailUrl(pinIdFromAvatar);
          }
          if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/users\/avatar\/accelerate\//i.test(avatar) && pinIdFromAvatar) {
            if (/[?&]process=/i.test(avatar)) return avatar;
            return buildAvatarThumbnailUrl(pinIdFromAvatar);
          }
          if (/\/content\/?$/i.test(avatar)) return null;
          return avatar;
        }

        if (avatar.startsWith('metafile://')) {
          return buildAvatarThumbnailUrl(pinIdFromAvatar);
        }

        if (/^\/content\//i.test(avatar)) {
          return buildAvatarThumbnailUrl(pinIdFromAvatar);
        }

        if (/^\/files\/content\//i.test(avatar)) {
          return buildAvatarThumbnailUrl(pinIdFromAvatar);
        }

        if (avatarId) {
          return buildAvatarThumbnailUrl(avatarId);
        }

        if (pinId) {
          return buildAvatarThumbnailUrl(pinId);
        }

        return avatar || null;
      };

      const avatarNeedsAddressFallback = (avatarUrl) => {
        const normalized = toText(avatarUrl).toLowerCase();
        if (!normalized) return true;
        if (/\/content\/?$/.test(normalized)) return true;
        if (normalized.includes('/users/avatar/accelerate/')) return true;
        if (normalized.includes('file.metaid.io/metafile-indexer/content/')) return true;
        if (normalized.includes('file.metaid.io/metafile-indexer/api/v1/files/content/')) return true;
        return false;
      };

      const fetchUserByAddress = async (targetAddress) => {
        const normalizedAddress = toText(targetAddress);
        if (!normalizedAddress) return null;
        const addressEndpoint = `/users/address/${encodeURIComponent(normalizedAddress)}`;
        const addressUrl = buildServiceUrl(baseURL, addressEndpoint);
        const response = await fetch(addressUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });
        if (!response.ok) return null;
        const payload = await response.json();
        return extractUserInfo(payload);
      };

      // Step 1: Check IndexedDB for cached user data (only when we have metaid; address-based fetch skips cache)
      try {
        const cachedUser = metaid ? await this._getUserFromIndexedDB(metaid) : null;
        if (cachedUser) {
          let cacheChanged = false;

          if (cachedUser.avatarImg) {
            if (!cachedUser.avatar && toText(cachedUser.avatarImg)) {
              cachedUser.avatar = toText(cachedUser.avatarImg);
            }
            delete cachedUser.avatarImg;
            cacheChanged = true;
          }

          const normalizedCachedAvatar = normalizeAvatarUrl(
            cachedUser.avatarUrl || cachedUser.avatar || '',
            cachedUser.avatarId || ''
          );
          if (normalizedCachedAvatar !== cachedUser.avatarUrl) {
            cachedUser.avatarUrl = normalizedCachedAvatar;
            cacheChanged = true;
          }

          if (
            avatarNeedsAddressFallback(cachedUser.avatarUrl) &&
            toText(cachedUser.address) &&
            !/\/(?:v1\/)?users\/address\//.test(toText(endpoint))
          ) {
            try {
              const addressUserInfo = await fetchUserByAddress(cachedUser.address);
              if (addressUserInfo) {
                const fallbackAvatar = normalizeAvatarUrl(
                  addressUserInfo.avatarImage || addressUserInfo.avatarUrl || addressUserInfo.avatar,
                  addressUserInfo.avatarId || addressUserInfo.avatarPinId
                );
                if (fallbackAvatar) {
                  cachedUser.avatarUrl = fallbackAvatar;
                  cachedUser.avatar = addressUserInfo.avatar || cachedUser.avatar || '';
                  cachedUser.avatarId = addressUserInfo.avatarId || addressUserInfo.avatarPinId || cachedUser.avatarId || '';
                  cachedUser.globalMetaId = addressUserInfo.globalMetaId || cachedUser.globalMetaId || '';
                  cachedUser.metaid = addressUserInfo.metaid || addressUserInfo.metaId || cachedUser.metaid || '';
                  cachedUser.name = addressUserInfo.name || cachedUser.name || '';
                  cachedUser.address = addressUserInfo.address || cachedUser.address || '';
                  cacheChanged = true;
                }
              }
            } catch (error) {
              console.warn('UserDelegate: address avatar fallback (cache) failed:', error);
            }
          }

          if (cacheChanged) {
            await this._saveUserToIndexedDB(cachedUser);
          }
          return cachedUser;
        }
      } catch (error) {
        console.warn('UserDelegate: Error reading from IndexedDB:', error);
        // Continue to fetch from API
      }

      // Step 2: Fetch from remote API
      const finalEndpoint = endpoint || (globalMetaId ? `/info/globalmetaid/${globalMetaId}` : (metaid ? `/info/metaid/${metaid}` : (address ? `/users/address/${address}` : null)));
      if (!finalEndpoint) {
        throw new Error('UserDelegate: endpoint or metaid or globalMetaId or address is required');
      }
      const url = buildServiceUrl(baseURL, finalEndpoint);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const userData = await response.json();

        // Extract user info from API response (support code===1/code===0 + data, or data only, or raw user object)
        let userInfo = extractUserInfo(userData);

        if (userInfo) {
          // Step 3: Avatar URL – normalize different shapes and fallback by address when needed
          let effectiveUserInfo = userInfo;
          let avatarUrl = normalizeAvatarUrl(
            userInfo.avatarImage || userInfo.avatarUrl || userInfo.avatar,
            userInfo.avatarId || userInfo.avatarPinId
          );

          const normalizedAddress = toText(userInfo.address || address || '');
          const isAddressEndpoint = /\/(?:v1\/)?users\/address\//.test(toText(finalEndpoint));
          if (avatarNeedsAddressFallback(avatarUrl) && normalizedAddress && !isAddressEndpoint) {
            try {
              const addressUserInfo = await fetchUserByAddress(normalizedAddress);
              if (addressUserInfo) {
                effectiveUserInfo = { ...userInfo, ...addressUserInfo };
                avatarUrl = normalizeAvatarUrl(
                  effectiveUserInfo.avatarImage || effectiveUserInfo.avatarUrl || effectiveUserInfo.avatar,
                  effectiveUserInfo.avatarId || effectiveUserInfo.avatarPinId
                );
              }
            } catch (error) {
              console.warn('UserDelegate: address avatar fallback failed:', error);
            }
          }

          // Step 4: Prepare user object for storage (map API fields: metaId→metaid, namePinId→nameId, avatarPinId→avatarId, chatPublicKey→chatpubkey)
          const userObject = {
            globalMetaId: effectiveUserInfo.globalMetaId || globalMetaId || '',
            metaid: effectiveUserInfo.metaid || effectiveUserInfo.metaId || metaid,
            name: effectiveUserInfo.name || '',
            nameId: effectiveUserInfo.nameId || effectiveUserInfo.namePinId || '',
            address: effectiveUserInfo.address || address || '',
            avatar: effectiveUserInfo.avatar || '',
            avatarId: effectiveUserInfo.avatarId || effectiveUserInfo.avatarPinId || '',
            chatpubkey: effectiveUserInfo.chatpubkey || effectiveUserInfo.chatPublicKey || '',
            chatpubkeyId: effectiveUserInfo.chatpubkeyId || effectiveUserInfo.chatPublicKeyPinId || '',
            avatarUrl: avatarUrl,
          };

          // Step 5: Store in IndexedDB
          try {
            await this._saveUserToIndexedDB(userObject);
          } catch (error) {
            console.warn('UserDelegate: Error saving to IndexedDB:', error);
            // Continue anyway - return the data even if caching fails
          }

          return userObject;
        } else {
          const msg = (userData.message && userData.message !== 'success')
            ? userData.message
            : 'API response format not recognized (missing data or user object)';
          throw new Error(`UserDelegate: ${msg}`);
        }
      } catch (error) {
        console.error(`UserDelegate error for ${serviceKey}${endpoint}:`, error);
        throw error;
      }
    },

    /**
     * Initialize IndexedDB for user data storage
     * @returns {Promise<IDBDatabase>} IndexedDB database instance
     */
    async _initIndexedDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('idframework-user-db', 1);

        request.onerror = () => {
          reject(new Error('Failed to open IndexedDB'));
        };

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          
          // Create User object store if it doesn't exist
          if (!db.objectStoreNames.contains('User')) {
            const objectStore = db.createObjectStore('User', { keyPath: 'metaid' });
            // Create index for faster lookups
            objectStore.createIndex('globalMetaId', 'globalMetaId', { unique: false });
          }
        };
      });
    },

    /**
     * Get user data from IndexedDB
     * @param {string} metaid - MetaID to look up
     * @returns {Promise<Object|null>} User data or null if not found
     */
    async _getUserFromIndexedDB(metaid) {
      try {
        const cacheKey = String(metaid || '').trim();
        if (!cacheKey) return null;
        const db = await this._initIndexedDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction(['User'], 'readonly');
          const objectStore = transaction.objectStore('User');
          const request = objectStore.get(cacheKey);

          request.onsuccess = () => {
            resolve(request.result || null);
          };

          request.onerror = () => {
            reject(new Error('Failed to read from IndexedDB'));
          };
        });
      } catch (error) {
        console.error('_getUserFromIndexedDB error:', error);
        return null;
      }
    },

    /**
     * Save user data to IndexedDB
     * @param {Object} userData - User data object
     * @returns {Promise<void>}
     */
    async _saveUserToIndexedDB(userData) {
      try {
        const cacheKey = String(
          (userData && (userData.metaid || userData.metaId)) || ''
        ).trim();
        if (!cacheKey) {
          return;
        }
        const db = await this._initIndexedDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction(['User'], 'readwrite');
          const objectStore = transaction.objectStore('User');
          
          // Check for existing entry to potentially update its structure
          const getRequest = objectStore.get(cacheKey);
          getRequest.onsuccess = async () => {
            let existingUser = getRequest.result;
            let userToStore = {
              ...userData,
              metaid: cacheKey,
            }; // Start with normalized object

            if (existingUser) {
              // If old entry has avatarImg but not avatarUrl, migrate it
              if (existingUser.avatarImg && !existingUser.avatarUrl && userData.avatarUrl) {
                userToStore.avatarUrl = userData.avatarUrl;
                delete userToStore.avatarImg; // Remove old field
              }
              // Merge existing data with new data, prioritizing new data
              userToStore = { ...existingUser, ...userToStore };
            }

            const putRequest = objectStore.put(userToStore); // Use put to add or update

            putRequest.onerror = () => {
              reject(new Error('Failed to save to IndexedDB'));
            };

            putRequest.onsuccess = () => {
              resolve();
            };
          };
          getRequest.onerror = () => {
            reject(new Error('Error checking existing user in IndexedDB'));
          };
        });
      } catch (error) {
        console.error('_saveUserToIndexedDB error:', error);
        throw error;
      }
    },

    /**
     * Clear all cached user data from IndexedDB
     * This is useful for debugging or when cache structure changes
     * Usage: IDFramework.Delegate.UserDelegate.clearUserCache()
     */
    async clearUserCache() {
      try {
        const db = await this._initIndexedDB();
        return new Promise((resolve, reject) => {
          const transaction = db.transaction(['User'], 'readwrite');
          const objectStore = transaction.objectStore('User');
          const request = objectStore.clear();

          request.onerror = () => {
            reject(new Error('Error clearing user cache from IndexedDB'));
          };

          request.onsuccess = () => {
            resolve();
          };
        });
      } catch (error) {
        console.error('clearUserCache error:', error);
        throw error;
      }
    },

    /**
     * Convert Blob to Data URL (Base64)
     * @param {Blob} blob - Blob to convert
     * @returns {Promise<string>} Data URL string
     */
    async _blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    },
  };

  /**
   * ============================================
   * CONTROLLER LAYER - Event to Command Mapping
   * ============================================
   * 
   * IDController maps events to Commands with async lazy loading.
   * This allows Commands to be loaded on-demand, reducing initial bundle size.
   * 
   * Built-in Commands:
   * - connectWallet: Connect to Metalet wallet
   * - createPIN: Create and broadcast a PIN to the blockchain (mock implementation)
   */

  /**
   * IDController - Maps Events to Commands
   * 
   * The controller maintains a registry of event-to-command mappings.
   * Commands are lazy-loaded when events are dispatched, enabling code splitting.
   */
  static IDController = {
    /**
     * Command registry: Map of event names to command module paths
     * @type {Map<string, string>}
     */
    commands: new Map(),

    /**
     * Built-in command registry for framework-provided commands
     * @type {Map<string, Function>}
     */
    builtInCommands: new Map(),

    /**
     * Register a command for an event
     * 
     * Commands can be:
     * - File paths (e.g., './commands/FetchBuzzCommand.js') - will be lazy-loaded
     * - Built-in command functions (registered via registerBuiltIn)
     * 
     * @param {string} eventName - Event name (e.g., 'fetchBuzz', 'postBuzz')
     * @param {string|Function} commandPathOrFunction - Path to command module or built-in command function
     * 
     * @example
     * // Register a file-based command
     * IDFramework.IDController.register('fetchBuzz', './commands/FetchBuzzCommand.js');
     * 
     * @example
     * // Register a built-in command
     * IDFramework.IDController.registerBuiltIn('connectWallet', IDFramework.BuiltInCommands.connectWallet);
     */
    register(eventName, commandPathOrFunction) {
      if (typeof commandPathOrFunction === 'function') {
        this.builtInCommands.set(eventName, commandPathOrFunction);
      } else {
        this.commands.set(eventName, commandPathOrFunction);
      }
    },

    /**
     * Register a built-in command function
     * 
     * @param {string} eventName - Event name
     * @param {Function} commandFunction - Command function
     */
    registerBuiltIn(eventName, commandFunction) {
      this.builtInCommands.set(eventName, commandFunction);
    },

    /**
     * Execute a command for an event
     * 
     * This method:
     * 1. Looks up the command for the event
     * 2. Lazy-loads file-based commands or uses built-in commands
     * 3. Instantiates and executes the command
     * 4. Passes BusinessDelegate and relevant stores to the command
     * 
     * @param {string} eventName - Event name to execute
     * @param {Object} payload - Event payload data
     * @param {Object} stores - Object containing relevant Alpine stores (optional, auto-resolved if not provided)
     * @returns {Promise<void>}
     * 
     * @example
     * await IDFramework.IDController.execute('fetchBuzz', { cursor: 0, size: 30 });
     */
    async execute(eventName, payload = {}, stores = null) {
        
      // Check built-in commands first
      const builtInCommand = this.builtInCommands.get(eventName);
      if (builtInCommand) {
        try {
          // Resolve stores if not provided
          if (!stores) {
            stores = {
              wallet: IDFramework.getStore('wallet'),
              app: IDFramework.getStore('app'),
            };
          }
          
          const builtInResult = await builtInCommand({
            payload,
            stores,
            delegate: IDFramework.Delegate.BusinessDelegate.bind(IDFramework.Delegate),
            userDelegate: IDFramework.Delegate.UserDelegate.bind(IDFramework.Delegate),
          });
          return builtInResult;
        } catch (error) {
          console.error(`Error executing built-in command '${eventName}':`, error);
          throw error;
        }
      }

      // Check file-based commands
      const commandPath = this.commands.get(eventName);
      
      if (!commandPath) {
        console.warn(`No command registered for event: ${eventName}`);
        return;
      }

      // Validate commandPath is a valid string
      if (typeof commandPath !== 'string' || !commandPath.trim()) {
        console.error(`Invalid command path for event '${eventName}': ${commandPath}`);
        return;
      }
      
      try {
        // Lazy load the command module
        const CommandModule = await import(commandPath);
        const CommandClass = CommandModule.default || CommandModule[Object.keys(CommandModule)[0]];
        
        if (!CommandClass) {
          throw new Error(`Command class not found in ${commandPath}`);
        }

        const command = new CommandClass();
        
        // Resolve stores if not provided
        // Include all registered stores (wallet, app, buzz, user, chat, etc.)
        if (!stores) {
          stores = {
            wallet: IDFramework.getStore('wallet'),
            app: IDFramework.getStore('app'),
            user: IDFramework.getStore('user'),
            
          };
        }
        
        // Execute command with Delegate and stores
        // Commands can use either BusinessDelegate or UserDelegate
        // Bind UserDelegate to Delegate object to ensure 'this' context is correct
        const commandResult = await command.execute({
          payload,
          stores,
          delegate: IDFramework.Delegate.BusinessDelegate.bind(IDFramework.Delegate),
          userDelegate: IDFramework.Delegate.UserDelegate.bind(IDFramework.Delegate),
        });
        return commandResult;
      } catch (error) {
        console.error(`Error executing command for event '${eventName}':`, error);
        throw error;
      }
    },
  };

  /**
   * ============================================
   * BUILT-IN COMMANDS
   * ============================================
   * 
   * Framework-provided commands for common MetaID operations.
   * These can be used directly or extended by applications.
   */

  /**
   * Built-in Commands collection
   */
  static BuiltInCommands = {
    /**
     * ConnectWalletCommand - Connect to Metalet wallet
     * 
     * Updates the wallet store with connection status and user information.
     * 
     * @param {Object} params - Command parameters
     * @param {Object} params.stores - Alpine stores (wallet, app)
     * @returns {Promise<void>}
     */
    async connectWallet({ stores }) {
      if (!window.metaidwallet) {
        throw new Error('Metalet wallet is not installed. Please install Metalet extension first.');
      }

      try {
        const result = await window.metaidwallet.connect();
        
        if (result && result.address) {
          // Update wallet store
          stores.wallet.isConnected = true;
          stores.wallet.address = result.address;
          
          // Try to get additional wallet info
          try {
            // stores.wallet.metaid = result.metaid || result.address;
            stores.wallet.publicKey = await window.metaidwallet.getPublicKey();
             const network = await window.metaidwallet.getNetwork();
             if(network){
                     stores.wallet.network=network.network
             }else{
                stores.wallet.network='mainnet'
             }
            
            // Get GlobalMetaID for cross-chain identity
            try {
              const globalMetaIdResult = await window.metaidwallet.getGlobalMetaid();
              
              if (globalMetaIdResult && globalMetaIdResult.mvc) {
                
                stores.wallet.globalMetaId = globalMetaIdResult.mvc.globalMetaId;
                stores.wallet.globalMetaIdInfo = globalMetaIdResult; // Store full info (mvc, btc, doge)
              }
            } catch (e) {
              console.warn('Failed to get GlobalMetaID:', e);
            }
          } catch (e) {
            console.warn('Failed to get additional wallet info:', e);
          }

          // Update app store
          stores.app.isLogin = true;
          stores.app.userAddress = result.address;
        }
      } catch (error) {
        console.error('Failed to connect wallet:', error);
        throw error;
      }
    },

    /**
     * CreatePINCommand - Create and broadcast a PIN to the blockchain
     * 
     * This method:
     * 1. Constructs the PIN transaction
     * 2. Signs the transaction using Metalet
     * 3. Broadcasts to the blockchain
     * 
     * @param {Object} params - Command parameters
     * @param {Object} params.payload - PIN data (operation, body, path, contentType)
     * @param {Object} params.stores - Alpine stores
     * @returns {Promise<Object>} Created PIN information
     */
    async createPin({ payload, stores }) {
      try {
        // 1. Construct PIN transaction
        // 2. Sign with Metalet
        // 3. Broadcast to blockchain
        
        const { operation, body, path, contentType } = payload;

        if (!body) {
          throw new Error('PIN body is required');
        }

        const normalizeChain = (rawChain) => {
          const chain = String(rawChain || '').trim().toLowerCase();
          if (chain === 'btc' || chain === 'bsv') return 'btc';
          if (chain === 'doge' || chain === 'dogecoin') return 'doge';
          if (chain === 'mvc' || chain === 'microvisionchain') return 'mvc';
          return '';
        };
        const cfg = window.IDConfig || {};
        const resolvedChain = normalizeChain(payload.chain || payload.network || payload.blockchain || cfg.CHAIN || cfg.DEFAULT_CHAIN) || 'mvc';
        const payloadFeeRate = Number(payload.feeRate);
        const cfgFeeRate = Number(cfg.FEE_RATE);
        const resolvedFeeRate = (Number.isFinite(payloadFeeRate) && payloadFeeRate > 0)
          ? payloadFeeRate
          : ((Number.isFinite(cfgFeeRate) && cfgFeeRate > 0) ? cfgFeeRate : 1);

        const metaidData = {
          operation: operation,
          path: path,
          body: body,
          contentType: contentType,
        };
        if (payload.encoding) metaidData.encoding = payload.encoding;
        if (payload.encryption) metaidData.encryption = payload.encryption;
        if (payload.flag) metaidData.flag = payload.flag;

        const normalizeInscribeFeeRate = (chainName, rawFeeRate) => {
          const numeric = Number(rawFeeRate);
          if (!Number.isFinite(numeric) || numeric <= 0) {
            return chainName === 'doge' ? 200000 : 1;
          }
          if (chainName === 'btc' && numeric === 1) return 1.1;
          if (chainName === 'doge') return Math.max(1, Math.round(numeric));
          return numeric;
        };
        const extractTxidLike = (value) => {
          if (!value) return '';
          if (typeof value === 'string') {
            const raw = String(value).trim();
            if (!raw) return '';
            const pinMatch = raw.match(/([a-fA-F0-9]{64})i\d+$/);
            if (pinMatch && pinMatch[1]) return pinMatch[1];
            const txMatch = raw.match(/([a-fA-F0-9]{64})/);
            return txMatch && txMatch[1] ? txMatch[1] : '';
          }
          if (typeof value === 'object') {
            const direct = extractTxidLike(
              value.txid ||
              value.txId ||
              value.hash ||
              value.id ||
              value.pinId ||
              value.revealTxId ||
              value.revealTxid
            );
            if (direct) return direct;
            if (Array.isArray(value.txids)) {
              for (let i = 0; i < value.txids.length; i += 1) {
                const candidate = extractTxidLike(value.txids[i]);
                if (candidate) return candidate;
              }
            }
            if (Array.isArray(value.txIDs)) {
              for (let i = 0; i < value.txIDs.length; i += 1) {
                const candidate = extractTxidLike(value.txIDs[i]);
                if (candidate) return candidate;
              }
            }
            if (Array.isArray(value.revealTxIds)) {
              for (let i = 0; i < value.revealTxIds.length; i += 1) {
                const candidate = extractTxidLike(value.revealTxIds[i]);
                if (candidate) return candidate;
              }
            }
            if (Array.isArray(value.res)) {
              for (let i = 0; i < value.res.length; i += 1) {
                const candidate = extractTxidLike(value.res[i]);
                if (candidate) return candidate;
              }
            }
          }
          return '';
        };
        const normalizeInscribeResult = (rawResult) => {
          if (!rawResult) return rawResult;
          const txids = [];
          const collectFromList = (list) => {
            if (!Array.isArray(list)) return;
            for (let i = 0; i < list.length; i += 1) {
              const candidate = extractTxidLike(list[i]);
              if (candidate) txids.push(candidate);
            }
          };
          if (Array.isArray(rawResult)) collectFromList(rawResult);
          if (rawResult && typeof rawResult === 'object') {
            collectFromList(rawResult.txIDs);
            collectFromList(rawResult.txids);
            collectFromList(rawResult.revealTxIds);
            collectFromList(rawResult.res);
            const direct = extractTxidLike(rawResult);
            if (direct) txids.push(direct);
          } else {
            const direct = extractTxidLike(rawResult);
            if (direct) txids.push(direct);
          }
          const unique = Array.from(new Set(txids.filter(Boolean)));
          if (unique.length > 0) return { txids: unique };
          return rawResult;
        };
        const shouldFallbackToCreatePinFromInscribe = (error) => {
          if (!error) return false;
          const message = String(error.message || error || '').toLowerCase();
          if (!message) return false;
          if (message.indexOf('insufficient funds') >= 0) return true;
          if (message.indexOf('insufficient') >= 0 && message.indexOf('balance') >= 0) return true;
          if (message.indexOf('insufficient') >= 0 && message.indexOf('utxo') >= 0) return true;
          if (message.indexOf('need') >= 0 && message.indexOf('have') >= 0) return true;
          return false;
        };
        const tryInscribeByChain = async () => {
          if (resolvedChain !== 'btc' && resolvedChain !== 'doge') return null;
          const wallet = window.metaidwallet || {};
          const chainApi = wallet[resolvedChain];
          if (!chainApi || typeof chainApi.inscribe !== 'function' || typeof chainApi.getAddress !== 'function') {
            return null;
          }
          const revealAddress = await chainApi.getAddress();
          if (!revealAddress) throw new Error('wallet chain address is unavailable');

          const rawInscribeRes = await chainApi.inscribe({
            data: {
              feeRate: normalizeInscribeFeeRate(resolvedChain, resolvedFeeRate),
              revealOutValue: resolvedChain === 'doge' ? 100000 : 546,
              metaidDataList: [{
                operation: metaidData.operation,
                revealAddr: revealAddress,
                body: metaidData.body,
                path: metaidData.path,
                contentType: metaidData.contentType || 'text/plain',
                encryption: metaidData.encryption,
                flag: metaidData.flag,
                version: '1.0.0',
                encoding: metaidData.encoding || 'utf-8',
              }],
              changeAddress: revealAddress,
            },
            options: { noBroadcast: false },
          });
          if (
            rawInscribeRes &&
            typeof rawInscribeRes === 'object' &&
            rawInscribeRes.status &&
            String(rawInscribeRes.status).toLowerCase() !== 'success'
          ) {
            throw new Error(String(rawInscribeRes.status));
          }
          return normalizeInscribeResult(rawInscribeRes);
        };

        let inscribeRes = null;
        try {
          inscribeRes = await tryInscribeByChain();
        } catch (inscribeError) {
          if (!shouldFallbackToCreatePinFromInscribe(inscribeError)) throw inscribeError;
          inscribeRes = null;
        }
        if (inscribeRes) return inscribeRes;

        const parmas = {
          chain: resolvedChain,
          feeRate: resolvedFeeRate,
          dataList: [
            {
              metaidData: metaidData,
            }
          ]
        };
        
        const createPinRes = await window.metaidwallet.createPin(parmas);
        return createPinRes;
      } catch (e) {
        throw new Error(e);
      }
    },

  
  };

  /**
   * ============================================
   * INITIALIZATION
   * ============================================
   */

  /**
   * Initialize IDFramework
   * 
   * This method initializes the framework with built-in models and registers built-in commands.
   * Should be called after Alpine.js is loaded but before DOM processing.
   * 
   * @param {Object} customModels - Optional custom models to register
   * 
   * @example
   * IDFramework.init({
   *   user: { name: '', email: '' }
   * });
   */
  static init(customModels = {}) {
    this.I18n.init();

    // Initialize built-in models
    this.initModels(customModels);

    // Register built-in commands
    this.IDController.registerBuiltIn('connectWallet', this.BuiltInCommands.connectWallet);
    this.IDController.registerBuiltIn('createPIN', this.BuiltInCommands.createPin);
  }

  /**
   * ============================================
   * ROUTER LAYER - Hash-based Routing
   * ============================================
   * 
   * IDRouter handles hash-based routing for SPA navigation.
   * It listens to hash changes and dispatches ROUTE_CHANGE events
   * that are handled by routing commands (e.g., NavigateCommand).
   */

  

  /**
   * ============================================
   * HELPER METHODS
   * ============================================
   */

  /**
   * Load a Web Component dynamically (lazy loading)
   * 
   * This method allows components to be loaded on-demand rather than at startup,
   * reducing initial bundle size and improving performance.
   * 
   * @param {string} componentPath - Relative path to the component module (e.g., './components/id-buzz-card.js')
   * @returns {Promise<void>} Resolves when the component is loaded and registered
   * 
   * @example
   * // Load a component dynamically
   * await IDFramework.loadComponent('./components/id-buzz-card.js');
   * 
   * // Now the component can be used in the DOM
   * // <id-buzz-card content="Hello" author="user123"></id-buzz-card>
   */
  static async loadComponent(componentPath) {
    try {
      // Use dynamic import to load the component module
      await import(componentPath);
      // Component is automatically registered via customElements.define() in the module
      console.log(`Component loaded: ${componentPath}`);
    } catch (error) {
      console.error(`Failed to load component from ${componentPath}:`, error);
      throw new Error(`Component loading failed: ${error.message}`);
    }
  }

  /**
   * Dispatch an event (helper for views)
   * 
   * This is a convenience method for views to dispatch events.
   * It automatically resolves the appropriate stores and executes the command.
   * 
   * @param {string} eventName - Event name
   * @param {Object} payload - Event payload
   * @param {string} storeName - Optional specific store name (default: auto-resolve all)
   * 
   * @example
   * // In a component
   * await IDFramework.dispatch('fetchBuzz', { cursor: 0, size: 30 });
   * 
   * @example
   * // In a component with specific store
   * await IDFramework.dispatch('updateUser', { name: 'John' }, 'user');
   */
  static async dispatch(eventName, payload = {}, storeName = null) {
    // Auto-resolve all available stores
    // This ensures commands have access to all stores they might need
    const stores = {
      wallet: this.getStore('wallet'),
      app: this.getStore('app'),
    };

    // Add all other registered stores (like 'buzz', 'user', etc.)
    // Alpine doesn't provide a direct way to list all stores,
    // so we try common store names and add any that exist
    const commonStoreNames = [ 'user', 'settings', 'chat', 'buzz' ];
    commonStoreNames.forEach(name => {
      const store = this.getStore(name);
      if (store) {
        stores[name] = store;
      }
    });
    
    // Ensure user store is always included for user-related commands
    if (!stores.user && this.getStore('user')) {
      stores.user = this.getStore('user');
    }

    // If specific store requested, add it (even if not in common list)
    if (storeName && this.getStore(storeName)) {
      stores[storeName] = this.getStore(storeName);
    }
    
    return await this.IDController.execute(eventName, payload, stores);
  }

  /**
   * createOrUpdateUserInfo - Configurable hook for MetaID user registration / profile update
   * Set window.__createOrUpdateUserInfoImpl to your implementation (e.g. assist API + wallet).
   * @param {Object} opts - { userData: { name, bio?, avatar? }, oldUserData: { nameId, bioId, avatarId, chatpubkey }, options: { feeRate, network, assistDomain } }
   * @returns {Promise<Object>} Result with txids etc.
   */
  static async createOrUpdateUserInfo(opts) {
    if (typeof window.__createOrUpdateUserInfoImpl === 'function') {
      return window.__createOrUpdateUserInfoImpl(opts);
    }
    throw new Error('User registration not configured. Set window.__createOrUpdateUserInfoImpl.');
  }
}

// Make IDFramework globally available
window.IDFramework = IDFramework;

// Expose router for convenience
IDFramework.router = IDFramework.IDRouter;

// Auto-initialize framework when Alpine is ready
// This ensures built-in commands are registered even if init() wasn't called explicitly
const initializeFramework = () => {
  try {
    IDFramework.init();
  } catch (error) {
    console.error('IDFramework initialization failed:', error);
  }
};

if (typeof window !== 'undefined') {
  if (window.Alpine && typeof window.Alpine.store === 'function') {
    initializeFramework();
  } else {
    window.addEventListener('alpine:init', initializeFramework, { once: true });
    IDFramework.ensureAlpineLoaded().catch((error) => {
      console.error('IDFramework failed to auto-load Alpine.js:', error);
    });
  }
}
