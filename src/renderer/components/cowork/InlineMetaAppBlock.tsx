/**
 * InlineMetaAppBlock — a MetaApp rendered in place inside an assistant-mode
 * chat bubble.
 *
 * The Bot embeds an app with markdown image syntax (`![name](metaapp://<pin>)`);
 * the ordinary link form keeps opening the Bot Browser. The block resolves the
 * pin through the same host path the Bot Browser uses (botBrowser:resolveResource
 * → cache / local install / community install from chain) and frames the app's
 * local run URL directly, so the app runs exactly as it does in a Browser tab:
 * same sandbox tokens, same AgentBrowser bridge v1 wire protocol. The block is
 * the bridge host — it answers browser.actor.current, metaid.pin.write,
 * metafile.upload, browser.llm.complete and browser.permissions.request by
 * calling the existing trusted-action IPC with the SESSION BOT as the Actor,
 * so a write the app asks for is signed by the Bot the owner is chatting with
 * and the two-phase confirmation card (review → approve → sign) renders inside
 * the block instead of in a Browser modal. Browser-only methods (compose
 * modals, Agent-Game sessions) and in-app navigation hand off to the Bot
 * Browser with the same Actor seeded.
 *
 * The frame is a fixed-height viewport the owner can drag-resize (apps are
 * interactive and scroll internally), unlike the content-sized HTML report
 * block. Protocol helpers live in inlineMetaAppBridge.ts and are DOM-free so
 * the server-rendered renderer tests can drive them directly.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ExclamationTriangleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { useInlineMetaAppActor } from './InlineMetaAppActorContext';
import {
  INLINE_METAAPP_BROWSER_ONLY_METHODS,
  INLINE_METAAPP_COMMERCE_METHODS,
  INLINE_METAAPP_DEFAULT_HEIGHT,
  INLINE_METAAPP_SUPPORTED_METHODS,
  bridgeErrorFromHostResult,
  bridgeResultFromHostResult,
  browserOnlyMethodError,
  buildInlineMetaAppActorSnapshot,
  buildInlineMetaAppBridgeResponse,
  clampInlineMetaAppHeight,
  consentPendingError,
  createInlineMetaAppSessionId,
  inlineMetaAppFrameUrl,
  inlineMetaAppSandbox,
  isAgentInternetNavigateUri,
  missingActorError,
  originOfUrl,
  parseInlineMetaAppBridgeMessage,
  parseInlineMetaAppConfirmation,
  unsupportedMethodError,
  userCancelledError,
  type InlineMetaAppActor,
  type InlineMetaAppBridgeError,
  type InlineMetaAppBridgeRequest,
} from './inlineMetaAppBridge';
import {
  COMMERCE_INTENT_WINDOW_EVENT,
  SOCIAL_FRIEND_PROMPT_WINDOW_EVENT,
  sanitizeAddFriendPrompt,
  sanitizeAskTwinToBuy,
  sanitizeOpenPromoPack,
  checkPromoPackOwnership,
  COMMERCE_METHOD_TO_INTENT,
  SanitizeFailure,
  type CommerceIntentKind,
  type CommerceIntentSource,
  type OpenPromoPackParams,
} from '../commerce/commerceBridgeContract';
import { resolveCommerceLang, tCommerce } from '../commerce/commercePromoI18n';
import { PromoAmmoPackModal } from '../commerce/PromoAmmoPackModal';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A bridge-level failure: the code/message go back to the app verbatim. */
class BridgeFailure extends Error {
  code: string;

  constructor(error: InlineMetaAppBridgeError) {
    super(error.message);
    this.code = error.code;
  }
}

const toBridgeError = (error: unknown, fallback: InlineMetaAppBridgeError): InlineMetaAppBridgeError => {
  if (error instanceof BridgeFailure) return { code: error.code, message: error.message };
  if (error instanceof Error && error.message) return { code: fallback.code, message: error.message };
  return fallback;
};

type PromptPhase = 'review' | 'sending' | 'failed';

type PromptState =
  | {
      kind: 'pin-write' | 'permissions';
      confirmation: Record<string, unknown>;
      phase: PromptPhase;
      failure?: string;
      decide: (approved: boolean) => void;
    }
  | {
      kind: 'llm';
      purpose: string;
      phase: 'review';
      decide: (approved: boolean) => void;
    }
  | {
      kind: 'commerce';
      intent: CommerceIntentKind;
      params: Record<string, unknown>;
      decide: (approved: boolean) => void;
    };

type PromptDraft =
  | { kind: 'pin-write' | 'permissions'; confirmation: Record<string, unknown> }
  | { kind: 'llm'; purpose: string }
  | { kind: 'commerce'; intent: CommerceIntentKind; params: Record<string, unknown> };

interface InlineMetaAppBlockProps {
  /** Normalized metaapp://<pinId> URI (see parseMetaAppEmbedUri). */
  uri: string;
  /** Image alt text the Bot wrote — the block title until the app resolves. */
  title?: string;
}

const openInBotBrowser = (uri: string, actor: InlineMetaAppActor | null): void => {
  window.dispatchEvent(new CustomEvent('botBrowser:openUri', {
    detail: { uri, actorId: actor?.actorId || undefined },
  }));
};

const InlineMetaAppBlock: React.FC<InlineMetaAppBlockProps> = ({ uri, title }) => {
  const actor = useInlineMetaAppActor();
  const actorId = actor?.actorId ?? '';

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [resolvedTitle, setResolvedTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [height, setHeight] = useState(INLINE_METAAPP_DEFAULT_HEIGHT);
  const [frameKey, setFrameKey] = useState(0);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promoPackParams, setPromoPackParams] = useState<OpenPromoPackParams | null>(null);
  const [resizing, setResizing] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mountedRef = useRef(true);
  const actorRef = useRef<InlineMetaAppActor | null>(actor);
  const uriRef = useRef(uri);
  const promptRef = useRef<PromptState | null>(null);
  const llmConsentRef = useRef<'allow' | 'deny' | null>(null);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const sessionId = useMemo(() => createInlineMetaAppSessionId(), []);

  actorRef.current = actor;
  uriRef.current = uri;

  const hostOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const sandbox = useMemo(() => (frameUrl ? inlineMetaAppSandbox(frameUrl, hostOrigin) : ''), [frameUrl, hostOrigin]);
  const frameOrigin = useMemo(() => (frameUrl ? originOfUrl(frameUrl) : null), [frameUrl]);
  // Bridge frames must come from the app's origin; an opaque (no
  // allow-same-origin) frame reports 'null' instead.
  const expectedMessageOrigin = sandbox.includes('allow-same-origin') ? frameOrigin : 'null';
  const displayTitle = text(title) || resolvedTitle || uri;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setFrameUrl(null);
    setErrorMessage('');
    setPrompt(null);
    promptRef.current = null;
    setPromoPackParams(null);
    llmConsentRef.current = null;
    void (async () => {
      try {
        const result = await window.electron.botBrowser.resolveResource({ uri, actorId: actorId || undefined });
        if (cancelled) return;
        if (!result?.ok) {
          const message = result && 'message' in result ? text(result.message) : '';
          setErrorMessage(message || i18nService.t('metaAppEmbedLoadFailed'));
          setStatus('error');
          return;
        }
        const url = inlineMetaAppFrameUrl(result.data);
        if (!url) {
          setErrorMessage(i18nService.t('metaAppEmbedLoadFailed'));
          setStatus('error');
          return;
        }
        setResolvedTitle(text(result.data?.title));
        setFrameUrl(url);
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(error instanceof Error && error.message ? error.message : i18nService.t('metaAppEmbedLoadFailed'));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri, actorId]);

  const postToFrame = useCallback((message: unknown) => {
    const target = iframeRef.current?.contentWindow;
    if (!target || !frameOrigin) return;
    target.postMessage(message, frameOrigin);
  }, [frameOrigin]);

  const clearPrompt = useCallback(() => {
    promptRef.current = null;
    if (mountedRef.current) setPrompt(null);
  }, []);

  const updatePrompt = useCallback((patch: Partial<Pick<Extract<PromptState, { kind: 'pin-write' | 'permissions' }>, 'phase' | 'failure'>>) => {
    const current = promptRef.current;
    if (!current || current.kind === 'llm') return;
    const next: PromptState = { ...current, ...patch };
    promptRef.current = next;
    if (mountedRef.current) setPrompt(next);
  }, []);

  // One confirmation at a time per block (ABC: consent_pending). The promise
  // settles on the card's Approve/Deny; a denial closes the card immediately,
  // an approval leaves it open so the caller can show the sending/failed phase.
  const askUser = useCallback((draft: PromptDraft): Promise<boolean> => {
    if (promptRef.current) return Promise.reject(new BridgeFailure(consentPendingError()));
    return new Promise<boolean>((resolve) => {
      const decide = (approved: boolean) => {
        if (!approved) clearPrompt();
        resolve(approved);
      };
      const state: PromptState = draft.kind === 'llm'
        ? { kind: 'llm', purpose: draft.purpose, phase: 'review', decide }
        : draft.kind === 'commerce'
          ? { kind: 'commerce', intent: draft.intent, params: draft.params, decide }
          : { kind: draft.kind, confirmation: draft.confirmation, phase: 'review', decide };
      promptRef.current = state;
      if (mountedRef.current) setPrompt(state);
    });
  }, [clearPrompt]);

  const requireActorId = useCallback((): string => {
    const current = actorRef.current;
    if (!current?.actorId) throw new BridgeFailure(missingActorError());
    return current.actorId;
  }, []);

  // metaid.pin.write, mirroring ABC's submitMetaIdPinWrite: phase one may
  // answer with a confirmation; the approved confirmRequest is echoed back
  // (its opaque token is what botBrowserBridgeService checks); one renewed
  // confirmation (expired token) is re-prompted, a second is an error.
  const runPinWrite = useCallback(async (params: Record<string, unknown>): Promise<unknown> => {
    const resourceUri = uriRef.current;
    const invoke = (targetUri: string, payload: unknown) => window.electron.botBrowser.writeMetaIdPin({
      actorId: requireActorId(),
      resourceUri: targetUri,
      sessionId,
      payload,
    });
    const phaseOne = await invoke(resourceUri, params);
    let structured = parseInlineMetaAppConfirmation(phaseOne, 'metaid-pin-write', resourceUri);
    if (!structured) {
      if (!phaseOne?.ok) {
        throw new BridgeFailure(bridgeErrorFromHostResult(phaseOne, 'pin_write_failed', 'MetaID PIN write failed.'));
      }
      return bridgeResultFromHostResult(phaseOne);
    }
    let renewals = 0;
    while (structured) {
      const approved = await askUser({ kind: 'pin-write', confirmation: structured.confirmation });
      if (!approved) throw new BridgeFailure(userCancelledError('MetaID PIN write was cancelled.'));
      updatePrompt({ phase: 'sending' });
      const phaseTwo = await invoke(structured.confirmRequest.resourceUri, structured.confirmRequest.payload);
      const renewed = parseInlineMetaAppConfirmation(phaseTwo, 'metaid-pin-write', resourceUri);
      if (renewed && renewals < 1) {
        renewals += 1;
        structured = renewed;
        clearPrompt();
        continue;
      }
      if (!phaseTwo?.ok) {
        const error = bridgeErrorFromHostResult(phaseTwo, 'pin_write_failed', 'MetaID PIN write confirmation failed.');
        updatePrompt({ phase: 'failed', failure: error.message });
        throw new BridgeFailure(error);
      }
      clearPrompt();
      return bridgeResultFromHostResult(phaseTwo);
    }
    throw new BridgeFailure({ code: 'pin_write_failed', message: 'MetaID PIN write failed.' });
  }, [askUser, clearPrompt, requireActorId, sessionId, updatePrompt]);

  // browser.permissions.request, mirroring ABC's handleBridgePermissionsRequest:
  // the reply is always { granted }, a renewed confirmation after approval is
  // a failure rather than a second prompt.
  const runPermissions = useCallback(async (params: Record<string, unknown>): Promise<unknown> => {
    const resourceUri = uriRef.current;
    const invoke = (targetUri: string, payload: unknown) => window.electron.botBrowser.requestPermissions({
      actorId: requireActorId(),
      resourceUri: targetUri,
      sessionId,
      payload,
    });
    const grantedOf = (result: unknown): unknown[] => {
      const data = bridgeResultFromHostResult(result);
      return isPlainObject(data) && Array.isArray(data.granted) ? data.granted : [];
    };
    const phaseOne = await invoke(resourceUri, params);
    const structured = parseInlineMetaAppConfirmation(phaseOne, 'permissions-request', resourceUri);
    if (!structured) {
      if (!phaseOne?.ok) {
        throw new BridgeFailure(bridgeErrorFromHostResult(phaseOne, 'consent_denied', 'Permission request failed.'));
      }
      return { granted: grantedOf(phaseOne) };
    }
    const approved = await askUser({ kind: 'permissions', confirmation: structured.confirmation });
    if (!approved) throw new BridgeFailure(userCancelledError('Permission request was cancelled.'));
    updatePrompt({ phase: 'sending' });
    const phaseTwo = await invoke(structured.confirmRequest.resourceUri, structured.confirmRequest.payload);
    if (parseInlineMetaAppConfirmation(phaseTwo, 'permissions-request', resourceUri)) {
      clearPrompt();
      throw new BridgeFailure({ code: 'consent_denied', message: 'The permission grant could not be recorded.' });
    }
    if (!phaseTwo?.ok) {
      const error = bridgeErrorFromHostResult(phaseTwo, 'consent_denied', 'Permission request failed.');
      updatePrompt({ phase: 'failed', failure: error.message });
      throw new BridgeFailure(error);
    }
    clearPrompt();
    return { granted: grantedOf(phaseTwo) };
  }, [askUser, clearPrompt, requireActorId, sessionId, updatePrompt]);

  // browser.llm.complete: the app spends the Bot's model quota, so the owner
  // consents once per block (ABC remembers allow/deny per resource).
  const runLlmComplete = useCallback(async (params: Record<string, unknown>): Promise<unknown> => {
    const denied = (): never => {
      throw new BridgeFailure({ code: 'consent_denied', message: 'The user denied local LLM access for this MetaApp.' });
    };
    if (llmConsentRef.current === 'deny') denied();
    if (llmConsentRef.current !== 'allow') {
      const approved = await askUser({ kind: 'llm', purpose: text(params.purpose) });
      llmConsentRef.current = approved ? 'allow' : 'deny';
      if (!approved) denied();
      clearPrompt();
    }
    const result = await window.electron.botBrowser.completeLlm({
      actorId: requireActorId(),
      resourceUri: uriRef.current,
      sessionId,
      payload: params,
    });
    if (!result?.ok) {
      throw new BridgeFailure(bridgeErrorFromHostResult(result, 'llm_unavailable', 'LLM completion failed.'));
    }
    return bridgeResultFromHostResult(result);
  }, [askUser, clearPrompt, requireActorId, sessionId]);

  const runMetafileUpload = useCallback(async (params: Record<string, unknown>): Promise<unknown> => {
    const result = await window.electron.botBrowser.uploadMetaFile({
      actorId: requireActorId(),
      resourceUri: uriRef.current,
      sessionId,
      payload: params,
    });
    if (!result?.ok) {
      throw new BridgeFailure(bridgeErrorFromHostResult(result, 'upload_failed', 'MetaFile upload failed.'));
    }
    return bridgeResultFromHostResult(result);
  }, [requireActorId, sessionId]);

  // browser.commerce.* / browser.social.addFriendPrompt (REQ-E-01): pure
  // intent raisers. Params are re-validated through commerceBridgeContract,
  // the user approves through the in-block card, and only THEN does the host
  // dispatch the commerce window event (WS-D mounts the downstream purchase /
  // friend / promo-pack surfaces on it). Nothing here signs or sends.
  const runCommerceIntent = useCallback(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const intent = COMMERCE_METHOD_TO_INTENT[method];
    if (!intent) throw new BridgeFailure(unsupportedMethodError());
    const source: CommerceIntentSource = 'inline-metaapp';

    let sanitized: Record<string, unknown>;
    if (intent === 'askTwinToBuy') {
      const result = sanitizeAskTwinToBuy(params);
      if (result instanceof SanitizeFailure) {
        throw new BridgeFailure({ code: result.error.code, message: result.error.message });
      }
      sanitized = result as unknown as Record<string, unknown>;
    } else if (intent === 'addFriendPrompt') {
      const result = sanitizeAddFriendPrompt(params);
      if (result instanceof SanitizeFailure) {
        throw new BridgeFailure({ code: result.error.code, message: result.error.message });
      }
      sanitized = result as unknown as Record<string, unknown>;
    } else {
      // Promo pack is seller-side tooling: after sanitizing + the ownership
      // gate it opens the host-owned PromoAmmoPackModal right here — the
      // user is the shop owner already, no "send to Twin" step involved.
      const result = sanitizeOpenPromoPack(params);
      if (result instanceof SanitizeFailure) {
        throw new BridgeFailure({ code: result.error.code, message: result.error.message });
      }
      const ownership = checkPromoPackOwnership(result, actorRef.current?.globalMetaId ?? null);
      if (ownership instanceof SanitizeFailure) {
        throw new BridgeFailure({ code: ownership.error.code, message: ownership.error.message });
      }
      if (mountedRef.current) setPromoPackParams(result);
      return { opened: true };
    }

    const approved = await askUser({ kind: 'commerce', intent, params: sanitized });
    if (!approved) throw new BridgeFailure(userCancelledError('Commerce intent was cancelled.'));
    clearPrompt();

    const eventName = intent === 'addFriendPrompt' ? SOCIAL_FRIEND_PROMPT_WINDOW_EVENT : COMMERCE_INTENT_WINDOW_EVENT;
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: { intent, source, params: sanitized, actorId: actorRef.current?.actorId || undefined },
    }));
    return { opened: true };
  }, [askUser, clearPrompt]);

  const handleRequest = useCallback(async (request: InlineMetaAppBridgeRequest): Promise<void> => {
    const { id, method, params } = request;
    try {
      let result: unknown;
      if (method === 'browser.actor.current') {
        result = { actor: buildInlineMetaAppActorSnapshot(actorRef.current) };
      } else if (INLINE_METAAPP_COMMERCE_METHODS.has(method)) {
        result = await runCommerceIntent(method, params);
      } else if (INLINE_METAAPP_BROWSER_ONLY_METHODS.has(method)) {
        throw new BridgeFailure(browserOnlyMethodError(method));
      } else if (!INLINE_METAAPP_SUPPORTED_METHODS.has(method)) {
        throw new BridgeFailure(unsupportedMethodError());
      } else if (method === 'metaid.pin.write') {
        result = await runPinWrite(params);
      } else if (method === 'metafile.upload') {
        result = await runMetafileUpload(params);
      } else if (method === 'browser.llm.complete') {
        result = await runLlmComplete(params);
      } else {
        result = await runPermissions(params);
      }
      if (!mountedRef.current) return;
      postToFrame(buildInlineMetaAppBridgeResponse(id, true, result));
    } catch (error) {
      if (!mountedRef.current) return;
      postToFrame(buildInlineMetaAppBridgeResponse(
        id,
        false,
        toBridgeError(error, { code: 'bridge_failed', message: 'Bridge request failed.' }),
      ));
    }
  }, [postToFrame, runCommerceIntent, runLlmComplete, runMetafileUpload, runPermissions, runPinWrite]);

  // Bridge host: accept only frames whose source is THIS block's iframe and
  // whose origin is the app's; navigate requests to other on-chain resources
  // open in the Bot Browser (the bubble stays on its app).
  useEffect(() => {
    if (status !== 'ready') return;
    const handleMessage = (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow ?? null;
      const parsed = parseInlineMetaAppBridgeMessage(event.data, event.source, iframeWindow);
      if (!parsed) return;
      if (expectedMessageOrigin && event.origin !== expectedMessageOrigin) return;
      if (parsed.type === 'navigate') {
        if (isAgentInternetNavigateUri(parsed.uri)) openInBotBrowser(parsed.uri, actorRef.current);
        return;
      }
      void handleRequest(parsed);
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [status, expectedMessageOrigin, handleRequest]);

  const reload = useCallback(() => {
    if (promptRef.current) promptRef.current.decide(false);
    clearPrompt();
    setFrameKey((current) => current + 1);
  }, [clearPrompt]);

  const openInBrowser = useCallback(() => {
    openInBotBrowser(uriRef.current, actorRef.current);
  }, []);

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStateRef.current = { startY: event.clientY, startHeight: height };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }, [height]);

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state) return;
    setHeight(clampInlineMetaAppHeight(state.startHeight + (event.clientY - state.startY)));
  }, []);

  const handleResizePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStateRef.current) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  }, []);

  const iconButtonClass = 'h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors';
  const actingAsLabel = actor ? i18nService.t('metaAppEmbedActingAs').replace('{name}', actor.name || actor.globalMetaId) : '';

  return (
    <div
      className="relative my-1 w-[688px] max-w-full overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-subtle"
      data-inline-metaapp={uri}
    >
      <div className="flex h-8 items-center gap-2 border-b px-2.5 dark:border-claude-darkBorder border-claude-border">
        <Squares2X2Icon className="h-3.5 w-3.5 shrink-0 text-claude-accent" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium dark:text-claude-darkText text-claude-text" title={uri}>
          {displayTitle}
        </span>
        <span className="shrink-0 rounded bg-claude-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-claude-accent">
          {i18nService.t('metaAppEmbedHint')}
        </span>
        <span
          className="hidden sm:inline shrink-0 max-w-[160px] truncate text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={actor ? actor.globalMetaId : undefined}
        >
          {actor ? actingAsLabel : i18nService.t('metaAppEmbedNoActor')}
        </span>
        <button
          type="button"
          onClick={reload}
          className={iconButtonClass}
          aria-label={i18nService.t('metaAppEmbedReload')}
          title={i18nService.t('metaAppEmbedReload')}
          disabled={status !== 'ready'}
        >
          <ArrowPathIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={openInBrowser}
          className={iconButtonClass}
          aria-label={i18nService.t('metaAppEmbedOpenInBrowser')}
          title={i18nService.t('metaAppEmbedOpenInBrowser')}
        >
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {status === 'loading' ? (
        <div className="px-3 py-8 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metaAppEmbedLoading')}
        </div>
      ) : status === 'error' ? (
        <div className="flex items-start gap-3 px-3.5 py-4">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('metaAppEmbedLoadFailed')}
            </div>
            <div className="mt-0.5 break-all text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {errorMessage}
            </div>
            <button
              type="button"
              onClick={openInBrowser}
              className="mt-2 inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11px] font-medium text-claude-accent transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              {i18nService.t('metaAppEmbedOpenInBrowser')}
            </button>
          </div>
        </div>
      ) : (
        <div className="relative" style={{ height: `${height}px` }}>
          <iframe
            key={frameKey}
            ref={iframeRef}
            title={displayTitle}
            src={frameUrl ?? undefined}
            sandbox={sandbox}
            className="block h-full w-full border-0 bg-white"
          />
          {/* A busy frame swallows pointer events; while resizing, a shield keeps the drag on the host. */}
          {resizing && <div className="absolute inset-0 z-10" />}
          {prompt && (
            <div className="absolute inset-0 z-20 flex items-start justify-center overflow-auto bg-black/30 p-3 backdrop-blur-[1px]">
              <InlineMetaAppPromptCard prompt={prompt} appTitle={displayTitle} actor={actor} onClose={clearPrompt} />
            </div>
          )}
          {promoPackParams && (
            <PromoAmmoPackModal
              params={promoPackParams}
              lang={resolveCommerceLang((i18nService as { getLanguage?: () => string }).getLanguage?.() ?? 'en')}
              onClose={() => setPromoPackParams(null)}
            />
          )}
        </div>
      )}

      {status === 'ready' && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={i18nService.t('metaAppEmbedResize')}
          title={i18nService.t('metaAppEmbedResize')}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          className="flex h-3 cursor-ns-resize items-center justify-center border-t dark:border-claude-darkBorder border-claude-border touch-none select-none"
        >
          <span className="h-0.5 w-8 rounded-full dark:bg-claude-darkBorder bg-claude-border" />
        </div>
      )}
    </div>
  );
};

const fieldText = (record: Record<string, unknown>, key: string): string => text(record[key]);

const PromptField: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-4">
      <dt className="w-20 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all dark:text-claude-darkText text-claude-text ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
};

const PromptActor: React.FC<{ name: string; globalMetaId: string }> = ({ name, globalMetaId }) => (
  <div className="mt-3 flex items-center gap-2 rounded-lg px-2.5 py-2 dark:bg-claude-darkSurfaceHover/60 bg-claude-surfaceHover/60">
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-claude-accent/15 text-[11px] font-semibold text-claude-accent">
      {(name || globalMetaId || '?').slice(0, 1).toUpperCase()}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-xs font-medium dark:text-claude-darkText text-claude-text">{name || globalMetaId}</span>
      {globalMetaId && (
        <span className="block truncate font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary" title={globalMetaId}>
          {globalMetaId}
        </span>
      )}
    </span>
  </div>
);

interface InlineMetaAppPromptCardProps {
  prompt: PromptState;
  appTitle: string;
  actor: InlineMetaAppActor | null;
  onClose: () => void;
}

/**
 * The in-block confirmation card. Pin-write and permission cards show the
 * host-issued `confirmation` (the record the Bot is about to sign / the
 * protocol grants), the LLM card asks once for model access. Approve/Deny
 * settle the bridge call; the sending and failed phases keep the card up so
 * the owner sees the outcome of what they approved.
 */
const InlineMetaAppPromptCard: React.FC<InlineMetaAppPromptCardProps> = ({ prompt, appTitle, actor, onClose }) => {
  const t = (key: string) => i18nService.t(key);
  const confirmation = prompt.kind === 'llm' || prompt.kind === 'commerce' ? null : prompt.confirmation;
  const confirmationActor = confirmation && isPlainObject(confirmation.actor) ? confirmation.actor : null;
  const actorName = text(confirmationActor?.name) || actor?.name || '';
  const actorGlobalMetaId = text(confirmationActor?.globalMetaId) || actor?.globalMetaId || '';
  const phase: PromptPhase | 'review' = 'phase' in prompt ? prompt.phase : 'review';
  const busy = phase === 'sending';
  const commerceLang = (() => {
    const maybeI18n = i18nService as { getLanguage?: () => string };
    try {
      return maybeI18n.getLanguage ? maybeI18n.getLanguage() : 'en';
    } catch {
      return 'en';
    }
  })();

  const primaryButtonClass = 'inline-flex items-center justify-center rounded-lg bg-claude-accent px-3 py-1.5 text-xs font-medium text-claude-accentInk transition-colors hover:bg-claude-accentHover disabled:opacity-60';
  const secondaryButtonClass = 'inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-60';

  let eyebrow = '';
  let intro = '';
  let Icon = ShieldCheckIcon;
  if (prompt.kind === 'pin-write') {
    eyebrow = t('metaAppPinWriteTitle');
    intro = t('metaAppPinWriteIntro');
  } else if (prompt.kind === 'permissions') {
    eyebrow = t('metaAppPermissionsTitle');
    intro = t('metaAppPermissionsIntro');
  } else if (prompt.kind === 'commerce') {
    eyebrow = tCommerce('commerceConfirmTitle', commerceLang);
    intro = prompt.intent === 'addFriendPrompt'
      ? tCommerce('commerceConfirmIntroFriend', commerceLang)
      : tCommerce('commerceConfirmIntroBuy', commerceLang);
    Icon = SparklesIcon;
  } else {
    eyebrow = t('metaAppLlmTitle');
    intro = t('metaAppLlmIntro');
    Icon = SparklesIcon;
  }

  const display = confirmation && isPlainObject(confirmation.display) ? confirmation.display : null;
  const grants = confirmation && Array.isArray(confirmation.grants) ? confirmation.grants.filter(isPlainObject) : [];
  const payloadSize = confirmation && typeof confirmation.payloadSize === 'number' && confirmation.payloadSize >= 0
    ? `${confirmation.payloadSize} bytes`
    : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={eyebrow}
      className="w-full max-w-[440px] rounded-xl border p-4 shadow-lg dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
      data-inline-metaapp-prompt={prompt.kind}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-claude-accent/10">
          <Icon className="h-[18px] w-[18px] text-claude-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-claude-accent">{eyebrow}</div>
          <div className="mt-0.5 text-xs leading-5 dark:text-claude-darkText text-claude-text">
            <span className="font-medium">{appTitle}</span>
            {' — '}
            {intro}
          </div>
        </div>
      </div>

      {(actorName || actorGlobalMetaId) && <PromptActor name={actorName} globalMetaId={actorGlobalMetaId} />}

      {prompt.kind === 'pin-write' && confirmation && (
        <>
          <dl className="mt-3 space-y-1.5">
            <PromptField label={t('metaAppPinWriteOperation')} value={fieldText(confirmation, 'operation').toUpperCase()} />
            <PromptField label={t('metaAppPinWritePath')} value={fieldText(confirmation, 'path')} mono />
            <PromptField label={t('metaAppPinWriteContentType')} value={fieldText(confirmation, 'contentType')} mono />
            <PromptField label={t('metaAppPinWritePayload')} value={payloadSize} />
          </dl>
          {display && (text(display.title) || text(display.summary)) && (
            <div className="mt-3 rounded-lg border px-2.5 py-2 text-xs leading-5 dark:border-claude-darkBorder border-claude-border">
              {text(display.title) && <div className="font-medium dark:text-claude-darkText text-claude-text">{text(display.title)}</div>}
              {text(display.summary) && (
                <div className="whitespace-pre-wrap break-words dark:text-claude-darkTextSecondary text-claude-textSecondary">{text(display.summary)}</div>
              )}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('metaAppPinWriteNote')}</p>
        </>
      )}

      {prompt.kind === 'permissions' && confirmation && (
        <>
          {grants.length > 0 && (
            <ul className="mt-3 space-y-1">
              {grants.map((grant, index) => (
                <li key={index} className="flex items-baseline gap-2 text-[11px] leading-4">
                  <span className="shrink-0 rounded bg-claude-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-claude-accent">
                    {text(grant.operation) || 'create'}
                  </span>
                  <code className="min-w-0 flex-1 break-all font-mono dark:text-claude-darkText text-claude-text">{text(grant.path)}</code>
                </li>
              ))}
            </ul>
          )}
          {text(confirmation.reason) && (
            <p className="mt-2 text-xs leading-5 dark:text-claude-darkText text-claude-text">{text(confirmation.reason)}</p>
          )}
          <p className="mt-3 text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('metaAppPermissionsNote')}</p>
        </>
      )}

      {prompt.kind === 'llm' && prompt.purpose && (
        <p className="mt-3 text-xs leading-5 dark:text-claude-darkText text-claude-text">{prompt.purpose}</p>
      )}

      {prompt.kind === 'commerce' && (
        <dl className="mt-3 space-y-1.5">
          {prompt.intent === 'askTwinToBuy' && (() => {
            const params = prompt.params as Record<string, string | number | undefined>;
            const modeLabel = params.mode === 'negotiate'
              ? tCommerce('commerceModeNegotiate', commerceLang)
              : params.mode === 'inquire_unlisted'
                ? tCommerce('commerceModeInquire', commerceLang)
                : tCommerce('commerceModeBuy', commerceLang);
            return (
              <>
                <PromptField label={tCommerce('commerceFieldItem', commerceLang)} value={String(params.itemName || '')} />
                <PromptField label={tCommerce('commerceFieldCollection', commerceLang)} value={String(params.collectionName || '')} />
                <PromptField label={tCommerce('commerceFieldSeller', commerceLang)} value={String(params.sellerName || params.sellerGlobalMetaId || '')} mono={!params.sellerName} />
                <PromptField label={tCommerce('commerceFieldMode', commerceLang)} value={modeLabel} />
              </>
            );
          })()}
          {prompt.intent === 'addFriendPrompt' && (() => {
            const params = prompt.params as Record<string, string | undefined>;
            return (
              <>
                <PromptField label={tCommerce('commerceFieldSeller', commerceLang)} value={String(params.targetName || params.targetGlobalMetaId || '')} mono={!params.targetName} />
                {params.greeting ? <PromptField label="✎" value={params.greeting} /> : null}
              </>
            );
          })()}
          {prompt.intent === 'openPromoPack' && (() => {
            const params = prompt.params as { shopOwnerName?: string; shopOwnerGlobalMetaId?: string; shopSlogan?: string };
            return (
              <>
                <PromptField label={tCommerce('commerceFieldOwner', commerceLang)} value={params.shopOwnerName || params.shopOwnerGlobalMetaId || ''} mono={!params.shopOwnerName} />
                {params.shopSlogan ? <PromptField label="✎" value={params.shopSlogan} /> : null}
              </>
            );
          })()}
        </dl>
      )}

      {phase === 'sending' && (
        <p className="mt-3 text-[11px] leading-4 text-claude-accent" role="status" aria-live="polite">
          {prompt.kind === 'pin-write' ? t('metaAppPinWriteSending') : t('metaAppPermissionsSending')}
        </p>
      )}
      {'phase' in prompt && prompt.phase === 'failed' && (
        <p className="mt-3 break-words text-[11px] leading-4 text-red-500" role="alert">
          {t('metaAppPinWriteFailed')}{prompt.failure ? `: ${prompt.failure}` : ''}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        {phase === 'failed' ? (
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {t('metaAppConfirmClose')}
          </button>
        ) : (
          <>
            <button type="button" className={secondaryButtonClass} onClick={() => prompt.decide(false)} disabled={busy}>
              {prompt.kind === 'commerce' ? tCommerce('commerceCancel', commerceLang) : t('metaAppConfirmDeny')}
            </button>
            <button type="button" className={primaryButtonClass} onClick={() => prompt.decide(true)} disabled={busy}>
              {prompt.kind === 'llm' ? t('metaAppConfirmAllow') : prompt.kind === 'commerce' ? tCommerce('commerceSendToTwin', commerceLang) : t('metaAppConfirmApprove')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default InlineMetaAppBlock;
