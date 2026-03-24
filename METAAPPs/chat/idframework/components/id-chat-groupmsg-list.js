/**
 * id-chat-groupmsg-list
 * Unified message list for group/private chats.
 * Single data source: Alpine.store('chat')
 */
import { getSimpleTalkStore } from '../stores/chat/simple-talk.js';

class IdChatGroupmsgList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._lastSignature = '';
    this._cryptoStore = null;
    this._cryptoReady = false;
    this._highlightTimer = null;
    this._onChatUpdated = this._handleChatUpdated.bind(this);
    this._onBubbleToTimestamp = this._handleBubbleToTimestamp.bind(this);
    this._onBubbleMentionClick = this._handleBubbleMentionClick.bind(this);
    this._onScroll = this._handleScroll.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove = this._handleTouchMove.bind(this);
    this._onScrollToBottomClick = this._handleScrollToBottomClick.bind(this);
    this._isLoadingOlder = false;
    this._noMoreOlderByConversation = {};
    this._stalledOlderLoadsByConversation = {};
    this._pendingScrollRestore = null;
    this._recentRestoreAnchor = null;
    this._nextAllowedLoadAt = 0;
    this._topEdgeArmed = true;
    this._lastScrollTop = Number.MAX_SAFE_INTEGER;
    this._touchStartY = 0;
    this._wheelGestureSeq = 0;
    this._lastWheelEventAt = 0;
    this._touchGestureSeq = 0;
    this._activeTouchGestureToken = '';
    this._lastLoadedGestureToken = '';
    this._lastDownwardIntentAt = 0;
    this._postRestoreStabilizer = null;
    this._lastConversation = '';
    this._lastMaxIndex = 0;
    this._lastOldestIndex = 0;
    this._lastMessageCount = 0;
    this._showScrollToBottomButton = false;
    this._pendingForceBottomConversation = '';
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    document.addEventListener('id:chat:updated', this._onChatUpdated);
    this.addEventListener('bubble-to-timestamp', this._onBubbleToTimestamp);
    this.addEventListener('bubble-mention-click', this._onBubbleMentionClick);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this._handleChatUpdated();
    this._ensureCryptoHelper();
  }

  disconnectedCallback() {
    document.removeEventListener('id:chat:updated', this._onChatUpdated);
    this.removeEventListener('bubble-to-timestamp', this._onBubbleToTimestamp);
    this.removeEventListener('bubble-mention-click', this._onBubbleMentionClick);
    this._unbindScroll();
    if (this._highlightTimer) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = null;
    }
    this._unbindScrollToBottomButton();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  _handleLocaleChanged() {
    this._lastSignature = '';
    this._handleChatUpdated();
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

  _snapshot() {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') {
      return {
        ready: false,
        currentConversation: '',
        conversationType: '1',
        messages: [],
        isLoading: false,
        error: '',
        selfGlobalMetaId: '',
        selfMetaId: '',
      };
    }

    const chatStore = Alpine.store('chat');
    const walletStore = Alpine.store('wallet');
    const userStore = Alpine.store('user');
    if (!chatStore) {
      return {
        ready: false,
        currentConversation: '',
        conversationType: '1',
        messages: [],
        isLoading: false,
        error: '',
        selfGlobalMetaId: '',
        selfMetaId: '',
      };
    }

    const currentConversation = String(chatStore.currentConversation || '');
    const messages = currentConversation
      ? (Array.isArray(chatStore.messages[currentConversation]) ? chatStore.messages[currentConversation] : [])
      : [];

    return {
      ready: true,
      currentConversation: currentConversation,
      conversationType: String(chatStore.currentConversationType || '1'),
      messages: messages,
      isLoading: !!chatStore.isLoading,
      error: String(chatStore.error || ''),
      selfGlobalMetaId: String((walletStore && walletStore.globalMetaId) || ''),
      selfMetaId: String(
        (userStore && userStore.user && (userStore.user.metaid || userStore.user.metaId)) || ''
      ),
    };
  }

  _signature(snapshot) {
    const first = snapshot.messages.length ? snapshot.messages[0] : null;
    const last = snapshot.messages.length ? snapshot.messages[snapshot.messages.length - 1] : null;
    return [
      snapshot.ready ? '1' : '0',
      snapshot.currentConversation,
      snapshot.conversationType,
      snapshot.isLoading ? '1' : '0',
      this._isLoadingOlder ? '1' : '0',
      snapshot.error,
      String(snapshot.messages.length),
      String(first && (first.id || first.pinId || first.txId || '')),
      String(first && (first.index || 0)),
      String(last && (last.id || last.pinId || last.txId || '')),
      String(last && (last.index || 0)),
    ].join('|');
  }

  _getMaxIndex(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    let maxIndex = 0;
    rows.forEach((row) => {
      const index = Number(row && row.index ? row.index : 0);
      if (index > maxIndex) maxIndex = index;
    });
    return maxIndex;
  }

  _getMinPositiveIndex(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    let minIndex = Number.MAX_SAFE_INTEGER;
    rows.forEach((row) => {
      const index = Number(row && row.index ? row.index : 0);
      if (index > 0 && index < minIndex) minIndex = index;
    });
    return minIndex === Number.MAX_SAFE_INTEGER ? 0 : minIndex;
  }

  _getOldestIndex(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    if (!rows.length) return 0;
    const firstIndex = Number(rows[0] && rows[0].index ? rows[0].index : 0);
    if (Number.isFinite(firstIndex) && firstIndex > 0) return firstIndex;
    return this._getMinPositiveIndex(rows);
  }

  _captureScrollMetrics() {
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) {
      return { top: 0, height: 0, clientHeight: 0, nearBottom: true };
    }
    const top = Number(container.scrollTop || 0);
    const height = Number(container.scrollHeight || 0);
    const clientHeight = Number(container.clientHeight || 0);
    const nearBottom = (height - (top + clientHeight)) < 120;
    return { top, height, clientHeight, nearBottom };
  }

  _postRenderScrollAdjust(snapshot, beforeMetrics, previousConversation, previousMaxIndex, previousOldestIndex = 0) {
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) return;

    if (this._pendingScrollRestore && this._pendingScrollRestore.conversation === snapshot.currentConversation) {
      const pending = this._pendingScrollRestore;
      const currentOldestIndex = this._getOldestIndex(snapshot.messages);
      const currentMaxIndex = this._getMaxIndex(snapshot.messages);
      const hasOlderLoaded =
        !!currentOldestIndex &&
        currentOldestIndex > 0 &&
        currentOldestIndex < Number(pending.oldestIndex || 0);
      const listShapeChanged = Number(snapshot.messages.length || 0) !== Number(pending.messageCount || 0);
      const staleRestoreWithoutOlderProgress =
        !!listShapeChanged &&
        (!currentOldestIndex || currentOldestIndex >= Number(pending.oldestIndex || 0));

      if (hasOlderLoaded || listShapeChanged) {
        if (hasOlderLoaded) {
          this._restoreScrollPosition(container, pending);
          this._pendingScrollRestore = null;
          this._syncScrollToBottomButton(container, snapshot);
          return;
        }
        if (staleRestoreWithoutOlderProgress) {
          this._debugTrace('scroll-drop-stale-pending-restore', {
            pendingOldestIndex: Number(pending.oldestIndex || 0),
            currentOldestIndex: Number(currentOldestIndex || 0),
            currentMaxIndex: Number(currentMaxIndex || 0),
            previousMaxIndex: Number(previousMaxIndex || 0),
            pendingMessageCount: Number(pending.messageCount || 0),
            currentMessageCount: Number(snapshot.messages.length || 0),
          });
          this._pendingScrollRestore = null;
        } else {
          this._restoreScrollPosition(container, pending);
          this._pendingScrollRestore = null;
          this._syncScrollToBottomButton(container, snapshot);
          return;
        }
      }
      if (this._pendingScrollRestore) {
        this._syncScrollToBottomButton(container, snapshot);
        return;
      }
    }
    this._pendingScrollRestore = null;

    if (!snapshot.currentConversation) {
      this._pendingForceBottomConversation = '';
      this._syncScrollToBottomButton(container, snapshot);
      return;
    }
    if (snapshot.currentConversation === String(this._pendingForceBottomConversation || '').trim()) {
      this._scrollToBottom();
      return;
    }
    if (snapshot.currentConversation !== previousConversation) {
      this._recentRestoreAnchor = null;
      this._postRestoreStabilizer = null;
      this._pendingForceBottomConversation = String(snapshot.currentConversation || '').trim();
      this._debugTrace('scroll-bottom-on-conversation-switch', {
        conversation: String(snapshot.currentConversation || ''),
        previousConversation: String(previousConversation || ''),
      });
      this._scrollToBottom();
      return;
    }

    const currentMaxIndex = this._getMaxIndex(snapshot.messages);
    const currentOldestIndex = this._getOldestIndex(snapshot.messages);
    const unchangedWindow =
      Number(snapshot.messages.length || 0) === Number(this._lastMessageCount || 0) &&
      Number(currentMaxIndex || 0) === Number(previousMaxIndex || 0) &&
      Number(currentOldestIndex || 0) === Number(previousOldestIndex || 0);
    if (unchangedWindow) {
      let keepTop = Math.max(0, Number(beforeMetrics && beforeMetrics.top ? beforeMetrics.top : 0));
      const refined = this._refinePreserveTopWithRecentRestore(container, snapshot, keepTop);
      if (refined && Number.isFinite(Number(refined.top))) {
        keepTop = Math.max(0, Number(refined.top || 0));
        this._debugTrace('scroll-preserve-refined-by-restore', {
          top: keepTop,
          previousTop: Math.max(0, Number(beforeMetrics && beforeMetrics.top ? beforeMetrics.top : 0)),
          source: String(refined.source || 'recent-top'),
          driftDown: Number(refined.driftDown || 0),
          age: Number(refined.age || 0),
          mode: String(refined.mode || ''),
        });
      }
      container.scrollTop = keepTop;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          container.scrollTop = keepTop;
        });
      }
      this._debugTrace('scroll-preserve-unchanged-window', {
        top: keepTop,
        messageCount: Number(snapshot.messages.length || 0),
        currentMaxIndex: Number(currentMaxIndex || 0),
        currentOldestIndex: Number(currentOldestIndex || 0),
      });
      this._armPostRestoreStabilizer(snapshot.currentConversation, keepTop, 640);
      this._syncScrollToBottomButton(container, snapshot);
      return;
    }
    if (currentMaxIndex > previousMaxIndex && beforeMetrics.nearBottom) {
      this._scrollToBottom();
      return;
    }
    this._syncScrollToBottomButton(container, snapshot);
  }

  _refinePreserveTopWithRecentRestore(container, snapshot, keepTop) {
    const recent = this._recentRestoreAnchor;
    if (!recent || !container || !snapshot) return null;
    const conversation = String(snapshot.currentConversation || '').trim();
    if (!conversation || conversation !== String(recent.conversation || '').trim()) return null;
    const appliedAt = Number(recent.appliedAt || 0);
    if (!Number.isFinite(appliedAt) || appliedAt <= 0) return null;
    const age = Date.now() - appliedAt;
    if (age > 1600) return null;

    const baselineTop = Math.max(0, Number(recent.top || 0));
    let preferredTop = baselineTop;
    let source = 'recent-top';
    const anchorKey = String(recent.anchorKey || '').trim();
    const anchorIndex = String(recent.anchorIndex || '').trim();
    const anchorOffset = Number.isFinite(Number(recent.anchorOffset))
      ? Number(recent.anchorOffset)
      : 0;

    let anchorNode = null;
    if (anchorKey) {
      anchorNode = container.querySelector(`[data-msg-key="${anchorKey}"]`);
    }
    if (!anchorNode && anchorIndex) {
      anchorNode = container.querySelector(`[data-msg-index="${anchorIndex}"]`);
    }
    if (anchorNode) {
      const candidateTop = Number(anchorNode.offsetTop || 0) - anchorOffset;
      if (
        Number.isFinite(candidateTop) &&
        candidateTop >= 0 &&
        Math.abs(candidateTop - baselineTop) <= 120
      ) {
        preferredTop = candidateTop;
        source = 'recent-anchor';
      }
    }

    const driftDown = Number(keepTop || 0) - preferredTop;
    if (driftDown <= 10) return null;
    return {
      top: preferredTop,
      source: source,
      driftDown: driftDown,
      age: age,
      mode: String(recent.mode || ''),
    };
  }

  _armPostRestoreStabilizer(conversation, top, ttlMs = 560) {
    const conv = String(conversation || '').trim();
    const targetTop = Math.max(0, Number(top || 0));
    if (!conv || !Number.isFinite(targetTop)) {
      this._postRestoreStabilizer = null;
      return;
    }
    const armedAt = Date.now();
    this._postRestoreStabilizer = {
      conversation: conv,
      top: targetTop,
      armedAt: armedAt,
      until: armedAt + Math.max(180, Number(ttlMs || 560)),
    };
  }

  _applyRestoreStabilizer(container, scrollTop) {
    const stabilizer = this._postRestoreStabilizer;
    if (!stabilizer || !container) return Number(scrollTop || 0);
    const now = Date.now();
    if (now > Number(stabilizer.until || 0)) {
      this._postRestoreStabilizer = null;
      return Number(scrollTop || 0);
    }
    const currentConversation = String(this._lastConversation || '').trim();
    if (currentConversation && currentConversation !== String(stabilizer.conversation || '').trim()) {
      this._postRestoreStabilizer = null;
      return Number(scrollTop || 0);
    }

    const targetTop = Math.max(0, Number(stabilizer.top || 0));
    if (!Number.isFinite(targetTop)) {
      this._postRestoreStabilizer = null;
      return Number(scrollTop || 0);
    }
    const top = Number(scrollTop || 0);
    if (top < targetTop - 24) {
      // User has continued scrolling upward; stop stabilizing.
      this._postRestoreStabilizer = null;
      return top;
    }
    const driftDown = top - targetTop;
    if (driftDown <= 10) return top;

    const sinceDownIntent = now - Number(this._lastDownwardIntentAt || 0);
    if (sinceDownIntent <= 140) {
      // Respect recent explicit downward gesture.
      this._postRestoreStabilizer = null;
      return top;
    }

    container.scrollTop = targetTop;
    this._debugTrace('scroll-stabilize-after-restore', {
      top: top,
      targetTop: targetTop,
      driftDown: driftDown,
      age: now - Number(stabilizer.armedAt || now),
      sinceDownIntent: sinceDownIntent,
    });
    return targetTop;
  }

  _handleChatUpdated() {
    if (!this._cryptoReady) this._ensureCryptoHelper();
    const beforeMetrics = this._captureScrollMetrics();
    const previousConversation = this._lastConversation;
    const previousMaxIndex = this._lastMaxIndex;
    const previousOldestIndex = this._lastOldestIndex;
    const snapshot = this._snapshot();
    const signature = this._signature(snapshot);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;
    this.render(snapshot);
    this._bindScroll();
    this._bindScrollToBottomButton();
    this._postRenderScrollAdjust(snapshot, beforeMetrics, previousConversation, previousMaxIndex, previousOldestIndex);
    this._lastConversation = snapshot.currentConversation;
    this._lastMessageCount = Array.isArray(snapshot.messages) ? snapshot.messages.length : 0;
    this._lastMaxIndex = this._getMaxIndex(snapshot.messages);
    this._lastOldestIndex = this._getOldestIndex(snapshot.messages);
  }

  async _ensureCryptoHelper() {
    if (this._cryptoReady) return;
    try {
      this._cryptoStore = getSimpleTalkStore();
      await this._cryptoStore.init();
      this._cryptoReady = true;
      this._handleChatUpdated();
    } catch (_) {
      this._cryptoReady = false;
    }
  }

  _handleBubbleToTimestamp(event) {
    const detail = event && event.detail ? event.detail : {};
    const targetIndex = Number(detail.index || 0);
    if (!Number.isFinite(targetIndex) || targetIndex <= 0) return;

    const target = this.shadowRoot.querySelector(`[data-msg-index="${String(targetIndex)}"]`);
    if (!target || typeof target.scrollIntoView !== 'function') return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this._highlightMessageNode(target);
  }

  _highlightMessageNode(node) {
    if (!node || !node.classList || typeof node.classList.add !== 'function') return;
    node.classList.add('jump-highlight');
    if (this._highlightTimer) clearTimeout(this._highlightTimer);
    this._highlightTimer = setTimeout(() => {
      if (node && node.classList && typeof node.classList.remove === 'function') {
        node.classList.remove('jump-highlight');
      }
      this._highlightTimer = null;
    }, 1400);
  }

  async _handleBubbleMentionClick(event) {
    const detail = event && event.detail ? event.detail : {};
    const targetGlobalMetaId = String(detail.globalMetaId || '').trim();
    if (!targetGlobalMetaId) return;
    if (this._isMentionNavigationDisabled()) return;

    const idf = (typeof window !== 'undefined' && window.IDFramework) ? window.IDFramework : null;
    if (!idf || typeof idf.dispatch !== 'function') return;

    try {
      await idf.dispatch('selectConversation', {
        metaid: targetGlobalMetaId,
        globalMetaId: targetGlobalMetaId,
        type: '2',
      });
      if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
        document.dispatchEvent(new CustomEvent('id:chat:updated'));
      }
    } catch (_) {
      // ignore mention route errors
    }
  }

  _isMentionNavigationDisabled() {
    if (typeof this.getAttribute !== 'function') return false;
    const attr = this.getAttribute('disable-mention-navigation');
    if (attr == null) return false;
    const value = String(attr).trim().toLowerCase();
    if (!value) return true;
    return !(value === 'false' || value === '0' || value === 'no' || value === 'off');
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _messageDomKey(message) {
    const msg = message && typeof message === 'object' ? message : {};
    const pinId = String(msg.pinId || msg.pin_id || '').trim();
    if (pinId) return `pin:${pinId}`;
    const txId = String(msg.txId || msg.tx_id || '').trim();
    if (txId) return `tx:${txId}`;
    const id = String(msg.id || '').trim();
    if (id) return `id:${id}`;
    const index = String(msg.index || '').trim();
    const timestamp = String(msg.timestamp || '').trim();
    return `idx:${index}|ts:${timestamp}`;
  }

  _bindScroll() {
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) return;
    container.removeEventListener('scroll', this._onScroll);
    container.removeEventListener('wheel', this._onWheel);
    container.removeEventListener('touchstart', this._onTouchStart);
    container.removeEventListener('touchmove', this._onTouchMove);
    container.addEventListener('scroll', this._onScroll, { passive: true });
    container.addEventListener('wheel', this._onWheel, { passive: true });
    container.addEventListener('touchstart', this._onTouchStart, { passive: true });
    container.addEventListener('touchmove', this._onTouchMove, { passive: true });
  }

  _unbindScroll() {
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) return;
    container.removeEventListener('scroll', this._onScroll);
    container.removeEventListener('wheel', this._onWheel);
    container.removeEventListener('touchstart', this._onTouchStart);
    container.removeEventListener('touchmove', this._onTouchMove);
  }

  _bindScrollToBottomButton() {
    const button = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.scroll-to-bottom-button')
      : null;
    if (!button || typeof button.addEventListener !== 'function') return;
    if (typeof button.removeEventListener === 'function') {
      button.removeEventListener('click', this._onScrollToBottomClick);
    }
    button.addEventListener('click', this._onScrollToBottomClick);
  }

  _unbindScrollToBottomButton() {
    const button = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.scroll-to-bottom-button')
      : null;
    if (!button || typeof button.removeEventListener !== 'function') return;
    button.removeEventListener('click', this._onScrollToBottomClick);
  }

  _captureTopAnchor(container) {
    if (!container || !container.querySelectorAll) return null;
    const nodes = Array.from(container.querySelectorAll('id-chat-bubble[data-msg-index]'));
    if (!nodes.length) return null;
    const hostRect = container.getBoundingClientRect ? container.getBoundingClientRect() : null;
    if (!hostRect) return null;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const idx = String(node.getAttribute ? (node.getAttribute('data-msg-index') || '') : '').trim();
      if (!idx) continue;
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!rect) continue;
      if (rect.bottom >= hostRect.top + 2) {
        return {
          index: idx,
          key: String(node.getAttribute ? (node.getAttribute('data-msg-key') || '') : '').trim(),
          offset: Math.max(0, rect.top - hostRect.top),
        };
      }
    }
    const first = nodes[0];
    return {
      index: String(first.getAttribute ? (first.getAttribute('data-msg-index') || '') : '').trim(),
      key: String(first.getAttribute ? (first.getAttribute('data-msg-key') || '') : '').trim(),
      offset: 0,
    };
  }

  _restoreScrollPosition(container, pending) {
    if (!container || !pending) return;
    const apply = () => {
      if (typeof container.isConnected === 'boolean' && !container.isConnected) return;
      const currentHeight = Number(container.scrollHeight || 0);
      if (currentHeight <= 0 && Number(pending.height || 0) > 0) return;
      let restored = false;
      const anchorKey = String(pending.anchorKey || '').trim();
      const anchorIndex = String(pending.anchorIndex || '').trim();
      const delta = currentHeight - Number(pending.height || 0);
      const expectedTop = Math.max(0, Number(pending.top || 0) + delta);
      let anchorNode = null;
      let candidateTop = null;
      let restoreMode = 'delta';
      let matchedByKey = false;
      if (anchorKey) {
        anchorNode = container.querySelector(`[data-msg-key="${anchorKey}"]`);
        matchedByKey = !!anchorNode;
      }
      if (!anchorNode && anchorIndex) {
        anchorNode = container.querySelector(`[data-msg-index="${anchorIndex}"]`);
      }
      if (anchorNode) {
        const anchorOffsetTop = Number(anchorNode.offsetTop || 0);
        candidateTop = anchorOffsetTop - Number(pending.anchorOffset || 0);
        if (candidateTop >= 0) {
          if (matchedByKey) {
            container.scrollTop = candidateTop;
            restored = true;
            restoreMode = 'anchor';
          } else {
            const skew = Math.abs(candidateTop - expectedTop);
            const suspiciousAnchor =
              Math.abs(delta) >= 40 &&
              skew > 120;
            if (!suspiciousAnchor) {
              container.scrollTop = candidateTop;
              restored = true;
              restoreMode = 'anchor';
            } else {
              restoreMode = 'anchor-rejected';
            }
          }
        }
      }
      if (!restored) {
        container.scrollTop = expectedTop;
      }
      this._syncScrollToBottomButton(container);
      this._rememberRecentRestore(pending, Number(container.scrollTop || 0), restoreMode);
      this._debugTrace('scroll-restore', {
        mode: restoreMode,
        anchorKey: anchorKey,
        anchorIndex: anchorIndex,
        candidateTop: Number.isFinite(Number(candidateTop)) ? Number(candidateTop) : null,
        expectedTop: expectedTop,
        delta: delta,
        pendingTop: Number(pending.top || 0),
        pendingHeight: Number(pending.height || 0),
        scrollHeight: Number(container.scrollHeight || 0),
        finalTop: Number(container.scrollTop || 0),
      });
    };

    apply();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => apply());
    }
    if (typeof setTimeout === 'function') {
      setTimeout(() => apply(), 90);
    }
  }

  _rememberRecentRestore(pending, finalTop, restoreMode) {
    const pendingObj = pending && typeof pending === 'object' ? pending : {};
    const conversation = String(
      pendingObj.conversation || (this._snapshot && this._snapshot().currentConversation) || ''
    ).trim();
    if (!conversation) return;
    const top = Math.max(0, Number(finalTop || 0));
    if (!Number.isFinite(top)) return;
    const anchorOffset = Number.isFinite(Number(pendingObj.anchorOffset))
      ? Number(pendingObj.anchorOffset)
      : 0;

    this._recentRestoreAnchor = {
      conversation: conversation,
      top: top,
      anchorKey: String(pendingObj.anchorKey || '').trim(),
      anchorIndex: String(pendingObj.anchorIndex || '').trim(),
      anchorOffset: anchorOffset,
      mode: String(restoreMode || ''),
      appliedAt: Date.now(),
    };
    this._armPostRestoreStabilizer(conversation, top, 560);
  }

  _canLoadOlderNow() {
    const now = Date.now();
    return !this._isLoadingOlder && now >= Number(this._nextAllowedLoadAt || 0);
  }

  _scheduleLoadCooldown(ms = 360) {
    const delay = Number.isFinite(Number(ms)) ? Number(ms) : 360;
    this._nextAllowedLoadAt = Date.now() + Math.max(120, delay);
  }

  _refreshTopEdgeArm(scrollTop) {
    const top = Number(scrollTop || 0);
    if (top > 120) this._topEdgeArmed = true;
  }

  _distanceFromBottom(container) {
    if (!container) return 0;
    const top = Math.max(0, Number(container.scrollTop || 0));
    const height = Math.max(0, Number(container.scrollHeight || 0));
    const clientHeight = Math.max(0, Number(container.clientHeight || 0));
    return Math.max(0, height - (top + clientHeight));
  }

  _scrollToBottomButtonThreshold(container) {
    const clientHeight = Math.max(0, Number(container && container.clientHeight ? container.clientHeight : 0));
    if (clientHeight <= 0) return 180;
    return Math.max(120, Math.min(320, Math.floor(clientHeight * 0.32)));
  }

  _shouldShowScrollToBottomButton(container, forcedSnapshot) {
    if (!container) return false;
    const snapshot = forcedSnapshot || this._snapshot();
    if (!snapshot || !snapshot.currentConversation) return false;
    if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return false;
    const distance = this._distanceFromBottom(container);
    return distance > this._scrollToBottomButtonThreshold(container);
  }

  _syncScrollToBottomButton(forcedContainer, forcedSnapshot) {
    const container = forcedContainer || (this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null);
    const shouldShow = this._shouldShowScrollToBottomButton(container, forcedSnapshot);
    this._showScrollToBottomButton = !!shouldShow;

    const button = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.scroll-to-bottom-button')
      : null;
    if (!button) return;

    const hidden = !shouldShow;
    button.hidden = hidden;
    if (button.classList && typeof button.classList.toggle === 'function') {
      button.classList.toggle('is-hidden', hidden);
    }
  }

  _debugEnabled() {
    return typeof window !== 'undefined' && !!window.__IDCHAT_SCROLL_DEBUG__;
  }

  _debugTrace(eventName, payload) {
    if (!this._debugEnabled()) return;
    const trace = {
      ts: Date.now(),
      event: String(eventName || 'unknown'),
      conversation: String(this._snapshot().currentConversation || ''),
      ...((payload && typeof payload === 'object') ? payload : {}),
    };
    if (!Array.isArray(window.__IDCHAT_SCROLL_TRACE__)) {
      window.__IDCHAT_SCROLL_TRACE__ = [];
    }
    window.__IDCHAT_SCROLL_TRACE__.push(trace);
    if (window.__IDCHAT_SCROLL_TRACE__.length > 1500) {
      window.__IDCHAT_SCROLL_TRACE__.splice(0, window.__IDCHAT_SCROLL_TRACE__.length - 1500);
    }
    if (window.__IDCHAT_SCROLL_DEBUG_CONSOLE__ && typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[id-chat-groupmsg-list]', trace);
    }
  }

  _nextWheelGestureToken(deltaY) {
    const dy = Number(deltaY || 0);
    if (dy >= 0) return '';
    const now = Date.now();
    const gap = now - Number(this._lastWheelEventAt || 0);
    if (!this._wheelGestureSeq || gap > 320) {
      this._wheelGestureSeq += 1;
    }
    this._lastWheelEventAt = now;
    return `wheel:${this._wheelGestureSeq}`;
  }

  _nextTouchGestureToken() {
    this._touchGestureSeq += 1;
    this._activeTouchGestureToken = `touch:${this._touchGestureSeq}`;
    return this._activeTouchGestureToken;
  }

  _requestOlderLoad(source, gestureToken) {
    const token = String(gestureToken || '').trim();
    if ((source === 'wheel' || source === 'touch') && token) {
      if (token === this._lastLoadedGestureToken) {
        this._debugTrace('load-skip-same-gesture', { source: source, token: token });
        return;
      }
    }
    if (!this._canLoadOlderNow()) {
      this._debugTrace('load-skip-cooldown', {
        source: source,
        token: token,
        nextAllowedAt: Number(this._nextAllowedLoadAt || 0),
      });
      return;
    }
    if ((source === 'wheel' || source === 'touch') && token) {
      this._lastLoadedGestureToken = token;
    }
    this._debugTrace('load-trigger', {
      source: source,
      token: token,
      topEdgeArmed: !!this._topEdgeArmed,
    });
    this._scheduleLoadCooldown(source === 'scroll' ? 280 : 360);
    this._loadOlderMessages();
  }

  async _handleScroll() {
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) return;
    let top = Number(container.scrollTop || 0);
    top = this._applyRestoreStabilizer(container, top);
    this._syncScrollToBottomButton(container);
    const prevTop = Number.isFinite(this._lastScrollTop) ? this._lastScrollTop : top;
    this._lastScrollTop = top;
    this._refreshTopEdgeArm(top);
    const movingUp = top < prevTop;
    if (top <= 48 || prevTop <= 48) {
      this._debugTrace('scroll-near-top', {
        top: top,
        prevTop: prevTop,
        movingUp: movingUp,
        topEdgeArmed: !!this._topEdgeArmed,
      });
    }
    if (movingUp) return;
  }

  _handleWheel(event) {
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) return;
    const top = Number(container.scrollTop || 0);
    const deltaY = Number(event && event.deltaY ? event.deltaY : 0);
    if (deltaY >= 0) {
      this._lastDownwardIntentAt = Date.now();
      this._postRestoreStabilizer = null;
      this._refreshTopEdgeArm(top);
      return;
    }
    const gestureToken = this._nextWheelGestureToken(deltaY);
    this._debugTrace('wheel-up-near-top', {
      top: top,
      deltaY: deltaY,
      topEdgeArmed: !!this._topEdgeArmed,
      token: gestureToken,
    });
    if (!this._canLoadOlderNow()) return;
    if (top > 24) return;
    if (!this._topEdgeArmed) return;
    this._topEdgeArmed = false;
    this._requestOlderLoad('wheel', gestureToken);
  }

  _handleTouchStart(event) {
    const touches = event && event.touches ? event.touches : null;
    if (!touches || !touches.length) return;
    this._touchStartY = Number(touches[0].clientY || 0);
    this._nextTouchGestureToken();
  }

  _handleTouchMove(event) {
    if (!this._canLoadOlderNow()) return;
    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (!container) return;
    const touches = event && event.touches ? event.touches : null;
    if (!touches || !touches.length) return;
    const currentY = Number(touches[0].clientY || 0);
    const deltaY = currentY - Number(this._touchStartY || 0);
    const top = Number(container.scrollTop || 0);
    if (deltaY < -18) {
      this._lastDownwardIntentAt = Date.now();
      this._postRestoreStabilizer = null;
    }
    this._refreshTopEdgeArm(top);
    this._debugTrace('touch-move-near-top', {
      top: top,
      deltaY: deltaY,
      topEdgeArmed: !!this._topEdgeArmed,
      token: this._activeTouchGestureToken,
    });
    if (deltaY <= 18) return;
    if (top > 24) return;
    if (!this._topEdgeArmed) return;
    this._topEdgeArmed = false;
    this._requestOlderLoad('touch', this._activeTouchGestureToken);
  }

  async _loadOlderMessages() {
    const snapshot = this._snapshot();
    const conversationId = String(snapshot.currentConversation || '').trim();
    if (!conversationId) return;
    if (this._noMoreOlderByConversation[conversationId]) return;

    const oldestIndex = this._getOldestIndex(snapshot.messages);
    if (!oldestIndex || oldestIndex <= 1) {
      this._noMoreOlderByConversation[conversationId] = true;
      return;
    }

    const idf = (typeof window !== 'undefined' && window.IDFramework) ? window.IDFramework : null;
    if (!idf || typeof idf.dispatch !== 'function') return;

    const container = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('.messages-container')
      : null;
    if (container) {
      const anchor = this._captureTopAnchor(container);
      this._pendingScrollRestore = {
        conversation: conversationId,
        top: Number(container.scrollTop || 0),
        height: Number(container.scrollHeight || 0),
        oldestIndex: Number(oldestIndex || 0),
        messageCount: Number(snapshot.messages.length || 0),
        anchorIndex: anchor && anchor.index ? String(anchor.index) : '',
        anchorKey: anchor && anchor.key ? String(anchor.key) : '',
        anchorOffset: anchor && Number.isFinite(Number(anchor.offset)) ? Number(anchor.offset) : 0,
      };
    }

    const pageSize = 20;
    const expectedOlderCount = Math.max(0, oldestIndex - 1);
    const fetchSize = Math.min(pageSize, expectedOlderCount);
    if (fetchSize <= 0) {
      this._noMoreOlderByConversation[conversationId] = true;
      return;
    }
    const startIndex = Math.max(1, oldestIndex - fetchSize);
    let didProgress = false;
    this._debugTrace('load-start', {
      conversationId: conversationId,
      oldestIndex: Number(oldestIndex || 0),
      startIndex: Number(startIndex || 0),
      fetchSize: Number(fetchSize || 0),
      conversationType: String(snapshot.conversationType || ''),
    });
    this._isLoadingOlder = true;
    this._handleChatUpdated();

    try {
      if (snapshot.conversationType === '1') {
        await idf.dispatch('fetchGroupMessages', {
          groupId: conversationId,
          startIndex: startIndex,
          size: fetchSize,
          mergeMode: 'prepend',
        });
      } else {
        const selfGlobalMetaId = String(snapshot.selfGlobalMetaId || '').trim();
        if (!selfGlobalMetaId) throw new Error('Wallet globalMetaId is missing');
        await idf.dispatch('fetchPrivateMessages', {
          metaId: selfGlobalMetaId,
          otherMetaId: conversationId,
          startIndex: startIndex,
          size: fetchSize,
          mergeMode: 'prepend',
        });
      }

      const nextSnapshot = this._snapshot();
      if (String(nextSnapshot.currentConversation || '') !== conversationId) return;
      const nextOldestIndex = this._getOldestIndex(nextSnapshot.messages);
      const madeProgress = !!nextOldestIndex && nextOldestIndex < oldestIndex;
      didProgress = !!madeProgress;
      if (madeProgress) {
        this._stalledOlderLoadsByConversation[conversationId] = 0;
      } else {
        this._stalledOlderLoadsByConversation[conversationId] =
          Number(this._stalledOlderLoadsByConversation[conversationId] || 0) + 1;
      }

      if (!nextOldestIndex || nextOldestIndex <= 1) {
        this._noMoreOlderByConversation[conversationId] = true;
        this._pendingScrollRestore = null;
        this._debugTrace('load-no-more', {
          conversationId: conversationId,
          nextOldestIndex: Number(nextOldestIndex || 0),
        });
        return;
      }
      if (!madeProgress && startIndex <= 1) {
        this._noMoreOlderByConversation[conversationId] = true;
        this._pendingScrollRestore = null;
        return;
      }
      if (!madeProgress && Number(this._stalledOlderLoadsByConversation[conversationId] || 0) >= 2) {
        this._noMoreOlderByConversation[conversationId] = true;
      }
      if (!madeProgress) {
        this._pendingScrollRestore = null;
      }
      this._debugTrace('load-finish', {
        conversationId: conversationId,
        nextOldestIndex: Number(nextOldestIndex || 0),
        madeProgress: !!madeProgress,
        stalledCount: Number(this._stalledOlderLoadsByConversation[conversationId] || 0),
      });
    } catch (_) {
      this._debugTrace('load-error', {
        conversationId: conversationId,
      });
      this._pendingScrollRestore = null;
    } finally {
      this._isLoadingOlder = false;
      this._scheduleLoadCooldown(420);
      this._handleChatUpdated();
      if (didProgress && !this._noMoreOlderByConversation[conversationId]) {
        const container = this.shadowRoot && this.shadowRoot.querySelector
          ? this.shadowRoot.querySelector('.messages-container')
          : null;
        const top = Number(container && container.scrollTop ? container.scrollTop : 0);
        if (top <= 24) {
          this._topEdgeArmed = true;
          this._debugTrace('load-rearm-top', {
            conversationId: conversationId,
            top: top,
          });
        }
      }
    }
  }

  _scrollToBottom() {
    this._debugTrace('scroll-bottom-request', {});
    requestAnimationFrame(() => {
      const container = this.shadowRoot.querySelector('.messages-container');
      if (!container) return;
      container.scrollTop = container.scrollHeight;
      this._syncScrollToBottomButton(container);
      this._debugTrace('scroll-bottom-applied', {
        top: Number(container.scrollTop || 0),
        scrollHeight: Number(container.scrollHeight || 0),
      });
    });
  }

  _handleScrollToBottomClick(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    this._scrollToBottom();
  }

  _hydrateBubbles(snapshot) {
    const nodes = Array.from(this.shadowRoot.querySelectorAll('id-chat-bubble'));
    const mode = snapshot.conversationType === '2' ? 'private' : 'public';
    const groupId = snapshot.conversationType === '1' ? snapshot.currentConversation : '';

    nodes.forEach((node, i) => {
      const msg = snapshot.messages[i] || null;
      node.message = msg;
      node.currentUserGlobalMetaId = snapshot.selfGlobalMetaId;
      node.currentUserMetaId = snapshot.selfMetaId;
      node.mode = mode;
      node.groupId = groupId;
      node.chatStore = this._cryptoReady ? this._cryptoStore : null;
    });

    this._applyForceBottomAfterHydrate(snapshot);
    this._syncScrollToBottomButton(null, snapshot);
  }

  _applyForceBottomAfterHydrate(snapshot) {
    const currentConversation = String(snapshot && snapshot.currentConversation ? snapshot.currentConversation : '').trim();
    if (!currentConversation) return;
    if (currentConversation !== String(this._pendingForceBottomConversation || '').trim()) return;
    this._pendingForceBottomConversation = '';
    this._debugTrace('scroll-bottom-after-hydrate', {
      conversation: currentConversation,
    });
    this._scrollToBottom();
  }

  render(forcedSnapshot) {
    const snapshot = forcedSnapshot || this._snapshot();
    this._lastSignature = this._signature(snapshot);
    const showLoadingState = !!snapshot.isLoading && (!snapshot.currentConversation || !snapshot.messages.length);
    const showInlineSyncing = !!snapshot.isLoading && !!snapshot.currentConversation && snapshot.messages.length > 0;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          width: 100%;
          height: 100%;
        }

        .messages-container {
          width: 100%;
          height: 100%;
          overflow-y: auto;
          padding: var(--id-spacing-sm, 0.5rem);
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          box-sizing: border-box;
          background-color: var(--id-bg-body, #f3f4f6);
        }

        .scroll-to-bottom-button {
          position: absolute;
          right: 14px;
          bottom: 14px;
          width: 38px;
          height: 38px;
          border: 0;
          border-radius: 999px;
          background: rgba(17, 24, 39, 0.92);
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          box-shadow: 0 8px 20px rgba(15, 23, 42, 0.28);
          transition: opacity 140ms ease, transform 140ms ease;
          z-index: 3;
        }

        .scroll-to-bottom-button:hover {
          transform: translateY(-1px);
        }

        .scroll-to-bottom-button.is-hidden {
          opacity: 0;
          pointer-events: none;
          transform: translateY(4px);
        }

        .history-loader {
          position: sticky;
          top: 0;
          z-index: 2;
          margin: 0 0 8px;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.08);
          color: var(--id-text-secondary, #6b7280);
          font-size: 12px;
          text-align: center;
        }

        .state {
          min-height: 120px;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          color: var(--id-text-secondary, #6b7280);
          padding: var(--id-spacing-md, 1rem);
        }

        .state.error {
          color: var(--id-text-error, #dc2626);
        }

        .list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        id-chat-bubble {
          display: block;
          width: 100%;
        }

        id-chat-bubble.jump-highlight {
          outline: 2px solid var(--id-color-primary, #3b82f6);
          outline-offset: 2px;
          border-radius: 12px;
          animation: jump-pulse 0.9s ease;
        }

        @keyframes jump-pulse {
          0% { opacity: 0.6; }
          100% { opacity: 1; }
        }
      </style>

      <div class="messages-container">
        ${this._isLoadingOlder ? `<div class="history-loader">${this._escapeHtml(this._t('chat.groupmsg.loadingOlder', 'Loading older messages...'))}</div>` : ''}
        ${showInlineSyncing ? `<div class="history-loader">${this._escapeHtml(this._t('chat.groupmsg.syncing', 'Syncing messages...'))}</div>` : ''}
        ${showLoadingState ? `
          <div class="state">${this._escapeHtml(this._t('chat.groupmsg.loadingMessages', 'Loading messages...'))}</div>
        ` : snapshot.error ? `
          <div class="state error">${this._escapeHtml(this._t('chat.groupmsg.errorPrefix', 'Error:'))} ${this._escapeHtml(snapshot.error)}</div>
        ` : !snapshot.currentConversation ? `
          <div class="state">${this._escapeHtml(this._t('chat.groupmsg.selectConversation', 'Select a conversation to view messages'))}</div>
        ` : !snapshot.messages.length ? `
          <div class="state">${this._escapeHtml(this._t('chat.groupmsg.noMessagesYet', 'No messages yet'))}</div>
        ` : `
          <div class="list">
            ${snapshot.messages.map((msg) => `
              <id-chat-bubble data-msg-index="${this._escapeHtml(String(msg && msg.index ? msg.index : ''))}" data-msg-key="${this._escapeHtml(this._messageDomKey(msg))}"></id-chat-bubble>
            `).join('')}
          </div>
        `}
      </div>
      <button
        class="scroll-to-bottom-button${this._showScrollToBottomButton ? '' : ' is-hidden'}"
        type="button"
        aria-label="${this._escapeHtml(this._t('chat.groupmsg.scrollToBottom', 'Scroll to latest messages'))}"
        ${this._showScrollToBottomButton ? '' : 'hidden'}
      >↓</button>
    `;

    if (snapshot.messages.length > 0) {
      if (!customElements.get('id-chat-bubble')) {
        import('./id-chat-bubble.js')
          .then(() => this._hydrateBubbles(snapshot))
          .catch((err) => console.warn('Failed to load id-chat-bubble:', err));
      } else {
        this._hydrateBubbles(snapshot);
      }
    }
  }
}

if (!customElements.get('id-chat-groupmsg-list')) {
  customElements.define('id-chat-groupmsg-list', IdChatGroupmsgList);
}

export default IdChatGroupmsgList;
