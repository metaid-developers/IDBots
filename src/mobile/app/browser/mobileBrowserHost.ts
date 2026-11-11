import { resolveMetaAppPinToRecord } from '@openagentinternet/agent-browser-core';
import { createBrowserEndpointShim, type BrowserEndpointShimResponse } from '@/features/botBrowser/browserEndpointShim';
import { createIdbotsBrowserHostAdapter } from '@/features/botBrowser/idbotsBrowserHostAdapter';
import { getMobileElectron } from '../appBridge';
import { createMobileMetaAppPreviewSession } from './mobileMetaAppPreview';

export function createMobileBrowserHost(): {
  handle: (request: { url: string; method?: string; body?: unknown }) => Promise<BrowserEndpointShimResponse>;
  dispose: () => void;
} {
  const preview = createMobileMetaAppPreviewSession();
  const adapter = createIdbotsBrowserHostAdapter({
    features: {
      privateChat: false,
      cacheManagement: false,
      templateSettings: true,
      nftBuy: false,
      mrc721Buy: false,
    },
    listMetabots: async () => {
      const result = await getMobileElectron().metabot.list();
      return result?.list ?? [];
    },
    getHumanIdentity: async () => {
      const result = await getMobileElectron().userIdentity.get();
      const identity = result?.identity;
      if (!identity) return null;
      return {
        label: identity.name || 'Account',
        globalMetaId: identity.globalmetaid || identity.metaid,
        ...(identity.avatar ? { avatar: identity.avatar } : {}),
        signingAvailable: false,
      };
    },
    listMetaApps: async () => [],
    resolveMetaAppPin: (pinId) => resolveMetaAppPinToRecord({
      pinId,
      createPreviewSession: preview.createPreviewSession,
    }),
    resolveMetaAppUrl: async () => {
      throw new Error('Local desktop MetaApp packages are unavailable on mobile.');
    },
    openConversation: async () => {
      throw new Error('Private conversations are not enabled in the mobile Browser.');
    },
  });
  const endpoint = createBrowserEndpointShim(adapter);
  return {
    handle: (request) => endpoint(request),
    dispose: preview.dispose,
  };
}
