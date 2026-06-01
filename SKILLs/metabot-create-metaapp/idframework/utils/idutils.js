/**
 * IDFramework utilities: message toast (no Element UI), IndexedDB helpers for metafile/avatar cache.
 */
(function (global) {
  'use strict';

  var IDUtils = {
    /**
     * Show a short message toast (idframework-style, no Element UI).
     * @param {string} type - 'success' | 'error' | 'info'
     * @param {string} message - Text to show
     */
    showMessage: function (type, message) {
      if (!message) return;
      var container = document.getElementById('idframework-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'idframework-toast-container';
        container.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
      }
      var el = document.createElement('div');
      el.setAttribute('role', 'alert');
      var bg = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#2563eb';
      el.style.cssText = 'padding:10px 16px;border-radius:8px;color:#fff;background:' + bg + ';font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);pointer-events:auto;';
      el.textContent = message;
      container.appendChild(el);
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 3000);
    },

    /**
     * Get avatar URL from IndexedDB cache (metaid user store) or return default.
     * Uses same IndexedDB as UserDelegate (idframework-user-db, User store).
     * @param {string} metaid - MetaID
     * @param {string} defaultUrl - Default avatar data URL or URL
     * @returns {Promise<string>}
     */
    getAvatarFromIndexedDB: function (metaid, defaultUrl) {
      return new Promise(function (resolve) {
        if (!metaid) {
          resolve(defaultUrl || '');
          return;
        }
        try {
          var req = indexedDB.open('idframework-user-db', 1);
          req.onerror = function () { resolve(defaultUrl || ''); };
          req.onsuccess = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('User')) {
              db.close();
              resolve(defaultUrl || '');
              return;
            }
            var tx = db.transaction(['User'], 'readonly');
            var store = tx.objectStore('User');
            var getReq = store.get(metaid);
            getReq.onsuccess = function () {
              var user = getReq.result;
              db.close();
              resolve(user && user.avatarUrl ? user.avatarUrl : (defaultUrl || ''));
            };
            getReq.onerror = function () {
              db.close();
              resolve(defaultUrl || '');
            };
          };
        } catch (e) {
          resolve(defaultUrl || '');
        }
      });
    },

    /**
     * Request MVC address-init (register address for gas subsidy). Call before getMVCRewards for new users.
     * @param {Object} params - { address: string, gasChain: 'mvc' }
     * @param {Object} [options] - Optional fetch options
     * @returns {Promise<Object>} API response
     */
    getMVCRewardsAddressInit: function (params, options) {
      var base = (global.IDConfig && global.IDConfig.ASSIST_OPEN_API_BASE) ? global.IDConfig.ASSIST_OPEN_API_BASE : 'https://www.metaso.network/assist-open-api';
      var url = base + '/v1/assist/gas/mvc/address-init';
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options && options.headers || {}) },
        body: JSON.stringify(params),
        ...options
      }).then(function (r) { return r.json(); });
    },

    /**
     * Request MVC gas reward (address-reward with signature). Call after getMVCRewardsAddressInit + wait for new users.
     * @param {Object} params - { address: string, gasChain: 'mvc' }
     * @param {Object} signature - { 'X-Public-Key': string, 'X-Signature': string }
     * @param {Object} [options] - Optional fetch options
     * @returns {Promise<Object>} API response
     */
    getMVCRewards: function (params, signature, options) {
      var base = (global.IDConfig && global.IDConfig.ASSIST_OPEN_API_BASE) ? global.IDConfig.ASSIST_OPEN_API_BASE : 'https://www.metaso.network/assist-open-api';
      var path = (global.IDConfig && global.IDConfig.MVC_REWARDS_PATH) ? global.IDConfig.MVC_REWARDS_PATH : '/v1/assist/gas/mvc/address-reward';
      var url = base + path;
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature['X-Signature'] || '',
          'X-Public-Key': signature['X-Public-Key'] || '',
          ...(options && options.headers || {})
        },
        body: JSON.stringify(params),
        ...options
      }).then(function (r) { return r.json(); });
    }
  };

  global.IDUtils = IDUtils;
})(typeof window !== 'undefined' ? window : this);
