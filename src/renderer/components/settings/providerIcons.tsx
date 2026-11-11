/**
 * Shared provider icon registry, extracted from Settings.tsx so surfaces
 * outside the settings dialog render the SAME per-provider icon:
 *
 *  - Settings > Models rows + provider detail header (24px box);
 *  - the composer model picker's provider group headers (16px box);
 *  - the pinned ID.Bots subscription entry, which shows the app icon
 *    (`public/logo.png` — the yellow avatar) instead of a generic glyph.
 *
 * Icon sources, in priority order:
 *  1. custom-* providers with a template logoKey → theme-aware template logo img;
 *  2. custom-* providers without a logo → the generic pencil glyph;
 *  3. the built-in free provider (metaid-free) → the IDBots app icon img;
 *  4. any other built-in key → its vendor icon component.
 */
import React from 'react';
import {
  AnthropicIcon,
  CommandCodeIcon,
  CustomProviderIcon,
  DeepSeekIcon,
  GeminiIcon,
  MiniMaxIcon,
  MoonshotIcon,
  OllamaIcon,
  OpenAIIcon,
  OpenCodeIcon,
  OpenRouterIcon,
  QwenIcon,
  VolcengineIcon,
  XiaomiIcon,
  ZhipuIcon,
} from '../icons/providers';
import { LLM_FREE_PROVIDER_KEY } from '../../services/llmFreeQuotaGate.js';
import { PROVIDER_TEMPLATES } from '../../services/providerTemplates';
import { resolveProviderTemplateLogo } from './providerTemplateLogos';

/** Built-in provider keys, in settings-list order (the free relay first). */
export const providerKeys = [
  'metaid-free',
  'deepseek',
  'opencode',
  'commandcode',
  'zhipu',
  'openai',
  'gemini',
  'anthropic',
  'moonshot',
  'minimax',
  'qwen',
  'volcengine',
  'xiaomi',
  'openrouter',
  'ollama',
] as const;

/** Custom providers (user- or template-created) carry a `custom-` key outside this registry. */
export const isCustomProviderKey = (key: string): boolean => (
  !(providerKeys as readonly string[]).includes(key)
);

/** Display labels for the built-in providers (the free relay's label is i18n-driven in Settings). */
const BUILT_IN_PROVIDER_LABELS: Record<string, string> = {
  'metaid-free': 'IDBots',
  deepseek: 'DeepSeek',
  opencode: 'OpenCode',
  commandcode: 'Command Code',
  zhipu: 'Zhipu',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  volcengine: 'Volcengine Ark',
  xiaomi: 'Xiaomi',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

/** Label for a built-in provider key; unknown keys echo back (matches the old providerMeta fallback). */
export const getBuiltInProviderLabel = (key: string): string => BUILT_IN_PROVIDER_LABELS[key] ?? key;

const BUILT_IN_PROVIDER_ICONS: Record<string, React.FC<{ className?: string }>> = {
  deepseek: DeepSeekIcon,
  opencode: OpenCodeIcon,
  commandcode: CommandCodeIcon,
  zhipu: ZhipuIcon,
  openai: OpenAIIcon,
  gemini: GeminiIcon,
  anthropic: AnthropicIcon,
  moonshot: MoonshotIcon,
  minimax: MiniMaxIcon,
  qwen: QwenIcon,
  volcengine: VolcengineIcon,
  xiaomi: XiaomiIcon,
  openrouter: OpenRouterIcon,
  ollama: OllamaIcon,
};

/**
 * Vendor logo key for a provider entry: template-created providers store
 * their template's logo key; legacy template entries (created before the
 * field existed) are recognized by their custom-<templateId>[-N] key shape.
 * Returns null for user-created custom providers — they keep the generic icon.
 */
const getProviderTemplateLogoKey = (key: string, config?: { logoKey?: string } | null): string | null => {
  if (config?.logoKey) {
    return config.logoKey;
  }
  if (!isCustomProviderKey(key)) {
    return null;
  }
  const slug = key.replace(/^custom-/, '');
  const stripped = slug.replace(/-\d+$/, '');
  const template = PROVIDER_TEMPLATES.find(entry => entry.templateId === stripped)
    ?? PROVIDER_TEMPLATES.find(entry => entry.templateId === slug);
  return template?.logo ?? null;
};

export interface ProviderIconProps {
  /** Provider key (built-in key or custom-*). */
  providerKey: string;
  /**
   * Custom/template provider config; only `logoKey` is read. The index
   * signature keeps this assignable from AppConfig provider unions that do
   * not declare logoKey (every built-in member shape).
   */
  config?: { logoKey?: string; [key: string]: unknown } | null;
  /** Resolved dark-mode flag (template logos ship light/dark variants). */
  dark: boolean;
  /**
   * Box size class for the icon — the rendered glyph always fills the box so
   * one implementation serves the settings row (`h-6 w-6`, default) and the
   * composer picker's group label (`h-4 w-4`).
   */
  className?: string;
}

export const ProviderIcon: React.FC<ProviderIconProps> = ({ providerKey, config, dark, className = 'h-6 w-6' }) => {
  let icon: React.ReactNode;
  if (isCustomProviderKey(providerKey)) {
    const logoKey = getProviderTemplateLogoKey(providerKey, config);
    const src = logoKey ? resolveProviderTemplateLogo(logoKey, dark) : null;
    icon = src
      ? <img src={src} alt="" aria-hidden className="h-full w-full object-contain" />
      : <CustomProviderIcon className="h-full w-full" />;
  } else if (providerKey === LLM_FREE_PROVIDER_KEY) {
    // The IDBots app icon (public/logo.png — the yellow avatar).
    icon = <img src="logo.png" alt="" aria-hidden className="h-full w-full rounded-[22%] object-cover" />;
  } else {
    const VendorIcon = BUILT_IN_PROVIDER_ICONS[providerKey];
    icon = VendorIcon ? <VendorIcon className="h-full w-full" /> : <CustomProviderIcon className="h-full w-full" />;
  }
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${className}`}>
      <span className="flex h-full w-full items-center justify-center overflow-hidden">
        {icon}
      </span>
    </span>
  );
};
