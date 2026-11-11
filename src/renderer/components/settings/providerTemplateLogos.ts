// Logo assets for the third-party provider templates shown in the
// Settings > Models "Add Provider" picker. Assets are ported from ZCode's
// provider-icons bundle (see services/providerTemplates.ts for provenance).
// openrouter / opencode ship light+dark variants; every other asset is a
// single file that reads well on both themes.
//
// Each asset resolves through `new URL('<literal>', import.meta.url)` instead
// of a static `import logo from './x.png'`: Vite rewrites the fully-literal
// form at build time (asset still bundled and hashed), while plain Node (tsx
// test runs that load this chain through ModelEffortPicker) just constructs a
// URL string without parsing the binary file. The literal must stay inline —
// a template-literal helper would degrade to a partial-dynamic glob that the
// bundler cannot fully resolve.

type ProviderTemplateLogoAsset = { light: string; dark?: string };

// Keys mirror the `logo` field of ProviderTemplate (services/providerTemplates.ts).
const PROVIDER_TEMPLATE_LOGO_ASSETS: Readonly<Record<string, ProviderTemplateLogoAsset>> = {
  zai: { light: new URL('../../assets/providers/zai.png', import.meta.url).href },
  bigmodel: { light: new URL('../../assets/providers/bigmodel.svg', import.meta.url).href },
  'moonshot-kimi': { light: new URL('../../assets/providers/moonshot-kimi.png', import.meta.url).href },
  minimax: { light: new URL('../../assets/providers/minimax.png', import.meta.url).href },
  deepseek: { light: new URL('../../assets/providers/deepseek.png', import.meta.url).href },
  'alibaba-model-studio': { light: new URL('../../assets/providers/alibaba-model-studio.png', import.meta.url).href },
  'xiaomi-mimo': { light: new URL('../../assets/providers/xiaomi-mimo.png', import.meta.url).href },
  openai: { light: new URL('../../assets/providers/openai.png', import.meta.url).href },
  anthropic: { light: new URL('../../assets/providers/anthropic.png', import.meta.url).href },
  xai: { light: new URL('../../assets/providers/xai.png', import.meta.url).href },
  openrouter: {
    light: new URL('../../assets/providers/openrouter-light.svg', import.meta.url).href,
    dark: new URL('../../assets/providers/openrouter-dark.svg', import.meta.url).href,
  },
  opencode: {
    light: new URL('../../assets/providers/opencode-light.svg', import.meta.url).href,
    dark: new URL('../../assets/providers/opencode-dark.svg', import.meta.url).href,
  },
  'tencent-cloud': { light: new URL('../../assets/providers/tencent-cloud.png', import.meta.url).href },
  volcengine: { light: new URL('../../assets/providers/volcengine.png', import.meta.url).href },
  stepfun: { light: new URL('../../assets/providers/stepfun.png', import.meta.url).href },
  siliconflow: { light: new URL('../../assets/providers/siliconflow.png', import.meta.url).href },
};

/** Resolve a template logo key to an asset URL, honoring the active theme. */
export const resolveProviderTemplateLogo = (logoKey: string, dark: boolean): string | null => {
  const asset = PROVIDER_TEMPLATE_LOGO_ASSETS[logoKey];
  if (!asset) {
    return null;
  }
  return dark ? (asset.dark ?? asset.light) : asset.light;
};
