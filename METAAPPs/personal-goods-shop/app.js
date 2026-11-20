/* personal-goods-shop app.js — vanilla, zero-build, relative assets only.
 * Hybrid load: shop-config.json (local snapshot) → URL param overrides →
 * live MetaSo APIs (Contract C3 envelopes, code===0||code===1 both ok).
 * Prices render ME points + CNY reference ONLY; no crypto-coin denominations anywhere.
 * All commerce actions go through browser.commerce.* / privateChat compose
 * with host confirmation; this page never pays, signs or sends by itself.
 */
(function () {
  'use strict';

  var API_DEFAULT_BASE = 'https://so.metaid.io';

  var I18N = {
    zh: {
      tabListings: '在售橱窗',
      tabHoldings: '全部藏品柜',
      addFriend: '+ 加好友 / 留言',
      message: '留言',
      ownerPromoPack: '领分销弹药包',
      ownerBarHint: '店主本人：也可对店招直接说「一句话改店招 / 上下架」。',
      buyWithMe: '用 ME 积分购买',
      negotiate: '找店主 AI 议价',
      inquire: '私聊求购 / 询价',
      autoFulfill: '24h 自动秒发',
      caVerified: '官方认证专辑',
      negotiable: '可议价',
      unlisted: '未上架 · 藏品柜',
      emptyListings: '小店暂无在售商品，欢迎留言询价。',
      emptyHoldings: '藏品柜暂无展示藏品。',
      footerNote: '去中心化点对点成交 · 官方不做撮合市场 · 价格以店主小店与私聊确认为准',
      guideTitle: '在 IDBots 中打开 · 让你的 AI 一句话帮买',
      guideBody: '复制下面这句话，发给你的 AI 助手（装了 IDBots 的同学），它会帮你谈价、锁积分、验货收卡：',
      guideDownload: '还没有 IDBots？在 idbots.ai 下载，让你的 AI 分身替你逛店。',
      guideCopy: '复制购买口令',
      copied: '已复制',
      detailNote: '点击购买后由你的 AI 助手完成托管与验货；付款前还会有一次独立确认。',
      presenceOnline: '在线',
      presenceOff: '离线/未知',
      loadFailed: '店铺数据加载失败，展示离线快照。'
    },
    en: {
      tabListings: 'Active Listings',
      tabHoldings: 'All Holdings',
      addFriend: '+ Add friend / message',
      message: 'Message',
      ownerPromoPack: 'Get promo ammo pack',
      ownerBarHint: 'Shop owner: you can also just tell your AI "change the slogan / list or delist".',
      buyWithMe: 'Buy with ME points',
      negotiate: 'Negotiate with owner AI',
      inquire: 'Inquire / make an offer',
      autoFulfill: '24h auto delivery',
      caVerified: 'Official CA collection',
      negotiable: 'Negotiable',
      unlisted: 'Unlisted · in vault',
      emptyListings: 'No active listings yet — leave a message to inquire.',
      emptyHoldings: 'No holdings on display.',
      footerNote: 'Decentralized peer-to-peer deals · no centralized marketplace · prices per shop owner confirmation',
      guideTitle: 'Open in IDBots · let your AI buy in one sentence',
      guideBody: 'Copy this line to your AI assistant (with IDBots installed); it will negotiate, escrow the points and verify delivery for you:',
      guideDownload: 'No IDBots yet? Download at idbots.ai and let your AI twin shop for you.',
      guideCopy: 'Copy purchase phrase',
      copied: 'Copied',
      detailNote: 'Your AI handles escrow and verification after you click; a separate confirmation happens before any payment.',
      presenceOnline: 'online',
      presenceOff: 'offline/unknown',
      loadFailed: 'Failed to load shop data; showing the offline snapshot.'
    }
  };

  var state = {
    lang: 'zh',
    apiBase: API_DEFAULT_BASE,
    mock: false,
    config: null,
    owner: { globalMetaId: '', name: '', avatar: '' },
    listings: [],
    holdings: [],
    presence: 'unknown',
    isHost: true,
    currentActor: null,
    drawerItem: null,
    caSet: {}
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

  /* MetaFile image resolution per agent-browser-metaapp.md §8 (static attr
   * rewrite only covers server-time HTML; JS-assigned src needs this). */
  function resolveImageUrl(reference, kind) {
    var raw = cleanText(reference, 512);
    if (!raw) return '';
    if (/^(data:|blob:|https?:)/i.test(raw)) return raw;
    var pinId = '';
    if (/^metafile:\/\//i.test(raw)) {
      pinId = raw.slice('metafile://'.length);
    } else if (/^[0-9a-f]{64}i\d+$/i.test(raw)) {
      pinId = raw;
    }
    pinId = cleanText(pinId.split('?')[0].split('#')[0].replace(/\.([a-z0-9]+)$/i, ''), 80).toLowerCase();
    if (!/^[0-9a-f]{64}i\d+$/.test(pinId)) return '';
    return 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/' + pinId;
  }

  function setCover(imgEl, fallbackEl, reference) {
    var url = resolveImageUrl(reference);
    if (url && imgEl) {
      imgEl.src = url;
      imgEl.hidden = false;
      if (fallbackEl) fallbackEl.hidden = true;
      imgEl.onerror = function () {
        imgEl.hidden = true;
        if (fallbackEl) fallbackEl.hidden = false;
      };
    } else {
      if (imgEl) imgEl.hidden = true;
      if (fallbackEl) fallbackEl.hidden = false;
    }
  }

  /* ---------- bridge helper (Agent Browser v1 wire protocol) ---------- */
  var bridgeCallbacks = {};
  var bridgeSeq = 0;
  var AgentBrowser = window.AgentBrowser || {};
  window.AgentBrowser = AgentBrowser;

  AgentBrowser.navigate = AgentBrowser.navigate || function (uri) {
    window.parent.postMessage({ type: 'agent-browser:navigate', version: 1, uri: String(uri || '') }, '*');
  };
  AgentBrowser.request = AgentBrowser.request || function (input) {
    var id = 'req-' + (++bridgeSeq);
    return new Promise(function (resolve, reject) {
      bridgeCallbacks[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage({
        type: 'agent-browser:request',
        version: 1,
        id: id,
        method: String((input && input.method) || ''),
        params: (input && input.params) || {}
      }, '*');
    });
  };
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || data.type !== 'agent-browser:response' || !bridgeCallbacks[data.id]) return;
    var cb = bridgeCallbacks[data.id];
    delete bridgeCallbacks[data.id];
    if (data.ok) cb.resolve(data.result);
    else {
      var error = new Error((data.error && data.error.message) || 'AgentBrowser request failed');
      error.code = (data.error && data.error.code) || 'bridge_error';
      cb.reject(error);
    }
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (!/^(metaid|pin|metaapp|metafile|map):\/\//i.test(href)) return;
    event.preventDefault();
    AgentBrowser.navigate(href);
  });

  /* ---------- config + boot ---------- */

  function readUrlParams() {
    var params = {};
    try {
      var search = window.location.search || '';
      search.replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        if (eq === -1) return;
        var key = pair.slice(0, eq).trim();
        var value = pair.slice(eq + 1);
        try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
        params[key] = value;
      });
    } catch (e) { /* ignore */ }
    return params;
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function envelopeOk(body) {
    return Boolean(body) && (body.code === 0 || body.code === 1) && body.data !== undefined;
  }

  function boot() {
    state.isHost = window.parent !== window;
    var params = readUrlParams();
    if (params.lang && I18N[params.lang]) state.lang = params.lang;
    fetchJson('./shop-config.json').then(function (config) {
      state.config = config && typeof config === 'object' ? config : {};
      applyConfig(params);
      renderStatic();
      renderOwner();
      loadData();
      detectActor();
    }).catch(function () {
      state.config = {};
      applyConfig(params);
      renderStatic();
      renderOwner();
      loadData();
      detectActor();
    });
  }

  function applyConfig(params) {
    var config = state.config || {};
    state.apiBase = cleanText(params.apiBase || config.apiBaseUrl || API_DEFAULT_BASE, 200).replace(/\/+$/, '');
    if (params.owner && isValidGlobalMetaId(params.owner)) {
      state.owner = { globalMetaId: params.owner.trim().toLowerCase(), name: '', avatar: '' };
    } else if (config.ownerGlobalMetaId && isValidGlobalMetaId(config.ownerGlobalMetaId)) {
      state.owner = { globalMetaId: config.ownerGlobalMetaId.trim().toLowerCase(), name: '', avatar: '' };
    }
    if (!state.lang && config.lang && I18N[config.lang]) state.lang = config.lang;
    if (params.mock === '1' || params.mock === 'true') state.mock = true;
    if (state.mock && config.mockSnapshot) {
      applySnapshot(config.mockSnapshot);
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.owner && isValidGlobalMetaId(snapshot.owner.globalMetaId)) {
      state.owner = {
        globalMetaId: snapshot.owner.globalMetaId,
        name: cleanText(snapshot.owner.name, 80),
        avatar: cleanText(snapshot.owner.avatar, 512)
      };
    }
    if (typeof snapshot.presence === 'string') state.presence = snapshot.presence;
    if (Array.isArray(snapshot.listings)) state.listings = snapshot.listings.filter(sanitizeListing);
    if (Array.isArray(snapshot.holdings)) state.holdings = snapshot.holdings.filter(sanitizeHolding);
  }

  function sanitizeListing(item) {
    return item && isValidPinId(item.itemPinId) && item !== null ? item : null;
  }
  function sanitizeHolding(item) {
    return item && isValidPinId(item.itemPinId) ? item : null;
  }

  /* ---------- data ---------- */

  function loadData() {
    if (!state.owner.globalMetaId) return;
    fetchListings();
    fetchHoldings();
    fetchPresence();
    fetchOwnerProfile();
    fetchCaRegistry();
  }

  function fetchListings() {
    fetchJson(state.apiBase + '/api/mrc721/market/listings?seller=' + encodeURIComponent(state.owner.globalMetaId) + '&size=50')
      .then(function (body) {
        if (!envelopeOk(body) || !Array.isArray(body.data)) return;
        var list = body.data.filter(function (item) { return item && isValidPinId(item.itemPinId); });
        if (list.length || !state.listings.length) state.listings = list;
        renderGrid();
      })
      .catch(function () { /* offline snapshot stays */ });
  }

  function fetchHoldings() {
    fetchJson(state.apiBase + '/api/mrc721/address/item?globalMetaId=' + encodeURIComponent(state.owner.globalMetaId))
      .then(function (body) {
        if (!envelopeOk(body)) return;
        var data = body.data;
        var raw = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
        var listed = {};
        state.listings.forEach(function (item) { listed[item.itemPinId] = true; });
        var holdings = raw.filter(function (item) {
          return item && isValidPinId(item.itemPinId || item.pinId) && !listed[item.itemPinId || item.pinId];
        }).map(function (item) {
          return {
            itemPinId: item.itemPinId || item.pinId,
            collectionName: cleanText(item.collectionName, 80),
            itemName: cleanText(item.name || item.itemName, 120),
            cover: cleanText(item.cover || item.image, 512),
            genesis: cleanText(item.genesis, 80),
            listed: false
          };
        });
        if (holdings.length || !state.holdings.length) state.holdings = holdings;
        renderGrid();
      })
      .catch(function () { /* offline snapshot stays */ });
  }

  function fetchPresence() {
    fetchJson(state.apiBase + '/api/presence/globalmetaid/' + encodeURIComponent(state.owner.globalMetaId))
      .then(function (body) {
        var data = body && body.data;
        var status = data && (data.presence || data.status || data.presenceStatus);
        if (typeof status !== 'string') {
          // unknown is not an error: keep the grey dot, never render a failure
          state.presence = 'unknown';
        } else {
          state.presence = status === 'online' ? 'online' : 'unknown';
        }
        renderPresence();
      })
      .catch(function () { state.presence = 'unknown'; renderPresence(); });
  }

  function fetchOwnerProfile() {
    fetchJson(state.apiBase + '/api/bot-homepage/globalmetaid/' + encodeURIComponent(state.owner.globalMetaId) + '?version=v3')
      .then(function (body) {
        if (!body || body.code !== 0 || !body.data || body.data.schemaVersion !== 'botHomepage.v3') return;
        var identity = body.data.identity || {};
        var profile = body.data.profile || {};
        var name = cleanText(profile.name || identity.name || identity.displayName, 80);
        var avatar = cleanText(profile.avatar || identity.avatar || '', 512);
        if (name) { state.owner.name = name; renderOwner(); }
        if (avatar) { state.owner.avatar = avatar; renderOwner(); }
        if (!state.shopSloganSet && profile.bio) {
          var bio = cleanText(profile.bio, 200);
          if (bio && !cleanText(state.config && state.config.slogan, 200)) {
            $('shop-slogan').textContent = bio;
          }
        }
      })
      .catch(function () { /* keep config name */ });
  }

  function fetchCaRegistry() {
    fetchJson(state.apiBase + '/api/mrc721/ca/registry')
      .then(function (body) {
        var data = body && body.data;
        var collections = data && Array.isArray(data.collections) ? data.collections : [];
        var set = {};
        collections.forEach(function (entry) {
          if (entry && isValidPinId(entry.collectionPinId)) set[entry.collectionPinId.toLowerCase()] = true;
        });
        state.caSet = set;
        renderGrid();
      })
      .catch(function () { /* CA enrichment optional */ });
  }

  /* ---------- rendering ---------- */

  function renderStatic() {
    $('tab-listings').textContent = t('tabListings');
    $('tab-holdings').textContent = t('tabHoldings');
    $('btn-add-friend').textContent = t('addFriend');
    $('btn-message').textContent = t('message');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.documentElement.lang = state.lang === 'zh' ? 'zh' : 'en';
    $('btn-lang').textContent = state.lang === 'zh' ? 'EN' : '中文';
  }

  function renderOwner() {
    var owner = state.owner;
    $('owner-name').textContent = owner.name || t('presenceOff');
    $('owner-name').textContent = owner.name || owner.globalMetaId.slice(0, 14) + '…';
    $('owner-id').textContent = owner.globalMetaId;
    var slogan = cleanText(state.config && state.config.slogan, 200) || cleanText(state.config && state.config.shopName, 80);
    $('shop-slogan').textContent = slogan;
    $('shop-slogan').hidden = !slogan;
    setCover($('owner-avatar'), $('owner-avatar-fallback'), owner.avatar);
    renderPresence();
  }

  function renderPresence() {
    var dot = $('owner-presence');
    dot.className = 'presence-dot ' + (state.presence === 'online' ? 'presence-online' : 'presence-unknown');
    dot.title = state.presence === 'online' ? t('presenceOnline') : t('presenceOff');
  }

  function cardHtml(item, kind) {
    var coverUrl = resolveImageUrl(item.cover || item.image || '');
    var caVerified = item.caVerified === true
      || (item.collectionPinId && state.caSet[String(item.collectionPinId).toLowerCase()] === true);
    var priceMe = item.prices && item.prices.me ? formatMe(item.prices.me.amountMilli) : '';
    var priceCny = item.prices && item.prices.fiat ? formatCny(item.prices.fiat.amountCents) : '';
    var name = cleanText(item.itemName || item.name, 120) || '#' + String(item.itemPinId).slice(-6);
    var collection = cleanText(item.collectionName, 80);
    var badges = '';
    if (caVerified) badges += '<span class="badge badge-ca">✔ ' + escapeHtml(t('caVerified')) + '</span>';
    if (kind === 'listing' && item.autoFulfillMe === true) badges += '<span class="badge badge-fast">⚡ ' + escapeHtml(t('autoFulfill')) + '</span>';
    if (kind === 'listing' && item.negotiable === true) badges += '<span class="badge badge-fast">✎ ' + escapeHtml(t('negotiable')) + '</span>';
    if (kind === 'holding') badges += '<span class="badge badge-ca">' + escapeHtml(t('unlisted')) + '</span>';
    return ''
      + '<button type="button" class="item-card" data-item-pin="' + escapeHtml(item.itemPinId) + '" data-kind="' + kind + '">'
      + (coverUrl
        ? '<img class="item-cover" src="' + escapeHtml(coverUrl) + '" alt="' + escapeHtml(name) + '" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false" />'
        : '')
      + '<div class="item-cover-fallback"' + (coverUrl ? ' hidden' : '') + '>◆</div>'
      + '<div class="item-body">'
      + '<div class="item-name">' + escapeHtml(name) + '</div>'
      + (collection ? '<div class="item-collection">' + escapeHtml(collection) + '</div>' : '')
      + ((priceMe || priceCny)
        ? '<div class="item-prices">'
          + (priceMe ? '<span class="price-me">' + escapeHtml(priceMe) + '</span>' : '')
          + (priceCny ? '<span class="price-cny">' + escapeHtml(priceCny) + '</span>' : '')
          + '</div>'
        : '')
      + '<div>' + badges + '</div>'
      + '</div>'
      + '</button>';
  }

  function renderGrid() {
    var listingsGrid = $('listings-grid');
    var holdingsGrid = $('holdings-grid');
    listingsGrid.innerHTML = state.listings.map(function (item) { return cardHtml(item, 'listing'); }).join('');
    holdingsGrid.innerHTML = state.holdings.map(function (item) { return cardHtml(item, 'holding'); }).join('');
    var emptyEl = $('empty-state');
    var activeTab = $('panel-listings').hidden ? 'holdings' : 'listings';
    var isEmpty = activeTab === 'listings' ? state.listings.length === 0 : state.holdings.length === 0;
    emptyEl.hidden = !isEmpty;
    emptyEl.textContent = activeTab === 'listings' ? t('emptyListings') : t('emptyHoldings');
  }

  /* ---------- drawer ---------- */

  function findItem(pinId, kind) {
    var pool = kind === 'holding' ? state.holdings : state.listings;
    for (var i = 0; i < pool.length; i += 1) {
      if (pool[i].itemPinId === pinId) return pool[i];
    }
    return null;
  }

  function openDrawer(pinId, kind) {
    var item = findItem(pinId, kind);
    if (!item) return;
    state.drawerItem = { item: item, kind: kind };
    var name = cleanText(item.itemName || item.name, 120) || '#' + String(item.itemPinId).slice(-6);
    $('drawer-name').textContent = name;
    $('drawer-collection').textContent = cleanText(item.collectionName, 80);
    setCover($('drawer-cover'), $('drawer-cover-fallback'), item.cover || item.image || '');
    var priceMe = item.prices && item.prices.me ? formatMe(item.prices.me.amountMilli) : '';
    var priceCny = item.prices && item.prices.fiat ? formatCny(item.prices.fiat.amountCents) : '';
    $('drawer-prices').innerHTML = ''
      + (priceMe ? '<span class="price-me">' + escapeHtml(priceMe) + '</span>' : '')
      + (priceCny ? '<span class="price-cny">' + escapeHtml(priceCny) + '</span>' : '');
    var badges = '';
    var caVerified = item.caVerified === true
      || (item.collectionPinId && state.caSet[String(item.collectionPinId).toLowerCase()] === true);
    if (caVerified) badges += '<span class="badge badge-ca">✔ ' + escapeHtml(t('caVerified')) + '</span>';
    if (kind === 'listing' && item.autoFulfillMe === true) badges += '<span class="badge badge-fast">⚡ ' + escapeHtml(t('autoFulfill')) + '</span>';
    $('drawer-badges').innerHTML = badges;
    var actions = $('drawer-actions');
    actions.innerHTML = '';
    if (kind === 'listing') {
      if (item.prices && item.prices.me) {
        actions.appendChild(actionButton(t('buyWithMe'), 'btn-accent', function () { askTwin(item, 'buy_me'); }));
      }
      if (item.negotiable === true) {
        actions.appendChild(actionButton(t('negotiate'), '', function () { askTwin(item, 'negotiate'); }));
      }
    } else {
      actions.appendChild(actionButton(t('inquire'), 'btn-accent', function () { askTwin(item, 'inquire_unlisted'); }));
    }
    actions.appendChild(actionButton(t('message'), '', function () { openPrivateChat(); }));
    $('drawer-note').textContent = t('detailNote');
    $('drawer-mask').hidden = false;
    $('drawer').hidden = false;
  }

  function actionButton(label, cls, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + cls;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function closeDrawer() {
    $('drawer-mask').hidden = true;
    $('drawer').hidden = true;
    state.drawerItem = null;
  }

  /* ---------- commerce actions ---------- */

  function askTwin(item, mode) {
    var prices = item.prices || {};
    var payload = {
      itemPinId: String(item.itemPinId),
      collectionId: isValidPinId(item.collectionPinId) ? String(item.collectionPinId).toLowerCase() : undefined,
      collectionName: cleanText(item.collectionName, 80),
      itemName: cleanText(item.itemName || item.name, 120) || '#' + String(item.itemPinId).slice(-6),
      tokenIndex: undefined,
      sellerGlobalMetaId: state.owner.globalMetaId,
      sellerName: cleanText(state.owner.name, 80) || undefined,
      priceMeMilli: prices.me && typeof prices.me.amountMilli === 'number' ? prices.me.amountMilli : undefined,
      priceCnyCents: prices.fiat && typeof prices.fiat.amountCents === 'number' ? prices.fiat.amountCents : undefined,
      mode: mode,
      shopMetaAppPinId: undefined
    };
    if (!state.isHost) {
      openGuide(payload);
      return;
    }
    AgentBrowser.request({ method: 'browser.commerce.askTwinToBuy', params: payload }).catch(function () {
      openGuide(payload);
    });
  }

  function openAddFriend() {
    if (!state.isHost) {
      openGuide({ mode: 'friend' });
      return;
    }
    AgentBrowser.request({
      method: 'browser.social.addFriendPrompt',
      params: {
        targetGlobalMetaId: state.owner.globalMetaId,
        targetName: cleanText(state.owner.name, 80) || undefined
      }
    }).catch(function () { /* host declined or unsupported */ });
  }

  function openPrivateChat() {
    if (!state.isHost) {
      openGuide({ mode: 'friend' });
      return;
    }
    // No-arg compose: the host derives the recipient from this page's owner.
    AgentBrowser.request({ method: 'browser.privateChat.compose', params: {} }).catch(function () { });
  }

  function openPromoPack() {
    if (!state.isHost) return;
    var featured = state.listings.slice(0, 3).map(function (item) {
      return {
        itemPinId: String(item.itemPinId),
        itemName: cleanText(item.itemName, 80),
        coverUrl: cleanText(item.cover, 512) || undefined,
        priceMeMilli: item.prices && item.prices.me ? item.prices.me.amountMilli : undefined,
        priceCnyCents: item.prices && item.prices.fiat ? item.prices.fiat.amountCents : undefined
      };
    });
    AgentBrowser.request({
      method: 'browser.commerce.openPromoPack',
      params: {
        shopOwnerGlobalMetaId: state.owner.globalMetaId,
        shopOwnerName: cleanText(state.owner.name, 80) || undefined,
        shopSlogan: cleanText(state.config && state.config.slogan, 200) || undefined,
        featuredItems: featured
      }
    }).catch(function () { /* forbidden for non-owner or unsupported */ });
  }

  /* ---------- external-browser fallback guide ---------- */

  function openGuide(payload) {
    var ownerLabel = state.owner.name ? '@' + state.owner.name + ' (' + state.owner.globalMetaId + ')' : state.owner.globalMetaId;
    var phrase = state.lang === 'zh'
      ? '去 ' + ownerLabel + ' 的小店帮我看看' + (payload.itemName ? '#' + payload.itemName : '')
      : 'Check ' + ownerLabel + '\'s shop for me' + (payload.itemName ? ' — ' + payload.itemName : '');
    $('guide-command').textContent = phrase;
    $('guide-copy').textContent = t('guideCopy');
    $('guide-copy').onclick = function () {
      try {
        navigator.clipboard.writeText(phrase).then(function () {
          $('guide-copy').textContent = t('copied');
        }, function () { /* selection fallback below */ });
      } catch (e) { /* clipboard unavailable */ }
    };
    $('guide-mask').hidden = false;
    $('guide-card').hidden = false;
  }

  function closeGuide() {
    $('guide-mask').hidden = true;
    $('guide-card').hidden = true;
  }

  /* ---------- actor detection (owner bar) ---------- */

  function detectActor() {
    if (!state.isHost) return;
    AgentBrowser.request({ method: 'browser.actor.current', params: {} }).then(function (result) {
      var actor = result && result.actor;
      state.currentActor = actor && isValidGlobalMetaId(actor.globalMetaId) ? actor : null;
      renderOwnerBar();
    }).catch(function () { renderOwnerBar(); });
  }

  function renderOwnerBar() {
    var isOwner = Boolean(state.currentActor
      && state.owner.globalMetaId
      && state.currentActor.globalMetaId === state.owner.globalMetaId);
    $('owner-bar').hidden = !isOwner;
  }

  /* ---------- events ---------- */

  function wireEvents() {
    $('tab-listings').addEventListener('click', function () { switchTab('listings'); });
    $('tab-holdings').addEventListener('click', function () { switchTab('holdings'); });
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-mask').addEventListener('click', closeDrawer);
    $('guide-close').addEventListener('click', closeGuide);
    $('guide-mask').addEventListener('click', closeGuide);
    $('btn-add-friend').addEventListener('click', openAddFriend);
    $('btn-message').addEventListener('click', openPrivateChat);
    $('btn-promo-pack').addEventListener('click', openPromoPack);
    $('btn-lang').addEventListener('click', function () {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      renderStatic();
      renderGrid();
    });
    $('shop-main').addEventListener('click', function (event) {
      var card = event.target && event.target.closest ? event.target.closest('.item-card') : null;
      if (!card) return;
      openDrawer(card.getAttribute('data-item-pin'), card.getAttribute('data-kind'));
    });
  }

  function switchTab(which) {
    var listings = which === 'listings';
    $('panel-listings').hidden = !listings;
    $('panel-holdings').hidden = listings;
    $('tab-listings').className = 'tab' + (listings ? ' active' : '');
    $('tab-holdings').className = 'tab' + (listings ? '' : ' active');
    renderGrid();
  }

  wireEvents();
  boot();
})();
