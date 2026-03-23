/**
 * id-chain-fee-selector
 * Reusable chain + fee-rate selector for chat/buzz send flows.
 */
class IdChainFeeSelector extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._open = false;
    this._draft = this._createEmptyDraft();
    this._onDocPointerDown = this._handleOutsidePointerDown.bind(this);
    this._onDocKeyDown = this._handleDocKeyDown.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    document.addEventListener('pointerdown', this._onDocPointerDown);
    document.addEventListener('keydown', this._onDocKeyDown);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this._syncDraftFromStore();
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._onDocPointerDown);
    document.removeEventListener('keydown', this._onDocKeyDown);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  _handleLocaleChanged() {
    this.render();
  }

  _t(key, fallback, params) {
    if (
      typeof window !== 'undefined' &&
      window.IDFramework &&
      window.IDFramework.I18n &&
      typeof window.IDFramework.I18n.t === 'function'
    ) {
      return window.IDFramework.I18n.t(key, params || {}, fallback || '');
    }
    return fallback || key;
  }

  _createEmptyDraft() {
    return {
      currentChain: 'mvc',
      btc: { selectedFeeType: 'economyFee', customizeFee: 1, customizeFeeInput: '1' },
      mvc: { selectedFeeType: 'economyFee', customizeFee: 1, customizeFeeInput: '1' },
      doge: { selectedFeeType: 'economyFee', customizeFee: 5000000, customizeFeeInput: '0.0500' },
    };
  }

  _normalizeChain(rawChain) {
    const chain = String(rawChain || '').trim().toLowerCase();
    if (chain === 'btc' || chain === 'bsv') return 'btc';
    if (chain === 'doge' || chain === 'dogecoin') return 'doge';
    if (chain === 'mvc' || chain === 'microvisionchain') return 'mvc';
    return 'mvc';
  }

  _getStore() {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store('chainFee') || null;
  }

  _feeToDogeDisplay(rawValue) {
    const num = Number(rawValue || 0);
    if (!Number.isFinite(num) || num <= 0) return '0.0500';
    return (num / 100000000).toFixed(4);
  }

  _feeToSatDisplay(rawValue) {
    const num = Number(rawValue || 0);
    if (!Number.isFinite(num) || num <= 0) return '1';
    return String(Math.round(num));
  }

  _syncDraftFromStore() {
    const store = this._getStore();
    if (!store) {
      this._draft = this._createEmptyDraft();
      return;
    }

    const chain = this._normalizeChain(store.currentChain);
    const btc = store.btc && typeof store.btc === 'object' ? store.btc : {};
    const mvc = store.mvc && typeof store.mvc === 'object' ? store.mvc : {};
    const doge = store.doge && typeof store.doge === 'object' ? store.doge : {};

    this._draft = {
      currentChain: chain,
      btc: {
        selectedFeeType: String(btc.selectedFeeType || 'economyFee'),
        customizeFee: Number(btc.customizeFee || 1),
        customizeFeeInput: this._feeToSatDisplay(btc.customizeFee),
      },
      mvc: {
        selectedFeeType: String(mvc.selectedFeeType || 'economyFee'),
        customizeFee: Number(mvc.customizeFee || 1),
        customizeFeeInput: this._feeToSatDisplay(mvc.customizeFee),
      },
      doge: {
        selectedFeeType: String(doge.selectedFeeType || 'economyFee'),
        customizeFee: Number(doge.customizeFee || 5000000),
        customizeFeeInput: this._feeToDogeDisplay(doge.customizeFee),
      },
    };
  }

  _formatFeeValue(chain, rawValue) {
    const num = Number(rawValue || 0);
    if (!Number.isFinite(num) || num <= 0) {
      return chain === 'doge' ? '0.0500 DOGE/KB' : '1 sat/vB';
    }
    if (chain === 'doge') return `${(num / 100000000).toFixed(4)} DOGE/KB`;
    return `${Math.round(num)} sat/vB`;
  }

  _currentButtonLabel() {
    const store = this._getStore();
    if (!store) return 'MVC · 1 sat/vB';

    let snapshot = null;
    if (typeof store.getChainFeeSnapshot === 'function') {
      snapshot = store.getChainFeeSnapshot(store.currentChain);
    }

    if (!snapshot || typeof snapshot !== 'object') {
      const chain = this._normalizeChain(store.currentChain);
      const state = store[chain] && typeof store[chain] === 'object' ? store[chain] : {};
      const selectedType = String(state.selectedFeeType || 'economyFee');
      const rate = Number(state[selectedType] || state.economyFee || 1);
      return `${chain.toUpperCase()} · ${this._formatFeeValue(chain, rate)}`;
    }

    return `${String(snapshot.chain || 'mvc').toUpperCase()} · ${this._formatFeeValue(
      String(snapshot.chain || 'mvc'),
      Number(snapshot.feeRate || 0)
    )}`;
  }

  _getRateForDraft(chain, feeType) {
    const store = this._getStore();
    const normalizedChain = this._normalizeChain(chain);
    const selectedType = String(feeType || '').trim();

    if (selectedType === 'customizeFee') {
      const item = this._draft[normalizedChain] || {};
      if (normalizedChain === 'doge') {
        const parsed = Number(item.customizeFeeInput || 0);
        if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 100000000);
        return Number(item.customizeFee || 5000000);
      }
      const parsed = Number(item.customizeFeeInput || 0);
      if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
      return Number(item.customizeFee || 1);
    }

    if (!store) return 1;
    const state = store[normalizedChain] && typeof store[normalizedChain] === 'object' ? store[normalizedChain] : {};
    const value = Number(state[selectedType]);
    if (Number.isFinite(value) && value > 0) return value;
    return Number(state.economyFee || 1);
  }

  _toggleOpen() {
    if (!this._open) this._syncDraftFromStore();
    this._open = !this._open;
    this.render();
  }

  _handleOutsidePointerDown(event) {
    if (!this._open) return;
    if (this.contains(event.target)) return;
    const path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (Array.isArray(path) && path.includes(this)) return;
    this._open = false;
    this.render();
  }

  _handleDocKeyDown(event) {
    if (!this._open) return;
    if (event.key === 'Escape') {
      this._open = false;
      this.render();
    }
  }

  _setDraftChain(rawChain) {
    this._draft.currentChain = this._normalizeChain(rawChain);
    this.render();
  }

  _setDraftFeeType(rawChain, rawFeeType) {
    const chain = this._normalizeChain(rawChain);
    const feeType = String(rawFeeType || '').trim();
    if (!feeType) return;
    const target = this._draft[chain] || this._createEmptyDraft()[chain];
    target.selectedFeeType = feeType;
    this._draft[chain] = target;
    this._draft.currentChain = chain;
    this.render();
  }

  _setDraftCustomInput(rawChain, value) {
    const chain = this._normalizeChain(rawChain);
    const target = this._draft[chain] || this._createEmptyDraft()[chain];
    target.customizeFeeInput = String(value || '');
    this._draft[chain] = target;
  }

  _applyDraft() {
    const store = this._getStore();
    if (!store) {
      this._open = false;
      this.render();
      return;
    }

    const chain = this._normalizeChain(this._draft.currentChain);
    const selected = this._draft[chain] || {};
    const selectedType = String(selected.selectedFeeType || 'economyFee');

    if (typeof store.setCurrentChain === 'function') store.setCurrentChain(chain);
    else store.currentChain = chain;

    if (selectedType === 'customizeFee') {
      if (chain === 'doge') {
        let customDoge = Number(selected.customizeFeeInput || 0);
        if (!Number.isFinite(customDoge) || customDoge <= 0) customDoge = Number(selected.customizeFee || 5000000) / 100000000;
        if (customDoge < 0.05) customDoge = 0.05;
        const customRaw = Math.round(customDoge * 100000000);
        if (typeof store.setCustomizeFee === 'function') store.setCustomizeFee(chain, customRaw);
        else {
          store[chain].customizeFee = customRaw;
          store[chain].selectedFeeType = 'customizeFee';
        }
      } else {
        let customSat = Number(selected.customizeFeeInput || 0);
        if (!Number.isFinite(customSat) || customSat <= 0) customSat = Number(selected.customizeFee || 1);
        customSat = Math.max(1, Math.round(customSat));
        if (typeof store.setCustomizeFee === 'function') store.setCustomizeFee(chain, customSat);
        else {
          store[chain].customizeFee = customSat;
          store[chain].selectedFeeType = 'customizeFee';
        }
      }
    }

    if (typeof store.setFeeType === 'function') store.setFeeType(chain, selectedType);
    else store[chain].selectedFeeType = selectedType;

    this._open = false;
    this._syncDraftFromStore();
    this.render();
    this.dispatchEvent(new CustomEvent('chain-fee-changed', {
      bubbles: true,
      composed: true,
      detail: {
        chain: chain,
        feeType: selectedType,
        feeRate: typeof store.getSelectedFeeRate === 'function'
          ? store.getSelectedFeeRate(chain)
          : this._getRateForDraft(chain, selectedType),
      },
    }));
  }

  _renderChainSymbol(chain) {
    if (chain === 'btc') return 'B';
    if (chain === 'doge') return 'D';
    return 'M';
  }

  _renderChainName(chain) {
    if (chain === 'btc') return 'BTC';
    if (chain === 'doge') return 'DOGE';
    return 'MVC';
  }

  _renderFeeUnit(chain) {
    return chain === 'doge' ? 'DOGE/KB' : 'sat/vB';
  }

  _renderFeeOptions(chain) {
    const selected = this._draft[chain] && this._draft[chain].selectedFeeType
      ? String(this._draft[chain].selectedFeeType)
      : 'economyFee';
    const options = chain === 'mvc'
      ? [
          { key: 'economyFee', label: this._t('chat.fee.economy', 'ECO') },
          { key: 'fastestFee', label: this._t('chat.fee.high', 'High') },
          { key: 'customizeFee', label: this._t('chat.fee.customize', 'Customize') },
        ]
      : [
          { key: 'economyFee', label: this._t('chat.fee.economy', 'ECO') },
          { key: 'halfHourFee', label: this._t('chat.fee.normal', 'Normal') },
          { key: 'customizeFee', label: this._t('chat.fee.customize', 'Customize') },
        ];

    return options.map((option) => {
      const isSelected = selected === option.key;
      const customInput =
        option.key === 'customizeFee' && isSelected
          ? (
            chain === 'doge'
              ? `<input class="fee-input" data-action="fee-custom-input" data-chain="${chain}" value="${this._escapeHtml(this._draft[chain].customizeFeeInput || '')}" type="number" min="0.05" step="0.0001">`
              : `<input class="fee-input" data-action="fee-custom-input" data-chain="${chain}" value="${this._escapeHtml(this._draft[chain].customizeFeeInput || '')}" type="number" min="1" step="1">`
          )
          : '';
      const rawValue = this._getRateForDraft(chain, option.key);
      const displayValue = chain === 'doge' ? (Number(rawValue || 0) / 100000000).toFixed(4) : String(Math.round(Number(rawValue || 1)));
      return '' +
        `<button class="fee-option ${isSelected ? 'selected' : ''}" data-action="fee-select" data-chain="${chain}" data-fee-type="${option.key}">` +
          `<span class="fee-label">${option.label}</span>` +
          '<span class="fee-value-wrap">' +
            `${customInput || `<span class="fee-value">${this._escapeHtml(displayValue)}</span>`}` +
            `<span class="fee-unit">${this._renderFeeUnit(chain)}</span>` +
          '</span>' +
        '</button>';
    }).join('');
  }

  _renderChainSection(chain) {
    const isCurrent = this._draft.currentChain === chain;
    return '' +
      `<section class="chain-section ${isCurrent ? 'selected' : ''}">` +
        `<button class="chain-header" data-action="chain-select" data-chain="${chain}">` +
          `<span class="chain-icon chain-${chain}">${this._renderChainSymbol(chain)}</span>` +
          '<span class="chain-text">' +
            `<span class="chain-name">${this._renderChainName(chain)}</span>` +
            '<span class="chain-subtitle">' + this._escapeHtml(this._t('chat.fee.network', 'Network')) + '</span>' +
          '</span>' +
          `<span class="chain-arrow ${isCurrent ? 'expanded' : ''}">▾</span>` +
        '</button>' +
        `<div class="fee-list ${isCurrent ? 'open' : ''}">` +
          this._renderFeeOptions(chain) +
        '</div>' +
      '</section>';
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  render() {
    const store = this._getStore();
    const loading = !!(store && store.isLoading);
    const currentLabel = this._currentButtonLabel();
    const hasError = !!(store && store.lastError);
    const errorText = hasError ? String(store.lastError || '') : '';

    this.shadowRoot.innerHTML = '' +
      '<style>' +
      ':host{display:inline-block;position:relative;}' +
      '.trigger{height:34px;border-radius:999px;border:1px solid var(--id-border-color,#d1d5db);background:var(--id-bg-card,#fff);padding:0 12px;font-size:12px;color:var(--id-text-main,#1f2937);display:inline-flex;align-items:center;gap:6px;cursor:pointer;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.trigger:hover{background:var(--id-bg-body,#f3f4f6);}' +
      '.trigger:disabled{opacity:.6;cursor:not-allowed;}' +
      '.loading-dot{width:6px;height:6px;border-radius:999px;background:var(--id-color-primary,#2563eb);display:inline-block;animation:pulse 1s ease-in-out infinite;}' +
      '@keyframes pulse{0%{opacity:.3}50%{opacity:1}100%{opacity:.3}}' +
      '.panel{position:absolute;right:0;bottom:42px;width:min(92vw, 360px);max-height:70vh;overflow:auto;padding:12px;border-radius:14px;border:1px solid var(--id-border-color,#d1d5db);background:var(--id-bg-card,#fff);box-shadow:0 16px 40px rgba(15,23,42,.22);z-index:30;}' +
      '.panel-title{font-size:13px;font-weight:600;color:var(--id-text-main,#111827);margin:0 0 10px 0;display:flex;align-items:center;justify-content:space-between;}' +
      '.refresh{border:1px solid var(--id-border-color,#d1d5db);background:var(--id-bg-card,#fff);color:var(--id-text-main,#111827);border-radius:8px;font-size:11px;padding:4px 8px;cursor:pointer;}' +
      '.chain-section{border:1px solid var(--id-border-color,#e5e7eb);border-radius:12px;margin-bottom:10px;overflow:hidden;}' +
      '.chain-section.selected{border-color:var(--id-color-primary,#2563eb);}' +
      '.chain-header{width:100%;padding:10px 12px;border:none;background:transparent;display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;}' +
      '.chain-icon{width:26px;height:26px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;}' +
      '.chain-btc{background:#f7931a;}' +
      '.chain-mvc{background:#16a34a;}' +
      '.chain-doge{background:#c3a634;}' +
      '.chain-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}' +
      '.chain-name{font-size:12px;font-weight:600;color:var(--id-text-main,#111827);}' +
      '.chain-subtitle{font-size:11px;color:var(--id-text-secondary,#6b7280);}' +
      '.chain-arrow{font-size:12px;color:var(--id-text-tertiary,#9ca3af);transition:transform .15s ease;}' +
      '.chain-arrow.expanded{transform:rotate(180deg);}' +
      '.fee-list{display:none;padding:0 10px 10px 10px;gap:8px;}' +
      '.fee-list.open{display:grid;}' +
      '.fee-option{border:1px solid var(--id-border-color,#e5e7eb);background:var(--id-bg-body,#f9fafb);border-radius:10px;padding:8px 10px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;gap:10px;}' +
      '.fee-option.selected{border-color:var(--id-color-primary,#2563eb);background:rgba(37,99,235,.08);}' +
      '.fee-label{font-size:11px;font-weight:600;color:var(--id-text-main,#111827);}' +
      '.fee-value-wrap{display:flex;align-items:center;gap:5px;}' +
      '.fee-value{font-size:12px;font-weight:600;color:var(--id-text-main,#111827);}' +
      '.fee-unit{font-size:11px;color:var(--id-text-secondary,#6b7280);}' +
      '.fee-input{width:86px;border:1px solid var(--id-border-color,#d1d5db);border-radius:6px;padding:3px 6px;font-size:12px;background:#fff;color:var(--id-text-main,#111827);}' +
      '.footer{display:flex;justify-content:flex-end;gap:8px;margin-top:8px;}' +
      '.btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--id-border-color,#d1d5db);font-size:12px;cursor:pointer;background:#fff;color:var(--id-text-main,#111827);}' +
      '.btn.primary{background:var(--id-color-primary,#2563eb);border-color:var(--id-color-primary,#2563eb);color:#fff;}' +
      '.error{margin-top:6px;font-size:11px;color:#dc2626;line-height:1.4;}' +
      '</style>' +
      `<button class="trigger" data-action="toggle">${loading ? '<span class="loading-dot"></span>' : ''}${this._escapeHtml(currentLabel)}</button>` +
      (
        this._open
          ? (
            '<div class="panel" data-role="panel">' +
              '<div class="panel-title">' +
                '<span>' + this._escapeHtml(this._t('chat.fee.title', 'Chain & Fee')) + '</span>' +
                '<button class="refresh" data-action="refresh">' + this._escapeHtml(this._t('chat.fee.refresh', 'Refresh')) + '</button>' +
              '</div>' +
              this._renderChainSection('btc') +
              this._renderChainSection('mvc') +
              this._renderChainSection('doge') +
              '<div class="footer">' +
                '<button class="btn" data-action="cancel">' + this._escapeHtml(this._t('chat.fee.cancel', 'Cancel')) + '</button>' +
                '<button class="btn primary" data-action="apply">' + this._escapeHtml(this._t('chat.fee.apply', 'OK')) + '</button>' +
              '</div>' +
              (hasError ? `<div class="error">${this._escapeHtml(errorText)}</div>` : '') +
            '</div>'
          )
          : ''
      );

    const toggle = this.shadowRoot.querySelector('[data-action="toggle"]');
    if (toggle) {
      toggle.addEventListener('click', () => {
        this._toggleOpen();
      });
    }

    const refresh = this.shadowRoot.querySelector('[data-action="refresh"]');
    if (refresh) {
      refresh.addEventListener('click', () => {
        const chainStore = this._getStore();
        if (!chainStore || typeof chainStore.refreshAllFeeRates !== 'function') return;
        chainStore.refreshAllFeeRates().then(() => {
          this.render();
        }).catch(() => {
          this.render();
        });
      });
    }

    const cancel = this.shadowRoot.querySelector('[data-action="cancel"]');
    if (cancel) {
      cancel.addEventListener('click', () => {
        this._open = false;
        this.render();
      });
    }

    const apply = this.shadowRoot.querySelector('[data-action="apply"]');
    if (apply) {
      apply.addEventListener('click', () => {
        this._applyDraft();
      });
    }

    Array.from(this.shadowRoot.querySelectorAll('[data-action="chain-select"]')).forEach((button) => {
      button.addEventListener('click', () => {
        this._setDraftChain(button.getAttribute('data-chain') || 'mvc');
      });
    });

    Array.from(this.shadowRoot.querySelectorAll('[data-action="fee-select"]')).forEach((button) => {
      button.addEventListener('click', () => {
        this._setDraftFeeType(
          button.getAttribute('data-chain') || 'mvc',
          button.getAttribute('data-fee-type') || 'economyFee'
        );
      });
    });

    Array.from(this.shadowRoot.querySelectorAll('[data-action="fee-custom-input"]')).forEach((input) => {
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('input', () => {
        this._setDraftCustomInput(input.getAttribute('data-chain') || 'mvc', input.value || '');
      });
    });
  }
}

if (!customElements.get('id-chain-fee-selector')) {
  customElements.define('id-chain-fee-selector', IdChainFeeSelector);
}
