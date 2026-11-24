import { resolveMetaAppPinToRecord } from '@openagentinternet/agent-browser-core';
import { createBrowserEndpointShim, type BrowserEndpointShimResponse } from '@/features/botBrowser/browserEndpointShim';
import { createIdbotsBrowserHostAdapter } from '@/features/botBrowser/idbotsBrowserHostAdapter';
import { getMobileElectron } from '../appBridge';
import { resolveLocalFileUrl } from '../../../renderer/services/localFileUrl';
import { createMobileMetaAppPreviewSession } from './mobileMetaAppPreview';
import { installLegacyWebViewUrlCompatibility } from '@/features/botBrowser/legacyWebViewUrl';

export function createMobileBrowserHost(): {
  handle: (request: { url: string; method?: string; body?: unknown }) => Promise<BrowserEndpointShimResponse>;
  dispose: () => void;
} {
  installLegacyWebViewUrlCompatibility();
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
    previewFileLocalResolve: async ({ path }) => ({
      localPreviewUrl: await resolveLocalFileUrl(path, { disposition: 'inline' }),
    }),
    resolveMetaAppPin: async (pinId) => {
      const resolved = await resolveMetaAppPinToRecord({
        pinId,
        createPreviewSession: preview.createPreviewSession,
      });
      if (!resolved.ok || !resolved.data) return resolved;
      const currentTitle = typeof resolved.data.title === 'string' ? resolved.data.title.trim() : '';
      if (/精选头像铺|头像铺|老藏家|清仓小铺|个人数字商品小店|数字商品小店/iu.test(currentTitle)) {
        const inferredOwner = currentTitle
          .replace(/\s*(?:的)?(?:精选头像铺|头像铺|老藏家清仓小铺|清仓小铺|个人数字商品小店|数字商品小店).*$/iu, '')
          .trim();
        return {
          ...resolved,
          data: {
            ...resolved.data,
            title: inferredOwner ? `${inferredOwner} 的 NFT 橱窗` : 'NFT 橱窗',
          },
        };
      }
      return resolved;
    },
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
