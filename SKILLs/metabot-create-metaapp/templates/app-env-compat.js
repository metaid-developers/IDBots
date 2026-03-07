// App environment compatibility logic
(function() {
  let accountInterval = null;
  let retryCount = 0;
  const RETRY_INTERVAL = 100; // 100ms
  const MAX_RETRY_TIME = 5000; // 5 seconds
  let timeoutId = null;

  // Helper function to show toast/alert
  function showWarning(message) {
    console.warn(message);
    // You can replace this with a proper toast library if needed
    alert(message);
  }

  // Helper function to reload page
  function completeReload() {
    window.location.reload();
  }

  // Helper function to sleep
  function sleep(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get connect button element
  function getConnectButton() {
    return document.querySelector('id-connect-button');
  }

  // Connect Metalet handler
  async function connectMetalet() {
    const connectButton = getConnectButton();
    if (connectButton && typeof connectButton.handleConnect === 'function') {
      try {
        await connectButton.handleConnect();
      } catch (error) {
        console.error('Failed to connect Metalet:', error);
        showWarning(error.message || 'Failed to connect Metalet wallet');
      }
    }
  }

  // Disconnect handler
  async function disconnectMetalet() {
    const connectButton = getConnectButton();
    if (connectButton && typeof connectButton.handleDisconnect === 'function') {
      connectButton.handleDisconnect();
    }
  }

  // Metalet accounts changed handler
  const metaletAccountsChangedHandler = async () => {
    try {
      const appStore = Alpine.store('app');
      if (appStore && appStore.isWebView) return;

      await disconnectMetalet();
      showWarning('Metalet 账户已变更。正在刷新页面...');
      await sleep();
      completeReload();
    } catch (error) {
      console.error('Error in metaletAccountsChangedHandler:', error);
    }
  };

  // Metalet network changed handler
  const metaletNetworkChangedHandler = (network) => {
    const walletStore = Alpine.store('wallet');
    if (!walletStore || !walletStore.isConnected) return;

    const appStore = Alpine.store('app');
    if (appStore && appStore.isWebView) return;

    // Handle network change if needed
    console.log('Network changed:', network);
  };

  // App login success handler
  const appLoginSuccessHandler = async () => {
    try {
      const walletStore = Alpine.store('wallet');
      if (!walletStore || walletStore.isConnected) {
        return;
      }

      await connectMetalet();
    } catch (error) {
      console.error('Error in appLoginSuccessHandler:', error);
      showWarning(error.message || 'Failed to handle login success');
    }
  };

  // App account switch handler
  const appAccountSwitchHandler = async () => {
    try {
      const appStore = Alpine.store('app');
      if (!appStore || !appStore.isWebView) return;

      await disconnectMetalet();
      await connectMetalet();
    } catch (error) {
      console.error('Error in appAccountSwitchHandler:', error);
      throw new Error(error);
    }
  };

  // App logout handler
  const appLogoutHandler = async (data) => {
    try {
      console.log('退出登录成功', data);
      const walletStore = Alpine.store('wallet');
      if (walletStore && walletStore.isConnected) {
        await disconnectMetalet();
      }
    } catch (error) {
      console.error('Error in appLogoutHandler:', error);
    }
  };

  // Setup Metalet event listeners
  const checkMetalet = () => {
    // Check WebView bridge first
    if (window.IDFramework) {
      window.IDFramework.dispatch('checkWebViewBridge').catch(err => {
        console.warn('Failed to check WebView bridge:', err);
      });
    }

    if (window.metaidwallet) {
      try {
        // Setup event listeners
        if (window.metaidwallet.on) {
          window.metaidwallet.on('accountsChanged', metaletAccountsChangedHandler);
          window.metaidwallet.on('LoginSuccess', appLoginSuccessHandler);
          window.metaidwallet.on('onAccountSwitch', appAccountSwitchHandler);
          window.metaidwallet.on('Logout', appLogoutHandler);
          window.metaidwallet.on('networkChanged', metaletNetworkChangedHandler);
        }
      } catch (err) {
        console.error('Failed to setup Metalet listeners:', err);
      }
    } else if (retryCount * RETRY_INTERVAL < MAX_RETRY_TIME) {
      retryCount++;
      timeoutId = setTimeout(checkMetalet, RETRY_INTERVAL);
    } else {
      console.warn('Metalet wallet not detected after timeout');
    }
  };

  // Account status check interval
  function startAccountCheckInterval() {
    if (accountInterval) {
      clearInterval(accountInterval);
    }

    accountInterval = setInterval(async () => {
      try {
        // Check WebView bridge
        if (window.IDFramework) {
          await window.IDFramework.dispatch('checkWebViewBridge').catch(err => {
            console.warn('Failed to check WebView bridge:', err);
          });
        }

        const walletStore = Alpine.store('wallet');
        const appStore = Alpine.store('app');

        // Auto connect in WebView if not authorized
        if (!walletStore || !walletStore.isConnected) {
          if (appStore && appStore.isWebView) {
            await connectMetalet();
          }
        }

        // Skip account check in WebView
        if (appStore && appStore.isWebView) return;

        // Check account status
        if (window.metaidwallet && walletStore && walletStore.isConnected) {
          try {
            const res = await window.metaidwallet.getAddress();
            const currentAddress = walletStore.address;

            if ((res && typeof res === 'object' && res.status === 'not-connected') ||
                (typeof res === 'string' && currentAddress && res !== currentAddress)) {
              await disconnectMetalet();
              showWarning('Metalet 账户已变更');
            }
          } catch (error) {
            console.error('Error checking account status:', error);
          }
        }
      } catch (error) {
        console.error('Error in account check interval:', error);
      }
    }, 2 * 1000); // Check every 2 seconds
  }

  // Initialize on DOM ready
  window.addEventListener('DOMContentLoaded', async () => {
    // Wait for Alpine and IDFramework to be ready
    await new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 100; // 5 seconds max wait
      const checkReady = () => {
        attempts++;
        if (typeof Alpine !== 'undefined' && window.IDFramework && Alpine.store('app') && Alpine.store('wallet')) {
          resolve();
        } else if (attempts < maxAttempts) {
          setTimeout(checkReady, 50);
        } else {
          console.warn('Alpine or IDFramework not ready after timeout, continuing anyway');
          resolve();
        }
      };
      checkReady();
    });

    // Initial WebView check
    if (window.IDFramework) {
      await window.IDFramework.dispatch('checkWebViewBridge').catch(err => {
        console.warn('Failed to check WebView bridge:', err);
      });
    }

    // Setup Metalet listeners
    checkMetalet();

    // Start account check interval
    startAccountCheckInterval();

    // Check BTC address if connected (wait a bit for connection to be established)
    setTimeout(() => {
      const walletStore = Alpine.store('wallet');
      if (window.metaidwallet && walletStore && walletStore.isConnected) {
        if (window.IDFramework) {
          window.IDFramework.dispatch('checkBtcAddressSameAsMvc').then().catch(() => {
            showWarning('Metalet BTC当前地址与MVC地址不一致，请切换BTC地址与MVC地址一致后再进行使用');
            setTimeout(() => {
              disconnectMetalet();
            }, 3000);
          });
        }
      }
    }, 1000); // Wait 1 second for connection to be fully established
  });

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (accountInterval) {
      clearInterval(accountInterval);
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Remove event listeners
    try {
      if (window.metaidwallet && window.metaidwallet.removeListener) {
        window.metaidwallet.removeListener('accountsChanged', metaletAccountsChangedHandler);
        window.metaidwallet.removeListener('networkChanged', metaletNetworkChangedHandler);
        window.metaidwallet.removeListener('LoginSuccess', appLoginSuccessHandler);
        window.metaidwallet.removeListener('Logout', appLogoutHandler);
        window.metaidwallet.removeListener('onAccountSwitch', appAccountSwitchHandler);
      }
    } catch (error) {
      console.error('Error removing event listeners:', error);
    }
  });
})();
