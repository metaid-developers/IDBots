import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildBrowserPageDefinition,
  createBrowserThemeMessage,
  renderBrowserPageHtml,
} from '@openagentinternet/agent-browser-ui/browser';
import { injectBrowserIframeBridge } from '@/features/botBrowser/browserIframeBridge';
import type { BotBrowserOpenUriInput } from '@/features/botBrowser/types';
import { mobileI18n, t } from '../../i18n';
import { createMobileBrowserHost } from './mobileBrowserHost';

export interface MobileBrowserRequest extends BotBrowserOpenUriInput {
  nonce: number;
}

type BrowserMessage = {
  source?: string;
  type?: string;
  id?: string;
  request?: { url: string; method?: string; body?: unknown };
};

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

export default function MobileBrowserScreen(props: {
  visible: boolean;
  request?: MobileBrowserRequest | null;
}): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<ReturnType<typeof createMobileBrowserHost> | null>(null);
  const srcDocRef = useRef<string | null>(null);
  const buildPromiseRef = useRef<Promise<void> | null>(null);
  const readyRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingRequestsRef = useRef<MobileBrowserRequest[]>([]);
  const lastRequestNonceRef = useRef(0);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const postToIframe = useCallback((message: object): boolean => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return false;
    target.postMessage({ source: 'idbots-browser-surface', ...message }, '*');
    return true;
  }, []);

  const postTheme = useCallback(() => {
    postToIframe(createBrowserThemeMessage(isDarkTheme() ? 'dark' : 'light'));
  }, [postToIframe]);

  const postRequest = useCallback((request: MobileBrowserRequest): boolean => {
    return postToIframe({
      type: 'open-uri',
      input: {
        uri: request.uri,
        actorId: request.actorId,
        label: request.label,
        newTab: request.newTab ?? true,
      },
    });
  }, [postToIframe]);

  const flushRequests = useCallback(() => {
    if (!readyRef.current) return;
    const pending = pendingRequestsRef.current.splice(0);
    for (const request of pending) {
      if (!postRequest(request)) {
        pendingRequestsRef.current.push(request);
        break;
      }
    }
  }, [postRequest]);

  const ensureSrcDoc = useCallback((): Promise<void> => {
    if (srcDocRef.current) return Promise.resolve();
    if (buildPromiseRef.current) return buildPromiseRef.current;
    setError('');
    const buildPromise = (async () => {
      try {
        const html = await renderBrowserPageHtml(
          injectBrowserIframeBridge(buildBrowserPageDefinition()),
          mobileI18n.getLanguage(),
          { theme: isDarkTheme() ? 'dark' : 'light' },
        );
        if (!mountedRef.current) return;
        readyRef.current = false;
        setReady(false);
        srcDocRef.current = html;
        setSrcDoc(html);
      } catch (caught) {
        if (mountedRef.current) setError(caught instanceof Error ? caught.message : t('mobile.browser.failed'));
        throw caught;
      } finally {
        buildPromiseRef.current = null;
      }
    })();
    buildPromiseRef.current = buildPromise;
    return buildPromise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const host = createMobileBrowserHost();
    hostRef.current = host;
    return () => {
      mountedRef.current = false;
      host.dispose();
      hostRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!props.visible) return;
    void ensureSrcDoc().catch(() => undefined);
  }, [ensureSrcDoc, props.visible]);

  useEffect(() => {
    const request = props.request;
    if (!request || request.nonce === lastRequestNonceRef.current) return;
    lastRequestNonceRef.current = request.nonce;
    if (!postRequest(request)) {
      pendingRequestsRef.current.push(request);
      readyRef.current = false;
      void ensureSrcDoc().catch(() => undefined);
    }
  }, [ensureSrcDoc, postRequest, props.request]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as BrowserMessage | null;
      if (!data || data.source !== 'idbots-browser-iframe-bridge') return;
      if (data.type === 'browser-ready') {
        readyRef.current = true;
        setReady(true);
        setError('');
        postTheme();
        flushRequests();
        return;
      }
      if (data.type !== 'endpoint-request' || !data.id || !data.request) return;
      const host = hostRef.current;
      if (!host) return;
      void host.handle(data.request).then((response) => {
        postToIframe({ type: 'endpoint-response', id: data.id, response });
      }).catch((caught) => {
        postToIframe({
          type: 'endpoint-response',
          id: data.id,
          response: {
            status: 400,
            body: {
              ok: false,
              state: 'failed',
              code: 'browser_endpoint_error',
              message: caught instanceof Error ? caught.message : t('mobile.browser.failed'),
            },
          },
        });
      });
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [flushRequests, postTheme, postToIframe]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (readyRef.current) postTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readyRef.current) postTheme();
    };
    media.addEventListener('change', onChange);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', onChange);
    };
  }, [postTheme]);

  return (
    <section
      className="mobile-browser-surface"
      style={{ display: props.visible ? 'block' : 'none' }}
      data-testid="mobile-browser-surface"
      data-ready={ready ? 'true' : 'false'}
      aria-label={t('mobile.tabs.browser')}
    >
      {srcDoc ? (
        <iframe
          ref={iframeRef}
          title="IDBots Browser"
          srcDoc={srcDoc}
          className="mobile-browser-frame"
          data-testid="mobile-browser-frame"
        />
      ) : (
        <div className="mobile-browser-loading">
          <span className="mobile-browser-loading-mark" aria-hidden />
          <p>{t('mobile.common.loading')}</p>
        </div>
      )}
      {error ? <div className="mobile-browser-error" role="alert">{error}</div> : null}
    </section>
  );
}
