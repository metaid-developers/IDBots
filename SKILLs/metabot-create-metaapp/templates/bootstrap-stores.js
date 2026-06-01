// CRITICAL: Register stores in alpine:init event
// This event fires BEFORE Alpine processes the DOM, ensuring stores are available
window.addEventListener('alpine:init', () => {
  const CHAIN_FEE_STORAGE_KEY = 'idframework_chain_fee';
  const CHAIN_FEE_REFRESH_MS = 5 * 60 * 1000;
  const CHAIN_FEE_ENDPOINTS = {
    btc: 'https://api.mvcscan.com/browser/v1/fees/recommended?chain=btc',
    mvc: 'https://api.mvcscan.com/browser/v1/fees/recommended?net=livenet',
    doge: 'https://api.mvcscan.com/browser/v1/fees/recommended?chain=doge',
  };
  const CHAIN_FEE_DEFAULTS = {
    btc: {
      fastestFee: 1,
      halfHourFee: 1,
      hourFee: 1,
      economyFee: 1,
      minimumFee: 1,
      customizeFee: 1,
      selectedFeeType: 'economyFee',
      lastUpdated: 0,
    },
    mvc: {
      fastestFee: 1,
      halfHourFee: 1,
      hourFee: 1,
      economyFee: 1,
      minimumFee: 1,
      customizeFee: 1,
      selectedFeeType: 'economyFee',
      lastUpdated: 0,
    },
    doge: {
      fastestFee: 300000,
      halfHourFee: 250000,
      hourFee: 200000,
      economyFee: 200000,
      minimumFee: 200000,
      customizeFee: 5000000,
      selectedFeeType: 'economyFee',
      lastUpdated: 0,
    },
    currentChain: 'mvc',
  };

  const StorageHelper = {
    saveWallet: (walletData) => {
      try {
        localStorage.setItem('idframework_wallet', JSON.stringify(walletData));
      } catch (error) {
        console.error('Failed to save wallet to localStorage:', error);
      }
    },
    loadWallet: () => {
      try {
        const stored = localStorage.getItem('idframework_wallet');
        if (stored) return JSON.parse(stored);
      } catch (error) {
        console.error('Failed to load wallet from localStorage:', error);
      }
      return null;
    },
    saveApp: (isLogin, userAddress) => {
      try {
        localStorage.setItem('idframework_app_isLogin', JSON.stringify(isLogin));
        localStorage.setItem('idframework_app_userAddress', JSON.stringify(userAddress));
      } catch (error) {
        console.error('Failed to save app to localStorage:', error);
      }
    },
    loadApp: () => {
      try {
        const isLogin = localStorage.getItem('idframework_app_isLogin');
        const userAddress = localStorage.getItem('idframework_app_userAddress');
        return {
          isLogin: isLogin !== null ? JSON.parse(isLogin) : false,
          userAddress: userAddress !== null ? JSON.parse(userAddress) : null,
        };
      } catch (error) {
        console.error('Failed to load app from localStorage:', error);
        return { isLogin: false, userAddress: null };
      }
    },
    saveUser: (users) => {
      try {
        localStorage.setItem('idframework_user_users', JSON.stringify(users));
      } catch (error) {
        console.error('Failed to save user to localStorage:', error);
      }
    },
    loadUser: () => {
      try {
        const stored = localStorage.getItem('idframework_user_users');
        if (stored) return JSON.parse(stored);
      } catch (error) {
        console.error('Failed to load user from localStorage:', error);
      }
      return null;
    },
    saveChainFee: (chainFeeData) => {
      try {
        localStorage.setItem(CHAIN_FEE_STORAGE_KEY, JSON.stringify(chainFeeData));
      } catch (error) {
        console.error('Failed to save chain fee store to localStorage:', error);
      }
    },
    loadChainFee: () => {
      try {
        const stored = localStorage.getItem(CHAIN_FEE_STORAGE_KEY);
        if (stored) return JSON.parse(stored);
      } catch (error) {
        console.error('Failed to load chain fee store from localStorage:', error);
      }
      return null;
    },
  };

  const savedWallet = StorageHelper.loadWallet();
  const savedApp = StorageHelper.loadApp();
  const savedUsers = StorageHelper.loadUser();
  const savedChainFee = StorageHelper.loadChainFee();

  const createPersistedStore = (storeData, syncCallback, nestedProps = []) => {
    const handler = {
      set(target, property, value) {
        const result = Reflect.set(target, property, value);
        syncCallback(target);
        return result;
      },
      get(target, property) {
        const value = Reflect.get(target, property);
        if (value && typeof value === 'object' && !Array.isArray(value) && nestedProps.includes(property)) {
          const nestedHandler = {
            set(nestedTarget, nestedProperty, nestedValue) {
              const result = Reflect.set(nestedTarget, nestedProperty, nestedValue);
              syncCallback(target);
              return result;
            },
            get(nestedTarget, nestedProperty) {
              return Reflect.get(nestedTarget, nestedProperty);
            },
            deleteProperty(nestedTarget, nestedProperty) {
              const result = Reflect.deleteProperty(nestedTarget, nestedProperty);
              syncCallback(target);
              return result;
            }
          };
          return new Proxy(value, nestedHandler);
        }
        return value;
      },
      deleteProperty(target, property) {
        const result = Reflect.deleteProperty(target, property);
        syncCallback(target);
        return result;
      }
    };
    return new Proxy(storeData, handler);
  };

  const normalizeChainName = (rawChain) => {
    const chain = String(rawChain || '').trim().toLowerCase();
    if (chain === 'btc' || chain === 'bsv') return 'btc';
    if (chain === 'doge' || chain === 'dogecoin') return 'doge';
    if (chain === 'mvc' || chain === 'microvisionchain') return 'mvc';
    return '';
  };

  const pickFeeNumber = (rawValue, fallbackValue) => {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return Number(fallbackValue);
  };

  const hydrateChainFeeState = (saved) => {
    const output = {
      btc: { ...CHAIN_FEE_DEFAULTS.btc },
      mvc: { ...CHAIN_FEE_DEFAULTS.mvc },
      doge: { ...CHAIN_FEE_DEFAULTS.doge },
      currentChain: CHAIN_FEE_DEFAULTS.currentChain,
    };
    if (!saved || typeof saved !== 'object') return output;
    ['btc', 'mvc', 'doge'].forEach((chain) => {
      const source = saved[chain];
      if (!source || typeof source !== 'object') return;
      output[chain].fastestFee = pickFeeNumber(source.fastestFee, output[chain].fastestFee);
      output[chain].halfHourFee = pickFeeNumber(source.halfHourFee, output[chain].halfHourFee);
      output[chain].hourFee = pickFeeNumber(source.hourFee, output[chain].hourFee);
      output[chain].economyFee = pickFeeNumber(source.economyFee, output[chain].economyFee);
      output[chain].minimumFee = pickFeeNumber(source.minimumFee, output[chain].minimumFee);
      output[chain].customizeFee = pickFeeNumber(source.customizeFee, output[chain].customizeFee);
      const selectedFeeType = String(source.selectedFeeType || '').trim();
      if (selectedFeeType) output[chain].selectedFeeType = selectedFeeType;
      output[chain].lastUpdated = Number(source.lastUpdated || 0);
    });
    const currentChain = normalizeChainName(saved.currentChain);
    if (currentChain) output.currentChain = currentChain;
    return output;
  };

  const walletStoreData = {
    isConnected: savedWallet?.isConnected ?? false,
    address: savedWallet?.address ?? null,
    publicKey: savedWallet?.publicKey ?? null,
    network: savedWallet?.network ?? null,
    globalMetaId: savedWallet?.globalMetaId ?? null,
    metaid: savedWallet?.metaid ?? null,
    globalMetaIdInfo: savedWallet?.globalMetaIdInfo ?? null,
  };
  const proxiedWalletStore = createPersistedStore(walletStoreData, (store) => {
    StorageHelper.saveWallet({
      isConnected: store.isConnected,
      address: store.address,
      publicKey: store.publicKey,
      network: store.network,
      globalMetaId: store.globalMetaId,
      metaid: store.metaid,
      globalMetaIdInfo: store.globalMetaIdInfo,
    });
  });
  Alpine.store('wallet', proxiedWalletStore);

  const appStoreData = {
    isLogin: savedApp.isLogin,
    userAddress: savedApp.userAddress,
    isWebView: false,
    currentView: null,
    routeParams: {},
    currentPath: '/',
  };
  const proxiedAppStore = createPersistedStore(appStoreData, (store) => {
    StorageHelper.saveApp(store.isLogin, store.userAddress);
  });
  Alpine.store('app', proxiedAppStore);

  const userStoreData = {
    user: savedUsers ?? {},
    isLoading: false,
    error: null,
    showProfileEditModal: false,
  };
  const proxiedUserStore = createPersistedStore(
    userStoreData,
    (store) => {
      StorageHelper.saveUser(store.user);
    },
    ['user']
  );
  Alpine.store('user', proxiedUserStore);

  const chainFeeData = hydrateChainFeeState(savedChainFee);
  const chainFeeStoreData = {
    btc: chainFeeData.btc,
    mvc: chainFeeData.mvc,
    doge: chainFeeData.doge,
    currentChain: chainFeeData.currentChain,
    isLoading: false,
    lastError: '',
    _refreshTimer: null,
    _inflightPromise: null,
    _normalChain(raw) {
      return normalizeChainName(raw);
    },
    _resolveChainOrDefault(rawChain) {
      return this._normalChain(rawChain) || 'mvc';
    },
    _getChainState(rawChain) {
      const chain = this._resolveChainOrDefault(rawChain);
      return this[chain] || this.mvc;
    },
    _getCurrentSelectedFeeType(rawChain) {
      const state = this._getChainState(rawChain);
      const selected = String(state.selectedFeeType || '').trim();
      if (selected && Number.isFinite(Number(state[selected])) && Number(state[selected]) > 0) return selected;
      return 'economyFee';
    },
    _sanitizeCustomFee(chain, rawValue) {
      let value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) {
        value = Number(this._getChainState(chain).customizeFee || 1);
      }
      if (chain === 'doge') return Math.max(5000000, Math.round(value));
      return Math.max(1, Math.round(value));
    },
    getCurrentChain() {
      return this._resolveChainOrDefault(this.currentChain);
    },
    setCurrentChain(rawChain) {
      this.currentChain = this._resolveChainOrDefault(rawChain);
    },
    setFeeType(rawChain, rawFeeType) {
      const chain = this._resolveChainOrDefault(rawChain);
      const target = this._getChainState(chain);
      const feeType = String(rawFeeType || '').trim();
      if (!feeType) return;
      if (feeType !== 'customizeFee' && (!Number.isFinite(Number(target[feeType])) || Number(target[feeType]) <= 0)) return;
      target.selectedFeeType = feeType;
    },
    setCustomizeFee(rawChain, rawValue) {
      const chain = this._resolveChainOrDefault(rawChain);
      const target = this._getChainState(chain);
      target.customizeFee = this._sanitizeCustomFee(chain, rawValue);
      target.selectedFeeType = 'customizeFee';
      target.lastUpdated = Date.now();
    },
    getSelectedFeeRate(rawChain) {
      const chain = this._resolveChainOrDefault(rawChain || this.currentChain);
      const state = this._getChainState(chain);
      const feeType = this._getCurrentSelectedFeeType(chain);
      const fromSelected = Number(state[feeType]);
      if (Number.isFinite(fromSelected) && fromSelected > 0) return fromSelected;
      return Number(state.economyFee || 1);
    },
    getSelectedFeeType(rawChain) {
      return this._getCurrentSelectedFeeType(rawChain || this.currentChain);
    },
    getChainFeeSnapshot(rawChain) {
      const chain = this._resolveChainOrDefault(rawChain || this.currentChain);
      const state = this._getChainState(chain);
      return {
        chain: chain,
        feeType: this._getCurrentSelectedFeeType(chain),
        feeRate: this.getSelectedFeeRate(chain),
        state: {
          fastestFee: Number(state.fastestFee || 0),
          halfHourFee: Number(state.halfHourFee || 0),
          hourFee: Number(state.hourFee || 0),
          economyFee: Number(state.economyFee || 0),
          minimumFee: Number(state.minimumFee || 0),
          customizeFee: Number(state.customizeFee || 0),
          selectedFeeType: String(state.selectedFeeType || ''),
          lastUpdated: Number(state.lastUpdated || 0),
        },
      };
    },
    async _requestFeeRates(url) {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) throw new Error(`fee api status ${response.status}`);
      return await response.json();
    },
    _applyFetchedRates(chain, payload) {
      const state = this._getChainState(chain);
      const source = payload && typeof payload === 'object' ? payload : {};
      state.fastestFee = pickFeeNumber(source.fastestFee, state.fastestFee);
      state.halfHourFee = pickFeeNumber(source.halfHourFee, state.halfHourFee);
      state.hourFee = pickFeeNumber(source.hourFee, state.hourFee);
      state.minimumFee = pickFeeNumber(source.minimumFee, state.minimumFee);
      if (chain === 'mvc') {
        state.economyFee = 1;
      } else {
        state.economyFee = pickFeeNumber(source.economyFee, state.economyFee);
      }
      state.lastUpdated = Date.now();
    },
    async refreshFeeRatesForChain(rawChain) {
      const chain = this._resolveChainOrDefault(rawChain);
      const endpoint = CHAIN_FEE_ENDPOINTS[chain];
      if (!endpoint) return;
      const payload = await this._requestFeeRates(endpoint);
      this._applyFetchedRates(chain, payload);
    },
    async refreshAllFeeRates() {
      if (this._inflightPromise) return this._inflightPromise;
      this.isLoading = true;
      this.lastError = '';
      this._inflightPromise = Promise.allSettled([
        this.refreshFeeRatesForChain('btc'),
        this.refreshFeeRatesForChain('mvc'),
        this.refreshFeeRatesForChain('doge'),
      ])
        .then((resultList) => {
          const hasSuccess = resultList.some((item) => item.status === 'fulfilled');
          if (!hasSuccess) {
            const firstError = resultList.find((item) => item.status === 'rejected');
            throw firstError && firstError.reason ? firstError.reason : new Error('refresh fee rates failed');
          }
        })
        .catch((error) => {
          this.lastError = error && error.message ? String(error.message) : 'refresh fee rates failed';
        })
        .finally(() => {
          this.isLoading = false;
          this._inflightPromise = null;
        });
      return this._inflightPromise;
    },
    startAutoRefresh() {
      this.stopAutoRefresh();
      this._refreshTimer = setInterval(() => {
        this.refreshAllFeeRates().catch(() => {});
      }, CHAIN_FEE_REFRESH_MS);
    },
    stopAutoRefresh() {
      if (this._refreshTimer) {
        clearInterval(this._refreshTimer);
        this._refreshTimer = null;
      }
    },
  };
  const proxiedChainFeeStore = createPersistedStore(
    chainFeeStoreData,
    (store) => {
      StorageHelper.saveChainFee({
        currentChain: store.currentChain,
        btc: {
          fastestFee: Number(store.btc.fastestFee || 0),
          halfHourFee: Number(store.btc.halfHourFee || 0),
          hourFee: Number(store.btc.hourFee || 0),
          economyFee: Number(store.btc.economyFee || 0),
          minimumFee: Number(store.btc.minimumFee || 0),
          customizeFee: Number(store.btc.customizeFee || 0),
          selectedFeeType: String(store.btc.selectedFeeType || ''),
          lastUpdated: Number(store.btc.lastUpdated || 0),
        },
        mvc: {
          fastestFee: Number(store.mvc.fastestFee || 0),
          halfHourFee: Number(store.mvc.halfHourFee || 0),
          hourFee: Number(store.mvc.hourFee || 0),
          economyFee: Number(store.mvc.economyFee || 0),
          minimumFee: Number(store.mvc.minimumFee || 0),
          customizeFee: Number(store.mvc.customizeFee || 0),
          selectedFeeType: String(store.mvc.selectedFeeType || ''),
          lastUpdated: Number(store.mvc.lastUpdated || 0),
        },
        doge: {
          fastestFee: Number(store.doge.fastestFee || 0),
          halfHourFee: Number(store.doge.halfHourFee || 0),
          hourFee: Number(store.doge.hourFee || 0),
          economyFee: Number(store.doge.economyFee || 0),
          minimumFee: Number(store.doge.minimumFee || 0),
          customizeFee: Number(store.doge.customizeFee || 0),
          selectedFeeType: String(store.doge.selectedFeeType || ''),
          lastUpdated: Number(store.doge.lastUpdated || 0),
        },
      });
    },
    ['btc', 'mvc', 'doge']
  );
  Alpine.store('chainFee', proxiedChainFeeStore);
  proxiedChainFeeStore.refreshAllFeeRates().catch(() => {});
  proxiedChainFeeStore.startAutoRefresh();

  if (window.IDFramework) {
    IDFramework.initModels({});
  }
});
