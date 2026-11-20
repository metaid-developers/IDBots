/* goods-market-thermometer app.js — 100% READ-ONLY.
 * Iron rule: this page contains NO buy / match / escrow-lock / payment action
 * of any kind. The only outbound navigation is "go visit that seller's shop"
 * (metaapp://<shopPinId> or metaid://<seller>), which returns the user to the
 * decentralized peer-to-peer flow. Data per Contract C3 envelopes
 * (code===0 market endpoints, code===1 legacy endpoints — both accepted).
 */
(function () {
  'use strict';

  var API_DEFAULT_BASE = 'https://so.metaid.io';

  var I18N = {
    zh: {
      title: '行情温度计',
      readonlyBadge: '只读 · 不撮合',
      subtitle: '只回答三个客观读数：在售多少、地板价多少、最近成交多少。看中哪件，去店主的小店当面谈。',
      footerNote: '数据来自链上与托管交割记录 · 本页只读 · 成交请回到卖家小店或私聊',
      sectionListings: '在售分布（价格升序）',
      sectionTrades: '最近真实成交流水',
      sectionHolders: '藏家持仓榜',
      floor: '积分地板价',
      median: '积分中位价',
      floorCny: '法币地板价',
      listed: '在售',
      trades24h: '24h 成交',
      holders: '持有人',
      minted: '已铸造',
      lastSale: '最新成交',
      visitShop: '去逛他的小店 →',
      visitHome: '去主页 →',
      sourceAbsEscrow: '积分托管交割',
      sourceChainOffer: '链上原子成交',
      sourceEscrowBot: '官方担保席交割',
      onchainNative: '链上原生成交',
      emptyListings: '该专辑暂无在售挂单。',
      emptyTrades: '暂无成交记录。',
      emptyHolders: '暂无持有人数据。',
      boardEmpty: '暂无认证专辑数据。'
    },
    en: {
      title: 'Market Thermometer',
      readonlyBadge: 'Read-only · no matching',
      subtitle: 'Three objective readings only: how many are listed, the floor, the latest trades. Found one you like? Visit the seller\'s shop.',
      footerNote: 'Data from on-chain records and escrow settlements · this page is read-only with no order entry · deals settle in the seller\'s shop or via private chat',
      sectionListings: 'Active listings (price ascending)',
      sectionTrades: 'Recent real trades',
      sectionHolders: 'Holder leaderboard',
      floor: 'Points floor',
      median: 'Points median',
      floorCny: 'Fiat floor',
      listed: 'Listed',
      trades24h: '24h trades',
      holders: 'Holders',
      minted: 'Minted',
      lastSale: 'Last sale',
      visitShop: 'Visit their shop →',
      visitHome: 'Visit profile →',
      sourceAbsEscrow: 'Points escrow settled',
      sourceChainOffer: 'On-chain atomic swap',
      sourceEscrowBot: 'Official escrow settled',
      onchainNative: 'On-chain native sale',
      emptyListings: 'No active listings in this collection.',
      emptyTrades: 'No trade records.',
      emptyHolders: 'No holder data.',
      boardEmpty: 'No verified collection data.'
    }
  };

  var state = {
    lang: 'zh',
    apiBase: API_DEFAULT_BASE,
    mock: false,
    collections: [],
    trades: [],
    holders: [],
    listings: [],
    activeCollection: null,
    config: null
  };

  function $(id) { return document.getElementById(id); }
  function t(key) { return (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key; }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanText(value, cap) {
    if (typeof value !== 'string') return '';
    var stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
    var collapsed = stripped.replace(/\s+/g, ' ').trim();
    return cap && collapsed.length > cap ? collapsed.slice(0, cap) : collapsed;
  }

  function isValidPinId(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}i\d+$/i.test(value.trim());
  }

  function isValidGlobalMetaId(value) {
    return typeof value === 'string' && /^idq1[a-z0-9]{30,64}$/i.test(value.trim());
  }

  function formatMe(amountMilli) {
    if (typeof amountMilli !== 'number' || !isFinite(amountMilli) || amountMilli < 0) return '';
    var me = amountMilli / 1000;
    return '⚡ ' + (me % 1 === 0 ? String(me) : me.toFixed(2)) + ' ME';
  }

  function formatCny(amountCents) {
    if (typeof amountCents !== 'number' || !isFinite(amountCents) || amountCents < 0) return '';
    return '¥' + (amountCents / 100).toFixed(2);
  }

  function resolveImageUrl(reference) {
    var raw = cleanText(reference, 512);
    if (!raw) return '';
    if (/^(data:|blob:|https?:)/i.test(raw)) return raw;
    var pinId = '';
    if (/^metafile:\/\//i.test(raw)) pinId = raw.slice('metafile://'.length);
    else if (/^[0-9a-f]{64}i\d+$/i.test(raw)) pinId = raw;
    pinId = cleanText(pinId.split('?')[0].split('#')[0].replace(/\.([a-z0-9]+)$/i, ''), 80).toLowerCase();
    if (!/^[0-9a-f]{64}i\d+$/.test(pinId)) return '';
    return 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/' + pinId;
  }

  /* navigation-only AgentBrowser helper (no request API used on this page) */
  var AgentBrowser = window.AgentBrowser || {};
  window.AgentBrowser = AgentBrowser;
  AgentBrowser.navigate = AgentBrowser.navigate || function (uri) {
    window.parent.postMessage({ type: 'agent-browser:navigate', version: 1, uri: String(uri || '') }, '*');
  };
  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (!/^(metaid|pin|metaapp|metafile|map):\/\//i.test(href)) return;
    event.preventDefault();
    AgentBrowser.navigate(href);
  });

  /* ---------- data ---------- */

  function fetchJson(url) {
    return fetch(url, { credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function envelopeOk(body) {
    return Boolean(body) && (body.code === 0 || body.code === 1) && body.data !== undefined;
  }

  function sanitizeCollection(entry) {
    return entry && isValidPinId(entry.collectionPinId) ? entry : null;
  }

  function boot() {
    var params = {};
    try {
      (window.location.search || '').replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        if (eq === -1) return;
        var key = pair.slice(0, eq).trim();
        var value = pair.slice(eq + 1);
        try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
        params[key] = value;
      });
    } catch (e) { /* ignore */ }

    if (params.lang && I18N[params.lang]) state.lang = params.lang;

    fetchJson('./market-config.json').then(function (config) {
      state.config = config && typeof config === 'object' ? config : {};
      state.apiBase = cleanText(params.apiBase || state.config.apiBaseUrl || API_DEFAULT_BASE, 200).replace(/\/+$/, '');
      if (!state.lang && state.config.lang && I18N[state.config.lang]) state.lang = state.config.lang;
      if (params.mock === '1' || params.mock === 'true') state.mock = true;
      if (state.mock && state.config.mockSnapshot) applySnapshot(state.config.mockSnapshot);
      renderStatic();
      renderBoard();
      if (!state.mock) loadCollections();
    }).catch(function () {
      state.config = {};
      state.apiBase = API_DEFAULT_BASE;
      renderStatic();
      renderBoard();
    });
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Array.isArray(snapshot.collections)) state.collections = snapshot.collections.filter(sanitizeCollection);
    if (Array.isArray(snapshot.listings)) state.listings = snapshot.listings.filter(function (x) { return x && isValidPinId(x.itemPinId); });
    if (Array.isArray(snapshot.trades)) state.trades = snapshot.trades.filter(function (x) { return x && typeof x.txId === 'string'; });
    if (Array.isArray(snapshot.holders)) state.holders = snapshot.holders.filter(function (x) { return x && isValidGlobalMetaId(x.globalMetaId); });
  }

  function loadCollections() {
    fetchJson(state.apiBase + '/api/mrc721/market/collections?caOnly=true&size=30')
      .then(function (body) {
        if (!envelopeOk(body) || !Array.isArray(body.data)) return;
        var list = body.data.filter(sanitizeCollection);
        if (list.length || !state.collections.length) {
          state.collections = list;
          renderBoard();
        }
      })
      .catch(function () { /* offline snapshot stays */ });
  }

  function loadDrawerData(collection) {
    var pin = collection.collectionPinId;
    fetchJson(state.apiBase + '/api/mrc721/market/listings?collectionPinId=' + encodeURIComponent(pin) + '&size=60')
      .then(function (body) {
        if (!envelopeOk(body) || !Array.isArray(body.data)) return;
        var list = body.data.filter(function (x) { return x && isValidPinId(x.itemPinId); });
        // price ascending client-side per C3 prices.me.amountMilli (missing price → bottom)
        list.sort(function (a, b) {
          var am = a.prices && a.prices.me && typeof a.prices.me.amountMilli === 'number' ? a.prices.me.amountMilli : Infinity;
          var bm = b.prices && b.prices.me && typeof b.prices.me.amountMilli === 'number' ? b.prices.me.amountMilli : Infinity;
          return am - bm;
        });
        state.listings = list;
        renderDrawerListings();
      })
      .catch(function () { renderDrawerListings(); });

    fetchJson(state.apiBase + '/api/mrc721/market/trades?collectionPinId=' + encodeURIComponent(pin) + '&size=20')
      .then(function (body) {
        if (!envelopeOk(body) || !Array.isArray(body.data)) return;
        state.trades = body.data.filter(function (x) { return x && typeof x.txId === 'string'; });
        renderDrawerTrades();
      })
      .catch(function () { renderDrawerTrades(); });

    fetchJson(state.apiBase + '/api/mrc721/collection/holders?pinId=' + encodeURIComponent(pin) + '&size=30')
      .then(function (body) {
        if (!envelopeOk(body)) return;
        var data = body.data;
        var raw = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
        state.holders = raw.filter(function (x) { return x && (isValidGlobalMetaId(x.globalMetaId) || typeof x.address === 'string'); });
        renderDrawerHolders();
      })
      .catch(function () { renderDrawerHolders(); });
  }

  /* ---------- rendering ---------- */

  function renderStatic() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.documentElement.lang = state.lang === 'zh' ? 'zh' : 'en';
    $('btn-lang').textContent = state.lang === 'zh' ? 'EN' : '中文';
  }

  function statCell(label, value, gold) {
    return '<div class="stat-cell"><div class="stat-label">' + escapeHtml(label)
      + '</div><div class="stat-value' + (gold ? ' gold' : '') + '">' + escapeHtml(value) + '</div></div>';
  }

  function renderBoard() {
    var board = $('board');
    var emptyEl = $('board-empty');
    board.innerHTML = state.collections.map(function (collection) {
      var stats = collection.tradeStats || {};
      var minted = typeof collection.mintedCount === 'number' ? collection.mintedCount : 0;
      var burned = typeof collection.burnedCount === 'number' ? collection.burnedCount : 0;
      var supply = typeof collection.totalSupply === 'number' ? collection.totalSupply : null;
      var mintedText = supply !== null ? (minted - burned) + ' / ' + supply : String(minted - burned);
      var coverUrl = resolveImageUrl(collection.cover);
      return ''
        + '<button type="button" class="collection-card" data-collection-pin="' + escapeHtml(collection.collectionPinId) + '">'
        + '<div class="collection-head">'
        + '<div class="collection-cover">' + (coverUrl ? '<img src="' + escapeHtml(coverUrl) + '" alt="" onerror="this.remove()" />' : '◆') + '</div>'
        + '<div><div class="collection-name">' + escapeHtml(cleanText(collection.displayTitle || collection.collectionName, 60)) + '</div>'
        + (collection.caVerified === true ? '<div class="collection-ca">✔ 官方认证 · CA verified</div>' : '')
        + '</div></div>'
        + '<div class="stat-grid">'
        + statCell(t('listed'), String(typeof collection.listedCount === 'number' ? collection.listedCount : 0))
        + statCell(t('floor'), formatMe(collection.floorPriceMeMilli) || '—', true)
        + statCell(t('floorCny'), formatCny(collection.floorPriceCnyCents) || '—')
        + statCell(t('median'), formatMe(collection.medianPriceMeMilli) || '—')
        + statCell(t('trades24h'), String(typeof stats.trades24h === 'number' ? stats.trades24h : 0))
        + statCell(t('holders'), String(typeof collection.holderCount === 'number' ? collection.holderCount : 0))
        + '</div>'
        + '<div class="stat-row"><span>' + escapeHtml(t('minted')) + ': ' + escapeHtml(mintedText) + '</span>'
        + '<span>' + escapeHtml(t('lastSale')) + ': ' + escapeHtml(formatMe(stats.lastSalePriceMeMilli) || '—') + '</span></div>'
        + '</button>';
    }).join('');
    var isEmpty = state.collections.length === 0;
    emptyEl.hidden = !isEmpty;
    if (isEmpty) emptyEl.textContent = t('boardEmpty');
  }

  function shopLink(seller) {
    var seller_ = seller || {};
    if (isValidPinId(seller_.shopMetaAppPinId)) {
      return '<a class="shop-link" href="metaapp://' + escapeHtml(seller_.shopMetaAppPinId) + '" data-nav>' + escapeHtml(t('visitShop')) + '</a>';
    }
    if (isValidGlobalMetaId(seller_.globalMetaId)) {
      return '<a class="shop-link" href="metaid://' + escapeHtml(seller_.globalMetaId) + '" data-nav>' + escapeHtml(t('visitShop')) + '</a>';
    }
    return '';
  }

  function presenceDot(isOnline) {
    return '<span class="presence-dot ' + (isOnline === true ? 'presence-online' : 'presence-unknown') + '"></span>';
  }

  function renderDrawerListings() {
    var box = $('drawer-listings');
    if (!state.listings.length) {
      box.innerHTML = '<div class="row"><span class="sub">' + escapeHtml(t('emptyListings')) + '</span></div>';
      return;
    }
    box.innerHTML = state.listings.map(function (item) {
      var seller = item.seller || {};
      var priceMe = item.prices && item.prices.me ? formatMe(item.prices.me.amountMilli) : '';
      var priceCny = item.prices && item.prices.fiat ? formatCny(item.prices.fiat.amountCents) : '';
      var name = cleanText(item.itemName, 60) || '#' + String(item.itemPinId).slice(-6);
      var tokenIndex = cleanText(item.tokenIndex, 12);
      return ''
        + '<div class="row">'
        + presenceDot(seller.isOnline)
        + '<div class="grow"><div class="name">' + escapeHtml(name) + '</div>'
        + '<div class="sub">' + escapeHtml(tokenIndex ? '#' + tokenIndex : '') + ' ' + escapeHtml(cleanText(seller.name, 40) || cleanText(seller.globalMetaId, 20)) + '</div></div>'
        + (priceMe ? '<span class="price">' + escapeHtml(priceMe) + '</span>' : '')
        + (priceCny ? '<span class="sub">' + escapeHtml(priceCny) + '</span>' : '')
        + shopLink(seller)
        + '</div>';
    }).join('');
  }

  function renderDrawerTrades() {
    var box = $('drawer-trades');
    if (!state.trades.length) {
      box.innerHTML = '<div class="row"><span class="sub">' + escapeHtml(t('emptyTrades')) + '</span></div>';
      return;
    }
    box.innerHTML = state.trades.map(function (trade) {
      var sourceText;
      var verified;
      if (trade.verifiedSource === 'abs_escrow') { sourceText = t('sourceAbsEscrow'); verified = true; }
      else if (trade.verifiedSource === 'chain_offer') { sourceText = t('sourceChainOffer'); verified = true; }
      else if (trade.verifiedSource === 'escrow_bot') { sourceText = t('sourceEscrowBot'); verified = true; }
      else { sourceText = t('onchainNative'); verified = false; }
      var amount = '';
      // Read-only display: points and fiat prices only; on-chain-native
      // settlement rows are labeled without any crypto-denominated price.
      if (trade.currency === 'me' && typeof trade.amountMilli === 'number') amount = formatMe(trade.amountMilli);
      else if (trade.currency === 'fiat:CNY' && typeof trade.amountCents === 'number') amount = formatCny(trade.amountCents);
      var name = cleanText(trade.itemName, 44) || '#' + String(trade.itemPinId || '').slice(-6);
      return ''
        + '<div class="row">'
        + '<div class="grow"><div class="name">' + escapeHtml(name) + '</div>'
        + '<div class="sub mono">' + escapeHtml(String(trade.txId).slice(0, 14)) + '…</div></div>'
        + (amount ? '<span class="price">' + escapeHtml(amount) + '</span>' : '')
        + '<span class="trade-source' + (verified ? ' verified' : '') + '">' + escapeHtml(sourceText) + '</span>'
        + '</div>';
    }).join('');
  }

  function renderDrawerHolders() {
    var box = $('drawer-holders');
    if (!state.holders.length) {
      box.innerHTML = '<div class="row"><span class="sub">' + escapeHtml(t('emptyHolders')) + '</span></div>';
      return;
    }
    box.innerHTML = state.holders.map(function (holder) {
      var idText = isValidGlobalMetaId(holder.globalMetaId) ? holder.globalMetaId : '';
      var link = idText
        ? '<a class="shop-link" href="metaid://' + escapeHtml(idText) + '" data-nav>' + escapeHtml(t('visitHome')) + '</a>'
        : '';
      return ''
        + '<div class="row">'
        + presenceDot(holder.isOnline)
        + '<div class="grow"><div class="name">' + escapeHtml(cleanText(holder.name, 40) || (idText || '—')) + '</div>'
        + '<div class="sub">' + escapeHtml(String(holder.itemCount != null ? holder.itemCount : 0)) + ' · '
        + escapeHtml(t('listed')) + ' ' + escapeHtml(String(holder.listedItemCount != null ? holder.listedItemCount : 0)) + '</div></div>'
        + link
        + '</div>';
    }).join('');
  }

  /* ---------- drawer ---------- */

  function openDrawer(collection) {
    state.activeCollection = collection;
    var stats = collection.tradeStats || {};
    $('drawer-title').textContent = cleanText(collection.displayTitle || collection.collectionName, 60);
    var minted = typeof collection.mintedCount === 'number' ? collection.mintedCount : 0;
    var burned = typeof collection.burnedCount === 'number' ? collection.burnedCount : 0;
    $('drawer-stats').textContent = t('listed') + ' ' + (collection.listedCount != null ? collection.listedCount : 0)
      + ' · ' + t('floor') + ' ' + (formatMe(collection.floorPriceMeMilli) || '—')
      + ' · ' + t('median') + ' ' + (formatMe(collection.medianPriceMeMilli) || '—')
      + ' · ' + t('minted') + ' ' + (minted - burned)
      + ' · ' + t('lastSale') + ' ' + (formatMe(stats.lastSalePriceMeMilli) || '—');
    renderDrawerListings();
    renderDrawerTrades();
    renderDrawerHolders();
    $('drawer-mask').hidden = false;
    $('drawer').hidden = false;
    loadDrawerData(collection);
  }

  function closeDrawer() {
    $('drawer-mask').hidden = true;
    $('drawer').hidden = true;
    state.activeCollection = null;
  }

  /* ---------- events ---------- */

  $('btn-lang').addEventListener('click', function () {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    renderStatic();
    renderBoard();
    if (state.activeCollection) openDrawer(state.activeCollection);
  });

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-mask').addEventListener('click', closeDrawer);

  $('board').addEventListener('click', function (event) {
    var card = event.target && event.target.closest ? event.target.closest('.collection-card') : null;
    if (!card) return;
    var pin = card.getAttribute('data-collection-pin');
    var found = null;
    state.collections.forEach(function (collection) {
      if (collection.collectionPinId === pin) found = collection;
    });
    if (found) openDrawer(found);
  });

  boot();
})();
