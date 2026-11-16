import type { EditorBrainOption } from './components/BotEditorForm';

const IDBOTS_PROVIDER_KEYS = new Set(['idbots', 'metaid-free']);
const DEEPSEEK_FLASH_MODEL_IDS = new Set(['deepseek-flash', 'deepseek-4.1-flash', 'deepseek-chat']);
const DEFAULT_FALLBACK_MODEL_ID = 'glm-5.3-flash';

export function defaultBotBrains(options: readonly EditorBrainOption[]): {
  primary: EditorBrainOption | null;
  fallback: EditorBrainOption | null;
} {
  const isIdbots = (option: EditorBrainOption) => IDBOTS_PROVIDER_KEYS.has(option.providerKey.trim().toLowerCase());
  const isDeepseekFlash = (option: EditorBrainOption) => DEEPSEEK_FLASH_MODEL_IDS.has(option.modelId.trim());
  const primary = options.find((option) => isIdbots(option) && isDeepseekFlash(option))
    ?? options.find(isDeepseekFlash)
    ?? options[0]
    ?? null;
  const fallback = options.find((option) => (
    option !== primary && isIdbots(option) && option.modelId.trim() === DEFAULT_FALLBACK_MODEL_ID
  )) ?? options.find((option) => option !== primary && option.modelId.trim() === DEFAULT_FALLBACK_MODEL_ID)
    ?? null;
  return { primary, fallback };
}
