// CRITICAL: Register stores in alpine:init event
// This event fires BEFORE Alpine processes the DOM, ensuring stores are available
window.addEventListener('alpine:init', () => {
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
  };

  const savedWallet = StorageHelper.loadWallet();
  const savedApp = StorageHelper.loadApp();
  const savedUsers = StorageHelper.loadUser();

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

  if (window.IDFramework) {
    IDFramework.initModels({});
  }
});
