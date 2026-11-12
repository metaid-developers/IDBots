import type { BrowserPageDefinition } from '@openagentinternet/agent-browser-ui/browser';

export const BROWSER_INIT_MARKER = "if (document.readyState === 'loading') {";

export function buildBrowserIframeBridgeScript(): string {
  return `
(function installIdbotsBrowserIframeBridge() {
  var BRIDGE_SOURCE = 'idbots-browser-iframe-bridge';
  var PARENT_SOURCE = 'idbots-browser-surface';
  var targetOrigin = '*';
  var nativeFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : null;
  var pendingRequests = {};
  var requestSeq = 0;
  var runtimeReady = false;
  var runtimeReadyPromise = null;
  var runtimeLoadSeq = 0;
  var readyPosted = false;

  if (globalThis.__idbotsBrowserIframeBridgeInstalled) {
    return;
  }
  globalThis.__idbotsBrowserIframeBridgeInstalled = true;

  // Window dragging: CSS -webkit-app-region is not honored inside this srcDoc
  // iframe, so emulate it. Blank areas of the ABC tabstrip/toolbar forward drag
  // deltas to the host, which moves the window. Interactive children (tabs,
  // buttons, address form, links) never start a drag.
  var windowDragState = null;
  function isDragInteractive(el) {
    return Boolean(el && el.closest && el.closest('button, input, a, select, textarea, [role="button"], .browser-tab, .browser-tab-close, .browser-tab-new, .browser-address-form'));
  }
  function isWindowDragSurface(el) {
    return Boolean(el && el.closest && el.closest('.browser-tabstrip, .browser-nav')) && !isDragInteractive(el);
  }
  document.addEventListener('mousedown', function (event) {
    if (event.button !== 0 || !isWindowDragSurface(event.target)) return;
    windowDragState = { x: event.screenX, y: event.screenY };
    event.preventDefault();
  }, true);
  document.addEventListener('mousemove', function (event) {
    if (!windowDragState) return;
    var dx = event.screenX - windowDragState.x;
    var dy = event.screenY - windowDragState.y;
    if (!dx && !dy) return;
    windowDragState = { x: event.screenX, y: event.screenY };
    window.parent.postMessage({
      source: BRIDGE_SOURCE,
      type: 'window-drag-move',
      dx: dx,
      dy: dy
    }, targetOrigin);
  }, true);
  document.addEventListener('mouseup', function () {
    windowDragState = null;
  }, true);

  function textValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function isRequest(value) {
    return typeof Request !== 'undefined' && value instanceof Request;
  }

  function requestUrl(input) {
    if (isRequest(input)) return input.url;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    return String(input);
  }

  function requestMethod(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (isRequest(input) && input.method) return String(input.method).toUpperCase();
    return 'GET';
  }

  function browserUrl(input) {
    try {
      return new URL(requestUrl(input), 'http://idbots.local');
    } catch (error) {
      return null;
    }
  }

  function shouldInterceptFetch(input) {
    var url = browserUrl(input);
    return Boolean(url && url.pathname.indexOf('/api/browser/') === 0);
  }

  function parseBodyText(raw) {
    var value = String(raw || '');
    if (!value.trim()) return undefined;
    try {
      return JSON.parse(value);
    } catch (error) {
      return value;
    }
  }

  async function normalizeBody(body) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return parseBodyText(body);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return parseBodyText(body.toString());
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      var formRecord = {};
      body.forEach(function (value, key) {
        formRecord[key] = typeof value === 'string' ? value : String(value && value.name ? value.name : '');
      });
      return formRecord;
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return parseBodyText(await body.text());
    }
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer && typeof TextDecoder !== 'undefined') {
      return parseBodyText(new TextDecoder().decode(body));
    }
    return body;
  }

  async function requestBody(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      return normalizeBody(init.body);
    }
    if (!isRequest(input)) return undefined;

    var method = requestMethod(input, init);
    if (method === 'GET' || method === 'HEAD') return undefined;

    try {
      return parseBodyText(await input.clone().text());
    } catch (error) {
      return undefined;
    }
  }

  function endpointResponse(data) {
    var pending = pendingRequests[data.id];
    if (!pending) return;
    delete pendingRequests[data.id];
    clearTimeout(pending.timeout);
    if (data.error) {
      pending.reject(new Error(String(data.error)));
      return;
    }
    pending.resolve(data.response || {
      status: 500,
      body: {
        ok: false,
        state: 'failed',
        code: 'missing_endpoint_response',
        message: 'Browser endpoint response was missing.'
      }
    });
  }

  // Default 30s is fine for gallery/resolve. llm-complete (and other trusted
  // actions that wait on the host LLM / user confirm) can take up to the
  // bridge contract max (180s). A hard 30s here aborts while the host is still
  // running — MetaApp then sees llm_unavailable "Browser endpoint request timed out."
  var ENDPOINT_TIMEOUT_DEFAULT_MS = 30000;
  var ENDPOINT_TIMEOUT_ACTIONS_MS = 180000;

  function endpointTimeoutMs(request) {
    var url = String((request && request.url) || '');
    // Trusted actions (llm-complete / pin-write / permissions) all go here and
    // may wait on the host LLM or a user confirmation card.
    if (url.indexOf('/api/browser/actions') !== -1) return ENDPOINT_TIMEOUT_ACTIONS_MS;
    return ENDPOINT_TIMEOUT_DEFAULT_MS;
  }

  async function fetchBrowserEndpoint(input, init) {
    var id = 'endpoint-' + (++requestSeq);
    var request = {
      url: requestUrl(input),
      method: requestMethod(input, init),
      body: await requestBody(input, init)
    };
    var waitMs = endpointTimeoutMs(request);

    var response = await new Promise(function (resolve, reject) {
      pendingRequests[id] = {
        resolve: resolve,
        reject: reject,
        timeout: setTimeout(function () {
          if (!pendingRequests[id]) return;
          delete pendingRequests[id];
          reject(new Error('Browser endpoint request timed out.'));
        }, waitMs)
      };

      window.parent.postMessage({
        source: BRIDGE_SOURCE,
        type: 'endpoint-request',
        id: id,
        request: request
      }, targetOrigin);
    });

    return new Response(JSON.stringify(response.body), {
      status: response.status || 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  if (nativeFetch) {
    globalThis.fetch = function idbotsBrowserBridgeFetch(input, init) {
      if (shouldInterceptFetch(input)) {
        return fetchBrowserEndpoint(input, init);
      }
      return nativeFetch(input, init);
    };
  }

  function toast(message) {
    if (typeof globalThis.showToast === 'function') {
      globalThis.showToast(message);
    }
  }

  function postReady() {
    if (readyPosted) return;
    readyPosted = true;
    window.parent.postMessage({
      source: BRIDGE_SOURCE,
      type: 'browser-ready'
    }, targetOrigin);
  }

  function runtimeApisReady() {
    return typeof globalThis.navigateTo === 'function'
      && typeof globalThis.selectUsingIdentity === 'function'
      && globalThis.AgentBrowserTabs
      && typeof globalThis.AgentBrowserTabs.openTab === 'function'
      && typeof globalThis.AgentBrowserTabs.closeTab === 'function'
      && typeof globalThis.AgentBrowserTabs.switchTab === 'function'
      && typeof globalThis.AgentBrowserTabs.getTabs === 'function'
      && typeof globalThis.AgentBrowserTabs.getActiveTab === 'function';
  }

  function ensureRuntimeReady(options) {
    var forceReload = Boolean(options && options.forceReload);
    if (!forceReload && runtimeReady && runtimeApisReady()) {
      return Promise.resolve();
    }
    if (!forceReload && runtimeReadyPromise) {
      return runtimeReadyPromise;
    }
    runtimeReady = false;
    var loadSeq = ++runtimeLoadSeq;
    var loadPromise = (async function () {
      if (typeof globalThis.loadRuntime !== 'function') {
        throw new Error('Browser runtime loader is not ready.');
      }
      await globalThis.loadRuntime();
      if (typeof globalThis.navigateTo !== 'function') {
        throw new Error('Browser navigation is not ready.');
      }
      if (typeof globalThis.selectUsingIdentity !== 'function') {
        throw new Error('Browser actor selection is not ready.');
      }
      if (loadSeq === runtimeLoadSeq) {
        runtimeReady = true;
        postReady();
      }
    })();
    runtimeReadyPromise = loadPromise.catch(function (error) {
      if (loadSeq === runtimeLoadSeq) {
        runtimeReady = false;
        runtimeReadyPromise = null;
      }
      throw error;
    });
    return runtimeReadyPromise;
  }

  async function handleOpenUri(input) {
    try {
      var uri = textValue(input && input.uri);
      var actorId = textValue(input && input.actorId);
      var newTab = Boolean(input && input.newTab);
      if (!uri) {
        throw new Error('Browser URI is required.');
      }
      await ensureRuntimeReady();
      // newTab marks user-initiated opens (chat links, deliverables, avatar bot
      // pages): openTab creates + activates a fresh tab and seeds the actor onto
      // it directly. selectUsingIdentity is only correct for the navigate-in-place
      // path — it writes the actor onto the currently active tab.
      if (newTab && typeof globalThis.AgentBrowserTabs.openTab === 'function') {
        var openLabel = textValue(input && input.label);
        if (openLabel || actorId) {
          globalThis.AgentBrowserTabs.openTab(uri, openLabel
            ? Object.assign({ label: openLabel }, actorId ? { actorId: actorId } : {})
            : actorId);
        } else {
          globalThis.AgentBrowserTabs.openTab(uri);
        }
        return;
      }
      if (actorId) {
        await globalThis.selectUsingIdentity(actorId);
      }
      await globalThis.navigateTo(uri);
    } catch (error) {
      toast(error && error.message ? error.message : String(error));
    }
  }

  async function handleOpenNewTab() {
    try {
      await ensureRuntimeReady();
      globalThis.AgentBrowserTabs.openTab();
    } catch (error) {
      toast(error && error.message ? error.message : String(error));
    }
  }

  function tabCommandResult(action, openedTabId) {
    var tabs = globalThis.AgentBrowserTabs.getTabs();
    var activeTab = globalThis.AgentBrowserTabs.getActiveTab();
    var result = {
      action: action,
      tabs: Array.isArray(tabs) ? tabs : [],
      activeTab: activeTab || null
    };
    if (openedTabId !== undefined) {
      result.openedTabId = openedTabId;
    }
    return result;
  }

  async function handleTabCommand(id, command) {
    try {
      await ensureRuntimeReady();
      var input = command && typeof command === 'object' ? command : {};
      var action = textValue(input.action);
      var openedTabId;
      var extra;

      if (action === 'open-tab') {
        var openLabel = textValue(input.label);
        var openOptions = {};
        if (openLabel) openOptions.label = openLabel;
        if (input.dedupe === false) openOptions.dedupe = false;
        openedTabId = Object.keys(openOptions).length
          ? globalThis.AgentBrowserTabs.openTab(textValue(input.uri) || undefined, openOptions)
          : globalThis.AgentBrowserTabs.openTab(textValue(input.uri) || undefined);
      } else if (action === 'navigate-tab') {
        // Resolve into a SPECIFIC tab. Background Live Stage updates restore
        // the user's previous tab synchronously; final reports pass activate
        // so the target stays active through resolve and paints its content.
        // ABC's resolveUri snapshots the originating tab synchronously.
        var navTabId = Number(input.tabId);
        var tabsNow = globalThis.AgentBrowserTabs.getTabs();
        var targetExists = false;
        for (var tabIndex = 0; tabIndex < tabsNow.length; tabIndex += 1) {
          if (tabsNow[tabIndex] && tabsNow[tabIndex].id === navTabId) { targetExists = true; break; }
        }
        if (!targetExists) {
          throw new Error('Bot Browser tab ' + navTabId + ' does not exist.');
        }
        var previousActive = globalThis.AgentBrowserTabs.getActiveTab();
        var activateTarget = input.activate === true;
        globalThis.AgentBrowserTabs.switchTab(navTabId);
        var navigation;
        try {
          navigation = globalThis.navigateTo(textValue(input.uri));
        } finally {
          if (!activateTarget && previousActive && previousActive.id !== navTabId) {
            globalThis.AgentBrowserTabs.switchTab(previousActive.id);
          }
        }
        await navigation;
      } else if (action === 'close-tab') {
        globalThis.AgentBrowserTabs.closeTab(Number(input.tabId));
      } else if (action === 'switch-tab') {
        globalThis.AgentBrowserTabs.switchTab(Number(input.tabId));
      } else if (action === 'get-content' || action === 'get-tab-info') {
        if (typeof globalThis.AgentBrowserTabs.getTabContent !== 'function'
          || typeof globalThis.AgentBrowserTabs.getTabInfo !== 'function') {
          throw new Error('This Bot Browser build does not support tab content extraction.');
        }
        var tabIdArg = input.tabId === undefined || input.tabId === null ? undefined : Number(input.tabId);
        extra = action === 'get-content'
          ? { content: globalThis.AgentBrowserTabs.getTabContent(tabIdArg) }
          : { info: globalThis.AgentBrowserTabs.getTabInfo(tabIdArg) };
      } else if (action !== 'get-tabs' && action !== 'get-active-tab') {
        throw new Error('Unsupported Bot Browser tab action: ' + action);
      }

      window.parent.postMessage({
        source: BRIDGE_SOURCE,
        type: 'tab-command-response',
        id: id,
        success: true,
        result: Object.assign(tabCommandResult(action, openedTabId), extra || {})
      }, targetOrigin);
    } catch (error) {
      window.parent.postMessage({
        source: BRIDGE_SOURCE,
        type: 'tab-command-response',
        id: id,
        success: false,
        error: error && error.message ? error.message : String(error)
      }, targetOrigin);
    }
  }

  async function handleRefreshRuntime() {
    try {
      await ensureRuntimeReady({ forceReload: true });
    } catch (error) {
      toast(error && error.message ? error.message : String(error));
    }
  }

  function localPreviewPath(uri) {
    var value = textValue(uri);
    if (value.indexOf('preview-metaapp://localhost/') !== 0) return '';
    try {
      return new URL(value).pathname;
    } catch (error) {
      return '';
    }
  }

  function liveStageReportNavigationAllowed(activeTab, turnId, reportUri) {
    var stagePath = localPreviewPath(activeTab && activeTab.uri);
    var reportPath = localPreviewPath(reportUri);
    var stageSuffix = '/live-stage-' + textValue(turnId) + '.html';
    if (!stagePath || !reportPath || !textValue(turnId)) return false;
    if (stagePath.slice(-stageSuffix.length) !== stageSuffix) return false;
    if (reportPath === stagePath || reportPath.slice(-stageSuffix.length) === stageSuffix) return false;
    var stageDirectory = stagePath.slice(0, stagePath.lastIndexOf('/') + 1);
    return reportPath.slice(0, stageDirectory.length) === stageDirectory;
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.source === 'idbots-live-stage' && data.type === 'open-report') {
      var reportTab = globalThis.AgentBrowserTabs && globalThis.AgentBrowserTabs.getActiveTab();
      var reportFrame = typeof globalThis.currentBrowserHtmlFrameWindow === 'function'
        ? globalThis.currentBrowserHtmlFrameWindow()
        : null;
      if (reportFrame && event.source === reportFrame
        && liveStageReportNavigationAllowed(reportTab, data.turnId, data.uri)) {
        Promise.resolve(globalThis.navigateTo(textValue(data.uri))).catch(function (error) {
          toast(error && error.message ? error.message : String(error));
        });
      }
      return;
    }
    // Live Stage interaction click relay: the stage card hands its answer to
    // the shell; the shell forwards it to the host renderer, which submits it
    // to main. Main re-validates requestId + single-use token against the
    // pending card, so a relayed entry is a hint, not an authority. Only the
    // current html frame's posts are eligible, and only well-shaped entries.
    if (data.source === 'idbots-live-stage' && data.type === 'stage-interaction') {
      var stageFrame = typeof globalThis.currentBrowserHtmlFrameWindow === 'function'
        ? globalThis.currentBrowserHtmlFrameWindow()
        : null;
      var entry = data.entry;
      var entryShapeOk = entry && typeof entry === 'object'
        && typeof entry.requestId === 'string' && entry.requestId
        && typeof entry.token === 'string' && entry.token
        && (entry.behavior === 'allow' || entry.behavior === 'deny');
      if (stageFrame && event.source === stageFrame && entryShapeOk) {
        window.parent.postMessage({
          source: PARENT_SOURCE,
          type: 'stage-interaction',
          entry: entry
        }, '*');
      }
      return;
    }
    if (event.source !== window.parent) return;
    if (!data || data.source !== PARENT_SOURCE) return;
    if (data.type === 'endpoint-response') {
      endpointResponse(data);
      return;
    }
    if (data.type === 'open-uri') {
      handleOpenUri(data.input);
      return;
    }
    if (data.type === 'open-new-tab') {
      handleOpenNewTab();
      return;
    }
    if (data.type === 'tab-command') {
      handleTabCommand(data.id, data.command);
      return;
    }
    if (data.type === 'refresh-runtime') {
      handleRefreshRuntime();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      Promise.resolve().then(function () {
        return ensureRuntimeReady();
      }).catch(function (error) {
        toast(error && error.message ? error.message : String(error));
      });
    });
  } else {
    Promise.resolve().then(function () {
      return ensureRuntimeReady();
    }).catch(function (error) {
      toast(error && error.message ? error.message : String(error));
    });
  }
})();
`;
}

/**
 * The MetaApp preview iframe sandbox is decided upstream by ABC's
 * htmlFrameSandbox(url) (see @openagentinternet/agent-browser-ui), which the
 * served page concatenates at runtime. IDBots therefore must not post-process
 * the rendered HTML to re-add allow-same-origin: it would contradict the
 * upstream "same-origin frames stay opaque" design and cannot reach the
 * runtime-built attribute anyway. The token list is extended with allow-forms
 * via patches/@openagentinternet+agent-browser-ui+0.6.0.patch.
 */
export function injectBrowserIframeBridge(
  definition: BrowserPageDefinition,
): BrowserPageDefinition {
  const bridgeScript = buildBrowserIframeBridgeScript();
  const sourceScript = definition.script || '';
  const markerIndex = sourceScript.indexOf(BROWSER_INIT_MARKER);
  const script = markerIndex === -1
    ? `${bridgeScript}\n${sourceScript}`
    : `${sourceScript.slice(0, markerIndex)}${bridgeScript}\n${sourceScript.slice(markerIndex)}`;

  return {
    ...definition,
    script,
  };
}
