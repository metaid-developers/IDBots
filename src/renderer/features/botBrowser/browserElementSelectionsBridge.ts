import type { BrowserElementSelectionsSnapshot } from '@openagentinternet/agent-browser-host-contract';

/**
 * Renderer-side transport for the ABC element picker (v0.10.0).
 *
 * The Bot Browser page runs inside a srcDoc iframe, so the host talks to it
 * with the message bridge documented in
 * agent-browser-core/docs/browser-element-picker-host-integration.md:
 *
 * - request  `agent-browser:get-element-selections`  -> `:response` (snapshot
 *   or `error.code === "tab_not_found"`)
 * - request  `agent-browser:clear-element-selections` -> `:response`
 *   (`result = { tabId, cleared: true }`)
 * - push     `agent-browser:event` / `element-selections-changed` — payload
 *   carries counts only, so every push is followed by a fresh read.
 *
 * The envelope conventions mirror the existing get-content / get-tab-info
 * bridge (requestId correlation + timeout), and inbound events are only
 * accepted from the frame's own window (enforced by the caller's
 * `event.source` guard before dispatching here).
 */

export type BrowserElementSelectionsClearResult = { tabId: number | string; cleared: boolean };

export interface BrowserElementSelectionsBridgeOptions {
  /** Posts one envelope into the Browser frame; false when no frame is mounted. */
  postToFrame(payload: Record<string, unknown>): boolean;
  /** Called with every freshly fetched snapshot after a changed-event push. */
  onSnapshot(snapshot: BrowserElementSelectionsSnapshot): void;
  timeoutMs?: number;
  /** Trailing debounce for changed-event refetches (tests pass 0). */
  refetchDebounceMs?: number;
  setTimeoutImpl?: (handler: () => void, timeout: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

type BridgeFrameMessage = {
  type?: unknown;
  version?: unknown;
  event?: unknown;
  payload?: { tabId?: unknown } | null;
  requestId?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

type PendingBrowserRequest = {
  responseType: string;
  resolve(result: unknown): void;
  reject(error: Error & { code?: string }): void;
  timeout: unknown;
};

const GET_SELECTIONS_REQUEST = 'agent-browser:get-element-selections';
const GET_SELECTIONS_RESPONSE = 'agent-browser:get-element-selections:response';
const CLEAR_SELECTIONS_REQUEST = 'agent-browser:clear-element-selections';
const CLEAR_SELECTIONS_RESPONSE = 'agent-browser:clear-element-selections:response';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFETCH_DEBOUNCE_MS = 120;

export class BrowserElementSelectionsRequestError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BrowserElementSelectionsRequestError';
    this.code = code;
  }
}

export function createBrowserElementSelectionsBridge(options: BrowserElementSelectionsBridgeOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refetchDebounceMs = options.refetchDebounceMs ?? DEFAULT_REFETCH_DEBOUNCE_MS;
  const setTimeoutImpl = options.setTimeoutImpl
    ?? ((handler: () => void, timeout: number) => globalThis.setTimeout(handler, timeout));
  const clearTimeoutImpl = options.clearTimeoutImpl
    ?? ((handle: unknown) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]));

  const pendingRequests = new Map<string, PendingBrowserRequest>();
  let requestSequence = 0;
  let refetchTimer: unknown = null;
  let refetchTabId: number | string | undefined;
  let disposed = false;

  const failPending = (error: Error & { code?: string }) => {
    for (const pending of pendingRequests.values()) {
      clearTimeoutImpl(pending.timeout);
      pending.reject(error);
    }
    pendingRequests.clear();
  };

  const requestFrame = <T>(
    requestType: string,
    responseType: string,
    tabId: number | string | undefined,
  ): Promise<T> => {
    if (disposed) {
      return Promise.reject(new BrowserElementSelectionsRequestError('disposed', 'Bot Browser surface was closed.'));
    }
    const requestId = `element-selections-${++requestSequence}`;
    const envelope: Record<string, unknown> = { type: requestType, requestId };
    if (tabId !== undefined && tabId !== null) envelope.tabId = tabId;
    // Everything (timeout arm, pending entry, frame post) lives inside the
    // executor so a failed post clears its own timer instead of firing a
    // later rejection nobody handles.
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeoutImpl(() => {
        pendingRequests.delete(requestId);
        reject(new BrowserElementSelectionsRequestError(
          'timeout',
          'Bot Browser element selections request timed out.',
        ));
      }, timeoutMs);
      pendingRequests.set(requestId, { responseType, resolve: resolve as (result: unknown) => void, reject, timeout });
      if (!options.postToFrame(envelope)) {
        pendingRequests.delete(requestId);
        clearTimeoutImpl(timeout);
        reject(new BrowserElementSelectionsRequestError(
          'frame_unavailable',
          'Bot Browser frame is not available.',
        ));
      }
    });
  };

  const fetchSnapshot = (tabId: number | string | undefined): Promise<BrowserElementSelectionsSnapshot | null> =>
    requestFrame<BrowserElementSelectionsSnapshot>(GET_SELECTIONS_REQUEST, GET_SELECTIONS_RESPONSE, tabId)
      .then((snapshot) => snapshot ?? null)
      .catch((error: unknown) => {
        // Unknown tab mirrors getTabInfo semantics: null, not a rejection.
        if (error instanceof BrowserElementSelectionsRequestError && error.code === 'tab_not_found') return null;
        throw error;
      });

  const scheduleRefetch = (tabId: unknown) => {
    refetchTabId = typeof tabId === 'number' && Number.isFinite(tabId)
      ? tabId
      : typeof tabId === 'string' && tabId
        ? tabId
        : undefined;
    if (refetchTimer !== null) return;
    refetchTimer = setTimeoutImpl(() => {
      refetchTimer = null;
      const tabId = refetchTabId;
      refetchTabId = undefined;
      fetchSnapshot(tabId)
        .then((snapshot) => {
          if (snapshot) options.onSnapshot(snapshot);
        })
        .catch(() => {
          // Marks are best-effort context: a failed refetch is retried by the
          // next changed event or the next turn capture, never surfaced.
        });
    }, refetchDebounceMs);
  };

  /**
   * Consumes one message from the Browser frame window. Returns false for
   * anything that is not part of this bridge so the caller can keep routing
   * (the idbots-iframe-bridge branches run after this one).
   */
  const handleMessage = (data: unknown): boolean => {
    const message = (data || {}) as BridgeFrameMessage;
    if (typeof message.type !== 'string') return false;
    if (message.type === 'agent-browser:event') {
      if (message.version !== 1 || message.event !== 'element-selections-changed') return false;
      if (!message.payload || typeof message.payload !== 'object') return false;
      scheduleRefetch(message.payload.tabId);
      return true;
    }
    if (message.type !== GET_SELECTIONS_RESPONSE && message.type !== CLEAR_SELECTIONS_RESPONSE) return false;
    const requestId = String(message.requestId ?? '');
    const pending = requestId ? pendingRequests.get(requestId) : undefined;
    if (!pending || pending.responseType !== message.type) return true;
    pendingRequests.delete(requestId);
    clearTimeoutImpl(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
      return true;
    }
    const error = message.error || {};
    pending.reject(new BrowserElementSelectionsRequestError(
      typeof error.code === 'string' ? error.code : 'invalid_request',
      typeof error.message === 'string' && error.message ? error.message : 'Bot Browser element selections request failed.',
    ));
    return true;
  };

  const clearElementSelections = (
    tabId: number | string | undefined,
  ): Promise<BrowserElementSelectionsClearResult | null> =>
    requestFrame<BrowserElementSelectionsClearResult>(CLEAR_SELECTIONS_REQUEST, CLEAR_SELECTIONS_RESPONSE, tabId)
      .then((result) => result ?? null)
      .catch((error: unknown) => {
        if (error instanceof BrowserElementSelectionsRequestError && error.code === 'tab_not_found') return null;
        throw error;
      });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (refetchTimer !== null) {
      clearTimeoutImpl(refetchTimer);
      refetchTimer = null;
    }
    failPending(new BrowserElementSelectionsRequestError('disposed', 'Bot Browser surface was closed.'));
  };

  return {
    handleMessage,
    getElementSelections: fetchSnapshot,
    clearElementSelections,
    dispose,
  };
}

export type BrowserElementSelectionsBridge = ReturnType<typeof createBrowserElementSelectionsBridge>;
