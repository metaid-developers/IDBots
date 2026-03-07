// CRITICAL: Register stores in alpine:init event
// This event fires BEFORE Alpine processes the DOM, ensuring stores are available
window.addEventListener('alpine:init', () => {
  // ============================================
  // localStorage Helper Functions
  // ============================================
  const StorageHelper = {
    // Save wallet store to localStorage
    saveWallet: (walletData) => {
      try {
        localStorage.setItem('idframework_wallet', JSON.stringify(walletData));
      } catch (error) {
        console.error('Failed to save wallet to localStorage:', error);
      }
    },

    // Load wallet store from localStorage
    loadWallet: () => {
      try {
        const stored = localStorage.getItem('idframework_wallet');
        if (stored) {
          return JSON.parse(stored);
        }
      } catch (error) {
        console.error('Failed to load wallet from localStorage:', error);
      }
      return null;
    },

    // Save app store (isLogin, userAddress) to localStorage
    saveApp: (isLogin, userAddress) => {
      try {
        localStorage.setItem('idframework_app_isLogin', JSON.stringify(isLogin));
        localStorage.setItem('idframework_app_userAddress', JSON.stringify(userAddress));
      } catch (error) {
        console.error('Failed to save app to localStorage:', error);
      }
    },

    // Load app store (isLogin, userAddress) from localStorage
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

    // Save user store (users) to localStorage
    saveUser: (users) => {
      try {
        localStorage.setItem('idframework_user_users', JSON.stringify(users));
      } catch (error) {
        console.error('Failed to save user to localStorage:', error);
      }
    },

    // Load user store (users) from localStorage
    loadUser: () => {
      try {
        const stored = localStorage.getItem('idframework_user_users');
        if (stored) {
          return JSON.parse(stored);
        }
      } catch (error) {
        console.error('Failed to load user from localStorage:', error);
      }
      return null;
    },
  };

  // ============================================
  // Initialize Stores with localStorage Data
  // ============================================
  // Load data from localStorage
  const savedWallet = StorageHelper.loadWallet();
  const savedApp = StorageHelper.loadApp();
  const savedUsers = StorageHelper.loadUser();

  // Create a function to wrap store with localStorage sync using Proxy
  const createPersistedStore = (storeData, syncCallback, nestedProps = []) => {
    // Create a Proxy to intercept property changes
    const handler = {
      set(target, property, value) {
        // Set the property
        const result = Reflect.set(target, property, value);
        // Sync to localStorage after property is set
        syncCallback(target);
        return result;
      },
      get(target, property) {
        const value = Reflect.get(target, property);
        // If accessing nested objects that need persistence, wrap them too
        if (value && typeof value === 'object' && !Array.isArray(value) && nestedProps.includes(property)) {
          // Create a nested proxy for the nested object
          const nestedHandler = {
            set(nestedTarget, nestedProperty, nestedValue) {
              const result = Reflect.set(nestedTarget, nestedProperty, nestedValue);
              // Sync parent store when nested property changes
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

    // Return proxied store data
    return new Proxy(storeData, handler);
  };

  // Initialize wallet store with Proxy for localStorage sync
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

  // Initialize app store with Proxy for localStorage sync (only isLogin and userAddress)
  const appStoreData = {
    isLogin: savedApp.isLogin,
    userAddress: savedApp.userAddress,
    isWebView: false, // WebView detection flag (not persisted)
    // Routing state (not persisted)
    currentView: null,
    routeParams: {},
    currentPath: '/',
  };
  const proxiedAppStore = createPersistedStore(appStoreData, (store) => {
    // Only save isLogin and userAddress
    StorageHelper.saveApp(store.isLogin, store.userAddress);
  });
  Alpine.store('app', proxiedAppStore);

  // Initialize user store with Proxy for localStorage sync (only users)
  const userStoreData = {
    user: savedUsers ?? {},
    isLoading: false,
    error: null,
    showProfileEditModal: false, // when true, id-connect-button opens ProfileEditModal (e.g. unregistered user)
  };

  const proxiedUserStore = createPersistedStore(
    userStoreData,
    (store) => {
      // Only save users
      StorageHelper.saveUser(store.user);
    },
    ['user'] // Enable nested proxy for users object
  );
  Alpine.store('user', proxiedUserStore);

  // If framework is already loaded, call init to ensure consistency
  if (window.IDFramework) {
    IDFramework.initModels({});
  }
});
