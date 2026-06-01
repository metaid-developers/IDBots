/**
 * CheckWebViewBridgeCommand - Check if running in WebView environment
 * 
 * Command Pattern implementation following IDFramework architecture.
 * 
 * This command:
 * 1. Detects if the app is running in IDChat WebView (iOS/Android)
 * 2. Updates the app store with isWebView status
 * 
 * @class CheckWebViewBridgeCommand
 */
export default class CheckWebViewBridgeCommand {
  /**
   * Execute the command
   * 
   * @param {Object} params - Command parameters
   * @param {Object} params.stores - Alpine stores object
   *   - app: {Object} - App store (isWebView, isLogin, etc.)
   * @returns {Promise<boolean>} Returns true if in WebView, false otherwise
   */
  async execute({ stores }) {
    const appStore = stores.app;
    if (!appStore) {
      console.error('CheckWebViewBridgeCommand: App store not found');
      return false;
    }

    const UA = window.navigator.userAgent.toLowerCase();
    const isAndroid = !!(UA && UA.indexOf('android') > 0);
    const isIOS = !!(UA && /iphone|ipad|ipod|ios/.test(UA));

    if (isIOS || isAndroid) {
      if (window?.navigator) {
        const userAgent = window?.navigator?.userAgent || '';
        if (userAgent === 'IDChat-iOS' || userAgent === 'IDChat-Android') {
          appStore.isWebView = true;
          return true;
        } else {
          appStore.isWebView = false;
          return false;
        }
      } else {
        appStore.isWebView = false;
        return false;
      }
    } else {
      appStore.isWebView = false;
      return false;
    }
  }
}
