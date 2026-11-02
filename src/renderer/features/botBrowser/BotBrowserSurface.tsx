import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  buildBrowserPageDefinition,
  createBrowserThemeMessage,
  renderBrowserPageHtml,
} from '@openagentinternet/agent-browser-ui/browser';
import { i18nService } from '../../services/i18n';
import { themeService } from '../../services/theme';
import { createBrowserEndpointShim, type BrowserEndpointShimResponse } from './browserEndpointShim';
import { createIdbotsBrowserHostAdapter } from './idbotsBrowserHostAdapter';
import { injectBrowserIframeBridge } from './browserIframeBridge';
import { useBotBrowserCapture } from './useBotBrowserCapture';
import type {
  BotBrowserConversationRequest,
  BotBrowserOpenUriInput,
  BotBrowserSurfaceHandle,
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
} from './types';

export interface BotBrowserSurfaceProps {
  visible: boolean;
  onOpenConversation(request: BotBrowserConversationRequest): Promise<void>;
  onError(message: string): void;
  onReady?: () => void;
}

type BrowserIframeMessage =
  | {
      source: 'idbots-browser-iframe-bridge';
      type: 'browser-ready';
    }
  | {
      source: 'idbots-browser-iframe-bridge';
      type: 'endpoint-request';
      id: string;
      request: {
        url: string;
        method?: string;
        body?: unknown;
      };
    }
  | {
      source: 'idbots-browser-iframe-bridge';
      type: 'tab-command-response';
      id: string;
      success: boolean;
      result?: BotBrowserTabCommandResult;
      error?: string;
    }
  | {
      source: 'idbots-browser-iframe-bridge';
      type: 'window-drag-move';
      dx?: number;
      dy?: number;
    };

type PendingTabCommand = {
  command: BotBrowserTabCommand;
  resolve(result: BotBrowserTabCommandResult): void;
  reject(error: Error): void;
};

type PendingTabResponse = {
  resolve(result: BotBrowserTabCommandResult): void;
  reject(error: Error): void;
  timeout: number;
};

const PARENT_SOURCE = 'idbots-browser-surface';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function getBrowserLanguagePreference(): string {
  const maybeI18n = i18nService as { getLanguage?: () => string };
  try {
    if (typeof maybeI18n.getLanguage === 'function') {
      const language = maybeI18n.getLanguage();
      if (language) return language;
    }
  } catch (error) {
    console.warn('Failed to read i18n language for Bot Browser:', error);
  }

  if (typeof document !== 'undefined' && document.documentElement.lang) {
    return document.documentElement.lang;
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en';
}

function endpointErrorResponse(error: unknown): BrowserEndpointShimResponse {
  return {
    status: 400,
    body: {
      ok: false,
      state: 'failed',
      code: 'browser_endpoint_error',
      message: errorMessage(error, 'Browser endpoint request failed.'),
    },
  };
}

export const BotBrowserSurface = forwardRef<BotBrowserSurfaceHandle, BotBrowserSurfaceProps>(
  function BotBrowserSurface(
    {
      visible,
      onOpenConversation,
      onError,
      onReady,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const srcDocRef = useRef<string | null>(null);
    const buildPromiseRef = useRef<Promise<void> | null>(null);
    const readyRef = useRef(false);
    const pendingOpenUrisRef = useRef<BotBrowserOpenUriInput[]>([]);
    const pendingRefreshRuntimeRef = useRef(false);
    const pendingTabCommandsRef = useRef<PendingTabCommand[]>([]);
    const pendingTabResponsesRef = useRef(new Map<string, PendingTabResponse>());
    const tabCommandSequenceRef = useRef(0);
    const callbacksRef = useRef({
      onOpenConversation,
      onError,
      onReady,
    });
    const endpointShimRef = useRef<ReturnType<typeof createBrowserEndpointShim> | null>(null);
    const [srcDoc, setSrcDoc] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    callbacksRef.current = {
      onOpenConversation,
      onError,
      onReady,
    };

    // Handle screenshot capture requests from the main-process capture bridge.
    useBotBrowserCapture({ iframeRef, visible });

    if (!endpointShimRef.current) {
      const adapter = createIdbotsBrowserHostAdapter({
        listMetabots: async () => {
          const result = await window.electron.metabot.list();
          return result?.list ?? [];
        },
        getHumanIdentity: async () => {
          const result = await window.electron.botBrowser.getHumanActor();
          return result?.actor ?? null;
        },
        listMetaApps: async () => {
          const result = await window.electron.metaapps.list();
          return result?.apps ?? [];
        },
        resolveBrowserResource: (input) => window.electron.botBrowser.resolveResource(input),
        getBrowserProfile: (input) => window.electron.botBrowser.getProfile(input),
        getBrowserSettings: (input) => window.electron.botBrowser.getSettings(input),
        updateBrowserSettings: (input) => window.electron.botBrowser.updateSettings(input),
        resolveMetaAppPin: async (pinId) => {
          return window.electron.botBrowser.resolveMetaAppPin({ pinId });
        },
        installCommunityMetaApp: async (sourcePinId) => {
          return window.electron.metaapps.installCommunity({ sourcePinId });
        },
        resolveMetaAppUrl: async (app) => {
          const result = await window.electron.metaapps.resolveUrl({
            appId: app.id,
            targetPath: app.entry,
          });
          if (!result?.success || !result.url) {
            throw new Error(result?.error || 'Failed to resolve MetaApp URL.');
          }
          return result.url;
        },
        getMetaAppCache: () => window.electron.botBrowser.getMetaAppCache(),
        clearMetaAppCache: (input) => window.electron.botBrowser.clearMetaAppCache(input),
        writeMetaIdPin: (input) => window.electron.botBrowser.writeMetaIdPin(input),
        uploadMetaFile: (input) => window.electron.botBrowser.uploadMetaFile(input),
        completeLlm: (input) => window.electron.botBrowser.completeLlm(input),
        requestPermissions: (input) => window.electron.botBrowser.requestPermissions(input),
        buyNft: (input) => window.electron.botBrowser.buyNft(input),
        sendPrivateChat: (input) => window.electron.botBrowser.sendPrivateChat(input),
        runAgentGameSession: (input) => window.electron.agentGame.session(input),
        openConversation: (request) => callbacksRef.current.onOpenConversation(request),
      });
      endpointShimRef.current = createBrowserEndpointShim(adapter);
    }

    const postToIframe = useCallback((message: Record<string, unknown>): boolean => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return false;
      target.postMessage({ source: PARENT_SOURCE, ...message }, '*');
      return true;
    }, []);

    const postThemeToIframe = useCallback((): boolean => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return false;
      target.postMessage(createBrowserThemeMessage(themeService.getEffectiveTheme()), '*');
      return true;
    }, []);

    const postTabCommand = useCallback((pending: PendingTabCommand): boolean => {
      const id = `tab-command-${++tabCommandSequenceRef.current}`;
      const timeout = window.setTimeout(() => {
        const response = pendingTabResponsesRef.current.get(id);
        if (!response) return;
        pendingTabResponsesRef.current.delete(id);
        response.reject(new Error('Bot Browser tab command timed out.'));
      }, 10_000);
      pendingTabResponsesRef.current.set(id, {
        resolve: pending.resolve,
        reject: pending.reject,
        timeout,
      });
      if (postToIframe({ type: 'tab-command', id, command: pending.command })) {
        return true;
      }
      window.clearTimeout(timeout);
      pendingTabResponsesRef.current.delete(id);
      return false;
    }, [postToIframe]);

    const postOpenUri = useCallback((input: BotBrowserOpenUriInput): boolean => {
      return postToIframe({
        type: 'open-uri',
        input,
      });
    }, [postToIframe]);

    const flushPendingOpenUris = useCallback(() => {
      if (!readyRef.current) return;
      const pending = pendingOpenUrisRef.current.splice(0);
      for (let index = 0; index < pending.length; index += 1) {
        const input = pending[index];
        if (!postOpenUri(input)) {
          readyRef.current = false;
          pendingOpenUrisRef.current.unshift(...pending.slice(index));
          break;
        }
      }
    }, [postOpenUri]);

    const flushPendingTabCommands = useCallback(() => {
      if (!readyRef.current) return;
      const pending = pendingTabCommandsRef.current.splice(0);
      for (let index = 0; index < pending.length; index += 1) {
        if (!postTabCommand(pending[index])) {
          readyRef.current = false;
          pendingTabCommandsRef.current.unshift(...pending.slice(index));
          break;
        }
      }
    }, [postTabCommand]);

    const flushPendingRefreshRuntime = useCallback(() => {
      if (!readyRef.current) return;
      if (!pendingRefreshRuntimeRef.current) return;
      if (postToIframe({ type: 'refresh-runtime' })) {
        pendingRefreshRuntimeRef.current = false;
      } else {
        readyRef.current = false;
      }
    }, [postToIframe]);

    const ensureSrcDoc = useCallback((): Promise<void> => {
      if (srcDocRef.current) return Promise.resolve();
      if (buildPromiseRef.current) return buildPromiseRef.current;

      setLoading(true);
      const buildPromise = (async () => {
        try {
          const definition = injectBrowserIframeBridge(
            buildBrowserPageDefinition(),
          );
          // Do NOT post-process the rendered HTML to widen the MetaApp iframe
          // sandbox: the iframe (and its sandbox attribute) is built at runtime
          // by the ABC browser client from htmlFrameSandbox(url), so a string
          // rewrite here cannot reach it. The allow-forms token is added at the
          // source via patches/@openagentinternet+agent-browser-ui+0.6.0.patch.
          const html = await renderBrowserPageHtml(
            definition,
            getBrowserLanguagePreference(),
            { theme: themeService.getEffectiveTheme() },
          );
          readyRef.current = false;
          srcDocRef.current = html;
          setSrcDoc(html);
        } catch (error) {
          const message = errorMessage(error, 'Failed to build Bot Browser surface.');
          callbacksRef.current.onError(message);
          throw error;
        } finally {
          setLoading(false);
          buildPromiseRef.current = null;
        }
      })();

      buildPromiseRef.current = buildPromise;
      return buildPromise;
    }, []);

    useEffect(() => {
      if (!visible) return;
      void ensureSrcDoc().catch(() => {});
    }, [ensureSrcDoc, visible]);

    // Human identity lifecycle (create/import/replace/logout): refresh the
    // Browser runtime so stale Actor/grant state never outlives the identity
    // it was issued for.
    useEffect(() => {
      return window.electron.botBrowser.onActorsChanged(() => {
        if (!srcDocRef.current) return;
        if (readyRef.current) {
          postToIframe({ type: 'refresh-runtime' });
        } else {
          pendingRefreshRuntimeRef.current = true;
        }
      });
    }, [postToIframe]);

    useEffect(() => {
      return themeService.subscribe(() => {
        if (readyRef.current) {
          postThemeToIframe();
        }
      });
    }, [postThemeToIframe]);

    useEffect(() => {
      const handleMessage = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data as BrowserIframeMessage;
        if (!data || data.source !== 'idbots-browser-iframe-bridge') return;

        if (data.type === 'browser-ready') {
          readyRef.current = true;
          postThemeToIframe();
          callbacksRef.current.onReady?.();
          flushPendingOpenUris();
          flushPendingTabCommands();
          flushPendingRefreshRuntime();
          return;
        }

        if (data.type === 'tab-command-response') {
          const pending = pendingTabResponsesRef.current.get(data.id);
          if (!pending) return;
          window.clearTimeout(pending.timeout);
          pendingTabResponsesRef.current.delete(data.id);
          if (!data.success || !data.result) {
            pending.reject(new Error(data.error || 'Bot Browser tab command failed.'));
            return;
          }
          pending.resolve(data.result);
          return;
        }

        // Blank-area tabstrip/toolbar drags forwarded from the iframe bridge:
        // move the host window (CSS -webkit-app-region does not reach srcDoc iframes).
        if (data.type === 'window-drag-move') {
          const dx = Math.round(Number((data as { dx?: unknown }).dx) || 0);
          const dy = Math.round(Number((data as { dy?: unknown }).dy) || 0);
          if (dx || dy) {
            window.electron.window.moveBy(dx, dy);
          }
          return;
        }

        if (data.type === 'endpoint-request') {
          const shim = endpointShimRef.current;
          if (!shim) return;
          void (async () => {
            const response = await shim(data.request).catch(endpointErrorResponse);
            postToIframe({
              type: 'endpoint-response',
              id: data.id,
              response,
            });
          })();
        }
      };

      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
    }, [
      flushPendingOpenUris,
      flushPendingRefreshRuntime,
      flushPendingTabCommands,
      postThemeToIframe,
      postToIframe,
    ]);

    useEffect(() => {
      return () => {
        for (const pending of pendingTabResponsesRef.current.values()) {
          window.clearTimeout(pending.timeout);
          pending.reject(new Error('Bot Browser surface was closed.'));
        }
        pendingTabResponsesRef.current.clear();
        const queued = pendingTabCommandsRef.current.splice(0);
        for (const pending of queued) {
          pending.reject(new Error('Bot Browser surface was closed.'));
        }
      };
    }, []);

    const controlTabs = useCallback((command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult> => {
      return new Promise((resolve, reject) => {
        const pending = { command, resolve, reject };
        if (readyRef.current && postTabCommand(pending)) {
          return;
        }
        readyRef.current = false;
        pendingTabCommandsRef.current.push(pending);
        void ensureSrcDoc().catch((error) => {
          const index = pendingTabCommandsRef.current.indexOf(pending);
          if (index !== -1) {
            pendingTabCommandsRef.current.splice(index, 1);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    }, [ensureSrcDoc, postTabCommand]);

    useImperativeHandle(ref, () => ({
      async openUri(input: BotBrowserOpenUriInput): Promise<void> {
        if (!readyRef.current) {
          pendingOpenUrisRef.current.push(input);
          await ensureSrcDoc().catch(() => {});
          return;
        }
        if (postOpenUri(input)) return;
        readyRef.current = false;
        pendingOpenUrisRef.current.push(input);
        await ensureSrcDoc().catch(() => {});
      },
      async openNewTab(): Promise<void> {
        await controlTabs({ action: 'open-tab' });
      },
      async controlTabs(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult> {
        return controlTabs(command);
      },
      async refreshRuntime(): Promise<void> {
        if (!readyRef.current) {
          pendingRefreshRuntimeRef.current = true;
          await ensureSrcDoc().catch(() => {});
          return;
        }
        if (postToIframe({ type: 'refresh-runtime' })) return;
        readyRef.current = false;
        pendingRefreshRuntimeRef.current = true;
        await ensureSrcDoc().catch(() => {});
      },
    }), [controlTabs, ensureSrcDoc, postOpenUri, postToIframe]);

    const showLoading = loading || !srcDoc;

    return (
      <div
        className="h-full w-full"
        data-bot-browser-surface
        style={{ display: visible ? 'block' : 'none' }}
      >
        {srcDoc ? (
          <iframe
            ref={iframeRef}
            title="Bot Browser"
            srcDoc={srcDoc}
            className="h-full w-full"
            style={{ border: 0, display: 'block' }}
          />
        ) : null}
        {showLoading ? (
          <div className="flex h-full w-full items-center justify-center dark:text-claude-darkText text-claude-text">
            {i18nService.t('loading')}
          </div>
        ) : null}
      </div>
    );
  },
);

BotBrowserSurface.displayName = 'BotBrowserSurface';
