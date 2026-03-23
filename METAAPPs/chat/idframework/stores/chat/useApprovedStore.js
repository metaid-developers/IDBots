/**
 * useApprovedStore - lightweight approved store for small-pay.
 * Keeps parity with IDChat approved store semantics in no-build architecture.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'idframework_approved_store';
  var DEFAULT_STATE = {
    isEnabled: true,
    isApproved: false,
    autoPaymentAmount: 10000,
  };

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Object.assign({}, DEFAULT_STATE);
      var parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_STATE, parsed || {});
    } catch (e) {
      return Object.assign({}, DEFAULT_STATE);
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  var singleton = null;

  function createStore() {
    var state = loadState();
    return {
      get last() {
        return state;
      },
      get has() {
        return !!state;
      },
      get canUse() {
        return !!(state.isEnabled && state.isApproved);
      },
      get canApproved() {
        return !!(state.isEnabled && !state.isApproved);
      },
      async getPaymentStatus() {
        if (!global.metaidwallet || typeof global.metaidwallet.autoPaymentStatus !== 'function') {
          return state;
        }
        var res = await global.metaidwallet.autoPaymentStatus();
        if (res && typeof res === 'object') {
          state = Object.assign({}, state, res);
          saveState(state);
        }
        return state;
      },
      async getAutoPayment() {
        if (!this.canApproved) return state;
        if (!global.metaidwallet || typeof global.metaidwallet.autoPayment !== 'function') {
          return state;
        }
        var res = await global.metaidwallet.autoPayment();
        if (res && (res.message === 'Auto payment approved' || res.status === 'success')) {
          state.isApproved = true;
          saveState(state);
        }
        return state;
      },
      clear() {
        state = Object.assign({}, DEFAULT_STATE);
        saveState(state);
      },
    };
  }

  function useApprovedStore() {
    if (!singleton) singleton = createStore();
    return singleton;
  }

  global.useApprovedStore = useApprovedStore;
})(typeof window !== 'undefined' ? window : this);

