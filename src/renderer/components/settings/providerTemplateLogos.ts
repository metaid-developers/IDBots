// Logo assets for the third-party provider templates shown in the
// Settings > Models "Add Provider" picker. Assets are ported from ZCode's
// provider-icons bundle (see services/providerTemplates.ts for provenance).
// openrouter / opencode ship light+dark variants; every other asset is a
// single file that reads well on both themes.
import alibabaModelStudioLogo from '../../assets/providers/alibaba-model-studio.png';
import anthropicLogo from '../../assets/providers/anthropic.png';
import bigModelLogo from '../../assets/providers/bigmodel.svg';
import deepSeekLogo from '../../assets/providers/deepseek.png';
import miniMaxLogo from '../../assets/providers/minimax.png';
import moonshotKimiLogo from '../../assets/providers/moonshot-kimi.png';
import openAiLogo from '../../assets/providers/openai.png';
import openrouterDarkLogo from '../../assets/providers/openrouter-dark.svg';
import openrouterLightLogo from '../../assets/providers/openrouter-light.svg';
import opencodeDarkLogo from '../../assets/providers/opencode-dark.svg';
import opencodeLightLogo from '../../assets/providers/opencode-light.svg';
import siliconflowLogo from '../../assets/providers/siliconflow.png';
import stepfunLogo from '../../assets/providers/stepfun.png';
import tencentCloudLogo from '../../assets/providers/tencent-cloud.png';
import volcengineLogo from '../../assets/providers/volcengine.png';
import xaiLogo from '../../assets/providers/xai.png';
import xiaomiMimoLogo from '../../assets/providers/xiaomi-mimo.png';
import zaiLogo from '../../assets/providers/zai.png';

type ProviderTemplateLogoAsset = { light: string; dark?: string };

// Keys mirror the `logo` field of ProviderTemplate (services/providerTemplates.ts).
const PROVIDER_TEMPLATE_LOGO_ASSETS: Readonly<Record<string, ProviderTemplateLogoAsset>> = {
  zai: { light: zaiLogo },
  bigmodel: { light: bigModelLogo },
  'moonshot-kimi': { light: moonshotKimiLogo },
  minimax: { light: miniMaxLogo },
  deepseek: { light: deepSeekLogo },
  'alibaba-model-studio': { light: alibabaModelStudioLogo },
  'xiaomi-mimo': { light: xiaomiMimoLogo },
  openai: { light: openAiLogo },
  anthropic: { light: anthropicLogo },
  xai: { light: xaiLogo },
  openrouter: { light: openrouterLightLogo, dark: openrouterDarkLogo },
  opencode: { light: opencodeLightLogo, dark: opencodeDarkLogo },
  'tencent-cloud': { light: tencentCloudLogo },
  volcengine: { light: volcengineLogo },
  stepfun: { light: stepfunLogo },
  siliconflow: { light: siliconflowLogo },
};

/** Resolve a template logo key to an asset URL, honoring the active theme. */
export const resolveProviderTemplateLogo = (logoKey: string, dark: boolean): string | null => {
  const asset = PROVIDER_TEMPLATE_LOGO_ASSETS[logoKey];
  if (!asset) {
    return null;
  }
  return dark ? (asset.dark ?? asset.light) : asset.light;
};
