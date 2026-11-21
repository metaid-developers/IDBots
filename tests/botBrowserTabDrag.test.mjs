import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  BROWSER_TAB_ORDER_STORAGE_KEY,
  BROWSER_TAB_DRAG_COARSE_QUERY,
  BROWSER_TAB_DRAG_MARKERS,
  BROWSER_TAB_DRAG_NARROW_QUERY,
  buildBrowserTabDragScript,
} from '../src/renderer/features/botBrowser/browserTabDragScript.ts';

/**
 * Behavioural wiring test for the tab-strip reorder script.
 *
 * The script is plain JS emitted into the ABC page (the srcDoc iframe) and runs
 * against ABC's `state.tabs` + `data-browser-tabs-container`. Rather than
 * grepping for handler names, this test EXECUTES the generated script inside a
 * minimal DOM stub and drives the real events — so an ordering bug, a missing
 * persistence write, or a regression in the 768 px / coarse-pointer degradation
 * fails the test instead of silently shipping.
 */

const TAB_URIS = [
  'metaid://idq1aaaa',
  'metaid://idq1bbbb',
  'metaid://idq1cccc',
];

function classList(element) {
  return {
    add: (token) => {
      const set = new Set(element._classes);
      set.add(token);
      element._classes = [...set];
    },
    remove: (token) => {
      element._classes = element._classes.filter((entry) => entry !== token);
    },
    contains: (token) => element._classes.includes(token),
  };
}

function makeElement({ tag = 'div', className = '', attrs = {}, rect = null } = {}) {
  const element = {
    tagName: tag.toUpperCase(),
    _classes: className ? className.split(/\s+/).filter(Boolean) : [],
    _attrs: { ...attrs },
    _children: [],
    hidden: false,
    style: {},
    scrollLeft: 0,
    parentNode: null,
    _rect: rect,
    classList: null,
    textContent: '',
  };
  // `element.className = 'x'` is how the injected script labels the line div;
  // keep it in the same slot the class selectors read.
  Object.defineProperty(element, 'className', {
    get: () => element._classes.join(' '),
    set: (value) => {
      element._classes = String(value ?? '').split(/\s+/).filter(Boolean);
    },
    enumerable: true,
  });
  element.classList = classList(element);
  // `style.id = 'x'` writes a property, `getElementById` reads the attribute:
  // keep them the same slot so the injected <style id> is discoverable.
  Object.defineProperty(element, 'id', {
    get: () => element._attrs.id ?? '',
    set: (value) => {
      element._attrs.id = String(value);
    },
    enumerable: true,
  });
  element.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(element._attrs, name) ? element._attrs[name] : null);
  element.setAttribute = (name, value) => {
    element._attrs[name] = String(value);
  };
  element.removeAttribute = (name) => {
    delete element._attrs[name];
  };
  element.hasAttribute = (name) => Object.prototype.hasOwnProperty.call(element._attrs, name);
  element.appendChild = (child) => {
    if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((entry) => entry !== child);
    child.parentNode = element;
    element._children.push(child);
    return child;
  };
  element.insertBefore = (child, anchor) => {
    if (child.parentNode) child.parentNode._children = child.parentNode._children.filter((entry) => entry !== child);
    child.parentNode = element;
    const at = element._children.indexOf(anchor);
    if (at === -1) element._children.push(child);
    else element._children.splice(at, 0, child);
    return child;
  };
  element.closest = (selector) => {
    const raw = String(selector || '').trim();
    // Only the two forms the injected script uses: `.class` and `[attr]`.
    const isAttr = raw.startsWith('[') && raw.endsWith(']');
    const wanted = isAttr ? raw.slice(1, -1) : raw.replace(/^\./, '');
    if (!wanted) return null;
    let cursor = element;
    while (cursor) {
      const hit = isAttr
        ? Boolean(cursor._attrs && Object.prototype.hasOwnProperty.call(cursor._attrs, wanted))
        : Array.isArray(cursor._classes) && cursor._classes.includes(wanted);
      if (hit) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  };
  element.contains = (candidate) => {
    if (!candidate) return false;
    if (candidate === element) return true;
    return element._children.some((child) => child.contains ? child.contains(candidate) : child === candidate);
  };
  element.getBoundingClientRect = () => {
    if (!element._rect) throw new Error(`no rect on <${element.tagName} class="${className}">`);
    return element._rect;
  };
  element._listeners = [];
  element.addEventListener = (type, listener) => element._listeners.push({ type, listener, capture: true });
  element.dispatch = (type, event) => {
    for (const entry of element._listeners) {
      if (entry.type !== type) continue;
      entry.listener.call(element, event);
    }
  };
  element.querySelectorAll = (selector) => {
    const wanted = selector.replace(/^\./, '');
    const out = [];
    const walk = (node) => {
      for (const child of node._children) {
        if (child._classes.includes(wanted)) out.push(child);
        walk(child);
      }
    };
    walk(element);
    return out;
  };
  element.querySelector = (selector) => element.querySelectorAll(selector)[0] ?? null;
  return element;
}

function makeTab(id, uri, rect) {
  const tab = makeElement({ className: 'browser-tab', attrs: { 'data-tab-id': String(id) }, rect });
  tab.appendChild(makeElement({ tag: 'span', className: 'browser-tab-title' }));
  tab.appendChild(makeElement({ tag: 'button', className: 'browser-tab-close', attrs: { 'data-tab-close': String(id) }, rect }));
  return tab;
}

/**
 * Build a DOM stub whose tab rects are laid out left→right at 100 px pitch, so
 * "before/after midpoint" boundaries are predictable.
 */
function makeHarness({ order = [0, 1, 2], media = {}, savedOrder = null, toastSink = null } = {}) {
  const tabWidth = 100;
  const container = makeElement({ className: 'browser-tabstrip-tabs' });
  const layout = new Map();

  const tabs = order.map((slot) => {
    const id = slot + 1;
    const left = 4 + slot * (tabWidth + 2);
    const tab = makeTab(id, TAB_URIS[slot], {
      left,
      right: left + tabWidth,
      top: 0,
      bottom: 32,
      width: tabWidth,
      height: 32,
    });
    layout.set(id, slot);
    container.appendChild(tab);
    return tab;
  });
  const newTabButton = makeElement({ tag: 'button', className: 'browser-tab-new' });
  container.appendChild(newTabButton);

  container._rect = { left: 0, right: 600, top: 0, bottom: 36, width: 600, height: 36 };

  const head = makeElement({ tag: 'head' });
  const body = makeElement({ tag: 'body' });
  const documentListeners = [];
  const created = [];
  const documentElement = {
    readyState: 'complete',
    head,
    body,
    getElementById: (id) => [...head._children, ...body._children]
      .find((child) => child._attrs && child._attrs.id === id) || null,
    createElement: (tag) => {
      const element = makeElement({ tag });
      created.push(element);
      return element;
    },
    querySelector: (selector) => (selector === '[data-browser-tabs-container]' ? container : null),
    addEventListener: (type, listener) => documentListeners.push({ type, listener }),
  };

  const storage = new Map();
  if (savedOrder) storage.set(BROWSER_TAB_ORDER_STORAGE_KEY, JSON.stringify(savedOrder));

  const mediaState = {
    [BROWSER_TAB_DRAG_NARROW_QUERY]: Boolean(media.narrow),
    [BROWSER_TAB_DRAG_COARSE_QUERY]: Boolean(media.coarse),
  };
  const observers = [];

  const state = {
    tabs: order.map((slot) => ({
      id: slot + 1,
      current: { uri: TAB_URIS[slot], normalizedUri: TAB_URIS[slot] },
      pinned: false,
    })),
    activeTabId: 1,
  };

  const windowListeners = [];
  const windowStub = {
    matchMedia: (query) => ({
      matches: Boolean(mediaState[query]),
      addEventListener: () => {},
      addListener: () => {},
    }),
    addEventListener: (type, listener) => windowListeners.push({ type, listener }),
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  const context = {
    window: windowStub,
    document: documentElement,
    state,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    },
    console,
    Array,
    Object,
    JSON,
    Number,
    String,
    Math,
    Date,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    showToast: toastSink ? (message) => toastSink.push(message) : () => {},
  };
  context.globalThis = context;
  Object.assign(windowStub, context);

  const domOrder = () => container.querySelectorAll('.browser-tab').map((tab) => Number(tab.getAttribute('data-tab-id')));
  const stateOrder = () => state.tabs.map((tab) => tab.id);
  const savedUris = () => {
    const raw = storage.get(BROWSER_TAB_ORDER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  };
  const indicator = () => container._children.find((child) => child._classes.includes('browser-tab-insert-line')) || null;
  const tabById = (id) => container._children.find((child) => child.getAttribute('data-tab-id') === String(id));
  const fire = (type, event) => container.dispatch(type, event);

  const run = () => vm.runInNewContext(buildBrowserTabDragScript(), context);

  return {
    run,
    container,
    head,
    state,
    setNarrow: (narrow) => {
      mediaState[BROWSER_TAB_DRAG_NARROW_QUERY] = Boolean(narrow);
    },
    fireWindowResize: () => {
      for (const entry of windowListeners) {
        if (entry.type === 'resize') entry.listener({});
      }
    },
    tabs,
    tabById,
    domOrder,
    stateOrder,
    savedUris,
    indicator,
    fire,
    observers,
    documentListeners,
    layout,
  };
}

test('generated drag script parses as valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(buildBrowserTabDragScript()));
});

test('generated drag script carries the wiring markers the host depends on', () => {
  const script = buildBrowserTabDragScript();
  for (const marker of BROWSER_TAB_DRAG_MARKERS) {
    assert.ok(script.includes(marker), `drag script must carry marker ${marker}`);
  }
  // The install guard keeps a re-injection (e.g. a rebuilt srcDoc) idempotent.
  assert.match(script, /if \(globalThis\.__idbotsBrowserTabDragInstalled\) return;/);
});

test('drag script stamps draggable tabs and binds the DnD handlers on the strip', () => {
  const harness = makeHarness();
  harness.run();

  for (const tab of harness.tabs) {
    assert.equal(tab.getAttribute('draggable'), 'true');
    assert.equal(tab.getAttribute('data-tab-drag'), 'ready');
  }
  // Close buttons must never be draggable — click-to-close stays exact.
  for (const tab of harness.tabs) {
    const close = tab.querySelectorAll('.browser-tab-close')[0];
    assert.equal(close.getAttribute('draggable'), 'false');
  }
  const bound = harness.container._listeners.map((entry) => entry.type);
  for (const type of ['dragstart', 'dragover', 'drop', 'dragend', 'dragleave']) {
    assert.ok(bound.includes(type), `strip must bind ${type}`);
  }
});

test('dragstart never relocates the source; neighbours collapse and open on the same transform', () => {
  const harness = makeHarness();
  harness.run();
  const parentBefore = harness.tabs[0].parentNode;

  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, clientY: 10, preventDefault() {}, dataTransfer: null });
  // Native-drag safety (owner ruling 21:33): the source keeps its layout
  // position — only opacity changes. Relocating it makes Chrome cancel the drag.
  assert.ok(!harness.tabs[0].style.position, 'the dragged tab must never be repositioned');
  assert.equal(harness.tabs[0].parentNode, parentBefore, 'the dragged tab must not move in the DOM');
  assert.ok(harness.tabs[0]._classes.includes('is-dragging'), 'the source fades via the class');
  assert.equal(harness.container.getAttribute('data-tab-drag-slot'), '102', 'slot width (tab+gap) is published');
  assert.equal(harness.indicator(), null, 'no insertion line may exist');
  // Drop-back position: collapse (-slot) and opening (+slot) cancel out.
  assert.equal(harness.tabs[1].style.transform, '');
  assert.equal(harness.tabs[2].style.transform, '');

  // Moving right past tab #2: it collapses left, the far tab stays put.
  harness.fire('dragover', { clientX: 205, clientY: 10, preventDefault() {}, dataTransfer: null });
  assert.equal(harness.tabs[1].style.transform, 'translateX(-102px)');
  assert.equal(harness.tabs[2].style.transform, '');
  // At the far right both tabs collapse by one slot.
  harness.fire('dragover', { clientX: 500, clientY: 10, preventDefault() {}, dataTransfer: null });
  assert.equal(harness.tabs[1].style.transform, 'translateX(-102px)');
  assert.equal(harness.tabs[2].style.transform, 'translateX(-102px)');
  assert.ok(!harness.tabs[0].style.position, 'still never repositioned after dragover');
});

test('neighbours yield in both directions and leave no residue', () => {
  const harness = makeHarness();
  harness.run();

  // Drag tab #1 to the far right: both remaining tabs collapse left one slot.
  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, clientY: 10, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 500, clientY: 10, preventDefault() {}, dataTransfer: null });
  assert.equal(harness.tabs[1].style.transform, 'translateX(-102px)');
  assert.equal(harness.tabs[2].style.transform, 'translateX(-102px)');

  // Dragend restores every inline transform and keeps the source in flow.
  harness.fire('dragend', {});
  for (const tab of harness.tabs) {
    assert.equal(tab.style.transform, '');
    assert.ok(!tab.style.position);
  }

  // Drag the last tab to the far left: both remaining tabs open right.
  harness.fire('dragstart', { target: harness.tabs[2], clientX: 250, clientY: 10, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 0, clientY: 10, preventDefault() {}, dataTransfer: null });
  assert.equal(harness.tabs[0].style.transform, 'translateX(102px)', 'left neighbour yields right');
  assert.equal(harness.tabs[1].style.transform, 'translateX(102px)', 'second neighbour yields right');

  harness.fire('drop', { clientX: 0, clientY: 10, preventDefault() {}, dataTransfer: null });
  for (const tab of harness.tabs) {
    assert.equal(tab.style.transform, '', 'no residual transform after drop');
    assert.ok(!tab.style.position, 'the source was never repositioned');
  }
  assert.deepEqual(harness.stateOrder(), [3, 1, 2], 'the drop lands at the far-left boundary');
});

test('the animation layer carries the exact motion contract', () => {
  const script = buildBrowserTabDragScript();
  assert.match(script, /GRAB_MS = 120/);
  assert.match(script, /SETTLE_MS = 150/);
  assert.match(script, /cubic-bezier\(\.2,0,0,1\)/);
  assert.match(script, /transform: scale\(1\.02\) translateY\(-1px\)/);
  assert.match(script, /opacity: \.05/);
  assert.match(script, /border-color: var\(--browser-accent\)/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.match(script, /transition: none !important/);
  assert.doesNotMatch(script, /browser-tab-insert-line/, 'the insertion line is deleted (owner ruling 21:07)');
  assert.match(script, /function settleFrom\(/);
  assert.match(script, /function previewYield\(/);
  assert.match(script, /function resetMotionState\(/);
  assert.match(script, /opacity: \.05/);
  assert.match(script, /data-tab-drag-slot/);
  assert.doesNotMatch(script, /style\.position = 'absolute'/, 'the source must never be relocated (native drag would cancel)');
  assert.doesNotMatch(script, /setDragImage/, 'the native drag image is the floating body');
  assert.doesNotMatch(script, /box-shadow/, 'the motion layer must not introduce shadow decoration');
});

test('drop reorders state.tabs, the DOM, and persists the URI order', () => {
  const harness = makeHarness();
  harness.run();
  assert.deepEqual(harness.domOrder(), [1, 2, 3]);
  assert.deepEqual(harness.stateOrder(), [1, 2, 3]);

  // Drag tab #1 to the very end (pointer past the last tab's midpoint).
  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 295, preventDefault() {}, dataTransfer: null });
  harness.fire('drop', { clientX: 295, preventDefault() {}, dataTransfer: null });

  assert.deepEqual(harness.stateOrder(), [2, 3, 1], 'state.tabs must carry the new order');
  assert.deepEqual(harness.domOrder(), [2, 3, 1], 'the DOM must match before the next renderTabs()');
  assert.deepEqual(harness.savedUris(), [TAB_URIS[1], TAB_URIS[2], TAB_URIS[0]]);
  assert.equal(harness.indicator(), null, 'no insertion line exists after the drop');
  assert.ok(!harness.tabs[0]._classes.includes('is-dragging'), 'dragging state must clear');
  // The "+" button stays after the LAST tab (ABC's own render contract).
  const lastChild = harness.container._children[harness.container._children.length - 1];
  assert.ok(
    lastChild._classes.includes('browser-tab-new'),
    'the new-tab button must stay after the tabs',
  );
  const newTabIndex = harness.container._children.findIndex((child) => child._classes.includes('browser-tab-new'));
  const lastTabIndex = harness.container._children.findLastIndex((child) => child._classes.includes('browser-tab'));
  assert.ok(newTabIndex > lastTabIndex, 'the new-tab button must remain after every tab');
});

test('a drop that would not move the tab writes nothing', () => {
  const harness = makeHarness();
  harness.run();
  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('drop', { clientX: 50, preventDefault() {}, dataTransfer: null });

  assert.deepEqual(harness.stateOrder(), [1, 2, 3]);
  assert.equal(harness.savedUris(), null, 'a no-op drop must not persist an order');
});

test('a drag started on the close button is refused', () => {
  const harness = makeHarness();
  harness.run();
  const close = harness.tabs[1].querySelectorAll('.browser-tab-close')[0];
  let prevented = false;

  harness.fire('dragstart', {
    target: close,
    clientX: 150,
    preventDefault() {
      prevented = true;
    },
    dataTransfer: null,
  });

  assert.equal(prevented, true, 'close-button dragstart must be cancelled');
  assert.ok(!harness.tabs[1]._classes.includes('is-dragging'));
  assert.equal(harness.indicator(), null, 'no insertion line for a refused drag');
});

test('plain clicks are untouched when no move mode is armed', () => {
  const harness = makeHarness();
  harness.run();
  let stopped = 0;
  let prevented = 0;
  const tab = harness.tabs[2];

  harness.fire('click', {
    target: tab.querySelectorAll('.browser-tab-title')[0],
    clientX: 230,
    stopPropagation() {
      stopped += 1;
    },
    preventDefault() {
      prevented += 1;
    },
  });

  // The strip's delegated click handler (owned by ABC) must see the click.
  assert.equal(stopped, 0, 'unarmed clicks must not be swallowed');
  assert.equal(prevented, 0);
  assert.deepEqual(harness.stateOrder(), [1, 2, 3]);
});

test('narrow (5-inch shell) breakpoint disables drag and keeps the strip inert', () => {
  const harness = makeHarness({ media: { narrow: true } });
  harness.run();

  for (const tab of harness.tabs) {
    assert.equal(tab.getAttribute('draggable'), 'false');
    assert.equal(tab.getAttribute('data-tab-drag'), null);
  }

  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 295, preventDefault() {}, dataTransfer: null });
  harness.fire('drop', { clientX: 295, preventDefault() {}, dataTransfer: null });

  assert.deepEqual(harness.stateOrder(), [1, 2, 3], 'no reorder under the narrow breakpoint');
  assert.equal(harness.indicator(), null);
  assert.equal(harness.savedUris(), null);
});

test('coarse pointer falls back to long-press move mode instead of DnD', async () => {
  const toasts = [];
  const harness = makeHarness({ media: { coarse: true }, toastSink: toasts });
  harness.run();

  const source = harness.tabs[0];
  const target = harness.tabs[2];
  const now = Date.now;
  harness.fire('pointerdown', { target: source, clientX: 50, clientY: 16, button: 0 });
  await new Promise((resolve) => setTimeout(resolve, 520));

  assert.ok(source._classes.includes('is-drag-armed'), 'long press must arm the tab');
  assert.equal(toasts.length, 1, 'arming must announce the move mode once');
  assert.match(toasts[0], /Move mode/i, 'the toast must be the move-mode announcement');

  // The press that armed must not also switch tabs.
  let stopped = false;
  harness.fire('click', {
    target: source.querySelectorAll('.browser-tab-title')[0],
    clientX: 50,
    stopPropagation() {
      stopped = true;
    },
    preventDefault() {},
  });
  assert.equal(stopped, true, 'the arming click must be swallowed');
  assert.deepEqual(harness.stateOrder(), [1, 2, 3]);

  // Move mode: clicking the right half of tab #3 places the armed tab after it.
  harness.fire('click', {
    target: target.querySelectorAll('.browser-tab-title')[0],
    clientX: 270,
    stopPropagation() {},
    preventDefault() {},
  });

  assert.deepEqual(harness.stateOrder(), [2, 3, 1], 'long-press move must reorder');
  assert.deepEqual(harness.savedUris(), [TAB_URIS[1], TAB_URIS[2], TAB_URIS[0]]);
  assert.ok(!harness.tabs[0]._classes.includes('is-drag-armed'), 'move mode must clear');
  void now;
});

test('Escape cancels an armed move mode without reordering', async () => {
  const harness = makeHarness({ media: { coarse: true } });
  harness.run();
  harness.fire('pointerdown', { target: harness.tabs[1], clientX: 150, clientY: 16, button: 0 });
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.ok(harness.tabs[1]._classes.includes('is-drag-armed'));

  const keydown = harness.documentListeners.find((entry) => entry.type === 'keydown');
  assert.ok(keydown, 'the script must bind Escape on the document');
  keydown.listener({ key: 'Escape' });

  assert.ok(!harness.tabs[1]._classes.includes('is-drag-armed'));
  assert.deepEqual(harness.stateOrder(), [1, 2, 3]);
  assert.equal(harness.savedUris(), null);
});

test('boot re-applies the persisted order without overwriting it', () => {
  const saved = [TAB_URIS[2], TAB_URIS[0], TAB_URIS[1]];
  const harness = makeHarness({ savedOrder: saved });
  harness.run();

  assert.deepEqual(harness.domOrder(), [3, 1, 2], 'DOM must follow the saved URI order');
  assert.deepEqual(harness.stateOrder(), [3, 1, 2], 'state.tabs must follow it too');
  assert.deepEqual(harness.savedUris(), saved, 'a restore must never rewrite the saved order');
});

test('unknown URIs keep their relative position when the saved order is applied', () => {
  // Only two of three tabs are remembered: the newcomer (id 2) stays put, the
  // remembered pair is ordered relative to it by their saved ranks.
  const harness = makeHarness({ savedOrder: [TAB_URIS[2], TAB_URIS[0]] });
  harness.run();

  assert.deepEqual(harness.domOrder(), [3, 1, 2]);
  assert.deepEqual(harness.stateOrder(), [3, 1, 2]);
});

test('re-render after a drop keeps the user order (renderTabs contract)', () => {
  const harness = makeHarness();
  harness.run();
  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 295, preventDefault() {}, dataTransfer: null });
  harness.fire('drop', { clientX: 295, preventDefault() {}, dataTransfer: null });
  assert.deepEqual(harness.stateOrder(), [2, 3, 1]);

  // Simulate ABC's own renderTabs(): children rebuilt from state.tabs order.
  const byId = new Map(harness.tabs.map((tab) => [Number(tab.getAttribute('data-tab-id')), tab]));
  harness.container._children = harness.container._children.filter((child) => !child._classes.includes('browser-tab'));
  for (const id of harness.stateOrder()) {
    const tab = byId.get(id);
    assert.ok(tab, `tab ${id} must exist in the stub`);
    tab.parentNode = null;
    harness.container.appendChild(tab);
  }
  const observer = harness.observers[0];
  assert.ok(observer, 'the strip must be watched so re-renders re-stamp draggable');
  observer.callback();
  assert.deepEqual(harness.domOrder(), [2, 3, 1], 'a re-render must not undo the drop');
});

test('blank tabs (no URI yet) still hold a persisted order slot', () => {
  // Found in the real-browser run: a New Tab has no URI, so keying the saved
  // order on URI dropped the whole write and the order was lost on restart.
  const harness = makeHarness();
  // Wipe the URIs: three blank tabs, exactly what a fresh strip looks like.
  for (const tab of harness.state.tabs) tab.current = null;
  harness.run();

  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 295, preventDefault() {}, dataTransfer: null });
  harness.fire('drop', { clientX: 295, preventDefault() {}, dataTransfer: null });

  assert.deepEqual(harness.stateOrder(), [2, 3, 1]);
  assert.deepEqual(
    harness.savedUris(),
    ['blank#1', 'blank#2', 'blank#3'],
    'blank tabs must persist as ordered occurrence tokens',
  );
});

test('switching screens re-stamps draggable (no stale arming from the other screen)', () => {
  const harness = makeHarness();
  harness.run();
  assert.equal(harness.tabs[0].getAttribute('draggable'), 'true');

  harness.setNarrow(true);
  harness.fireWindowResize();
  for (const tab of harness.tabs) {
    assert.equal(tab.getAttribute('draggable'), 'false', 'narrow must disarm at runtime');
  }

  harness.setNarrow(false);
  harness.fireWindowResize();
  for (const tab of harness.tabs) {
    assert.equal(tab.getAttribute('draggable'), 'true', 'wide must re-arm at runtime');
  }
});

test('narrow floor also refuses the long-press fallback', async () => {
  const toasts = [];
  const harness = makeHarness({ media: { coarse: true, narrow: true }, toastSink: toasts });
  harness.run();
  harness.fire('pointerdown', { target: harness.tabs[0], clientX: 50, clientY: 16, button: 0 });
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.ok(!harness.tabs[0]._classes.includes('is-drag-armed'));
  assert.deepEqual(toasts, []);
});

test('a free tab can never be dropped into the pinned segment (next render would snap it back)', () => {
  const harness = makeHarness();
  // Tab #1 pinned: ABC renders it first and keeps it first on every render.
  harness.state.tabs[0].pinned = true;
  harness.run();

  // Try to drop the (free) last tab before the pinned one.
  harness.fire('dragstart', { target: harness.tabs[2], clientX: 250, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 10, preventDefault() {}, dataTransfer: null });
  // The clamped boundary is 1 (right after the pinned tab): only the free tab
  // at index 1 yields right; the pinned tab itself never moves.
  assert.equal(harness.tabs[0].style.transform, '', 'the pinned tab must not yield');
  assert.equal(harness.tabs[1].style.transform, 'translateX(102px)', 'the free neighbour yields right');
  harness.fire('drop', { clientX: 10, preventDefault() {}, dataTransfer: null });

  const order = harness.stateOrder();
  assert.equal(order[0], 1, 'the pinned tab must stay first');
  assert.deepEqual(order, [1, 3, 2], 'the drop lands right after the pinned segment');
  assert.deepEqual(harness.savedUris(), [TAB_URIS[0], TAB_URIS[2], TAB_URIS[1]]);
});

test('a pinned tab may still be reordered among pinned tabs', () => {
  const harness = makeHarness();
  harness.state.tabs[0].pinned = true;
  harness.state.tabs[1].pinned = true;
  harness.run();

  // Past tab #2's midpoint (156) → boundary after it.
  harness.fire('dragstart', { target: harness.tabs[0], clientX: 50, preventDefault() {}, dataTransfer: null });
  harness.fire('dragover', { clientX: 160, preventDefault() {}, dataTransfer: null });
  harness.fire('drop', { clientX: 160, preventDefault() {}, dataTransfer: null });

  assert.deepEqual(harness.stateOrder(), [2, 1, 3], 'pinned tabs reorder among themselves');
  assert.deepEqual(harness.savedUris(), [TAB_URIS[1], TAB_URIS[0], TAB_URIS[2]]);
});
