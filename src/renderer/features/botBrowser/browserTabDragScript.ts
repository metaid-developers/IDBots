/**
 * Chrome-like left/right tab reordering for the Bot Browser tab strip.
 *
 * WHERE THIS RUNS: the Bot Browser chrome is ABC's own page, rendered into the
 * surface's srcDoc iframe (`@openagentinternet/agent-browser-ui` owns
 * `state.tabs` + `renderTabs()`). `browserIframeBridge.ts` is injected into
 * that SAME page script, so this module extends the page in place instead of
 * patching the ABC package: `node_modules/@openagentinternet/*` is a pnpm store
 * symlink — an install artifact, never an edit target (the only accepted ABC
 * change lives in patches/, which pnpm applies at install time).
 *
 * DATA FLOW (owner feedback 2026-11-21 01:32: the strip did not reorder):
 *   dragstart  -> remember the dragged `data-tab-id`, mark it half transparent
 *   dragover   -> compute the insertion boundary from pointer X and let the
 *                 neighbours slide aside (FLIP); there is NO insertion line —
 *                 the yielding itself is the only insertion-point expression
 *   drop       -> rewrite `state.tabs` order (ids mapped back to tab objects)
 *                 AND move the DOM nodes in the same order, then persist the
 *                 URI order. Both halves are required: reordering only the DOM
 *                 is undone by the next `renderTabs()`, reordering only
 *                 `state.tabs` is invisible until something re-renders.
 *
 * ORDER PERSISTENCE: ABC keeps tabs at session level (tabs are minted per
 * launch; the host only re-opens one session's stage/showcase tab), so the
 * durable half is the URI order: every drop writes `idbots.botBrowser.tabOrder`
 * (localStorage in the page's own origin — the same best-effort channel ABC
 * already uses for bookmarks/history/grants) and a boot pass re-applies that
 * relative order once the same URIs come back. URIs, not numeric tab ids: ids
 * are re-minted on every launch.
 *
 * PINNED TABS: ABC renders pinned tabs first (`stripTabs()` sorts by pinned), so
 * a non-pinned tab cannot be dropped to the left of a pinned one — same rule as
 * a browser with pinned tabs. The rewrite keeps the pinned segment intact.
 *
 * DEGRADATION (dual-screen ruling): below the strip's own 768 px breakpoint the
 * tab strip is `display: none` upstream (5-inch shell screen), so drag is
 * structurally unreachable there and this module additionally refuses to arm
 * DnD. A coarse pointer (2880x864 touch console) gets a long-press move mode
 * instead of HTML5 DnD, which does not deliver touch drags.
 *
 * EXISTING INTERACTION IS LOAD-BEARING: click / close / context-menu keep
 * working because DnD arms only on the tab body (never on `.browser-tab-close`),
 * the long press swallows exactly the one click it would otherwise cause, and
 * the module never binds mousedown on the strip (blank-area window dragging
 * stays with the bridge's own handler).
 */

export interface BrowserTabDragLabels {
  /** Discoverability text set as the tab's title attribute while DnD is armed. */
  dragHint: string;
  /** Long-press move-mode announcement (page toast). */
  armedHint: string;
}

const DEFAULT_LABELS: BrowserTabDragLabels = {
  dragHint: 'Drag to reorder tabs',
  armedHint: 'Move mode: click a target tab to move it there, Escape to cancel',
};

/** Markers the wiring tests pin (keep in sync with the emitted script). */
export const BROWSER_TAB_DRAG_MARKERS = [
  '__idbotsBrowserTabDragInstalled',
  'idbots.botBrowser.tabOrder',
  'data-browser-tabs-container',
  'previewYield',
  'settleFrom',
  'is-dragging',
  'is-drag-armed',
] as const;

/** Storage key written by the injected script (host-side tests read it back). */
export const BROWSER_TAB_ORDER_STORAGE_KEY = 'idbots.botBrowser.tabOrder';

export const BROWSER_TAB_DRAG_NARROW_QUERY = '(max-width: 768px)';

export const BROWSER_TAB_DRAG_COARSE_QUERY = '(pointer: coarse)';

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildBrowserTabDragScript(labels?: BrowserTabDragLabels): string {
  const resolved: BrowserTabDragLabels = {
    dragHint: String(labels?.dragHint ?? '').trim() || DEFAULT_LABELS.dragHint,
    armedHint: String(labels?.armedHint ?? '').trim() || DEFAULT_LABELS.armedHint,
  };

  return `
(function installIdbotsBrowserTabDrag() {
  if (globalThis.__idbotsBrowserTabDragInstalled) return;
  globalThis.__idbotsBrowserTabDragInstalled = true;

  var dragLabels = ${jsonScript(resolved)};
  var TABSTRIP_SELECTOR = '[data-browser-tabs-container]';
  var TAB_SELECTOR = '.browser-tab';
  var CLOSE_SELECTOR = '.browser-tab-close';
  var NEW_TAB_SELECTOR = '.browser-tab-new';
  var STORAGE_KEY = '${BROWSER_TAB_ORDER_STORAGE_KEY}';
  var MAX_SAVED_ORDER = 50;
  var NARROW_QUERY = '${BROWSER_TAB_DRAG_NARROW_QUERY}';
  var COARSE_QUERY = '${BROWSER_TAB_DRAG_COARSE_QUERY}';
  var LONG_PRESS_MS = 450;
  var ARM_CLICK_SUPPRESS_MS = 700;
  var GRAB_MS = 120;
  var SETTLE_MS = 150;
  var SETTLE_EASING = 'cubic-bezier(.2,0,0,1)';
  var REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
  var DRAG_STYLE_ID = 'idbots-browser-tab-drag-style';
  var BOOT_RETRY_MS = 50;
  var BOOT_RETRY_LIMIT = 60;

  var container = null;
  var draggedTabId = null;
  var pendingInsertIndex = null;
  var armedTabId = null;
  var suppressClickUntil = 0;
  var longPressTimer = null;
  var longPressStart = null;
  var restoreSignature = '';
  var dragOriginIndex = null;
  var yieldStep = 0;
  var lastPreviewIndex = null;
  var observer = null;
  var bootRetries = 0;

  /**
   * The page always ships the full DOM API, but the bridge is also executed in
   * minimal harness pages (and its own vm sandbox test). A missing capability
   * must degrade to "no reordering", never throw into the page's boot path.
   */
  function domSupported() {
    return Boolean(
      typeof document === 'object' && document
      && typeof document.querySelector === 'function'
      && typeof document.createElement === 'function'
      && typeof document.addEventListener === 'function'
    );
  }

  function matches(query) {
    try {
      return typeof window.matchMedia === 'function' && !!window.matchMedia(query).matches;
    } catch (error) {
      return false;
    }
  }

  // Narrow = the 5-inch shell breakpoint, where upstream hides the strip.
  function dragDisabled() {
    return matches(NARROW_QUERY);
  }

  // Coarse pointer = touch panel: HTML5 DnD does not deliver touch drags.
  function touchFallback() {
    return matches(COARSE_QUERY);
  }

  function setTabTransform(element, value) {
    if (!element || !element.style) return;
    element.style.transform = value || '';
  }

  function remainingTabElements() {
    var tabs = tabElements();
    var out = [];
    for (var index = 0; index < tabs.length; index += 1) {
      if (tabIdOf(tabs[index]) !== draggedTabId) out.push(tabs[index]);
    }
    return out;
  }

  /**
   * Clear every inline transform this layer may have written (yield previews
   * and FLIP residue). Called at dragstart so rapid consecutive drags never
   * accumulate a stale offset.
   */
  function resetMotionState() {
    var tabs = tabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      setTabTransform(tabs[index], '');
    }
    if (container && typeof container.removeAttribute === 'function') {
      container.removeAttribute('data-tab-drag-slot');
    }
    dragOriginIndex = null;
    yieldStep = 0;
    lastPreviewIndex = null;
  }

  function clearYieldTransforms() {
    var tabs = tabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      if (tabs[index] && tabIdOf(tabs[index]) !== draggedTabId) {
        setTabTransform(tabs[index], '');
      }
    }
  }

  /** One slot = tab width + the strip's inter-tab gap. */
  function computeYieldStep(draggedElement) {
    var tabs = tabElements();
    if (!draggedElement || typeof draggedElement.getBoundingClientRect !== 'function') return 0;
    var rect = draggedElement.getBoundingClientRect();
    var gap = 0;
    if (tabs.length > 1) {
      var first = tabs[0].getBoundingClientRect();
      var second = tabs[1].getBoundingClientRect();
      gap = Math.max(0, Number(second.left) - Number(first.right));
    }
    return Math.max(0, Number(rect.width) + gap);
  }

  /**
   * Two visual quantities, added on the SAME transform (owner ruling 21:33):
   *   - collapse: every tab AFTER the dragged one slides left by one slot, so
   *     the original slot visually disappears while the source keeps its
   *     layout position (the element itself is never repositioned);
   *   - opening: every remaining tab at/after the pointer boundary slides right
   *     by one slot, so the drop target opens.
   * Net transform is one of {-slot, 0, +slot}; nothing here touches state.
   */
  function previewYield(boundary) {
    if (draggedTabId === null || dragOriginIndex === null) return;
    if (boundary === lastPreviewIndex) return;
    lastPreviewIndex = boundary;
    var order = visibleTabIds();
    var tabs = remainingTabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      var id = tabIdOf(tabs[index]);
      if (id === null) continue;
      var afterOrigin = order.indexOf(id) > dragOriginIndex;
      var dx = (afterOrigin ? -yieldStep : 0) + (index >= boundary ? yieldStep : 0);
      setTabTransform(tabs[index], dx ? 'translateX(' + dx + 'px)' : '');
    }
  }

  function captureTabLefts() {
    var tabs = tabElements();
    var out = {};
    for (var index = 0; index < tabs.length; index += 1) {
      var id = tabIdOf(tabs[index]);
      if (id === null || typeof tabs[index].getBoundingClientRect !== 'function') continue;
      out[id] = tabs[index].getBoundingClientRect().left;
    }
    return out;
  }

  function clearInlineTransitionLater(element, ms) {
    if (!element || !element.style) return;
    if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return;
    window.setTimeout(function () {
      if (element.style) element.style.transition = '';
    }, Number(ms) + 30);
  }

  /**
   * FLIP settle: put each moved tab back at its recorded X with transitions
   * off, then release it so the curve plays from the old geometry to the new
   * one. Reduced motion zeroes the transition via CSS !important and the final
   * state lands instantly.
   */
  function settleFrom(before, duration) {
    var ms = Number(duration) > 0 ? Number(duration) : SETTLE_MS;
    var tabs = tabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      var id = tabIdOf(tabs[index]);
      if (id === null || !Object.prototype.hasOwnProperty.call(before, id)) continue;
      if (typeof tabs[index].getBoundingClientRect !== 'function') continue;
      var next = tabs[index].getBoundingClientRect().left;
      var dx = Number(before[id]) - Number(next);
      if (!dx || Math.abs(dx) < 0.5) continue;
      var element = tabs[index];
      element.style.transition = 'none';
      element.style.transform = 'translateX(' + dx + 'px)';
      // Force the browser to read the inverse position before releasing it.
      void element.getBoundingClientRect();
      element.style.transition = 'transform ' + ms + 'ms ' + SETTLE_EASING;
      element.style.transform = '';
      clearInlineTransitionLater(element, ms);
    }
  }


  /**
   * Stable identity for the persisted order. Tab ids are minted per launch, so
   * the order is stored against something that survives a restart: the URI. A
   * blank tab ("New Tab") has no URI yet — it still has to hold a slot, so it
   * gets an occurrence token (blank#1, blank#2, ...). Two blanks keep their
   * relative order because the token carries the occurrence index.
   */
  var BLANK_KEY_PREFIX = 'blank#';

  function browserState() {
    var current = globalThis.state;
    return current && Array.isArray(current.tabs) ? current : null;
  }

  function tabElements() {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    var nodes = container.querySelectorAll(TAB_SELECTOR);
    return Array.prototype.slice.call(nodes || []);
  }

  function tabIdOf(element) {
    var raw = element && typeof element.getAttribute === 'function'
      ? element.getAttribute('data-tab-id')
      : null;
    var id = Number(raw);
    return Number.isFinite(id) ? id : null;
  }

  // A click/drag lands on whatever child was hit (the title span, the close
  // button): resolve the owning tab by climbing, never by reading the target's
  // own attribute.
  function tabElementFromTarget(target) {
    if (!target) return null;
    if (typeof target.closest === 'function') {
      var owner = target.closest('[data-tab-id]');
      if (owner) return owner;
    }
    if (tabIdOf(target) !== null) return target;
    return null;
  }

  function tabElementById(id) {
    var tabs = tabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      if (tabIdOf(tabs[index]) === id) return tabs[index];
    }
    return null;
  }

  function tabById(id) {
    var current = browserState();
    if (!current) return null;
    for (var index = 0; index < current.tabs.length; index += 1) {
      if (current.tabs[index] && current.tabs[index].id === id) return current.tabs[index];
    }
    return null;
  }

  function uriOfTab(tab) {
    if (!tab || !tab.current) return '';
    var uri = tab.current.uri || tab.current.normalizedUri || '';
    return String(uri).trim();
  }

  /**
   * Stable identity for the persisted order. Tab ids are minted per launch, so
   * the order is stored against something that survives a restart: the URI. A
   * blank tab ("New Tab") has no URI yet — it still has to hold a slot, so it
   * gets an occurrence token (blank#1, blank#2, ...). Two blanks keep their
   * relative order because the token carries the occurrence index.
   */

  function tabKeysOf(ids) {
    var keys = [];
    var blanks = 0;
    for (var index = 0; index < ids.length; index += 1) {
      var tab = tabById(ids[index]);
      var uri = uriOfTab(tab);
      if (uri) {
        keys.push(uri);
      } else {
        blanks += 1;
        keys.push(BLANK_KEY_PREFIX + blanks);
      }
    }
    return keys;
  }

  function visibleTabIds() {
    var ids = [];
    var tabs = tabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      var id = tabIdOf(tabs[index]);
      if (id !== null) ids.push(id);
    }
    return ids;
  }

  function readSavedOrder() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      var out = [];
      for (var index = 0; index < parsed.length; index += 1) {
        var key = typeof parsed[index] === 'string' ? parsed[index].trim() : '';
        if (!key || out.indexOf(key) !== -1) continue;
        out.push(key);
      }
      return out;
    } catch (error) {
      return [];
    }
  }

  function writeSavedOrder(uris) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(uris.slice(0, MAX_SAVED_ORDER)));
    } catch (error) {
      // localStorage unavailable or full: the order stays this session's.
    }
  }

  function persistVisibleOrder() {
    var ids = visibleTabIds();
    if (ids.length < 2) return;
    var keys = tabKeysOf(ids);
    if (keys.length > 1) writeSavedOrder(keys);
  }

  /** Rewrite "state.tabs" to the given visible id order. True when order moved. */
  function applyStateOrder(orderedIds) {
    var current = browserState();
    if (!current) return false;
    var seen = {};
    var next = [];
    var index;
    for (index = 0; index < orderedIds.length; index += 1) {
      var tab = tabById(orderedIds[index]);
      if (tab && !seen[tab.id]) {
        next.push(tab);
        seen[tab.id] = true;
      }
    }
    // Tabs outside the rendered strip must survive the rewrite.
    for (index = 0; index < current.tabs.length; index += 1) {
      var existing = current.tabs[index];
      if (existing && !seen[existing.id]) next.push(existing);
    }
    if (next.length !== current.tabs.length) return false;
    var moved = false;
    for (index = 0; index < next.length; index += 1) {
      if (next[index] !== current.tabs[index]) {
        moved = true;
        break;
      }
    }
    if (!moved) return false;
    current.tabs.length = 0;
    for (index = 0; index < next.length; index += 1) current.tabs.push(next[index]);
    return true;
  }

  /**
   * Move the tab nodes in the DOM to the given order. The "+" button and the
   * insertion line stay after the tabs (they are the reference anchors), and
   * node identity is preserved so ABC's delegated handlers keep working.
   */
  function applyDomOrder(orderedIds) {
    if (!container || typeof container.insertBefore !== 'function') return;
    // The "+" button follows the LAST tab (ABC's own render contract), so it is
    // the insertion anchor (there is no insertion line any more).
    var anchor = typeof container.querySelector === 'function'
      ? container.querySelector(NEW_TAB_SELECTOR)
      : null;
    for (var index = 0; index < orderedIds.length; index += 1) {
      var element = tabElementById(orderedIds[index]);
      if (!element) continue;
      if (anchor) container.insertBefore(element, anchor);
      else container.appendChild(element);
    }
  }

  function injectStyle() {
    if (typeof document.getElementById !== 'function') return;
    if (document.getElementById(DRAG_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = DRAG_STYLE_ID;
    // Shape language of the chrome this lives in: rect-flat, 1 px strokes,
    // accent token, no glow and no capsule.
    style.textContent = [
      '.browser-tabstrip-tabs { position: relative; }',
      /* Base transition = the FLIP settle curve for every tab. Only our own
         transform/border writes ever trigger it. */
      '.browser-tab {',
      '  transition: transform ' + SETTLE_MS + 'ms ' + SETTLE_EASING + ', opacity ' + GRAB_MS + 'ms ease-out, border-color ' + GRAB_MS + 'ms ease-out;',
      '}',
      /* Grab: the SOURCE tab itself never moves in layout (Chrome cancels a
         native drag when the source is relocated); it just fades to ~0.05 and
         the native drag image does the following. */
      '.browser-tab.is-dragging {',
      '  transform: scale(1.02) translateY(-1px);',
      '  opacity: .05;',
      '  border-color: var(--browser-accent);',
      '  transition: transform ' + GRAB_MS + 'ms ease-out, opacity ' + GRAB_MS + 'ms ease-out, border-color ' + GRAB_MS + 'ms ease-out;',
      '  z-index: 2;',
      '}',
      /* Touch long-press arming: same accent edge, no shadow decoration. */
      '.browser-tab.is-drag-armed { border-color: var(--browser-accent); }',
      /* Accessibility: every animation in this layer collapses to an instant
         state change; the final order/visibility stays exact. */
      '@media ' + REDUCED_MOTION_QUERY + ' {',
      '  .browser-tab, .browser-tab.is-dragging { transition: none !important; }',
      '}',
    ].join('\\n');
    var head = document.head || document.body;
    if (head && typeof head.appendChild === 'function') head.appendChild(style);
  }

  /**
   * The drop boundary is expressed ONLY by the neighbours' displacement
   * (owner ruling 21:07: delete the blue insertion line — it was the "low"
   * source). The computed index is still remembered for the drop itself.
   */
  function clampRemainingBoundary(index) {
    var dragged = draggedTabId === null ? null : tabById(draggedTabId);
    if (!dragged || dragged.pinned) return index;
    var floor = pinnedCount();
    return index < floor ? floor : index;
  }

  function updateDropTarget(index) {
    var clamped = clampRemainingBoundary(index);
    pendingInsertIndex = clamped;
    previewYield(clamped);
  }

  function clearDropTarget() {
    pendingInsertIndex = null;
  }

  function clearDragging() {
    var tabs = tabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      if (tabs[index].classList && tabs[index].classList.remove) {
        tabs[index].classList.remove('is-dragging');
      }
    }
    draggedTabId = null;
  }

  function clearArmed() {
    if (armedTabId !== null) {
      var element = tabElementById(armedTabId);
      if (element && element.classList && element.classList.remove) {
        element.classList.remove('is-drag-armed');
      }
    }
    armedTabId = null;
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  /** Insertion boundary for a pointer X: before the first tab past its midpoint. */
  function insertionIndexFor(clientX) {
    var tabs = remainingTabElements();
    for (var index = 0; index < tabs.length; index += 1) {
      var rect = tabs[index].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }
    return tabs.length;
  }

  function clientXOf(event) {
    var value = Number(event && event.clientX);
    if (Number.isFinite(value)) return value;
    var box = container && typeof container.getBoundingClientRect === 'function'
      ? container.getBoundingClientRect()
      : { left: 0 };
    return Number(box.left) || 0;
  }

  function toast(message) {
    if (typeof globalThis.showToast !== 'function') return;
    try {
      globalThis.showToast(message);
    } catch (error) {
      // A toast must never break reordering.
    }
  }

  /**
   * ABC renders pinned tabs first (stripTabs(): state.tabs.slice().sort(by
   * pinned)). A non-pinned tab can therefore never land left of the pinned
   * segment: the next render would snap it back, and the drop would silently do
   * nothing. Clamp both the preview line and the actual move to that boundary,
   * exactly like Chrome refuses to mix pinned and free tabs.
   */
  function pinnedCount() {
    var ids = visibleTabIds();
    var count = 0;
    for (var index = 0; index < ids.length; index += 1) {
      var tab = tabById(ids[index]);
      if (tab && tab.pinned) count += 1;
    }
    return count;
  }

  function clampIndexForTab(index, tabId) {
    var tab = tabById(tabId);
    if (!tab || tab.pinned) return index;
    var floor = pinnedCount();
    return index < floor ? floor : index;
  }

  /** Move draggedId to boundary "targetIndex" of the visible order. */
  function moveTab(draggedId, targetIndex) {
    if (draggedId === null || targetIndex === null) return false;
    var order = visibleTabIds();
    var from = order.indexOf(draggedId);
    if (from === -1) return false;
    var next = order.slice();
    next.splice(from, 1);
    var to = Math.max(0, Math.min(targetIndex, order.length));
    // Removing the source shifts boundaries to its right by one.
    if (from < to) to -= 1;
    // Free tabs may not cross into the pinned segment (see clampIndexForTab).
    var dragged = tabById(draggedId);
    var floor = dragged && dragged.pinned ? 0 : pinnedCount();
    if (to < floor) to = floor;
    if (to === from) return false;
    next.splice(to, 0, draggedId);
    if (!applyStateOrder(next)) return false;
    applyDomOrder(next);
    persistVisibleOrder();
    return true;
  }

  /**
   * Boot restore: re-apply the persisted URI order once per distinct visible
   * URI set. A restore never persists (it must not overwrite the saved order).
   */
  function restoreOrder() {
    var current = browserState();
    if (!current || current.tabs.length < 2) return;
    var order = visibleTabIds();
    if (order.length < 2) return;
    var signature = order.join('\\n');
    if (signature === restoreSignature) return;
    var saved = readSavedOrder();
    if (saved.length < 2) {
      restoreSignature = signature;
      return;
    }
    restoreSignature = signature;
    var rank = {};
    for (var index = 0; index < saved.length; index += 1) rank[saved[index]] = index;
    var keys = tabKeysOf(order);
    var scored = [];
    for (index = 0; index < order.length; index += 1) {
      var key = keys[index];
      var position = Object.prototype.hasOwnProperty.call(rank, key) ? rank[key] : 1e9;
      scored.push({ id: order[index], rank: position, at: index });
    }
    scored.sort(function (a, b) {
      if (a.rank === b.rank) return a.at - b.at;
      return a.rank - b.rank;
    });
    var desired = [];
    for (index = 0; index < scored.length; index += 1) desired.push(scored[index].id);
    if (desired.join('\\n') === signature) return;
    if (!applyStateOrder(desired)) return;
    applyDomOrder(desired);
    restoreSignature = desired.join('\\n');
  }

  function decorate() {
    var tabs = tabElements();
    var enabled = !dragDisabled();
    for (var index = 0; index < tabs.length; index += 1) {
      var tab = tabs[index];
      if (typeof tab.setAttribute !== 'function') continue;
      if (enabled) {
        tab.setAttribute('draggable', 'true');
        tab.setAttribute('data-tab-drag', 'ready');
        if (!tab.getAttribute('title')) tab.setAttribute('title', dragLabels.dragHint);
      } else {
        tab.setAttribute('draggable', 'false');
        tab.removeAttribute('data-tab-drag');
        if (tab.getAttribute('title') === dragLabels.dragHint) tab.removeAttribute('title');
      }
      // The close button must never start a drag: click-to-close stays exact.
      var closeButtons = typeof tab.querySelectorAll === 'function'
        ? tab.querySelectorAll(CLOSE_SELECTOR)
        : [];
      for (var closeIndex = 0; closeIndex < closeButtons.length; closeIndex += 1) {
        closeButtons[closeIndex].setAttribute('draggable', 'false');
      }
    }
  }

  function isCloseTarget(target) {
    return Boolean(target && typeof target.closest === 'function' && target.closest(CLOSE_SELECTOR));
  }

  function isNewTabTarget(target) {
    return Boolean(target && typeof target.closest === 'function' && target.closest(NEW_TAB_SELECTOR));
  }

  function onDragStart(event) {
    if (dragDisabled()) return;
    var target = event && event.target;
    if (isCloseTarget(target)) {
      if (event.preventDefault) event.preventDefault();
      return;
    }
    var draggedElement = tabElementFromTarget(target);
    var id = tabIdOf(draggedElement);
    if (id === null) return;
    resetMotionState();
    draggedTabId = id;
    dragOriginIndex = visibleTabIds().indexOf(id);
    yieldStep = computeYieldStep(draggedElement);
    if (draggedElement.classList && draggedElement.classList.add) draggedElement.classList.add('is-dragging');
    if (container && typeof container.setAttribute === 'function') {
      container.setAttribute('data-tab-drag-slot', String(Math.round(yieldStep)));
    }
    var transfer = event.dataTransfer;
    if (transfer) {
      try {
        transfer.effectAllowed = 'move';
        transfer.setData('text/plain', String(id));
      } catch (error) {
        // Some embedders expose a read-only DataTransfer; the id is in memory.
      }
    }
    // The source tab NEVER leaves its layout position (relocating it makes
    // Chrome cancel the native drag). It only fades; the browser's own drag
    // image is the floating body.
    var remainingCount = remainingTabElements().length;
    updateDropTarget(Math.min(dragOriginIndex, Math.max(0, remainingCount)));
  }

  function onDragOver(event) {
    if (dragDisabled() || draggedTabId === null) return;
    if (event.preventDefault) event.preventDefault();
    if (event.dataTransfer) {
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch (error) {
        // Effect hint only.
      }
    }
    if (!remainingTabElements().length) return;
    updateDropTarget(insertionIndexFor(clientXOf(event)));
  }

  function onDrop(event) {
    if (dragDisabled() || draggedTabId === null) return;
    if (event.preventDefault) event.preventDefault();
    var boundary = pendingInsertIndex === null
      ? insertionIndexFor(clientXOf(event))
      : pendingInsertIndex;
    var dragged = draggedTabId;
    var from = dragOriginIndex === null ? visibleTabIds().indexOf(dragged) : dragOriginIndex;
    // The boundary indexes the REMAINING row; moveTab expects the full row.
    var fullBoundary = boundary <= from ? boundary : boundary + 1;
    var before = captureTabLefts();
    clearDropTarget();
    clearYieldTransforms();
    clearDragging();
    if (moveTab(dragged, fullBoundary)) settleFrom(before);
    resetMotionState();
  }

  function onDragEnd() {
    clearDropTarget();
    clearYieldTransforms();
    clearDragging();
    resetMotionState();
  }

  function onDragLeave(event) {
    // Leaving the container itself (not a child) returns the yielded neighbours.
    var related = event && event.relatedTarget;
    if (related && container && typeof container.contains === 'function' && container.contains(related)) return;
    clearDropTarget();
    clearYieldTransforms();
    lastPreviewIndex = null;
  }

  function armTab(id) {
    clearArmed();
    var element = tabElementById(id);
    if (!element) return;
    armedTabId = id;
    if (element.classList && element.classList.add) element.classList.add('is-drag-armed');
    // The long press ends in a click that would otherwise switch tabs.
    suppressClickUntil = Date.now() + ARM_CLICK_SUPPRESS_MS;
    toast(dragLabels.armedHint);
  }

  function onPointerDown(event) {
    if (!touchFallback() || dragDisabled()) return;
    if (event && event.button !== undefined && event.button !== 0) return;
    var target = event && event.target;
    if (isCloseTarget(target) || isNewTabTarget(target)) return;
    var longPressTab = tabElementFromTarget(target);
    var id = tabIdOf(longPressTab);
    if (id === null) return;
    longPressStart = { x: clientXOf(event), y: Number(event.clientY) || 0 };
    if (longPressTimer !== null) window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(function () {
      longPressTimer = null;
      armTab(id);
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event) {
    if (longPressTimer === null || !longPressStart) return;
    var dx = clientXOf(event) - longPressStart.x;
    var dy = (Number(event.clientY) || 0) - longPressStart.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressStart = null;
    }
  }

  function onPointerUp() {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  function onClickCapture(event) {
    if (Date.now() < suppressClickUntil) {
      // Swallow exactly the click the arming press produced.
      suppressClickUntil = 0;
      if (event && event.stopPropagation) event.stopPropagation();
      if (event && event.preventDefault) event.preventDefault();
      return;
    }
    if (armedTabId === null) return;
    var target = event && event.target;
    if (isCloseTarget(target) || isNewTabTarget(target)) {
      clearArmed();
      return;
    }
    var clickedElement = tabElementFromTarget(target);
    var id = tabIdOf(clickedElement);
    if (id === null || id === armedTabId) {
      clearArmed();
      return;
    }
    var element = tabElementById(id);
    var rect = element && typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : null;
    var index = visibleTabIds().indexOf(id);
    var after = Boolean(rect) && clientXOf(event) > rect.left + rect.width / 2;
    var targetIndex = after ? index + 1 : index;
    var dragged = armedTabId;
    clearArmed();
    if (event && event.stopPropagation) event.stopPropagation();
    if (event && event.preventDefault) event.preventDefault();
    moveTab(dragged, targetIndex);
  }

  function onKeyDown(event) {
    if (!event || event.key !== 'Escape') return;
    clearArmed();
    onDragEnd();
    clearDropTarget();
  }

  function installHandlers() {
    if (typeof container.addEventListener !== 'function') return;
    container.addEventListener('dragstart', onDragStart, true);
    container.addEventListener('dragover', onDragOver, true);
    container.addEventListener('drop', onDrop, true);
    container.addEventListener('dragend', onDragEnd, true);
    container.addEventListener('dragleave', onDragLeave, true);
    container.addEventListener('pointerdown', onPointerDown, true);
    container.addEventListener('pointermove', onPointerMove, true);
    container.addEventListener('pointerup', onPointerUp, true);
    container.addEventListener('pointercancel', onPointerUp, true);
    container.addEventListener('click', onClickCapture, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  /**
   * The same launch can move between the two screens' breakpoints (window
   * resize, display switch). Re-stamp "draggable" when that happens instead of
   * leaving a stale arming state from the other screen.
   */
  function watchBreakpoint() {
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', function () {
        decorate();
      });
    }
    try {
      if (typeof window.matchMedia === 'function') {
        var query = window.matchMedia(NARROW_QUERY);
        if (query && typeof query.addEventListener === 'function') {
          query.addEventListener('change', function () {
            decorate();
          });
        } else if (query && typeof query.addListener === 'function') {
          query.addListener(function () {
            decorate();
          });
        }
      }
    } catch (error) {
      // No media-query change feed: the resize listener above still covers it.
    }
  }

  function watchStrip() {
    if (typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(function () {
      // renderTabs() replaces the container's children: re-stamp draggable and
      // re-apply the saved order for the URIs that just arrived.
      decorate();
      restoreOrder();
    });
    observer.observe(container, { childList: true });
  }

  function boot() {
    if (!domSupported()) return;
    container = document.querySelector(TABSTRIP_SELECTOR);
    if (!container) {
      if (bootRetries < BOOT_RETRY_LIMIT) {
        bootRetries += 1;
        window.setTimeout(boot, BOOT_RETRY_MS);
      }
      return;
    }
    injectStyle();
    installHandlers();
    decorate();
    watchBreakpoint();
    watchStrip();
    restoreOrder();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;
}
