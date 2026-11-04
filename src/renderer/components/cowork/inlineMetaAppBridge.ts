/**
 * inlineMetaAppBridge — protocol helpers for MetaApps embedded in assistant
 * chat bubbles (InlineMetaAppBlock).
 *
 * A MetaApp page talks to its embedder through the AgentBrowser bridge v1
 * (`window.parent.postMessage` with `agent-browser:request` /
 * `agent-browser:navigate`, answered by `agent-browser:response` and pushed
 * `agent-browser:event` frames). Inside the Bot Browser that embedder is the
 * ABC client (@openagentinternet/agent-browser-ui); inside a chat bubble it is
 * the block in the IDBots renderer. Both speak the same wire protocol so one
 * published app runs unchanged on either surface, and the block routes every
 * trusted action to the same main-process IPC the Bot Browser uses
 * (botBrowser:writeMetaIdPin / uploadMetaFile / completeLlm /
 * requestPermissions) — validation, confirmation tokens, permission grants and
 * signing all stay in botBrowserBridgeService. What the bubble adds is the
 * acting identity: the session's Bot is the Actor, so the app signs as that Bot
 * without an Actor picker.
 *
 * Everything here is DOM-free on purpose: the renderer tests are
 * server-rendered (no jsdom), so they drive these helpers directly and pin the
 * component wiring through source assertions.
 */

export const INLINE_METAAPP_BRIDGE_VERSION = 1;

/** Bridge methods ABC answers for a MetaApp frame; anything else is unsupported_method. */
export const INLINE_METAAPP_SUPPORTED_METHODS = new Set([
  'browser.actor.current',
  'metaid.pin.write',
  'metafile.upload',
  'browser.llm.complete',
  'browser.permissions.request',
]);

/**
 * Bridge methods that exist in the Bot Browser but need surfaces the bubble
 * does not have (compose modals, Agent-Game session panels). They fail with an
 * explicit "open in Bot Browser" message instead of silently hanging.
 */
export const INLINE_METAAPP_BROWSER_ONLY_METHODS = new Set([
  'browser.privateChat.compose',
  'browser.simplemsg.compose',
  // Purchase confirmation card lives in the Bot Browser chrome; the bubble
  // has no surface for the two-phase NFT purchase approval.
  'browser.nft.buy',
  'browser.mrc721.buy',
  'browser.app.session.start',
  'browser.app.session.list',
  'browser.app.session.status',
  'browser.app.session.pause',
  'browser.app.session.resume',
  'browser.app.session.stop',
]);

/** Frame height bounds: the app frame is a viewport with its own scrolling, not a content-sized document. */
export const INLINE_METAAPP_MIN_HEIGHT = 240;
export const INLINE_METAAPP_MAX_HEIGHT = 1400;
export const INLINE_METAAPP_DEFAULT_HEIGHT = 480;

const METAAPP_PIN_ID_RE = /^[0-9a-f]{64}i\d+$/i;
const METAAPP_EMBED_SCHEME_RE = /^metaapp:\/\//i;
/** Mirrors ABC's isBrowserInternalHref: the only targets an in-app navigate may name. */
const AGENT_INTERNET_NAVIGATE_RE = /^(metaid|metaapp|metafile|map|pin):\/\//i;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse a markdown image destination as a MetaApp embed. Accepts
 * `metaapp://<pinId>` (optionally percent-encoded, with a trailing slash,
 * query or fragment, which are dropped) and returns the normalized URI plus
 * the lowercase pin id, or null when the destination is not a MetaApp pin.
 */
export const parseMetaAppEmbedUri = (src: unknown): { uri: string; pinId: string } | null => {
  const raw = text(src);
  if (!raw || !METAAPP_EMBED_SCHEME_RE.test(raw)) return null;
  const remainder = raw.replace(METAAPP_EMBED_SCHEME_RE, '');
  const head = remainder.split(/[/?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(head);
  } catch {
    return null;
  }
  const pinId = decoded.trim().toLowerCase();
  if (!METAAPP_PIN_ID_RE.test(pinId)) return null;
  return { uri: `metaapp://${pinId}`, pinId };
};

export const clampInlineMetaAppHeight = (height: number): number => {
  if (!Number.isFinite(height)) return INLINE_METAAPP_DEFAULT_HEIGHT;
  return Math.min(INLINE_METAAPP_MAX_HEIGHT, Math.max(INLINE_METAAPP_MIN_HEIGHT, Math.round(height)));
};

export interface InlineMetaAppBridgeRequest {
  type: 'request';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface InlineMetaAppBridgeNavigate {
  type: 'navigate';
  uri: string;
}

export type InlineMetaAppBridgeMessage = InlineMetaAppBridgeRequest | InlineMetaAppBridgeNavigate;

/**
 * Validate a window 'message' event from the app frame. The source must be
 * exactly this block's iframe contentWindow (several blocks share the window
 * bus, and a nested frame inside the app must not reach the host), and the
 * payload must be a v1 bridge frame: a request carries a non-empty id and
 * method, a navigate carries a uri. Params default to {} so handlers can read
 * fields without null checks. Anything else returns null and is ignored.
 */
export const parseInlineMetaAppBridgeMessage = (
  data: unknown,
  source: unknown,
  iframeWindow: unknown,
): InlineMetaAppBridgeMessage | null => {
  if (!iframeWindow || source !== iframeWindow) return null;
  if (!isPlainObject(data)) return null;
  if (data.version !== INLINE_METAAPP_BRIDGE_VERSION) return null;
  if (data.type === 'agent-browser:navigate') {
    const uri = text(data.uri);
    return uri ? { type: 'navigate', uri } : null;
  }
  if (data.type !== 'agent-browser:request') return null;
  const id = text(data.id);
  const method = text(data.method);
  if (!id || !method) return null;
  return {
    type: 'request',
    id,
    method,
    params: isPlainObject(data.params) ? data.params : {},
  };
};

export interface InlineMetaAppBridgeError {
  code: string;
  message: string;
}

export interface InlineMetaAppBridgeResponse {
  type: 'agent-browser:response';
  version: typeof INLINE_METAAPP_BRIDGE_VERSION;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: InlineMetaAppBridgeError;
}

/** Build the response frame the app's AgentBrowser helper resolves/rejects on. */
export const buildInlineMetaAppBridgeResponse = (
  id: string,
  ok: boolean,
  payload?: unknown,
): InlineMetaAppBridgeResponse => {
  const response: InlineMetaAppBridgeResponse = {
    type: 'agent-browser:response',
    version: INLINE_METAAPP_BRIDGE_VERSION,
    id,
    ok,
  };
  if (ok) {
    response.result = payload ?? {};
  } else {
    response.error = isPlainObject(payload) && text(payload.code)
      ? { code: text(payload.code), message: text(payload.message) || 'Bridge request failed.' }
      : { code: 'invalid_request', message: 'Invalid bridge request.' };
  }
  return response;
};

export const buildInlineMetaAppBridgeEvent = (
  event: string,
  payload?: Record<string, unknown>,
): { type: 'agent-browser:event'; version: typeof INLINE_METAAPP_BRIDGE_VERSION; event: string; payload: Record<string, unknown> } => ({
  type: 'agent-browser:event',
  version: INLINE_METAAPP_BRIDGE_VERSION,
  event,
  payload: payload ?? {},
});

export const isAgentInternetNavigateUri = (uri: unknown): boolean => AGENT_INTERNET_NAVIGATE_RE.test(text(uri));

/** The Bot acting for an embedded app. actorId is the idbots-metabot-<n> form botBrowserBridgeService resolves. */
export interface InlineMetaAppActor {
  actorId: string;
  name: string;
  globalMetaId: string;
  avatarPinId?: string;
}

/**
 * browser.actor.current reply, in the same sanitized shape ABC returns
 * (sanitizedActorSnapshot): uri + globalMetaId + display name, avatar pin only
 * when known. Null when the Bot has no on-chain identity yet — the app then
 * knows it cannot sign.
 */
export const buildInlineMetaAppActorSnapshot = (
  actor: InlineMetaAppActor | null | undefined,
): { uri: string; globalMetaId: string; name: string; avatarPinId?: string } | null => {
  const globalMetaId = text(actor?.globalMetaId);
  if (!globalMetaId) return null;
  const snapshot: { uri: string; globalMetaId: string; name: string; avatarPinId?: string } = {
    uri: `metaid://${globalMetaId}`,
    globalMetaId,
    name: text(actor?.name) || globalMetaId,
  };
  const avatarPinId = text(actor?.avatarPinId);
  if (METAAPP_PIN_ID_RE.test(avatarPinId)) snapshot.avatarPinId = avatarPinId.toLowerCase();
  return snapshot;
};

export type InlineMetaAppConfirmKind = 'metaid-pin-write' | 'permissions-request';

export interface InlineMetaAppStructuredConfirmation {
  confirmation: Record<string, unknown>;
  confirmRequest: { resourceUri: string; kind: InlineMetaAppConfirmKind; payload: Record<string, unknown> };
}

/**
 * Extract the two-phase confirmation from a trusted-action result. Mirrors
 * ABC's structuredPinWriteConfirmation / structuredPermissionsConfirmation:
 * the host answers phase one with manual_action_required carrying a display
 * `confirmation` plus the exact `confirmRequest` to echo back once the user
 * approves. The kind must match the action that was issued and the request
 * must target the same resource — a confirmation for another app is dropped
 * so a misrouted result can never approve a foreign write.
 */
export const parseInlineMetaAppConfirmation = (
  result: unknown,
  kind: InlineMetaAppConfirmKind,
  resourceUri: string,
): InlineMetaAppStructuredConfirmation | null => {
  if (!isPlainObject(result) || result.ok !== false || result.state !== 'manual_action_required') return null;
  const data = isPlainObject(result.data) ? result.data : null;
  const confirmation = data && isPlainObject(data.confirmation) ? data.confirmation : null;
  const confirmRequest = data && isPlainObject(data.confirmRequest) ? data.confirmRequest : null;
  if (!confirmation || !confirmRequest) return null;
  if (text(confirmRequest.kind) !== kind) return null;
  const requestUri = text(confirmRequest.resourceUri);
  if (!requestUri || requestUri !== text(resourceUri)) return null;
  if (!isPlainObject(confirmRequest.payload)) return null;
  return {
    confirmation,
    confirmRequest: { resourceUri: requestUri, kind, payload: confirmRequest.payload },
  };
};

/**
 * Bridge error for a failed host result (ok:false without a confirmation).
 * The host message is already user-safe (safeBridgeMessage in the adapter
 * path, host-contract failures here), so it is forwarded verbatim with a
 * method-specific fallback.
 */
export const bridgeErrorFromHostResult = (
  result: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): InlineMetaAppBridgeError => {
  const record = isPlainObject(result) ? result : {};
  return {
    code: text(record.code) || fallbackCode,
    message: text(record.message) || fallbackMessage,
  };
};

/** Successful host results reach the app as their `data` (the main-process payload), as in ABC. */
export const bridgeResultFromHostResult = (result: unknown): unknown => {
  if (!isPlainObject(result)) return result ?? {};
  return result.data !== undefined ? result.data : result;
};

export const browserOnlyMethodError = (method: string): InlineMetaAppBridgeError => ({
  code: 'unsupported_method',
  message: `${method} is not available in the chat preview. Open this MetaApp in the Bot Browser to use it.`,
});

export const unsupportedMethodError = (): InlineMetaAppBridgeError => ({
  code: 'unsupported_method',
  message: 'Unsupported AgentBrowser bridge method.',
});

export const missingActorError = (): InlineMetaAppBridgeError => ({
  code: 'actor_unavailable',
  message: 'This conversation has no Bot identity to act as; open the MetaApp in the Bot Browser to choose an Actor.',
});

export const consentPendingError = (): InlineMetaAppBridgeError => ({
  code: 'consent_pending',
  message: 'A confirmation is already open.',
});

export const userCancelledError = (message: string): InlineMetaAppBridgeError => ({
  code: 'user_cancelled',
  message,
});

/**
 * Sandbox tokens for the app frame, mirroring ABC's htmlFrameSandbox: the app
 * keeps its own real origin (allow-same-origin) only when that origin differs
 * from the host page — the local MetaApp server at http://127.0.0.1:<port> is
 * never the renderer's origin, so the app can use canvas export / downloads
 * yet can never script the host or call its same-origin APIs. A same-origin
 * URL (which the resolver never produces) stays fully opaque.
 */
export const inlineMetaAppSandbox = (frameUrl: string, hostOrigin: string): string => {
  const base = 'allow-scripts allow-downloads allow-forms';
  const origin = text(hostOrigin);
  if (!origin || origin === 'null') return `${base} allow-same-origin`;
  const frameOrigin = originOfUrl(frameUrl);
  if (!frameOrigin) return base;
  return frameOrigin === origin ? base : `${base} allow-same-origin`;
};

/** http(s) origin of a URL, or null when it is not an http(s) URL — the only kind the block will frame. */
export const originOfUrl = (url: unknown): string | null => {
  const raw = text(url);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

/**
 * Pick the frame URL out of a resolve envelope: a MetaApp resource rendered as
 * an html-iframe whose renderer.url is http(s). Anything else (a bot page, a
 * document, an unsupported renderer) is not embeddable here.
 */
export const inlineMetaAppFrameUrl = (resolved: unknown): string | null => {
  if (!isPlainObject(resolved)) return null;
  if (text(resolved.resourceType) !== 'metaapp') return null;
  const renderer = isPlainObject(resolved.renderer) ? resolved.renderer : null;
  if (!renderer || text(renderer.type) !== 'html-iframe') return null;
  const url = text(renderer.url);
  return originOfUrl(url) ? url : null;
};

/** Opaque per-block session id for permission grants (botBrowserBridgeService scopes grants per actor+resource+session). */
export const createInlineMetaAppSessionId = (random: () => string = defaultRandomToken): string =>
  `inline-metaapp-${random()}`;

const defaultRandomToken = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
