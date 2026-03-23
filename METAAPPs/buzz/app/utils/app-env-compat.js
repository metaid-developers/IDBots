// App environment compatibility logic
(function() {
  let accountInterval = null;
  let retryCount = 0;
  const RETRY_INTERVAL = 100;
  const MAX_RETRY_TIME = 5000;
  let timeoutId = null;

  function showWarning(message) {
    console.warn(message);
    alert(message);
  }

  function completeReload() {
    window.location.reload();
  }

  function sleep(ms = 1000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getConnectButton() {
    return document.querySelector('id-connect-button');
  }

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

  async function disconnectMetalet() {
    const connectButton = getConnectButton();
    if (connectButton && typeof connectButton.handleDisconnect === 'function') {
      connectButton.handleDisconnect();
    }
  }

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

  const metaletNetworkChangedHandler = (network) => {
    const walletStore = Alpine.store('wallet');
    if (!walletStore || !walletStore.isConnected) return;
    const appStore = Alpine.store('app');
    if (appStore && appStore.isWebView) return;
    console.log('Network changed:', network);
  };

  const appLoginSuccessHandler = async () => {
    try {
      const walletStore = Alpine.store('wallet');
      if (!walletStore || walletStore.isConnected) return;
      await connectMetalet();
    } catch (error) {
      console.error('Error in appLoginSuccessHandler:', error);
      showWarning(error.message || 'Failed to handle login success');
    }
  };

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

  const checkMetalet = () => {
    if (window.IDFramework) {
      window.IDFramework.dispatch('checkWebViewBridge').catch(err => {
        console.warn('Failed to check WebView bridge:', err);
      });
    }
    if (window.metaidwallet) {
      try {
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

  function startAccountCheckInterval() {
    if (accountInterval) clearInterval(accountInterval);
    accountInterval = setInterval(async () => {
      try {
        if (window.IDFramework) {
          await window.IDFramework.dispatch('checkWebViewBridge').catch(err => {
            console.warn('Failed to check WebView bridge:', err);
          });
        }
        const walletStore = Alpine.store('wallet');
        const appStore = Alpine.store('app');
        if (!walletStore || !walletStore.isConnected) {
          if (appStore && appStore.isWebView) await connectMetalet();
        }
        if (appStore && appStore.isWebView) return;
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
    }, 2000);
  }

  window.addEventListener('DOMContentLoaded', async () => {
    await new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 100;
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

    if (window.IDFramework) {
      await window.IDFramework.dispatch('checkWebViewBridge').catch(err => {
        console.warn('Failed to check WebView bridge:', err);
      });
    }
    checkMetalet();
    startAccountCheckInterval();

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
    }, 1000);
  });

  window.addEventListener('beforeunload', () => {
    if (accountInterval) clearInterval(accountInterval);
    if (timeoutId) clearTimeout(timeoutId);
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
