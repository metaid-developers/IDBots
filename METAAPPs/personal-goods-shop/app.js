/* personal-goods-shop app.js — vanilla, zero-build, relative assets only.
 * Hybrid load: shop-config.json (local snapshot) → URL param overrides →
 * live MetaSo APIs (Contract C3 envelopes, code===0||code===1 both ok).
 * Prices render ME points + token prices + CNY reference ONLY; no crypto-coin denominations anywhere.
 * All commerce actions go through browser.commerce.* / privateChat compose
 * with host confirmation; this page never pays, signs or sends by itself.
 */
(function () {
  'use strict';

  var API_DEFAULT_BASE = 'https://so.metaid.io';
  var FILE_INDEXER_BASE = 'https://file.metaid.io/metafile-indexer';

  var LEGACY_SHOP_NAME_RE = /精选头像铺|头像铺|老藏家|清仓小铺|个人数字商品小店|数字商品小店/i;
  var LEGACY_SLOGAN_RE = /自动秒发|秒发|24\s*h|24\s*小时|精选头像铺|头像铺|老藏家|清仓小铺|免费升级盘活/i;

  var I18N = {
    zh: {
      shopTitleSuffix: ' 的 NFT 橱窗',
      shopTitleFallback: 'NFT 橱窗',
      defaultSlogan: '链上 MRC-721 数字藏品橱窗 · 点对点担保交割',
      tabListings: '在售橱窗',
      tabHoldings: '全部藏品柜',
      addFriend: '+ 加好友',
      message: '留言',
      ownerPromoPack: '领分销弹药包',
      ownerBarHint: '店主本人管理入口',
      buyWithMe: '用 ME 积分购买',
      buyWithTokenPrefix: '用 ',
      buyWithTokenSuffix: ' 购买',
      negotiate: '议价',
      inquire: '求购 / 询价',
      caVerified: '官方认证',
      albumLabel: '专辑',
      editionLabel: '编号',
      issuerLabel: '发行方',
      unknownAlbum: '未命名专辑',
      unknownIssuer: '链上创作者',
      unlistedPrice: '藏品柜展示 · 未标价',
      emptyListings: '橱窗暂无在售藏品，可通过顶部「留言」联系店主。',
      emptyHoldings: '藏品柜暂无更多未上架藏品。',
      footerNote: '去中心化点对点成交 · 官方不做撮合市场 · 付款前由你的 AI 助手二次确认',
      guideTitle: '在 IDBots 中打开 · 让你的 AI 一句话帮买',
      guideBody: '复制下面这句话，发给你的 AI 助手（装了 IDBots 的客户端），它会帮你锁积分托管并验货收卡：',
      guideDownload: '还没有 IDBots？在 idbots.ai 下载，让你的 AI 分身替你逛店。',
      guideCopy: '复制购买口令',
      copied: '已复制',
      copyIdTitle: '点击复制店主 GlobalMetaID',
      presenceOnline: '在线',
      presenceOff: '离线/未知'
    },
    en: {
      shopTitleSuffix: "'s NFT Showcase",
      shopTitleFallback: 'NFT Showcase',
      defaultSlogan: 'On-chain MRC-721 NFT Showcase · Peer-to-peer Escrow',
      tabListings: 'For Sale',
      tabHoldings: 'Collection Vault',
      addFriend: '+ Add Friend',
      message: 'Message',
      ownerPromoPack: 'Promo Pack',
      ownerBarHint: 'Shop owner tools',
      buyWithMe: 'Buy with ME',
      buyWithTokenPrefix: 'Buy · ',
      buyWithTokenSuffix: '',
      negotiate: 'Negotiate',
      inquire: 'Make Offer',
      caVerified: 'Verified',
      albumLabel: 'Collection',
      editionLabel: 'Edition',
      issuerLabel: 'Issuer',
      unknownAlbum: 'Collection',
      unknownIssuer: 'On-chain Creator',
      unlistedPrice: 'In Vault · Unlisted',
      emptyListings: 'No active listings right now — use Message above to reach the owner.',
      emptyHoldings: 'No additional unlisted holdings in vault.',
      footerNote: 'Decentralized peer-to-peer deals · no centralized marketplace · confirmed by your AI before payment',
      guideTitle: 'Open in IDBots · let your AI buy in one sentence',
      guideBody: 'Copy this line to your AI assistant in IDBots; it will escrow the points and verify delivery for you:',
      guideDownload: 'No IDBots yet? Download at idbots.ai and let your AI twin shop for you.',
      guideCopy: 'Copy purchase phrase',
      copied: 'Copied',
      copyIdTitle: 'Click to copy owner GlobalMetaID',
      presenceOnline: 'online',
      presenceOff: 'offline/unknown'
    }
  };

  var state = {
    lang: 'zh',
    apiBase: API_DEFAULT_BASE,
    mock: false,
    config: null,
    owner: { globalMetaId: '', name: '', avatar: '', bio: '' },
    listings: [],
    rawHoldings: [],
    holdings: [],
    itemsByPinId: {},
    collectionsByPinId: {},
    collectionsBySlug: {},
    pendingCollections: {},
    issuerNamesByMetaId: {},
    pendingIssuers: {},
    caSet: {},
    caTitleByPinId: {},
    presence: 'unknown',
    isHost: true,
    idCopiedTimer: null
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

  function shortMetaId(value) {
    var clean = cleanText(value, 80);
    if (!clean) return '';
    if (clean.length <= 18) return clean;
    return clean.slice(0, 10) + '…' + clean.slice(-6);
  }

  function shortAddress(value) {
    var clean = cleanText(value, 80);
    if (!clean) return '';
    if (clean.length <= 14) return clean;
    return clean.slice(0, 6) + '…' + clean.slice(-4);
  }

  function monogramOf(label) {
    var clean = cleanText(label, 40).replace(/^#/, '');
    if (!clean) return 'N';
    var alnum = clean.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
    return alnum ? alnum[0].toUpperCase() : clean.slice(0, 1).toUpperCase();
  }

  function parseJsonObject(raw) {
    if (!raw) return null;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (!trimmed || trimmed.charAt(0) !== '{') return null;
    try {
      var parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function formatMe(amountMilli) {
    if (typeof amountMilli !== 'number' || !isFinite(amountMilli) || amountMilli < 0) return '';
    var me = amountMilli / 1000;
    return '⚡ ' + (me % 1 === 0 ? String(me) : me.toFixed(2).replace(/0$/, '').replace(/\.$/, '')) + ' ME';
  }

  function formatCny(amountCents) {
    if (typeof amountCents !== 'number' || !isFinite(amountCents) || amountCents < 0) return '';
    return '¥' + (amountCents / 100).toFixed(2);
  }

  function sanitizeTokenPrices(item) {
    var tokens = item && item.prices && Array.isArray(item.prices.tokens) ? item.prices.tokens : [];
    var out = [];
    for (var i = 0; i < tokens.length && out.length < 6; i += 1) {
      var tok = tokens[i];
      if (!tok || typeof tok !== 'object') continue;
      var assetKey = cleanText(tok.assetKey || '', 140).toLowerCase();
      var symbol = cleanText(tok.symbol || '', 24);
      var amountDisplay = cleanText(tok.amountDisplay != null ? String(tok.amountDisplay) : '', 40);
      var amountBase = tok.amountBase != null ? cleanText(String(tok.amountBase), 64) : '';
      if (!assetKey || !symbol || !amountDisplay) continue;
      out.push({
        assetKey: assetKey,
        symbol: symbol,
        amountDisplay: amountDisplay,
        amountBase: amountBase
      });
    }
    return out;
  }

  function formatTokenLabel(tok) {
    return tok.amountDisplay + ' $' + tok.symbol;
  }

  /* ---------- MetaFile multi-gateway image resolution ----------
   * Extracts pinId from strings (metafile://, /content/, /metafile-indexer/...,
   * bare <64hex>i<N>) AND avatar objects ({ pinId, avatarId, url }).
   * Uses verified direct content endpoints first and retains
   * metafile-indexer/api/v1/files/accelerate/content/ as final fallback. */

  function extractReferenceString(reference) {
    if (!reference) return '';
    if (typeof reference === 'string') return cleanText(reference, 512);
    if (typeof reference === 'object') {
      return cleanText(
        reference.pinId || reference.avatarPinId || reference.avatarId || reference.filePinId || reference.url || reference.content || '',
        512
      );
    }
    return '';
  }

  function extractMetafilePinId(raw) {
    var cleaned = cleanText(raw, 512);
    if (!cleaned) return '';
    var candidate = '';
    if (/^metafile:\/\//i.test(cleaned)) {
      candidate = cleaned.slice('metafile://'.length);
    } else if (/^\/content\//i.test(cleaned)) {
      candidate = cleaned.slice('/content/'.length);
    } else if (/\/metafile-indexer\/(?:api\/v1\/files\/(?:accelerate\/)?content|content)\//i.test(cleaned)) {
      var parts = cleaned.split(/\/metafile-indexer\/(?:api\/v1\/files\/(?:accelerate\/)?content|content)\//i);
      candidate = parts[parts.length - 1] || '';
    } else {
      candidate = cleaned;
    }
    candidate = cleanText(
      candidate.split('?')[0].split('#')[0].replace(/\.([a-z0-9]{1,8})$/i, ''),
      90
    ).toLowerCase();
    return /^[0-9a-f]{64}i\d+$/.test(candidate) ? candidate : '';
  }

  function buildImageCandidates(reference, kind) {
    var raw = extractReferenceString(reference);
    if (!raw) return [];
    var pinId = extractMetafilePinId(raw);
    if (pinId) {
      var directApi = FILE_INDEXER_BASE + '/api/v1/files/content/' + pinId;
      var directContent = FILE_INDEXER_BASE + '/content/' + pinId;
      var accelerate = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/' + pinId;
      if (kind === 'avatar') {
        return [directContent, directApi, accelerate];
      }
      return [directApi, directContent, accelerate];
    }
    if (/^(data:|blob:|https?:)/i.test(raw)) return [raw];
    return [];
  }

  function resolveImageUrl(reference, kind) {
    var candidates = buildImageCandidates(reference, kind);
    return candidates.length ? candidates[0] : '';
  }

  function bindImageWithFallback(imgEl, fallbackEl, reference, kind) {
    if (!imgEl) return;
    var candidates = buildImageCandidates(reference, kind);
    if (!candidates.length) {
      imgEl.hidden = true;
      imgEl.removeAttribute('src');
      if (fallbackEl) fallbackEl.hidden = false;
      return;
    }
    var index = 0;
    imgEl.hidden = false;
    if (fallbackEl) fallbackEl.hidden = true;
    imgEl.onload = function () {
      imgEl.hidden = false;
      if (fallbackEl) fallbackEl.hidden = true;
    };
    imgEl.onerror = function () {
      index += 1;
      if (index < candidates.length) {
        imgEl.src = candidates[index];
      } else {
        imgEl.onerror = null;
        imgEl.hidden = true;
        if (fallbackEl) fallbackEl.hidden = false;
      }
    };
    imgEl.src = candidates[0];
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

  /* TESTABLE_EXTRACT_LIST_START */
  /* Market endpoints (Contract C3) answer paginated envelopes
   * { code: 0, data: { list: [...], total, cursor } }; legacy endpoints
   * answer bare arrays. Accept both, reject everything else. */
  function extractListData(body) {
    if (!envelopeOk(body)) return null;
    if (Array.isArray(body.data)) return body.data;
    if (body.data && Array.isArray(body.data.list)) return body.data.list;
    return null;
  }
  /* TESTABLE_EXTRACT_LIST_END */

  function boot() {
    state.isHost = window.parent !== window;
    var params = readUrlParams();
    if (params.lang && I18N[params.lang]) state.lang = params.lang;
    fetchJson('./shop-config.json').then(function (config) {
      state.config = config && typeof config === 'object' ? config : {};
      applyConfig(params);
      renderStatic();
      renderOwner();
      renderGrid();
      if (!state.mock) loadData();
    }).catch(function () {
      state.config = {};
      applyConfig(params);
      renderStatic();
      renderOwner();
      renderGrid();
      if (!state.mock) loadData();
    });
  }

  function applyConfig(params) {
    var config = state.config || {};
    state.apiBase = cleanText(params.apiBase || config.apiBaseUrl || API_DEFAULT_BASE, 200).replace(/\/+$/, '');
    if (params.owner && isValidGlobalMetaId(params.owner)) {
      state.owner = { globalMetaId: params.owner.trim().toLowerCase(), name: '', avatar: '', bio: '' };
    } else if (config.ownerGlobalMetaId && isValidGlobalMetaId(config.ownerGlobalMetaId)) {
      var snapOwner = config.mockSnapshot && config.mockSnapshot.owner;
      var sameSnapOwner = snapOwner
        && isValidGlobalMetaId(snapOwner.globalMetaId)
        && snapOwner.globalMetaId.trim().toLowerCase() === config.ownerGlobalMetaId.trim().toLowerCase();
      state.owner = {
        globalMetaId: config.ownerGlobalMetaId.trim().toLowerCase(),
        name: sameSnapOwner ? cleanText(snapOwner.name, 80) : '',
        avatar: sameSnapOwner ? extractReferenceString(snapOwner.avatar) : '',
        bio: sameSnapOwner ? cleanText(snapOwner.bio, 200) : ''
      };
      if (state.owner.name) {
        state.issuerNamesByMetaId[state.owner.globalMetaId] = state.owner.name;
      }
    }
    if (!params.lang && config.lang && I18N[config.lang]) state.lang = config.lang;
    if (params.mock === '1' || params.mock === 'true') state.mock = true;
    if (state.mock && config.mockSnapshot) {
      applySnapshot(config.mockSnapshot);
    }
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.owner && isValidGlobalMetaId(snapshot.owner.globalMetaId)) {
      state.owner = {
        globalMetaId: snapshot.owner.globalMetaId.trim().toLowerCase(),
        name: cleanText(snapshot.owner.name, 80),
        avatar: extractReferenceString(snapshot.owner.avatar),
        bio: cleanText(snapshot.owner.bio, 200)
      };
      if (state.owner.name) {
        state.issuerNamesByMetaId[state.owner.globalMetaId] = state.owner.name;
      }
    }
    if (typeof snapshot.presence === 'string') state.presence = snapshot.presence;
    if (Array.isArray(snapshot.listings)) {
      state.listings = snapshot.listings.filter(function (item) {
        return item && isValidPinId(item.itemPinId);
      });
    }
    if (Array.isArray(snapshot.holdings)) {
      state.rawHoldings = snapshot.holdings.filter(function (item) {
        return item && isValidPinId(item.itemPinId || item.pinId);
      }).map(normalizeHoldingItem);
      recomputeHoldings();
    }
  }

  /* ---------- data & enrichment ---------- */

  function normalizeHoldingItem(raw) {
    var pinId = String(raw.itemPinId || raw.pinId || '').trim();
    var metaObj = parseJsonObject(raw.metadata || raw.metaData);
    var coverRef = extractReferenceString(raw.cover || raw.image || (metaObj && (metaObj.cover || metaObj.image)));
    var itemNumber = typeof raw.itemNumber === 'number'
      ? raw.itemNumber
      : (typeof raw.number === 'number'
        ? raw.number
        : (typeof raw.itemPinNumber === 'number' ? raw.itemPinNumber : undefined));
    return {
      itemPinId: pinId,
      collectionPinId: cleanText(raw.collectionPinId, 90),
      collectionName: cleanText(raw.collectionName, 80),
      collectionDisplayTitle: cleanText(raw.collectionDisplayTitle, 80),
      caVerified: raw.caVerified === true,
      itemName: cleanText(raw.itemName || raw.name || (metaObj && metaObj.title), 120),
      itemNumber: itemNumber,
      tokenIndex: raw.tokenIndex != null
        ? raw.tokenIndex
        : (metaObj && metaObj.custom && metaObj.custom.swap && metaObj.custom.swap.tokenIndex != null
          ? metaObj.custom.swap.tokenIndex
          : undefined),
      totalSupply: typeof raw.totalSupply === 'number' ? raw.totalSupply : undefined,
      issuerName: cleanText(raw.issuerName || (metaObj && metaObj.issuer), 80),
      issuerMetaId: cleanText(raw.createMetaId || raw.issuerMetaId, 80),
      issuerAddress: cleanText(raw.createAddress || raw.issuerAddress, 80),
      metadata: raw.metadata || raw.metaData || '',
      cover: coverRef,
      genesis: cleanText(raw.genesis, 80),
      listed: false
    };
  }

  function recomputeHoldings() {
    var listedMap = {};
    state.listings.forEach(function (item) {
      if (item && item.itemPinId) listedMap[String(item.itemPinId).toLowerCase()] = true;
    });
    state.holdings = state.rawHoldings.filter(function (item) {
      return item && item.itemPinId && !listedMap[String(item.itemPinId).toLowerCase()];
    });
  }

  function indexCollectionRecord(col) {
    if (!col || typeof col !== 'object') return;
    var pinId = cleanText(col.collectionPinId || col.pinId || col.pinid, 90).toLowerCase();
    var slug = cleanText(col.collectionName || col.collectionname, 80).toLowerCase();
    var createMetaId = cleanText(col.createMetaId || col.metaid, 80).toLowerCase();
    var createAddress = cleanText(col.createAddress || col.address, 80);
    var totalSupply = typeof col.totalSupply === 'number'
      ? col.totalSupply
      : (typeof col.totalsupply === 'number' ? col.totalsupply : undefined);
    var record = {
      collectionPinId: pinId,
      collectionName: cleanText(col.collectionName || col.collectionname, 80),
      displayTitle: cleanText(col.caDisplayTitle || col.displayTitle || col.name, 80),
      name: cleanText(col.name, 80),
      caVerified: col.caVerified === true,
      totalSupply: totalSupply,
      createMetaId: createMetaId,
      createAddress: createAddress
    };
    if (pinId) state.collectionsByPinId[pinId] = record;
    if (slug && !state.collectionsBySlug[slug]) state.collectionsBySlug[slug] = record;
    if (createMetaId && isValidGlobalMetaId(createMetaId)) {
      ensureIssuerName(createMetaId);
    }
  }

  function ensureCollectionLoaded(collectionPinId) {
    var cleanPin = cleanText(collectionPinId, 90).toLowerCase();
    if (!isValidPinId(cleanPin)) return;
    if (state.collectionsByPinId[cleanPin] || state.pendingCollections[cleanPin]) return;
    state.pendingCollections[cleanPin] = true;
    fetchJson(state.apiBase + '/api/mrc721/collection/info?pinId=' + encodeURIComponent(cleanPin))
      .then(function (body) {
        if (!envelopeOk(body) || !body.data || typeof body.data !== 'object') return;
        indexCollectionRecord(body.data);
        renderGrid();
      })
      .catch(function () { /* optional collection enrichment */ });
  }

  function ensureIssuerName(globalMetaId) {
    var cleanId = cleanText(globalMetaId, 80).toLowerCase();
    if (!isValidGlobalMetaId(cleanId)) return;
    if (state.issuerNamesByMetaId[cleanId] || state.pendingIssuers[cleanId]) return;
    if (cleanId === state.owner.globalMetaId && state.owner.name) {
      state.issuerNamesByMetaId[cleanId] = state.owner.name;
      return;
    }
    state.pendingIssuers[cleanId] = true;
    fetchJson(state.apiBase + '/api/bot-homepage/globalmetaid/' + encodeURIComponent(cleanId) + '?version=v3')
      .then(function (body) {
        if (!body || body.code !== 0 || !body.data) return;
        var identity = body.data.identity || {};
        var profile = body.data.profile || {};
        var name = cleanText(profile.name || identity.name || identity.displayName, 80);
        if (name) {
          state.issuerNamesByMetaId[cleanId] = name;
          renderGrid();
        }
      })
      .catch(function () { /* fallback to short ID */ });
  }

  function discoverCollectionsFromItems(items) {
    (items || []).forEach(function (item) {
      if (item && item.collectionPinId) {
        ensureCollectionLoaded(item.collectionPinId);
      }
    });
  }

  function loadData() {
    if (!state.owner.globalMetaId) return;
    fetchListings();
    fetchHoldings();
    fetchOwnerCollections();
    fetchPresence();
    fetchOwnerProfile();
    fetchCaRegistry();
  }

  function fetchListings() {
    fetchJson(state.apiBase + '/api/mrc721/market/listings?seller=' + encodeURIComponent(state.owner.globalMetaId) + '&size=50')
      .then(function (body) {
        var raw = extractListData(body);
        if (!raw) return;
        var list = raw.filter(function (item) { return item && isValidPinId(item.itemPinId); });
        state.listings = list;
        for (var i = 0; i < list.length; i += 1) {
          var seller = list[i] && list[i].seller;
          if (seller) {
            if (!state.owner.name && seller.name) {
              state.owner.name = cleanText(seller.name, 80);
              state.issuerNamesByMetaId[state.owner.globalMetaId] = state.owner.name;
            }
            if (!state.owner.avatar && seller.avatar) {
              state.owner.avatar = extractReferenceString(seller.avatar);
            }
          }
        }
        recomputeHoldings();
        discoverCollectionsFromItems(list);
        renderOwner();
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
        var normalized = [];
        var byPin = {};
        raw.forEach(function (entry) {
          if (!entry || !isValidPinId(entry.itemPinId || entry.pinId)) return;
          var item = normalizeHoldingItem(entry);
          normalized.push(item);
          byPin[item.itemPinId.toLowerCase()] = item;
        });
        state.itemsByPinId = byPin;
        state.rawHoldings = normalized;
        recomputeHoldings();
        discoverCollectionsFromItems(normalized);
        renderGrid();
      })
      .catch(function () { /* offline snapshot stays */ });
  }

  function fetchOwnerCollections() {
    fetchJson(state.apiBase + '/api/mrc721/address/collection?globalMetaId=' + encodeURIComponent(state.owner.globalMetaId))
      .then(function (body) {
        if (!envelopeOk(body)) return;
        var data = body.data;
        var raw = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
        raw.forEach(indexCollectionRecord);
        renderGrid();
      })
      .catch(function () { /* optional collection enrichment */ });
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
        var avatar = extractReferenceString(profile.avatar) || extractReferenceString(identity.avatar);
        var bio = cleanText(profile.bio, 200);
        if (name) {
          state.owner.name = name;
          state.issuerNamesByMetaId[state.owner.globalMetaId] = name;
        }
        if (avatar) state.owner.avatar = avatar;
        if (bio) state.owner.bio = bio;
        renderOwner();
        renderGrid();
      })
      .catch(function () { /* keep config/listing owner info */ });
  }

  function fetchCaRegistry() {
    fetchJson(state.apiBase + '/api/mrc721/ca/registry')
      .then(function (body) {
        var data = body && body.data;
        var collections = data && Array.isArray(data.collections) ? data.collections : [];
        var set = {};
        var titles = {};
        collections.forEach(function (entry) {
          if (!entry || !isValidPinId(entry.collectionPinId)) return;
          var key = entry.collectionPinId.toLowerCase();
          set[key] = true;
          if (entry.displayTitle) titles[key] = cleanText(entry.displayTitle, 80);
        });
        state.caSet = set;
        state.caTitleByPinId = titles;
        renderGrid();
      })
      .catch(function () { /* CA enrichment optional */ });
  }

  /* ---------- computed presentation helpers ---------- */

  function computeShopTitle() {
    var configured = cleanText(state.config && state.config.shopName, 80);
    if (configured && !LEGACY_SHOP_NAME_RE.test(configured)) {
      return configured;
    }
    var ownerLabel = cleanText(state.owner.name, 60) || shortMetaId(state.owner.globalMetaId);
    if (ownerLabel) return ownerLabel + t('shopTitleSuffix');
    return t('shopTitleFallback');
  }

  function computeShopSlogan() {
    var configured = cleanText(state.config && state.config.slogan, 200);
    if (configured && !LEGACY_SLOGAN_RE.test(configured)) {
      return configured;
    }
    if (state.owner.bio && !LEGACY_SLOGAN_RE.test(state.owner.bio)) {
      return state.owner.bio;
    }
    return t('defaultSlogan');
  }

  function resolveItemPresentation(item) {
    var pinKey = String(item.itemPinId || '').toLowerCase();
    var holdingExtra = state.itemsByPinId[pinKey] || null;
    var metaObj = parseJsonObject(item.metadata || (holdingExtra && holdingExtra.metadata));
    var colPin = cleanText(item.collectionPinId || (holdingExtra && holdingExtra.collectionPinId), 90).toLowerCase();
    var colSlug = cleanText(item.collectionName || (holdingExtra && holdingExtra.collectionName), 80).toLowerCase();
    var col = (colPin && state.collectionsByPinId[colPin]) || (colSlug && state.collectionsBySlug[colSlug]) || null;

    var caVerified = item.caVerified === true
      || Boolean(holdingExtra && holdingExtra.caVerified === true)
      || Boolean(col && col.caVerified === true)
      || Boolean(colPin && state.caSet[colPin] === true);

    var albumTitle = cleanText(
      item.collectionDisplayTitle
      || (colPin && state.caTitleByPinId[colPin])
      || (col && (col.displayTitle || col.name))
      || item.collectionName
      || (holdingExtra && holdingExtra.collectionName)
      || (col && col.collectionName),
      80
    ) || t('unknownAlbum');

    var serialNum = typeof item.itemNumber === 'number'
      ? item.itemNumber
      : (holdingExtra && typeof holdingExtra.itemNumber === 'number' ? holdingExtra.itemNumber : null);
    var totalSupply = typeof item.totalSupply === 'number'
      ? item.totalSupply
      : (col && typeof col.totalSupply === 'number' && col.totalSupply > 0 ? col.totalSupply : null);

    var editionText = '';
    if (metaObj && typeof metaObj.edition === 'string' && cleanText(metaObj.edition, 32)) {
      var rawEd = cleanText(metaObj.edition, 32);
      editionText = rawEd.charAt(0) === '#' ? rawEd : '#' + rawEd;
    } else if (serialNum != null && totalSupply != null && totalSupply > 0) {
      editionText = '#' + String(serialNum) + ' / ' + totalSupply.toLocaleString('en-US');
    } else if (serialNum != null) {
      editionText = '#' + String(serialNum);
    } else if (item.tokenIndex != null) {
      editionText = '#' + String(item.tokenIndex);
    }

    var createMetaId = cleanText(
      item.issuerMetaId || (holdingExtra && holdingExtra.issuerMetaId) || (col && col.createMetaId),
      80
    ).toLowerCase();
    var createAddress = cleanText(
      item.issuerAddress || (holdingExtra && holdingExtra.issuerAddress) || (col && col.createAddress),
      80
    );
    var issuerText = cleanText(
      item.issuerName
      || (holdingExtra && holdingExtra.issuerName)
      || (createMetaId && state.issuerNamesByMetaId[createMetaId])
      || (metaObj && metaObj.issuer),
      60
    ) || shortMetaId(createMetaId) || shortAddress(createAddress) || t('unknownIssuer');

    var coverRef = item.cover
      || item.image
      || (holdingExtra && holdingExtra.cover)
      || (metaObj && (metaObj.cover || metaObj.image))
      || '';

    var rawName = cleanText(
      item.itemName || item.name || (holdingExtra && holdingExtra.itemName) || (metaObj && metaObj.title),
      120
    );
    var name = rawName
      ? rawName.replace(/^(.+?)\s*-\s*\1\s*-\s*/i, '$1 - ')
      : '#' + String(item.itemPinId).slice(-6);

    return {
      name: name,
      albumTitle: albumTitle,
      editionText: editionText,
      issuerText: issuerText,
      caVerified: caVerified,
      coverCandidates: buildImageCandidates(coverRef, 'cover')
    };
  }

  /* ---------- rendering ---------- */

  function renderStatic() {
    $('tab-listings-label').textContent = t('tabListings');
    $('tab-holdings-label').textContent = t('tabHoldings');
    $('btn-add-friend').textContent = t('addFriend');
    $('btn-message').textContent = t('message');
    $('owner-id').title = t('copyIdTitle');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.documentElement.lang = state.lang === 'zh' ? 'zh' : 'en';
    $('btn-lang').textContent = state.lang === 'zh' ? 'EN' : '中文';
  }

  function renderOwner() {
    var owner = state.owner;
    var title = computeShopTitle();
    $('shop-title').textContent = title;
    document.title = title;

    var displayOwner = owner.name || shortMetaId(owner.globalMetaId) || '…';
    $('owner-name').textContent = displayOwner;
    $('owner-id').textContent = shortMetaId(owner.globalMetaId);
    $('owner-avatar-fallback').textContent = monogramOf(owner.name || title);

    var slogan = computeShopSlogan();
    $('shop-slogan').textContent = slogan;
    $('shop-slogan').hidden = !slogan;

    bindImageWithFallback($('owner-avatar'), $('owner-avatar-fallback'), owner.avatar, 'avatar');
    renderPresence();
  }

  function renderPresence() {
    var dot = $('owner-presence');
    dot.className = 'presence-dot ' + (state.presence === 'online' ? 'presence-online' : 'presence-unknown');
    dot.title = state.presence === 'online' ? t('presenceOnline') : t('presenceOff');
  }

  function cardHtml(item, kind) {
    var info = resolveItemPresentation(item);
    var firstCoverUrl = info.coverCandidates.length ? info.coverCandidates[0] : '';
    var candidatesAttr = info.coverCandidates.length > 1
      ? ' data-fallbacks="' + escapeHtml(info.coverCandidates.slice(1).join('|')) + '"'
      : '';

    var priceMe = kind === 'listing' && item.prices && item.prices.me ? formatMe(item.prices.me.amountMilli) : '';
    var priceCny = kind === 'listing' && item.prices && item.prices.fiat ? formatCny(item.prices.fiat.amountCents) : '';
    var tokens = kind === 'listing' ? sanitizeTokenPrices(item) : [];
    var tokenPillsHtml = tokens.map(function (tok) {
      return '<span class="price-token" data-asset-key="' + escapeHtml(tok.assetKey) + '">' + escapeHtml(formatTokenLabel(tok)) + '</span>';
    }).join('');

    var actionsHtml = '';
    if (kind === 'listing') {
      if (item.prices && item.prices.me) {
        actionsHtml += '<button type="button" class="btn btn-accent btn-buy-primary" data-action="buy_me" data-item-pin="' + escapeHtml(item.itemPinId) + '" data-kind="listing">'
          + escapeHtml(t('buyWithMe'))
          + '</button>';
      }
      tokens.forEach(function (tok) {
        var tokBtnCls = (item.prices && item.prices.me) ? 'btn btn-token btn-buy-primary' : 'btn btn-accent btn-buy-primary';
        actionsHtml += '<button type="button" class="' + tokBtnCls + '" data-action="buy_token" data-item-pin="' + escapeHtml(item.itemPinId) + '" data-kind="listing" data-payment-asset-key="' + escapeHtml(tok.assetKey) + '">'
          + escapeHtml(t('buyWithTokenPrefix') + formatTokenLabel(tok) + t('buyWithTokenSuffix'))
          + '</button>';
      });
      if (item.negotiable === true) {
        actionsHtml += '<button type="button" class="btn btn-ghost btn-negotiate" data-action="negotiate" data-item-pin="' + escapeHtml(item.itemPinId) + '" data-kind="listing">'
          + escapeHtml(t('negotiate'))
          + '</button>';
      }
    } else {
      actionsHtml += '<button type="button" class="btn btn-secondary btn-inquire" data-action="inquire_unlisted" data-item-pin="' + escapeHtml(item.itemPinId) + '" data-kind="holding">'
        + escapeHtml(t('inquire'))
        + '</button>';
    }

    return ''
      + '<article class="item-card" data-item-pin="' + escapeHtml(item.itemPinId) + '" data-kind="' + escapeHtml(kind) + '">'
      + '<div class="item-media">'
      + (firstCoverUrl
        ? '<img class="item-cover" src="' + escapeHtml(firstCoverUrl) + '"' + candidatesAttr + ' alt="' + escapeHtml(info.name) + '" decoding="async" />'
        : '')
      + '<div class="item-cover-fallback"' + (firstCoverUrl ? ' hidden' : '') + '>'
      + '<span class="fallback-monogram">' + escapeHtml(monogramOf(info.name)) + '</span>'
      + '<span class="fallback-caption">' + escapeHtml(info.albumTitle) + '</span>'
      + '</div>'
      + (info.editionText ? '<span class="media-badge-serial mono">' + escapeHtml(info.editionText) + '</span>' : '')
      + (info.caVerified ? '<span class="media-badge-verified">✔ ' + escapeHtml(t('caVerified')) + '</span>' : '')
      + '</div>'
      + '<div class="item-body">'
      + '<div class="item-album-row">'
      + '<span class="item-album" title="' + escapeHtml(info.albumTitle) + '">' + escapeHtml(info.albumTitle) + '</span>'
      + '</div>'
      + '<h2 class="item-name" title="' + escapeHtml(info.name) + '">' + escapeHtml(info.name) + '</h2>'
      + '<div class="item-meta-list">'
      + '<div class="item-meta-row">'
      + '<span class="item-meta-label">' + escapeHtml(t('issuerLabel')) + '</span>'
      + '<span class="item-meta-value" title="' + escapeHtml(info.issuerText) + '">' + escapeHtml(info.issuerText) + '</span>'
      + '</div>'
      + '</div>'
      + '<div class="item-price-block">'
      + ((priceMe || priceCny || tokenPillsHtml)
        ? '<div class="price-primary-group">'
          + (priceMe ? '<span class="price-me">' + escapeHtml(priceMe) + '</span>' : '')
          + (priceCny ? '<span class="price-cny">' + escapeHtml(priceCny) + '</span>' : '')
          + '</div>'
          + (tokenPillsHtml ? '<div class="token-pills">' + tokenPillsHtml + '</div>' : '')
        : '<span class="price-unlisted">' + escapeHtml(t('unlistedPrice')) + '</span>')
      + '</div>'
      + '<div class="item-actions">' + actionsHtml + '</div>'
      + '</div>'
      + '</article>';
  }

  function wireGridImageFallbacks(container) {
    if (!container) return;
    var imgs = container.querySelectorAll('img.item-cover');
    imgs.forEach(function (imgEl) {
      var rawFallbacks = imgEl.getAttribute('data-fallbacks') || '';
      var queue = rawFallbacks ? rawFallbacks.split('|').filter(Boolean) : [];
      var cursor = 0;
      var fallbackEl = imgEl.nextElementSibling;
      imgEl.onload = function () {
        imgEl.hidden = false;
        if (fallbackEl) fallbackEl.hidden = true;
      };
      imgEl.onerror = function () {
        if (cursor < queue.length) {
          var nextUrl = queue[cursor];
          cursor += 1;
          imgEl.src = nextUrl;
        } else {
          imgEl.onerror = null;
          imgEl.hidden = true;
          if (fallbackEl) fallbackEl.hidden = false;
        }
      };
    });
  }

  function renderGrid() {
    var listingsGrid = $('listings-grid');
    var holdingsGrid = $('holdings-grid');
    $('tab-listings-count').textContent = String(state.listings.length);
    $('tab-holdings-count').textContent = String(state.holdings.length);

    listingsGrid.innerHTML = state.listings.map(function (item) { return cardHtml(item, 'listing'); }).join('');
    holdingsGrid.innerHTML = state.holdings.map(function (item) { return cardHtml(item, 'holding'); }).join('');
    wireGridImageFallbacks(listingsGrid);
    wireGridImageFallbacks(holdingsGrid);

    var emptyEl = $('empty-state');
    var activeTab = $('panel-listings').hidden ? 'holdings' : 'listings';
    var isEmpty = activeTab === 'listings' ? state.listings.length === 0 : state.holdings.length === 0;
    emptyEl.hidden = !isEmpty;
    emptyEl.textContent = activeTab === 'listings' ? t('emptyListings') : t('emptyHoldings');
  }

  function findItem(pinId, kind) {
    var pool = kind === 'holding' ? state.holdings : state.listings;
    for (var i = 0; i < pool.length; i += 1) {
      if (pool[i].itemPinId === pinId) return pool[i];
    }
    return null;
  }

  /* ---------- commerce actions ---------- */

  function askTwin(item, mode, selectedToken) {
    var prices = item.prices || {};
    var seller = item.seller || {};
    var info = resolveItemPresentation(item);
    var payload = {
      itemPinId: String(item.itemPinId),
      collectionId: isValidPinId(item.collectionPinId) ? String(item.collectionPinId).toLowerCase() : undefined,
      collectionName: cleanText(item.collectionName || info.albumTitle, 80),
      itemName: cleanText(item.itemName || item.name || info.name, 120) || '#' + String(item.itemPinId).slice(-6),
      tokenIndex: item.itemNumber != null ? String(item.itemNumber) : (item.tokenIndex != null ? String(item.tokenIndex) : undefined),
      sellerGlobalMetaId: state.owner.globalMetaId,
      sellerAddress: seller.address && typeof seller.address === 'string' ? seller.address : undefined,
      sellerName: cleanText(state.owner.name, 80) || undefined,
      priceMeMilli: prices.me && typeof prices.me.amountMilli === 'number' ? prices.me.amountMilli : undefined,
      priceCnyCents: prices.fiat && typeof prices.fiat.amountCents === 'number' ? prices.fiat.amountCents : undefined,
      paymentAssetKey: selectedToken && selectedToken.assetKey ? selectedToken.assetKey : undefined,
      paymentSymbol: selectedToken && selectedToken.symbol ? selectedToken.symbol : undefined,
      paymentAmountDisplay: selectedToken && selectedToken.amountDisplay ? selectedToken.amountDisplay : undefined,
      paymentAmountBase: selectedToken && selectedToken.amountBase ? selectedToken.amountBase : undefined,
      mode: mode,
      shopMetaAppPinId: isValidPinId(item.shopMetaAppPinId) ? String(item.shopMetaAppPinId).toLowerCase() : undefined
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
    AgentBrowser.request({ method: 'browser.privateChat.compose', params: {} }).catch(function () { });
  }

  function openPromoPack() {
    if (!state.isHost) return;
    var featured = state.listings.slice(0, 3).map(function (item) {
      return {
        itemPinId: String(item.itemPinId),
        itemName: cleanText(item.itemName, 80),
        coverUrl: resolveImageUrl(item.cover, 'cover') || undefined,
        priceMeMilli: item.prices && item.prices.me ? item.prices.me.amountMilli : undefined,
        priceCnyCents: item.prices && item.prices.fiat ? item.prices.fiat.amountCents : undefined
      };
    });
    AgentBrowser.request({
      method: 'browser.commerce.openPromoPack',
      params: {
        shopOwnerGlobalMetaId: state.owner.globalMetaId,
        shopOwnerName: cleanText(state.owner.name, 80) || undefined,
        shopSlogan: computeShopSlogan() || undefined,
        featuredItems: featured
      }
    }).catch(function () { /* forbidden for non-owner or unsupported */ });
  }

  /* ---------- external-browser fallback guide ---------- */

  function openGuide(payload) {
    var ownerLabel = state.owner.name ? '@' + state.owner.name + ' (' + state.owner.globalMetaId + ')' : state.owner.globalMetaId;
    var phrase = state.lang === 'zh'
      ? '去 ' + ownerLabel + ' 的小店帮我看看' + (payload.itemName ? '「' + payload.itemName + '」' : '')
      : 'Check ' + ownerLabel + '\'s shop for me' + (payload.itemName ? ' — ' + payload.itemName : '');
    $('guide-command').textContent = phrase;
    $('guide-copy').textContent = t('guideCopy');
    $('guide-copy').onclick = function () {
      try {
        navigator.clipboard.writeText(phrase).then(function () {
          $('guide-copy').textContent = t('copied');
        }, function () { /* clipboard denied */ });
      } catch (e) { /* clipboard unavailable */ }
    };
    $('guide-mask').hidden = false;
    $('guide-card').hidden = false;
  }

  function closeGuide() {
    $('guide-mask').hidden = true;
    $('guide-card').hidden = true;
  }

  /* ---------- events ---------- */

  function wireEvents() {
    $('tab-listings').addEventListener('click', function () { switchTab('listings'); });
    $('tab-holdings').addEventListener('click', function () { switchTab('holdings'); });
    $('guide-close').addEventListener('click', closeGuide);
    $('guide-mask').addEventListener('click', closeGuide);
    $('btn-add-friend').addEventListener('click', openAddFriend);
    $('btn-message').addEventListener('click', openPrivateChat);
    $('btn-promo-pack').addEventListener('click', openPromoPack);

    $('owner-id').addEventListener('click', function () {
      if (!state.owner.globalMetaId) return;
      try {
        navigator.clipboard.writeText(state.owner.globalMetaId).then(function () {
          $('owner-id').textContent = t('copied');
          if (state.idCopiedTimer) clearTimeout(state.idCopiedTimer);
          state.idCopiedTimer = setTimeout(function () {
            $('owner-id').textContent = shortMetaId(state.owner.globalMetaId);
          }, 1400);
        }, function () {});
      } catch (e) { /* ignore */ }
    });

    $('btn-lang').addEventListener('click', function () {
      state.lang = state.lang === 'zh' ? 'en' : 'zh';
      renderStatic();
      renderOwner();
      renderGrid();
    });

    $('shop-main').addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      var pinId = btn.getAttribute('data-item-pin');
      var kind = btn.getAttribute('data-kind');
      var item = findItem(pinId, kind);
      if (!item) return;
      if (action === 'buy_token') {
        var assetKey = btn.getAttribute('data-payment-asset-key') || '';
        var tokens = sanitizeTokenPrices(item);
        var selected = null;
        for (var i = 0; i < tokens.length; i += 1) {
          if (tokens[i].assetKey === assetKey) {
            selected = tokens[i];
            break;
          }
        }
        if (selected) askTwin(item, 'buy_token', selected);
        return;
      }
      askTwin(item, action);
    });
  }

  function switchTab(which) {
    var listings = which === 'listings';
    $('panel-listings').hidden = !listings;
    $('panel-holdings').hidden = listings;
    $('tab-listings').className = 'tab' + (listings ? ' active' : '');
    $('tab-holdings').className = 'tab' + (listings ? '' : ' active');
    $('tab-listings').setAttribute('aria-selected', listings ? 'true' : 'false');
    $('tab-holdings').setAttribute('aria-selected', listings ? 'false' : 'true');
    renderGrid();
  }

  wireEvents();
  boot();
})();
