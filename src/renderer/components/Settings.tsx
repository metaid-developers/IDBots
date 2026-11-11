import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { configService, mergeProvidersConfig } from '../services/config';
import { apiService } from '../services/api';
import { buildOpenCodeGoSessionHeaders } from '../services/opencodeGatewayHeaders';
import { buildOpenAIResponsesUrl } from '../services/openaiResponsesUrl';
import { themeService } from '../services/theme';
import { i18nService, LanguageType } from '../services/i18n';
import { decryptSecret, encryptWithPassword, decryptWithPassword, EncryptedPayload, PasswordEncryptedPayload } from '../services/encryption';
import { coworkService } from '../services/cowork';
import { imService } from '../services/im';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import ErrorMessage from './ErrorMessage';
import FreeQuotaCard from './FreeQuotaCard';
import { XMarkIcon, Cog6ToothIcon, PlusCircleIcon, TrashIcon, PencilIcon, SignalIcon, CheckCircleIcon, XCircleIcon, CubeIcon, ChatBubbleLeftIcon, ArchiveBoxIcon, PuzzlePieceIcon, BriefcaseIcon, BoltIcon, ArrowPathIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import BrainIcon from './icons/BrainIcon';
import { fetchProviderModelList, providerSupportsModelListSync } from '../services/providerModels';
import { testCerebellumConnection } from '../services/cerebellumConnection';
import Tooltip from './ui/Tooltip';
import { useDispatch, useSelector } from 'react-redux';
import { setAvailableModels, setSelectedModel } from '../store/slices/modelSlice';
import { RootState } from '../store';
import ThemedSelect from './ui/ThemedSelect';
import SecretInput from './ui/SecretInput';
import { useTextInputContextMenu } from './ui/useTextInputContextMenu';
import type {
  CoworkExecutionMode,
  CoworkSandboxProgress,
  CoworkSandboxStatus,
  CoworkSessionSummary,
} from '../types/cowork';
import type { GroupTaskSummary } from '../types/groupTask';
import { groupTaskService } from '../services/groupTaskService';
import { effectiveMaxOutputForWindow, formatContextWindowSize, NEW_MODEL_DEFAULT_MAX_OUTPUT_TOKENS, parseContextWindowSizeInput } from '../utils/contextWindowSize';
import { groupTaskStatusBadgeClass } from './groupTasks/groupTaskUtils';
import { groupTaskStatusLabelKey } from './groupTasks/GroupTasksView';
import IMSettings from './im/IMSettings';
import EmailSkillConfig from './skills/EmailSkillConfig';
import MemorySettings from './settings/MemorySettings';
import SkillMcpManager from './skills/SkillMcpManager';
import ProjectsManager from './projects/ProjectsManager';
import IdbotsPlanCard from './me/IdbotsPlanCard';
import MeIncrementPackCard from './me/MeIncrementPackCard';
import MeUsageAndCredits from './me/MeUsageAndCredits';
import TrafficSettings from './traffic/TrafficSettings';
import { findMeRateForModel } from './me/meRates';
import { ensureMeSnapshot, getMeSnapshot, subscribeMeSnapshot } from './me/mePointsStore';
import { defaultConfig, type AppConfig } from '../config';
import { LLM_FREE_PROVIDER_KEY, getFreeProviderModelDisplayName } from '../services/llmFreeQuotaGate.js';
import { type ProviderTemplate } from '../services/providerTemplates';
import { getBuiltInProviderLabel, isCustomProviderKey, providerKeys, ProviderIcon } from './settings/providerIcons';
import ProviderTemplatePicker from './settings/ProviderTemplatePicker';

type TabType = 'general' | 'model' | 'skills' | 'projects' | 'coworkSandbox' | 'coworkMemory' | 'archivedChats' | 'shortcuts' | 'im' | 'email' | 'paramsConfig' | 'traffic';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
  /** Auto-open the Settings > Projects "New Project" form. */
  openNewProjectForm?: boolean;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
}

/** Archived Chats panel page size (Settings). */
const ARCHIVED_CHATS_PAGE_SIZE = 20;


type ProviderType = (typeof providerKeys)[number];
type ProvidersConfig = NonNullable<AppConfig['providers']>;
// name 字段来自 AppConfig.providers 的 index signature（自定义供应商显示名），
// 命名的内置供应商成员类型不含该字段，这里显式补上以便统一访问。
type ProviderConfig = ProvidersConfig[string] & { name?: string };
type Model = NonNullable<ProviderConfig['models']>[number];
type CerebellumConfig = NonNullable<AppConfig['cerebellum']>;

// Cerebellum provider options: direct TypeSafe (user-owned key) plus the
// official IDBots relay, whose usage is billed in ME credits server-side.
const CEREBELLUM_PROVIDER_OPTIONS = [
  { value: 'typesafe-jev', label: 'TypeSafe JEV' },
  { value: 'idbots-jev-free', label: 'IDBots-JEV' },
];

// Keep the legacy storage key for config compatibility; the provider is now
// presented as IDBots-JEV and metered through the user's ME credit balance.
const CEREBELLUM_FREE_PROVIDER = 'idbots-jev-free';
const CEREBELLUM_FREE_RELAY_BASE_URL = 'https://www.metaso.network/assist-open-api/v2/assist/llm/jev';
const CEREBELLUM_FREE_MODEL = 'jev-latest';
const TYPESAFE_JEV_BASE_URL = 'https://api.typesafe.ai';

const DEFAULT_CEREBELLUM_CONFIG: CerebellumConfig = {
  enabled: true,
  provider: CEREBELLUM_FREE_PROVIDER,
  apiKey: '',
  baseUrl: CEREBELLUM_FREE_RELAY_BASE_URL,
  model: CEREBELLUM_FREE_MODEL,
};
type MemoryMetabotOption = {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  globalmetaid: string | null;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'responses';
  models?: Model[];
  /** 自定义供应商显示名称，内置供应商无此字段 */
  name?: string;
  /** 自定义/模板供应商的取 key 控制台链接，内置供应商无此字段 */
  apiKeyManagementUrl?: string;
  /** 模板供应商的 logo key，内置/用户自建供应商无此字段 */
  logoKey?: string;
}

interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: 2;
  exportedAt: string;
  encryption: {
    algorithm: 'AES-GCM';
    keySource: 'password';
    keyDerivation: 'PBKDF2';
  };
  providers: Record<string, ProviderExportEntry>;
}

interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'responses' | 'native';
  models?: Model[];
  /** 自定义供应商显示名称，内置供应商无此字段 */
  name?: string;
  /** 自定义/模板供应商的取 key 控制台链接，内置供应商无此字段 */
  apiKeyManagementUrl?: string;
  /** 模板供应商的 logo key，内置/用户自建供应商无此字段 */
  logoKey?: string;
}

interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}


const providerSwitchableDefaultBaseUrls: Partial<Record<ProviderType, { anthropic: string; openai: string; responses?: string }>> = {
  deepseek: {
    anthropic: 'https://api.deepseek.com/anthropic',
    openai: 'https://api.deepseek.com',
  },
  moonshot: {
    anthropic: 'https://api.moonshot.cn/anthropic',
    openai: 'https://api.moonshot.cn/v1',
  },
  // Zhipu GLM coding plan (https://docs.bigmodel.cn/cn/coding-plan/quick-start):
  // one key, three protocol endpoints. Chat Completions is the default — the
  // only wire where GLM thinking can be explicitly disabled.
  zhipu: {
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    openai: 'https://open.bigmodel.cn/api/coding/paas/v4',
    responses: 'https://open.bigmodel.cn/api/v1',
  },
  minimax: {
    anthropic: 'https://api.minimaxi.com/anthropic',
    openai: 'https://api.minimaxi.com/v1',
  },
  qwen: {
    anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  xiaomi: {
    anthropic: 'https://api.xiaomimimo.com/anthropic',
    openai: 'https://api.xiaomimimo.com/v1/chat/completions',
  },
  openrouter: {
    anthropic: 'https://openrouter.ai/api',
    openai: 'https://openrouter.ai/api/v1',
  },
  ollama: {
    anthropic: 'http://localhost:11434',
    openai: 'http://localhost:11434/v1',
  },
  opencode: {
    // OpenCode Go 网关：三个端点共用同一 Base URL（https://opencode.ai/docs/zh-cn/go）
    anthropic: 'https://opencode.ai/zen/go/v1',
    openai: 'https://opencode.ai/zen/go/v1',
  },
};

const providerRequiresApiKey = (provider: ProviderType) => provider !== 'ollama';
/** The built-in free-quota provider is relay-managed: its credentials and API shape are hidden from the UI. */
const isBuiltInFreeProvider = (provider: string): boolean => provider === LLM_FREE_PROVIDER_KEY;
/**
 * Providers whose Base URL / API format are managed by the app (relay endpoint
 * or the vendor's official fixed endpoint). Their API Key stays user-editable
 * unless relay-provisioned (ID.Bots).
 */
const isManagedProvider = (provider: string): boolean => (
  isBuiltInFreeProvider(provider) || provider === 'deepseek' || provider === 'commandcode'
);
/** DeepSeek official key-console URL, opened in the external browser from the key hint. */
const DEEPSEEK_PLATFORM_URL = 'https://platform.deepseek.com/';
/** Command Code Studio key-management page, opened in the external browser from the key hint. */
const COMMAND_CODE_KEYS_URL = 'https://commandcode.ai/settings/api-keys';
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '').toLowerCase();
const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' | 'responses' => {
  if (value === 'responses') {
    return 'responses';
  }
  return value === 'openai' ? 'openai' : 'anthropic';
};
const getFixedApiFormatForProvider = (provider: string): 'anthropic' | 'openai' | null => {
  if (provider === 'openai' || provider === 'gemini') {
    return 'openai';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  // Free-quota relay always speaks the OpenAI format; the selector stays hidden.
  if (isBuiltInFreeProvider(provider)) {
    return 'openai';
  }
  return null;
};
const getEffectiveApiFormat = (provider: string, value: unknown): 'anthropic' | 'openai' | 'responses' => {
  const fixed = getFixedApiFormatForProvider(provider);
  if (fixed) {
    return fixed;
  }
  const normalized = normalizeApiFormat(value);
  // Managed providers hide the format selector and pin chat-completions.
  // Coerce leftover Anthropic Messages so they are not stuck unavailable.
  if (normalized === 'anthropic' && isManagedProvider(provider)) {
    return 'openai';
  }
  return normalized;
};

// DeepSeek hides the selector (official harness pins the key-only chat-completions
// setup); the stored format still drives requests so legacy endpoints keep working.
const shouldShowApiFormatSelector = (provider: string): boolean => (
  getFixedApiFormatForProvider(provider) === null && !isManagedProvider(provider)
);
const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai' | 'responses'
): string | null => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  if (!defaults) {
    return null;
  }
  // Providers without a responses-specific endpoint (shared gateway base URL)
  // keep their current base URL when the responses format is selected.
  if (apiFormat === 'responses') {
    return defaults.responses ?? null;
  }
  return defaults[apiFormat];
};
const shouldAutoSwitchProviderBaseUrl = (provider: ProviderType, currentBaseUrl: string): boolean => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  if (!defaults) {
    return false;
  }

  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    normalizedCurrent === normalizeBaseUrl(defaults.anthropic)
    || normalizedCurrent === normalizeBaseUrl(defaults.openai)
    || (defaults.responses !== undefined && normalizedCurrent === normalizeBaseUrl(defaults.responses))
  );
};
const buildOpenAICompatibleChatCompletionsUrl = (baseUrl: string, provider: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/chat/completions';
  }
  if (normalized.endsWith('/chat/completions')) {
    return normalized;
  }

  const isGeminiLike = provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1')
        ? `${normalized.slice(0, -3)}v1beta`
        : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  // Versioned bases (…/v1, …/v4 — e.g. Zhipu's /api/coding/paas/v4) mount
  // chat/completions directly; only unversioned hosts take the /v1 prefix.
  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};
// buildOpenAIResponsesUrl is imported from services/openaiResponsesUrl (the
// shared renderer routing rule — DeepSeek host-root + versioned-base guard)
// so the settings probe hits the exact URL the data paths build.
const shouldUseOpenAIResponsesForProvider = (provider: string): boolean => (
  provider === 'openai'
);
const shouldUseMaxCompletionTokensForOpenAI = (provider: string, modelId?: string): boolean => {
  if (provider !== 'openai') {
    return false;
  }
  const normalizedModel = (modelId ?? '').toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
};
const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ])
  ) as ProvidersConfig;
};

const getInitialProviders = (): ProvidersConfig => (
  (mergeProvidersConfig(undefined, configService.getConfig().providers) as ProvidersConfig) || getDefaultProviders()
);

const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = providerKeys.find(providerKey => providers[providerKey]?.enabled);
  return firstEnabledProvider ?? providerKeys[0];
};

// --- 自定义供应商辅助 ---
// 自定义供应商由用户通过"添加供应商"创建，key 形如 custom-<slug>，
// 不在内置注册表内，显示名存于配置的 name 字段。
const getProviderDisplayLabel = (key: ProviderType, config?: ProviderConfig): string => {
  if (isCustomProviderKey(key)) {
    return config?.name?.trim() || key.charAt(0).toUpperCase() + key.slice(1);
  }
  if (isBuiltInFreeProvider(key)) {
    return i18nService.t('idbotsSubscriptionProvider');
  }
  return getBuiltInProviderLabel(key);
};

const generateCustomProviderKey = (name: string, existingKeys: string[]): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const base = slug ? `custom-${slug}` : 'custom-provider';
  let candidate = base;
  let suffix = 2;
  while (existingKeys.includes(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

// Template instances are custom providers keyed `custom-<templateId>` (ZCode
// personal-provider model: every pick seeds a fresh entry). The display name
// gets the same numeric suffix as the key so duplicates read "Z.ai API 2".
const generateTemplateProviderKey = (
  templateId: string,
  existingKeys: string[]
): { key: string; suffix: number } => {
  const base = `custom-${templateId}`;
  let candidate = base;
  let suffix = 1;
  while (existingKeys.includes(candidate)) {
    candidate = `${base}-${suffix + 1}`;
    suffix += 1;
  }
  return { key: candidate, suffix };
};

/**
 * Hint under the context-window field: when the entered window is small
 * enough that the resolution-time clamp (main: clampCoworkMaxOutputTokens)
 * would pull the output ceiling below the new-model 128K pin, tell the user
 * the effective cap instead of letting them discover it via overflow
 * failures. Returns null when nothing would change.
 */
const contextWindowClampHint = (raw: string): string | null => {
  const parsed = parseContextWindowSizeInput(raw);
  if (parsed === undefined || parsed === null) return null;
  const effective = effectiveMaxOutputForWindow(parsed);
  if (effective >= NEW_MODEL_DEFAULT_MAX_OUTPUT_TOKENS) return null;
  return i18nService.t('contextWindowOutputClampHint').replace('{value}', formatContextWindowSize(effective));
};

const Settings: React.FC<SettingsProps> = ({ onClose, initialTab, notice, openNewProjectForm }) => {
  const dispatch = useDispatch();
  // Sandbox settings are temporarily hidden; fall back to general.
  const resolvedInitialTab: TabType = initialTab === 'coworkSandbox' ? 'general' : (initialTab ?? 'general');
  const [activeTab, setActiveTab] = useState<TabType>(resolvedInitialTab);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [language, setLanguage] = useState<LanguageType>(i18nService.getLanguage());
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [isUpdatingAutoLaunch, setIsUpdatingAutoLaunch] = useState(false);
  const [experimentalAutomation, setExperimentalAutomationState] = useState(true);
  const [isUpdatingExperimentalAutomation, setIsUpdatingExperimentalAutomation] = useState(false);
  const [liveStageEnabled, setLiveStageEnabled] = useState(false);
  const [isUpdatingLiveStage, setIsUpdatingLiveStage] = useState(false);
  const [preventDeviceSleep, setPreventDeviceSleepState] = useState(false);
  const [isUpdatingPreventDeviceSleep, setIsUpdatingPreventDeviceSleep] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(notice ?? null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [fetchModelsResult, setFetchModelsResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isImportingProviders, setIsImportingProviders] = useState(false);
  const [isExportingProviders, setIsExportingProviders] = useState(false);
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  // Add state for active provider
  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());

  // Add state for providers configuration
  const [providers, setProviders] = useState<ProvidersConfig>(() => getInitialProviders());

  // The decision-model configuration sits beside ID.Bots in the provider list.
  const [showCerebellumSettings, setShowCerebellumSettings] = useState(false);
  // S9 ME points: shared server-data snapshot (plans / balance / rates).
  const meSnapshot = React.useSyncExternalStore(subscribeMeSnapshot, getMeSnapshot, getMeSnapshot);
  useEffect(() => {
    // The model tab needs plans + weekly grant + rates; the traffic tab
    // (用量 & 积分) pulls its own pages. Cheap: TTL-cached + best-effort.
    ensureMeSnapshot();
  }, []);
  // Cerebellum edits are local until the shared Save button persists them.
  const [cerebellum, setCerebellum] = useState<CerebellumConfig>(() => ({
    ...DEFAULT_CEREBELLUM_CONFIG,
    ...(configService.getConfig().cerebellum ?? {}),
  }));
  const [cerebellumTestResult, setCerebellumTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTestingCerebellum, setIsTestingCerebellum] = useState(false);

  // 创建引用来确保内容区域的滚动
  const contentRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  
  // 快捷键设置
  const [shortcuts, setShortcuts] = useState({
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  });

  // Fee rate configuration
  type FeeRateTier = { title: string; desc: string; feeRate: number };
  const [feeRateTiers, setFeeRateTiers] = useState<Record<string, FeeRateTier[]>>({
    btc: [{ title: 'Fast', desc: 'About 10 minutes', feeRate: 2 }, { title: 'Avg', desc: 'About 30 minutes', feeRate: 2 }, { title: 'Slow', desc: 'About 1 hours', feeRate: 2 }],
    mvc: [{ title: 'Fast', desc: 'About 10 minutes', feeRate: 1 }, { title: 'Avg', desc: 'About 30 minutes', feeRate: 1 }, { title: 'Slow', desc: 'About 1 hours', feeRate: 1 }],
    doge: [{ title: 'Fast', desc: 'About 10 minutes', feeRate: 7500000 }, { title: 'Avg', desc: 'About 30 minutes', feeRate: 5000000 }, { title: 'Slow', desc: 'About 1 hours', feeRate: 5000000 }],
  });
  const [selectedFeeTier, setSelectedFeeTier] = useState<Record<string, string>>({
    btc: 'Fast',
    mvc: 'Fast',
    doge: 'Fast',
  });
  const [feeRateLoading, setFeeRateLoading] = useState(false);

  const handleSelectFeeTier = useCallback((chain: string, tierTitle: string) => {
    setSelectedFeeTier((prev) => ({ ...prev, [chain]: tierTitle }));
    window.electron.feeRates.select(chain, tierTitle).catch(() => {});
  }, []);

  const loadFeeRates = useCallback(async () => {
    setFeeRateLoading(true);
    try {
      const [tiersData, selectedData] = await Promise.all([
        window.electron.feeRates.refresh(),
        window.electron.feeRates.getSelected(),
      ]);
      if (tiersData) setFeeRateTiers(tiersData);
      if (selectedData) setSelectedFeeTier(selectedData);
    } catch {
      // silently use defaults
    } finally {
      setFeeRateLoading(false);
    }
  }, []);

  // State for model editing
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  // Raw input for the optional per-model context window (empty = inherit the
  // default 128K / known-model catalog instead of persisting an explicit value).
  const [newModelContextWindow, setNewModelContextWindow] = useState('');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  // "Add Provider" template picker (ZCode-style): when open, the right detail
  // area is replaced by the third-party template list instead of a modal.
  const [showProviderTemplatePicker, setShowProviderTemplatePicker] = useState(false);
  // Provider awaiting delete confirmation (in-app modal — window.confirm is
  // a no-op in Electron, it resolves false without showing any dialog).
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<ProviderType | null>(null);

  // 「积分 & 流量」 tab sub-page: ME credits (default) vs the on-chain
  // traffic quota page, brought back verbatim.
  const [creditsSubTab, setCreditsSubTab] = useState<'credits' | 'traffic'>('credits');

  // Right-click cut/copy/paste menus for the Base URL inputs on this page
  // (API-key fields get theirs from SecretInput itself).
  const providerBaseUrlContextMenu = useTextInputContextMenu();
  const cerebellumBaseUrlContextMenu = useTextInputContextMenu();

  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const imConfig = useSelector((state: RootState) => state.im.config);

  const [coworkExecutionMode, setCoworkExecutionMode] = useState<CoworkExecutionMode>('local');
  // Shared MetaBot list — also used by the Archived Chats tab.
  const [coworkMemoryMetabots, setCoworkMemoryMetabots] = useState<MemoryMetabotOption[]>([]);
  const [coworkSandboxStatus, setCoworkSandboxStatus] = useState<CoworkSandboxStatus | null>(null);
  const [coworkSandboxLoading, setCoworkSandboxLoading] = useState(true);
  const [coworkSandboxProgress, setCoworkSandboxProgress] = useState<CoworkSandboxProgress | null>(null);
  const [coworkSandboxInstalling, setCoworkSandboxInstalling] = useState(false);

  // Archived Chats panel (P4): archived conversations with search + restore.
  const [archivedChats, setArchivedChats] = useState<CoworkSessionSummary[]>([]);
  const [archivedChatsLoading, setArchivedChatsLoading] = useState<boolean>(false);
  const [archivedChatsQuery, setArchivedChatsQuery] = useState<string>('');
  const [archivedChatsSearchContent, setArchivedChatsSearchContent] = useState<boolean>(false);
  const [archivedChatsMetabotId, setArchivedChatsMetabotId] = useState<number | null>(null);
  const [archivedChatsPage, setArchivedChatsPage] = useState<number>(0);
  const [archivedChatsTotal, setArchivedChatsTotal] = useState<number>(0);
  const [archivedChatsNotice, setArchivedChatsNotice] = useState<string | null>(null);
  // Archived panel sub-tab: 'chats' (local chats, default), 'groupTasks' or 'a2a' (online A2A chats).
  const [archivedSubTab, setArchivedSubTab] = useState<'chats' | 'groupTasks' | 'a2a'>('chats');
  // Archived Group Tasks panel: archived group tasks with pagination + restore.
  const [archivedGroupTasks, setArchivedGroupTasks] = useState<GroupTaskSummary[]>([]);
  const [archivedGroupTasksLoading, setArchivedGroupTasksLoading] = useState<boolean>(false);
  const [archivedGroupTasksTotal, setArchivedGroupTasksTotal] = useState<number>(0);
  const [archivedGroupTasksPage, setArchivedGroupTasksPage] = useState<number>(0);
  const [archivedGroupTasksNotice, setArchivedGroupTasksNotice] = useState<string | null>(null);
  // Archived A2A chats panel (Settings): archived online (A2A) sessions, paginated + restore.
  const [archivedA2AChats, setArchivedA2AChats] = useState<CoworkSessionSummary[]>([]);
  const [archivedA2AChatsLoading, setArchivedA2AChatsLoading] = useState<boolean>(false);
  const [archivedA2AChatsTotal, setArchivedA2AChatsTotal] = useState<number>(0);
  const [archivedA2AChatsPage, setArchivedA2AChatsPage] = useState<number>(0);
  const [archivedA2AChatsNotice, setArchivedA2AChatsNotice] = useState<string | null>(null);

  useEffect(() => {
    window.electron.appInfo
      .getVersion()
      .then((v) => setAppVersion(typeof v === 'string' ? v : ''))
      .catch(() => setAppVersion(''));
  }, []);

  // feat/legacy-data-recovery ②: data-directory visibility (path + open).
  const [dataDirectoryPath, setDataDirectoryPath] = useState<string>('');

  useEffect(() => {
    window.electron.appInfo
      .getDataDirectory()
      .then((info) => setDataDirectoryPath(typeof info?.userDataPath === 'string' ? info.userDataPath : ''))
      .catch(() => setDataDirectoryPath(''));
  }, []);

  const handleOpenDataDirectory = useCallback(async (): Promise<void> => {
    if (!dataDirectoryPath) return;
    try {
      const result = await window.electron.shell.openPath(dataDirectoryPath);
      if (result && result.success === false) {
        setError(i18nService.t('settingsDataDirectoryOpenFailed'));
      }
    } catch (openError) {
      setError(i18nService.t('settingsDataDirectoryOpenFailed'));
    }
  }, [dataDirectoryPath]);

  useEffect(() => {
    setCoworkExecutionMode('local');
  }, [coworkConfig.executionMode]);

  const loadCoworkSandboxStatus = useCallback(async () => {
    setCoworkSandboxLoading(true);
    try {
      const status = await coworkService.getSandboxStatus();
      setCoworkSandboxStatus(status);
      if (status?.progress) {
        setCoworkSandboxProgress(status.progress);
      }
    } catch (loadError) {
      console.error('Failed to load cowork sandbox status:', loadError);
      setCoworkSandboxStatus(null);
    } finally {
      setCoworkSandboxLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCoworkSandboxStatus();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    loadFeeRates();
  }, [loadFeeRates]);

  useEffect(() => {
    const unsubscribe = coworkService.onSandboxDownloadProgress((progress) => {
      setCoworkSandboxProgress(progress);
      if (progress.percent !== undefined && progress.percent >= 1) {
        void loadCoworkSandboxStatus();
      }
    });
    return () => unsubscribe();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    let active = true;
    window.electron.studioLiveStage.get().then((settings) => {
      if (!active) return;
      setLiveStageEnabled(settings.enabled);
    }).catch((loadError) => console.error('Failed to load Live Stage settings:', loadError));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try {
      const config = configService.getConfig();
      
      // Set general settings
      initialThemeRef.current = config.theme;
      initialLanguageRef.current = config.language;
      setTheme(config.theme);
      setLanguage(config.language);

      // Load auto-launch setting
      window.electron.autoLaunch.get().then(({ enabled }) => {
        setAutoLaunchState(enabled);
      }).catch(err => {
        console.error('Failed to load auto-launch setting:', err);
      });

      // Load the experimental automation kill-switch (missing key = allowed)
      window.electron.experimentalAutomation.get().then(({ enabled }) => {
        setExperimentalAutomationState(enabled);
      }).catch(err => {
        console.error('Failed to load the experimental automation setting:', err);
      });

      // Load prevent-device-sleep setting (missing key = OFF)
      window.electron.powerGuard.getPreventDeviceSleep().then(({ enabled }) => {
        setPreventDeviceSleepState(enabled);
      }).catch(err => {
        console.error('Failed to load prevent-device-sleep setting:', err);
      });
      
      // Set up providers based on saved config
      if (config.api) {
        // For backward compatibility with older config
        // Initialize active provider based on baseUrl
        const normalizedApiBaseUrl = config.api.baseUrl.toLowerCase();
        if (normalizedApiBaseUrl.includes('openai')) {
          setActiveProvider('openai');
          setProviders(prev => ({
            ...prev,
            openai: {
              ...prev.openai,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('deepseek')) {
          setActiveProvider('deepseek');
          setProviders(prev => ({
            ...prev,
            deepseek: {
              ...prev.deepseek,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('moonshot.ai') || normalizedApiBaseUrl.includes('moonshot.cn')) {
          setActiveProvider('moonshot');
          setProviders(prev => ({
            ...prev,
            moonshot: {
              ...prev.moonshot,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('bigmodel.cn')) {
          setActiveProvider('zhipu');
          setProviders(prev => ({
            ...prev,
            zhipu: {
              ...prev.zhipu,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('minimax')) {
          setActiveProvider('minimax');
          setProviders(prev => ({
            ...prev,
            minimax: {
              ...prev.minimax,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('dashscope')) {
          setActiveProvider('qwen');
          setProviders(prev => ({
            ...prev,
            qwen: {
              ...prev.qwen,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('openrouter.ai')) {
          setActiveProvider('openrouter');
          setProviders(prev => ({
            ...prev,
            openrouter: {
              ...prev.openrouter,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('googleapis')) {
          setActiveProvider('gemini');
          setProviders(prev => ({
            ...prev,
            gemini: {
              ...prev.gemini,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('anthropic')) {
          setActiveProvider('anthropic');
          setProviders(prev => ({
            ...prev,
            anthropic: {
              ...prev.anthropic,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        } else if (normalizedApiBaseUrl.includes('ollama') || normalizedApiBaseUrl.includes('11434')) {
          setActiveProvider('ollama');
          setProviders(prev => ({
            ...prev,
            ollama: {
              ...prev.ollama,
              enabled: true,
              apiKey: config.api.key,
              baseUrl: config.api.baseUrl
            }
          }));
        }
      }
      
      // Load provider-specific configurations if available
      // 合并已保存的配置和默认配置，确保新添加的 provider 能被显示
      setProviders(mergeProvidersConfig(undefined, config.providers) as ProvidersConfig);
      
      // 加载快捷键设置
      if (config.shortcuts) {
        setShortcuts(prev => ({
          ...prev,
          ...config.shortcuts,
        }));
      }
    } catch (error) {
      setError('Failed to load settings');
    }
  }, []);

  useEffect(() => {
    return () => {
      if (didSaveRef.current) {
        return;
      }
      themeService.setTheme(initialThemeRef.current);
      i18nService.setLanguage(initialLanguageRef.current, { persist: false });
    };
  }, []);

  // 监听标签页切换，确保内容区域滚动到顶部
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    setNoticeMessage(notice ?? null);
  }, [notice]);

  useEffect(() => {
    if (!initialTab || initialTab === 'coworkSandbox') {
      if (initialTab === 'coworkSandbox') {
        setActiveTab('general');
      }
      return;
    }
    setActiveTab(initialTab);
  }, [initialTab]);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // The default list only surfaces the two ID.Bots entries: the subscription
  // relay (always visible) and the top-up pseudo-entry (rendered separately).
  // Untouched built-ins (disabled + keyless, the factory state for DeepSeek,
  // OpenCode, ...) stay hidden; they reappear once the user configures them
  // (enabled or key set) or adds them back via the template picker. Custom
  // providers (template- or user-created) always show.
  const visibleProviders = useMemo(() => {
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of Object.keys(providers)) {
      const config = providers[key as keyof ProvidersConfig];
      if (!isCustomProviderKey(key)) {
        const isTouched = Boolean(config?.enabled || config?.apiKey?.trim());
        if (!isTouched && !isBuiltInFreeProvider(key)) {
          continue;
        }
      }
      filtered[key as keyof ProvidersConfig] = config;
    }
    return filtered as ProvidersConfig;
  }, [providers]);

  // Resolved theme for the template logo assets (light/dark variants).
  const isDarkTheme = theme === 'dark'
    || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  // Optional vendor key-console link carried by custom/template providers.
  const activeApiKeyManagementUrl = (providers[activeProvider] as ProviderConfig | undefined)?.apiKeyManagementUrl;
  // Everything below the two pinned ID.Bots entries: configured built-ins +
  // custom/template providers. The group label only renders when non-empty.
  const thirdPartyProviderEntries = useMemo(
    () => Object.entries(visibleProviders).filter(([provider]) => provider !== LLM_FREE_PROVIDER_KEY),
    [visibleProviders]
  );
  // Display name shown in the delete-confirmation dialog.
  const pendingDeleteProviderName = pendingDeleteProvider
    ? getProviderDisplayLabel(pendingDeleteProvider, providers[pendingDeleteProvider])
    : '';

  // Ensure activeProvider is always in visibleProviders when language changes
  useEffect(() => {
    const visibleKeys = Object.keys(visibleProviders) as ProviderType[];
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeProvider)) {
      // If current activeProvider is not visible, switch to first visible provider
      const firstEnabledVisible = visibleKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider(firstEnabledVisible ?? visibleKeys[0]);
    }
  }, [visibleProviders, activeProvider]);

  // Handle provider change
  const handleProviderChange = (provider: ProviderType) => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelContextWindow('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
    setActiveProvider(provider);
    setShowCerebellumSettings(false);
    setShowProviderTemplatePicker(false);
    // 切换 provider 时清除测试结果
    setTestResult(null);
    setFetchModelsResult(null);
  };

  // Handle provider configuration change
  const handleProviderConfigChange = (provider: ProviderType, field: string, value: string) => {
    setProviders(prev => {
      if (field === 'apiFormat') {
        const nextApiFormat = getEffectiveApiFormat(provider, value);
        const nextProviderConfig: ProviderConfig = {
          ...prev[provider],
          apiFormat: nextApiFormat,
        };

        // Only auto-switch URL when current value is still a known default URL.
        if (shouldAutoSwitchProviderBaseUrl(provider, prev[provider].baseUrl)) {
          const defaultBaseUrl = getProviderDefaultBaseUrl(provider, nextApiFormat);
          if (defaultBaseUrl) {
            nextProviderConfig.baseUrl = defaultBaseUrl;
          }
        }

        return {
          ...prev,
          [provider]: nextProviderConfig,
        };
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          [field]: value,
        },
      };
    });
  };

  const hasCoworkConfigChanges = coworkExecutionMode !== coworkConfig.executionMode;

  const coworkSandboxDisabled = !coworkSandboxStatus?.supported
    || !coworkSandboxStatus?.runtimeReady
    || !coworkSandboxStatus?.imageReady;

  const coworkSandboxStatusHint = useMemo(() => {
    if (coworkSandboxLoading) return i18nService.t('coworkSandboxChecking');
    if (!coworkSandboxStatus?.supported) return i18nService.t('coworkSandboxUnsupported');
    if (coworkSandboxStatus?.downloading) return i18nService.t('coworkSandboxDownloading');
    if (!coworkSandboxStatus?.runtimeReady) return i18nService.t('coworkSandboxRuntimeMissing');
    if (!coworkSandboxStatus?.imageReady) return i18nService.t('coworkSandboxImageMissing');
    return '';
  }, [coworkSandboxLoading, coworkSandboxStatus]);

  const coworkSandboxPercent = useMemo(() => {
    if (!coworkSandboxProgress) return null;
    if (coworkSandboxProgress.percent !== undefined && Number.isFinite(coworkSandboxProgress.percent)) {
      return Math.min(100, Math.max(0, Math.round(coworkSandboxProgress.percent * 100)));
    }
    if (coworkSandboxProgress.total && coworkSandboxProgress.total > 0) {
      return Math.min(100, Math.max(0, Math.round((coworkSandboxProgress.received / coworkSandboxProgress.total) * 100)));
    }
    return null;
  }, [coworkSandboxProgress]);

  const coworkSandboxStageLabel = coworkSandboxProgress?.stage === 'image'
    ? (i18nService.getLanguage() === 'zh' ? '镜像' : 'Image')
    : (i18nService.getLanguage() === 'zh' ? '运行时' : 'Runtime');

  const handleInstallCoworkSandbox = async () => {
    setCoworkSandboxInstalling(true);
    try {
      const result = await coworkService.installSandbox();
      if (result?.status) {
        setCoworkSandboxStatus(result.status);
        if (result.status.progress) {
          setCoworkSandboxProgress(result.status.progress);
        }
      }
    } finally {
      setCoworkSandboxInstalling(false);
    }
  };

  const loadCoworkMemoryMetabots = useCallback(async () => {
    try {
      // `metabot:list` carries `globalmetaid`, which the ID-anchored contact
      // view needs to resolve the observer bot's on-chain identity.
      const result = await window.electron?.metabot?.list();
      const list = result?.success && Array.isArray(result.list)
        ? result.list
          .filter((item) => (
            typeof item?.id === 'number'
            && Number.isFinite(item.id)
            && item.id > 0
            && typeof item?.name === 'string'
          ))
          .map((item) => ({
            id: item.id,
            name: item.name,
            avatar: item.avatar ?? null,
            metabot_type: item.metabot_type === 'worker' ? 'worker' : item.metabot_type === 'welcome' ? 'welcome' : 'twin',
            globalmetaid: item.globalmetaid ?? null,
          }))
        : [];
      setCoworkMemoryMetabots(list);
    } catch (loadError) {
      console.error('Failed to load MetaBots for memory scope:', loadError);
      setCoworkMemoryMetabots([]);
    }
  }, []);

  useEffect(() => {
    void loadCoworkMemoryMetabots();
  }, [loadCoworkMemoryMetabots]);

  useEffect(() => {
    if (activeTab !== 'coworkMemory') return;
    void loadCoworkMemoryMetabots();
  }, [activeTab, loadCoworkMemoryMetabots]);

  const loadArchivedChats = useCallback(async () => {
    setArchivedChatsLoading(true);
    try {
      const result = await window.electron?.cowork?.listArchivedSessions({
        metabotId: archivedChatsMetabotId,
        query: archivedChatsQuery.trim() || undefined,
        searchContent: archivedChatsSearchContent || undefined,
        limit: ARCHIVED_CHATS_PAGE_SIZE,
        offset: archivedChatsPage * ARCHIVED_CHATS_PAGE_SIZE,
      });
      setArchivedChats(result?.success && Array.isArray(result.sessions) ? result.sessions : []);
      setArchivedChatsTotal(result?.success && typeof result.total === 'number' ? result.total : 0);
    } catch (loadError) {
      console.error('Failed to load archived chats:', loadError);
      setArchivedChats([]);
    } finally {
      setArchivedChatsLoading(false);
    }
  }, [archivedChatsQuery, archivedChatsMetabotId, archivedChatsSearchContent, archivedChatsPage]);

  // Jump back to the first page whenever a filter (bot, query or content toggle) changes.
  useEffect(() => {
    setArchivedChatsPage(0);
  }, [archivedChatsQuery, archivedChatsMetabotId, archivedChatsSearchContent]);

  useEffect(() => {
    if (activeTab !== 'archivedChats') return;
    const debounce = setTimeout(() => {
      void loadArchivedChats();
    }, 300);
    return () => clearTimeout(debounce);
  }, [activeTab, loadArchivedChats]);

  useEffect(() => {
    if (archivedChatsNotice == null) return;
    const timer = setTimeout(() => setArchivedChatsNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [archivedChatsNotice]);

  const handleUnarchiveChat = async (sessionId: string) => {
    try {
      const result = await window.electron?.cowork?.unarchiveSession(sessionId);
      if (result?.success) {
        const remaining = archivedChats.filter((session) => session.id !== sessionId);
        setArchivedChats(remaining);
        if (remaining.length === 0 && archivedChatsPage > 0) {
          setArchivedChatsPage((page) => Math.max(0, page - 1));
        }
        // The sidebar reads the shared cowork store's session list, which only
        // reloads on init / stream events — without this refresh the restored
        // chat stays invisible until the next app launch.
        await coworkService.loadSessions();
        setArchivedChatsNotice(i18nService.t('archivedChatsRestored'));
      }
    } catch (unarchiveError) {
      console.error('Failed to unarchive session:', unarchiveError);
    }
  };

  const loadArchivedGroupTasks = useCallback(async () => {
    setArchivedGroupTasksLoading(true);
    try {
      const { tasks, total } = await groupTaskService.listArchivedTasks({
        limit: ARCHIVED_CHATS_PAGE_SIZE,
        offset: archivedGroupTasksPage * ARCHIVED_CHATS_PAGE_SIZE,
      });
      setArchivedGroupTasks(tasks);
      setArchivedGroupTasksTotal(total);
    } catch (loadError) {
      console.error('Failed to load archived group tasks:', loadError);
      setArchivedGroupTasks([]);
    } finally {
      setArchivedGroupTasksLoading(false);
    }
  }, [archivedGroupTasksPage]);

  useEffect(() => {
    if (activeTab !== 'archivedChats' || archivedSubTab !== 'groupTasks') return;
    void loadArchivedGroupTasks();
  }, [activeTab, archivedSubTab, loadArchivedGroupTasks]);

  useEffect(() => {
    if (archivedGroupTasksNotice == null) return;
    const timer = setTimeout(() => setArchivedGroupTasksNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [archivedGroupTasksNotice]);

  const handleUnarchiveGroupTask = async (taskId: number) => {
    try {
      await groupTaskService.unarchiveTask(taskId);
      const remaining = archivedGroupTasks.filter((task) => task.id !== taskId);
      setArchivedGroupTasks(remaining);
      if (remaining.length === 0 && archivedGroupTasksPage > 0) {
        setArchivedGroupTasksPage((page) => Math.max(0, page - 1));
      }
      // Same staleness as restored chats: the sidebar's group tab renders the
      // redux task list, which only reloads on tab entry — refresh it now.
      await groupTaskService.loadTasks();
      setArchivedGroupTasksNotice(i18nService.t('archivedGroupTasksRestored'));
    } catch (unarchiveError) {
      console.error('Failed to unarchive group task:', unarchiveError);
    }
  };

  const loadArchivedA2AChats = useCallback(async () => {
    setArchivedA2AChatsLoading(true);
    try {
      const result = await window.electron?.cowork?.listArchivedSessions({
        sessionType: 'a2a',
        limit: ARCHIVED_CHATS_PAGE_SIZE,
        offset: archivedA2AChatsPage * ARCHIVED_CHATS_PAGE_SIZE,
      });
      setArchivedA2AChats(result?.success && Array.isArray(result.sessions) ? result.sessions : []);
      setArchivedA2AChatsTotal(result?.success && typeof result.total === 'number' ? result.total : 0);
    } catch (loadError) {
      console.error('Failed to load archived A2A chats:', loadError);
      setArchivedA2AChats([]);
    } finally {
      setArchivedA2AChatsLoading(false);
    }
  }, [archivedA2AChatsPage]);

  useEffect(() => {
    if (activeTab !== 'archivedChats' || archivedSubTab !== 'a2a') return;
    void loadArchivedA2AChats();
  }, [activeTab, archivedSubTab, loadArchivedA2AChats]);

  useEffect(() => {
    if (archivedA2AChatsNotice == null) return;
    const timer = setTimeout(() => setArchivedA2AChatsNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [archivedA2AChatsNotice]);

  const handleUnarchiveA2AChat = async (sessionId: string) => {
    try {
      const result = await window.electron?.cowork?.unarchiveSession(sessionId);
      if (result?.success) {
        const remaining = archivedA2AChats.filter((session) => session.id !== sessionId);
        setArchivedA2AChats(remaining);
        if (remaining.length === 0 && archivedA2AChatsPage > 0) {
          setArchivedA2AChatsPage((page) => Math.max(0, page - 1));
        }
        // See handleUnarchiveChat: the sidebar's a2a tab renders the same
        // redux session list, so it needs the same explicit refresh.
        await coworkService.loadSessions();
        setArchivedA2AChatsNotice(i18nService.t('archivedChatsRestored'));
      }
    } catch (unarchiveError) {
      console.error('Failed to unarchive A2A session:', unarchiveError);
    }
  };

  // Drill-down: jump from an experience record into the full conversation.
  // App listens for cowork:viewSession (switching to the cowork view and
  // loading the session); close Settings first so it does not stay overlaid.
  const handleOpenCoworkSession = (sessionId: string) => {
    const trimmed = sessionId?.trim();
    if (!trimmed) return;
    onClose();
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: trimmed } }));
  };

  const formatMemoryUpdatedAt = (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return '-';
    }
  };

  // Toggle provider enabled status
  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
    const isEnabling = !providerConfig.enabled;
    const missingApiKey = providerRequiresApiKey(provider) && !providerConfig.apiKey.trim();

    if (isEnabling && missingApiKey) {
      setError(i18nService.t('apiKeyRequired'));
      return;
    }

    setProviders(prev => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        enabled: !prev[provider].enabled
      }
    }));
  };

  // Free-quota card: after a manual enable, reload providers from the freshly
  // written config and rebuild the redux model list so the metaid-free models
  // appear everywhere without a restart.
  const handleFreeQuotaProvisioned = useCallback(() => {
    const config = configService.getConfig();
    setProviders(mergeProvidersConfig(undefined, config.providers) as ProvidersConfig);
    const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean; options?: AppConfig['model']['availableModels'][number]['options'] }[] = [];
    Object.entries(config.providers ?? {}).forEach(([providerName, providerConfig]) => {
      if (providerConfig.enabled && providerConfig.models) {
        providerConfig.models.forEach((model) => {
          allModels.push({
            id: model.id,
            name: model.name,
            provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
            providerKey: providerName,
            supportsImage: model.supportsImage ?? false,
            options: model.options,
          });
        });
      }
    });
    if (allModels.length > 0) {
      dispatch(setAvailableModels(allModels));
      const preferred = allModels.find(
        (model) => model.id === config.model.defaultModel && model.providerKey === config.model.defaultProvider
      ) ?? allModels.find((model) => model.id === config.model.defaultModel) ?? allModels[0];
      dispatch(setSelectedModel(preferred));
    }
  }, [dispatch]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerKey, providerConfig]) => [
          providerKey,
          {
            ...providerConfig,
            apiFormat: getEffectiveApiFormat(providerKey, providerConfig.apiFormat),
          },
        ])
      ) as ProvidersConfig;

      // Reconcile the persisted default model against the edited catalogs: a
      // Fetch Models sync or a manual delete may have removed the model the
      // global default points at. Fall back so the composer never references
      // an id that no longer exists — prefer the same provider's first model,
      // then the first enabled provider's first model overall.
      const persistedModelConfig = configService.getConfig().model;
      const persistedDefaultProvider = persistedModelConfig.defaultProvider ?? '';
      let reconciledDefault: { id: string; providerKey: string } | null = null;
      const defaultModelSurvives = Object.entries(normalizedProviders).some(([providerKey, providerConfig]) =>
        providerKey === persistedDefaultProvider
        && providerConfig.enabled
        && (providerConfig.models ?? []).some((model) => model.id === persistedModelConfig.defaultModel));
      if (!defaultModelSurvives) {
        const sameProvider = normalizedProviders[persistedDefaultProvider];
        const sameProviderFirst = sameProvider?.enabled ? (sameProvider.models ?? [])[0] : undefined;
        if (sameProviderFirst) {
          reconciledDefault = { id: sameProviderFirst.id, providerKey: persistedDefaultProvider };
        } else {
          for (const [providerKey, providerConfig] of Object.entries(normalizedProviders)) {
            const first = providerConfig.enabled ? (providerConfig.models ?? [])[0] : undefined;
            if (first) {
              reconciledDefault = { id: first.id, providerKey };
              break;
            }
          }
        }
      }

      // Find the first enabled provider to use as the primary API
      const firstEnabledProvider = Object.entries(normalizedProviders).find(
        ([_, config]) => config.enabled
      );

      const primaryProvider = firstEnabledProvider
        ? firstEnabledProvider[1]
        : normalizedProviders[activeProvider];

      await configService.updateConfig({
        api: {
          key: primaryProvider.apiKey,
          baseUrl: primaryProvider.baseUrl,
        },
        providers: normalizedProviders,
        theme,
        language,
        shortcuts,
        cerebellum,
        ...(reconciledDefault
          ? {
              model: {
                ...persistedModelConfig,
                defaultModel: reconciledDefault.id,
                defaultProvider: reconciledDefault.providerKey,
              },
            }
          : {}),
      });

      // Verify-what-was-persisted: re-read the store and adopt it as the
      // in-memory config. The next Settings open initializes its fields from
      // configService.getConfig(), so the key fields show the STORED value —
      // a silent write failure or a migration reshaping a provider becomes
      // visible in the (now plain-text) inputs instead of hiding behind dots.
      await configService.reloadFromStore();

      // 应用主题
      themeService.setTheme(theme);

      // 应用语言
      i18nService.setLanguage(language, { persist: false });

      // Set API with the primary provider
      apiService.setConfig({
        apiKey: primaryProvider.apiKey,
        baseUrl: primaryProvider.baseUrl,
      });

      // 更新 Redux store 中的可用模型列表
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean; options?: AppConfig['model']['availableModels'][number]['options'] }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (config.enabled && config.models) {
          config.models.forEach(model => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
              options: model.options,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));

      // Keep the redux selection on a model that exists in the saved catalogs
      // when the default was reconciled above.
      if (reconciledDefault) {
        const preferred = allModels.find(
          (model) => model.id === reconciledDefault.id && model.providerKey === reconciledDefault.providerKey
        );
        if (preferred) {
          dispatch(setSelectedModel(preferred));
        }
      }

      if (hasCoworkConfigChanges) {
        await coworkService.updateConfig({
          executionMode: coworkExecutionMode,
        });
      }

      // Save IM config
      await imService.updateConfig(imConfig);

      didSaveRef.current = true;
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // 标签页切换处理
  const handleTabChange = (tab: TabType) => {
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelContextWindow('');
      setNewModelSupportsImage(false);
      setModelFormError(null);
      setShowProviderTemplatePicker(false);
    }
    if (tab === 'paramsConfig') {
      loadFeeRates();
    }
    setActiveTab(tab);
  };

  // 快捷键更新处理
  const handleShortcutChange = (key: keyof typeof shortcuts, value: string) => {
    setShortcuts(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleLiveStageSettings = async (updates: { enabled?: boolean }) => {
    if (isUpdatingLiveStage) return;
    setIsUpdatingLiveStage(true);
    try {
      const result = await window.electron.studioLiveStage.set(updates);
      if (result.success) {
        setLiveStageEnabled(result.enabled === true);
      } else {
        setError(result.error || 'Failed to update Live Stage settings');
      }
    } catch (updateError) {
      console.error('Failed to update Live Stage settings:', updateError);
      setError('Failed to update Live Stage settings');
    } finally {
      setIsUpdatingLiveStage(false);
    }
  };

  // The chat-experience-mode switch UI is gone (owner ruling 2026-11-10): the
  // mode is decided by the active face (hooks/chatExperienceModeSource.ts) and
  // nothing here reads or writes chatExperienceMode any more.

  // 阻止点击设置窗口时事件传播到背景
  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Handlers for model operations
  const handleAddModel = () => {
    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    // The context-window field starts EMPTY: prefilling 1M silently stored a
    // wrong window for every small model added without edits, which pushed the
    // kernel's auto-compaction threshold far past the provider's real limit
    // (2026-09-30 space-bunny-free incident). Empty persists nothing, and
    // resolution falls back to the known-model catalog, then a safe 128K.
    setNewModelContextWindow('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleEditModel = (modelId: string, modelName: string, supportsImage?: boolean, contextWindow?: number) => {
    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    // Prefill the stored explicit window (if any) so the user can see and
    // change it; an empty field means "no explicit value persisted".
    setNewModelContextWindow(contextWindow ? formatContextWindowSize(contextWindow) : '');
    setNewModelSupportsImage(!!supportsImage);
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
    if (!providers[activeProvider].models) return;
    
    const updatedModels = providers[activeProvider].models.filter(
      model => model.id !== modelId
    );
    
    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));
  };

  const handleSaveNewModel = () => {
    const modelName = newModelName.trim();
    const modelId = newModelId.trim();
    if (!modelName || !modelId) {
      setModelFormError(i18nService.t('modelNameAndIdRequired'));
      return;
    }

    const parsedContextWindow = parseContextWindowSizeInput(newModelContextWindow);
    if (parsedContextWindow === null) {
      setModelFormError(i18nService.t('contextWindowSizeInvalid'));
      return;
    }

    const currentModels = providers[activeProvider].models ?? [];
    const duplicateModel = currentModels.find(
      model => model.id === modelId && (!isEditingModel || model.id !== editingModelId)
    );
    if (duplicateModel) {
      setModelFormError(i18nService.t('modelIdExists'));
      return;
    }

    const existingModel = isEditingModel && editingModelId
      ? currentModels.find(model => model.id === editingModelId)
      : undefined;
    const nextModel = {
      ...(existingModel ?? {}),
      id: modelId,
      name: modelName,
      supportsImage: newModelSupportsImage,
      // A new model pins a 128K output ceiling so an uncatalogued id matches
      // the main-process default (thinking-heavy models used to burn the old
      // 8192 fallback on reasoning alone — the cw-86812c4f stall); resolution
      // clamps it against the stored window. Edits keep whatever the entry
      // already stored via the spread above.
      ...(!isEditingModel && { maxOutputTokens: NEW_MODEL_DEFAULT_MAX_OUTPUT_TOKENS }),
      // Empty input clears an explicitly stored window (JSON drops the
      // undefined key) so resolution falls back to the known-model catalog.
      contextWindow: parsedContextWindow,
    };
    const updatedModels = isEditingModel && editingModelId
      ? currentModels.map(model => (model.id === editingModelId ? nextModel : model))
      : [...currentModels, nextModel];

    setProviders(prev => ({
      ...prev,
      [activeProvider]: {
        ...prev[activeProvider],
        models: updatedModels
      }
    }));

    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelContextWindow('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelContextWindow('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  // --- 供应商添加（模板选择）/删除 ---
  const handleAddProviderClick = () => {
    setShowProviderTemplatePicker(true);
  };

  const handleCloseProviderTemplatePicker = () => {
    setShowProviderTemplatePicker(false);
  };

  // ZCode personal-provider model: picking a template seeds a fresh custom
  // provider entry with the template's endpoint / preset models / key URL and
  // jumps straight into its edit form. Fields stay editable afterwards.
  const handleCreateProviderFromTemplate = (template: ProviderTemplate) => {
    const baseName = language === 'zh' ? template.nameZh : template.nameEn;
    const { key: providerKey, suffix } = generateTemplateProviderKey(template.templateId, Object.keys(providers));
    const displayName = suffix > 1 ? `${baseName} ${suffix}` : baseName;
    setProviders(prev => ({
      ...prev,
      [providerKey]: {
        enabled: false,
        apiKey: '',
        baseUrl: template.baseUrl,
        apiFormat: template.apiFormat,
        name: displayName,
        logoKey: template.logo,
        ...(template.apiKeyManagementUrl ? { apiKeyManagementUrl: template.apiKeyManagementUrl } : {}),
        models: template.models.map(model => ({ ...model })),
      },
    }));
    setTestResult(null);
    setFetchModelsResult(null);
    setShowProviderTemplatePicker(false);
    setShowCerebellumSettings(false);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setActiveProvider(providerKey as ProviderType);
  };

  // ZCode-style custom provider: no upfront form — create a blank entry named
  // "新供应商" immediately, then edit name / endpoint / key / models inline.
  const handleCreateCustomProviderInstant = () => {
    const baseName = i18nService.t('newProviderDefaultName');
    const providerKey = generateCustomProviderKey(baseName, Object.keys(providers));
    // release-review P2 follow-up: custom relays are overwhelmingly
    // OpenAI-compatible, so blank entries default to Chat Completions.
    setProviders(prev => ({
      ...prev,
      [providerKey]: {
        enabled: false,
        apiKey: '',
        baseUrl: '',
        apiFormat: 'openai',
        name: baseName,
      },
    }));
    setTestResult(null);
    setFetchModelsResult(null);
    setShowProviderTemplatePicker(false);
    setShowCerebellumSettings(false);
    setIsAddingModel(false);
    setIsEditingModel(false);
    setActiveProvider(providerKey as ProviderType);
  };

  const handleDeleteCustomProvider = (providerKey: string) => {
    setProviders(prev => {
      const next = { ...prev };
      delete next[providerKey];
      return next;
    });
    setTestResult(null);
    setPendingDeleteProvider(null);
    if (activeProvider === providerKey) {
      setShowCerebellumSettings(false);
      const remainingKeys = Object.keys(visibleProviders).filter(key => key !== providerKey);
      const firstEnabled = remainingKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider((firstEnabled ?? remainingKeys[0]) as ProviderType);
    }
  };

  // Provider list row shared by the pinned ID.Bots subscription entry and the
  // visibleProviders map (custom + configured built-ins).
  const renderProviderRow = (providerKey: ProviderType, config: ProviderConfig) => {
    const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
    const canToggleProvider = config.enabled || !missingApiKey;
    return (
      <div
        key={providerKey}
        onClick={() => handleProviderChange(providerKey)}
        className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors group ${
          activeProvider === providerKey && !showCerebellumSettings
            ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30 shadow-subtle'
            : 'dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent'
        }`}
      >
        <div className="flex flex-1 items-center min-w-0">
          <div className="mr-2 flex h-7 w-7 items-center justify-center shrink-0">
            <span className="dark:text-claude-darkText text-claude-text">
              <ProviderIcon providerKey={providerKey} config={config} dark={isDarkTheme} />
            </span>
          </div>
          <span className={`text-sm font-medium leading-snug ${
            activeProvider === providerKey && !showCerebellumSettings
              ? 'text-claude-accent'
              : 'dark:text-claude-darkText text-claude-text'
          }`}>
            {getProviderDisplayLabel(providerKey, config)}
          </span>
        </div>
        <div className="flex items-center ml-2">
          {isCustomProviderKey(providerKey) && (
            <button
              type="button"
              title={i18nService.t('deleteProvider')}
              onClick={(e) => {
                e.stopPropagation();
                setPendingDeleteProvider(providerKey);
              }}
              className="p-1 mr-1 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          )}
          <div
            title={!canToggleProvider ? i18nService.t('configureApiKey') : undefined}
            className={`w-7 h-4 rounded-full flex items-center transition-colors ${
              config.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
            } ${
              canToggleProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (!canToggleProvider) {
                return;
              }
              toggleProviderEnabled(providerKey);
            }}
          >
            <div
              className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                config.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </div>
        </div>
      </div>
    );
  };

  // 测试 API 连接
  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    const providerConfig = providers[activeProvider];

    if (providerRequiresApiKey(activeProvider) && !providerConfig.apiKey) {
      setTestResult({ success: false, message: i18nService.t('apiKeyRequired') });
      setIsTesting(false);
      return;
    }

    // 获取第一个可用模型
    const firstModel = providerConfig.models?.[0];
    if (!firstModel) {
      setTestResult({ success: false, message: i18nService.t('noModelsConfigured') });
      setIsTesting(false);
      return;
    }

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      const normalizedBaseUrl = providerConfig.baseUrl.replace(/\/+$/, '');

      // 统一为两种协议格式：
      // - anthropic: /v1/messages
      // - openai provider / 用户选择的 responses 格式: /v1/responses
      // - other openai-compatible providers: /v1/chat/completions
      const useAnthropicFormat = getEffectiveApiFormat(activeProvider, providerConfig.apiFormat) === 'anthropic';

      if (useAnthropicFormat) {
        const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
          ? `${normalizedBaseUrl}/messages`
          : `${normalizedBaseUrl}/v1/messages`;
        response = await window.electron.api.fetch({
          url: anthropicUrl,
          method: 'POST',
          headers: {
            'x-api-key': providerConfig.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            ...buildOpenCodeGoSessionHeaders(activeProvider, normalizedBaseUrl),
          },
          body: JSON.stringify({
            model: firstModel.id,
            max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        // A user-selected 'responses' apiFormat must drive the test through the
        // Responses endpoint too (mirrors llmConnection.testProviderConnection).
        // Zhipu's /api/v1 only serves Responses for coding-plan keys — a
        // chat/completions probe there fails with model_access_denied while
        // real traffic (api.ts honors apiFormat) works.
        const useResponsesApi = providerConfig.apiFormat === 'responses'
          || shouldUseOpenAIResponsesForProvider(activeProvider);
        const openaiUrl = useResponsesApi
          ? buildOpenAIResponsesUrl(normalizedBaseUrl, activeProvider)
          : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, activeProvider);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (providerConfig.apiKey) {
          headers.Authorization = `Bearer ${providerConfig.apiKey}`;
        }
        Object.assign(headers, buildOpenCodeGoSessionHeaders(activeProvider, normalizedBaseUrl));
        const openAIRequestBody: Record<string, unknown> = useResponsesApi
          ? {
              model: firstModel.id,
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
              max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            }
          : {
              model: firstModel.id,
              messages: [{ role: 'user', content: 'Hi' }],
            };
        if (!useResponsesApi && shouldUseMaxCompletionTokensForOpenAI(activeProvider, firstModel.id)) {
          openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
        } else {
          if (!useResponsesApi) {
            openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
          }
        }
        response = await window.electron.api.fetch({
          url: openaiUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody),
        });
      }

      if (response.ok) {
        setTestResult({ success: true, message: i18nService.t('connectionSuccess') });
      } else {
        const data = response.data || {};
        // 提取错误信息
        const errorMessage = data.error?.message || data.message || `${i18nService.t('connectionFailed')}: ${response.status}`;
        if (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('model output limit was reached')) {
          setTestResult({ success: true, message: i18nService.t('connectionSuccess') });
          return;
        }
        setTestResult({
          success: false,
          message: errorMessage,
        });
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleCerebellumConfigChange = <K extends keyof CerebellumConfig>(field: K, value: CerebellumConfig[K]) => {
    setCerebellum(prev => ({ ...prev, [field]: value }));
    setCerebellumTestResult(null);
  };

  /**
   * IDBots-JEV: the identity-bound relay key lives in the main-process
   * credential chain (kv -> metaid-free provider -> identity bootstrap), not
   * in user input. Always resolve from the chain (fresher than the config
   * snapshot) and persist it so the pure config path keeps working; an
   * unresolved key leaves the cerebellum off until credentials exist.
   */
  const ensureCerebellumIdbotsApiKey = async (): Promise<string> => {
    try {
      const response = await window.electron.jevRelay.resolveCredentials();
      const apiKey = response?.success ? (response.credentials?.apiKey ?? '').trim() : '';
      if (apiKey && apiKey !== cerebellum.apiKey.trim()) {
        setCerebellum(prev => (prev.provider === CEREBELLUM_FREE_PROVIDER ? { ...prev, apiKey } : prev));
      }
      return apiKey;
    } catch {
      // IPC failure: fall back to whatever was resolved before (may be '').
      return cerebellum.apiKey.trim();
    }
  };

  // S9 下线清单：原「小脑额度」（JEV/token 口径）显示与拉取已下线；
  // 统一口径展示走「用量 & 积分」页（me_balance / me_history）。

  // IDBots-JEV without a key yet: resolve it once in the background so the
  // connection test can run without a separate provisioning step. Failure is
  // silent; the deps gate re-runs when credentials become available.
  useEffect(() => {
    if (cerebellum.provider === CEREBELLUM_FREE_PROVIDER && !cerebellum.apiKey.trim()) {
      void ensureCerebellumIdbotsApiKey();
    }
  }, [cerebellum.provider, cerebellum.apiKey]);

  const handleCerebellumProviderChange = (provider: CerebellumConfig['provider']) => {
    setCerebellumTestResult(null);
    if (provider === CEREBELLUM_FREE_PROVIDER) {
      // baseUrl/model are pinned by the relay; the key resolves right away
      // (fire-and-forget — failure just leaves the field empty, and the
      // cerebellum stays silently off until a key exists).
      setCerebellum(prev => ({
        ...prev,
        provider,
        apiKey: '',
        baseUrl: CEREBELLUM_FREE_RELAY_BASE_URL,
        model: CEREBELLUM_FREE_MODEL,
      }));
      void ensureCerebellumIdbotsApiKey();
      return;
    }
    setCerebellum(prev => ({
      ...prev,
      provider,
      apiKey: '',
      baseUrl: TYPESAFE_JEV_BASE_URL,
      model: DEFAULT_CEREBELLUM_CONFIG.model,
    }));
  };

  const handleTestCerebellumConnection = async () => {
    if (isTestingCerebellum) {
      return;
    }
    setIsTestingCerebellum(true);
    setCerebellumTestResult(null);
    try {
      // IDBots-JEV: pull the identity-bound relay key from the credential
      // chain first (fresh installs may not have bootstrapped it yet).
      const apiKey = cerebellum.provider === CEREBELLUM_FREE_PROVIDER
        ? await ensureCerebellumIdbotsApiKey()
        : cerebellum.apiKey;
      const result = await testCerebellumConnection(
        { baseUrl: cerebellum.baseUrl, apiKey },
        i18nService,
      );
      setCerebellumTestResult(result);
    } finally {
      setIsTestingCerebellum(false);
    }
  };

  const handleFetchProviderModels = async () => {
    setIsFetchingModels(true);
    setFetchModelsResult(null);

    const providerConfig = providers[activeProvider];

    if (providerRequiresApiKey(activeProvider) && !providerConfig.apiKey) {
      setFetchModelsResult({ success: false, message: i18nService.t('apiKeyRequired') });
      setIsFetchingModels(false);
      return;
    }

    try {
      // Replace the catalog with the provider's official list; per-model
      // local settings survive for ids present in both lists (see
      // mergeSyncedProviderModels).
      const syncedModels = await fetchProviderModelList({
        providerKey: activeProvider,
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        existingModels: providerConfig.models ?? [],
      });
      setProviders(prev => ({
        ...prev,
        [activeProvider]: {
          ...prev[activeProvider],
          models: syncedModels,
        },
      }));
      setFetchModelsResult({
        success: true,
        message: `${i18nService.t('fetchModelsSuccess')} (${syncedModels.length})`,
      });
    } catch (err) {
      setFetchModelsResult({
        success: false,
        message: err instanceof Error ? err.message : i18nService.t('fetchModelsFailed'),
      });
    } finally {
      setIsFetchingModels(false);
    }
  };

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([providerKey, providerConfig]) => {
        const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
        return [
          providerKey,
          {
            enabled: providerConfig.enabled,
            apiKey,
            baseUrl: providerConfig.baseUrl,
            apiFormat: getEffectiveApiFormat(providerKey, providerConfig.apiFormat),
            models: providerConfig.models,
            name: isCustomProviderKey(providerKey) ? (providerConfig as ProviderConfig).name : undefined,
            apiKeyManagementUrl: isCustomProviderKey(providerKey) ? (providerConfig as ProviderConfig).apiKeyManagementUrl : undefined,
            logoKey: isCustomProviderKey(providerKey) ? (providerConfig as ProviderConfig).logoKey : undefined,
          },
        ] as const;
      })
    );

    return {
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      exportedAt: new Date().toISOString(),
      encryption: {
        algorithm: 'AES-GCM',
        keySource: 'password',
        keyDerivation: 'PBKDF2',
      },
      providers: Object.fromEntries(entries),
    };
  };

  const normalizeModels = (models?: Model[]) =>
    models?.map(model => ({
      ...model,
      supportsImage: model.supportsImage ?? false,
    }));

  const DEFAULT_EXPORT_PASSWORD = EXPORT_PASSWORD;

  const handleExportProviders = async () => {
    setError(null);
    setIsExportingProviders(true);

    try {
      const payload = await buildProvidersExport(DEFAULT_EXPORT_PASSWORD);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.error('Failed to export providers:', err);
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExportingProviders(false);
    }
  };

  const handleImportProvidersClick = () => {
    importInputRef.current?.click();
  };

  const handleImportProviders = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    setError(null);

    try {
      const raw = await file.text();
      let payload: ProvidersImportPayload;
      try {
        payload = JSON.parse(raw) as ProvidersImportPayload;
      } catch (parseError) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (!payload || payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if it's version 2 (password-based encryption)
      if (payload.version === 2 && payload.encryption?.keySource === 'password') {
        await processImportPayloadWithPassword(payload);
        return;
      }

      // Version 1 (legacy local-store key) - try to decrypt with local key
      if (payload.version === 1) {
        await processImportPayloadWithLocalKey(payload);
        return;
      }

      setError(i18nService.t('invalidProvidersFile'));
    } catch (err) {
      console.error('Failed to import providers:', err);
      setError(i18nService.t('importProvidersFailed'));
    }
  };

  const processImportPayloadWithLocalKey = async (payload: ProvidersImportPayload) => {
    setIsImportingProviders(true);
    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;
      // Built-in providers plus any custom provider keys present in the file
      const importKeys = Array.from(new Set([
        ...providerKeys,
        ...Object.keys(payload.providers ?? {}).filter(key => !(providerKeys as readonly string[]).includes(key)),
      ]));
      for (const providerKey of importKeys) {
        const providerData = payload.providers?.[providerKey];
        if (!providerData) {
          continue;
        }
        const existing = providers[providerKey] as ProviderConfig | undefined;

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          try {
            apiKey = await decryptSecret(providerData.apiKey as EncryptedPayload);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        } else if (typeof providerData.apiKeyEncrypted === 'string' && typeof providerData.apiKeyIv === 'string') {
          try {
            apiKey = await decryptSecret({ encrypted: providerData.apiKeyEncrypted, iv: providerData.apiKeyIv });
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : existing?.enabled ?? false,
          apiKey: apiKey ?? existing?.apiKey ?? '',
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : existing?.baseUrl ?? '',
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? existing?.apiFormat),
          models: models ?? existing?.models,
          name: typeof providerData.name === 'string' ? providerData.name : existing?.name,
          apiKeyManagementUrl: typeof providerData.apiKeyManagementUrl === 'string' ? providerData.apiKeyManagementUrl : existing?.apiKeyManagementUrl,
          logoKey: typeof providerData.logoKey === 'string' ? providerData.logoKey : existing?.logoKey,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const processImportPayloadWithPassword = async (payload: ProvidersImportPayload) => {
    if (!payload.providers) {
      return;
    }

    setIsImportingProviders(true);

    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      // Built-in providers plus any custom provider keys present in the file
      const importKeys = Array.from(new Set([
        ...providerKeys,
        ...Object.keys(payload.providers ?? {}).filter(key => !(providerKeys as readonly string[]).includes(key)),
      ]));
      for (const providerKey of importKeys) {
        const providerData = payload.providers[providerKey];
        if (!providerData) {
          continue;
        }
        const existing = providers[providerKey] as ProviderConfig | undefined;

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          const apiKeyObj = providerData.apiKey as PasswordEncryptedPayload;
          if (apiKeyObj.salt) {
            // Version 2 password-based encryption
            try {
              apiKey = await decryptWithPassword(apiKeyObj, DEFAULT_EXPORT_PASSWORD);
            } catch (error) {
              hadDecryptFailure = true;
              console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
            }
          }
        }

        const models = normalizeModels(providerData.models);

        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : existing?.enabled ?? false,
          apiKey: apiKey ?? existing?.apiKey ?? '',
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : existing?.baseUrl ?? '',
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? existing?.apiFormat),
          models: models ?? existing?.models,
          name: typeof providerData.name === 'string' ? providerData.name : existing?.name,
          apiKeyManagementUrl: typeof providerData.apiKeyManagementUrl === 'string' ? providerData.apiKeyManagementUrl : existing?.apiKeyManagementUrl,
          logoKey: typeof providerData.logoKey === 'string' ? providerData.logoKey : existing?.logoKey,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      // Check if any key was successfully decrypted
      const anyKeyDecrypted = Object.entries(providerUpdates).some(
        ([key, update]) => update?.apiKey && update.apiKey !== providers[key]?.apiKey
      );

      if (!anyKeyDecrypted && hadDecryptFailure) {
        // All decryptions failed - likely wrong password
        setError(i18nService.t('decryptProvidersFailed'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = {
            ...prev[providerKey],
            ...update,
          };
        });
        return next;
      });
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error
        && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError
        ? i18nService.t('decryptProvidersFailed')
        : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  // 渲染标签页
  const sidebarTabs: { key: TabType; label: string; icon: React.ReactNode }[] = useMemo(() => [
    { key: 'general',        label: i18nService.t('general'),        icon: <Cog6ToothIcon className="h-5 w-5" /> },
    { key: 'model',          label: i18nService.t('model'),          icon: <CubeIcon className="h-5 w-5" /> },
    { key: 'coworkMemory',   label: i18nService.t('coworkMemoryTitle'), icon: <BrainIcon className="h-5 w-5" /> },
    { key: 'traffic',        label: i18nService.t('usageCreditsTab'), icon: <BoltIcon className="h-5 w-5" /> },
    { key: 'skills',         label: i18nService.t('skills'),         icon: <PuzzlePieceIcon className="h-5 w-5" /> },
    { key: 'projects',       label: i18nService.t('projectsTab'),    icon: <BriefcaseIcon className="h-5 w-5" /> },
    { key: 'im',             label: i18nService.t('imBot'),          icon: <ChatBubbleLeftIcon className="h-5 w-5" /> },
    { key: 'archivedChats',  label: i18nService.t('archivedChatsTab'),  icon: <ArchiveBoxIcon className="h-5 w-5" /> },
  ], [language]);

  const activeTabLabel = useMemo(() => {
    return sidebarTabs.find(t => t.key === activeTab)?.label ?? '';
  }, [activeTab, sidebarTabs]);

  const renderTabContent = () => {
    switch(activeTab) {
      case 'general':
        return (
          <div className="space-y-8">
            {/* Chat Experience Mode Section — removed (owner ruling 2026-11-10):
                the mode is decided by the active face
                (hooks/chatExperienceModeSource.ts), so the inert transitional
                switch only confused users. The general tab now opens with the
                language selector. */}

            {/* Language Section — the label is intentionally bilingual so
                speakers of either UI language can tell what it selects. */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('language')}
              </h4>
              <div className="w-[140px] shrink-0">
                <ThemedSelect
                  id="language"
                  value={language}
                  onChange={(value) => {
                    const nextLanguage = value as LanguageType;
                    setLanguage(nextLanguage);
                    i18nService.setLanguage(nextLanguage, { persist: false });
                  }}
                  options={[
                    { value: 'zh', label: i18nService.t('chinese') },
                    { value: 'en', label: i18nService.t('english') }
                  ]}
                />
              </div>
            </div>

            {/* Auto-launch Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('autoLaunch')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('autoLaunchDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoLaunch}
                  onClick={async () => {
                    if (isUpdatingAutoLaunch) return;
                    const next = !autoLaunch;
                    setIsUpdatingAutoLaunch(true);
                    try {
                      const result = await window.electron.autoLaunch.set(next);
                      if (result.success) {
                        setAutoLaunchState(next);
                      } else {
                        setError(result.error || 'Failed to update auto-launch setting');
                      }
                    } catch (err) {
                      console.error('Failed to set auto-launch:', err);
                      setError('Failed to update auto-launch setting');
                    } finally {
                      setIsUpdatingAutoLaunch(false);
                    }
                  }}
                  disabled={isUpdatingAutoLaunch}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingAutoLaunch ? 'opacity-50 cursor-not-allowed' : ''
                  } ${
                    autoLaunch
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoLaunch ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">{i18nService.t('studioLiveStage')}</h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">{i18nService.t('studioLiveStageToggle')}</span>
                <button type="button" role="switch" aria-checked={liveStageEnabled} onClick={() => void handleLiveStageSettings({ enabled: !liveStageEnabled })} disabled={isUpdatingLiveStage} className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${isUpdatingLiveStage ? 'opacity-50 cursor-not-allowed' : ''} ${liveStageEnabled ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${liveStageEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </label>
              {/* The Generative visual Director has no switch of its own any
                  more (owner ruling 2026-11-10): it is always on and follows
                  this toggle — see writeStudioLiveStageSettings. */}
            </div>

            {/* Experimental automation kill-switch (browser automation + desktop computer use) */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('experimentalAutomation')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex items-center gap-2">
                  <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                    {i18nService.t('experimentalAutomationDescription')}
                  </span>
                  <Tooltip content={i18nService.t('experimentalAutomationTooltip')}>
                    <QuestionMarkCircleIcon className="w-4 h-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0" />
                  </Tooltip>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={experimentalAutomation}
                  onClick={async () => {
                    if (isUpdatingExperimentalAutomation) return;
                    const next = !experimentalAutomation;
                    setIsUpdatingExperimentalAutomation(true);
                    try {
                      const result = await window.electron.experimentalAutomation.set(next);
                      if (result.success) {
                        setExperimentalAutomationState(next);
                      } else {
                        setError(result.error || 'Failed to update the experimental automation setting');
                      }
                    } catch (err) {
                      console.error('Failed to set experimental automation:', err);
                      setError('Failed to update the experimental automation setting');
                    } finally {
                      setIsUpdatingExperimentalAutomation(false);
                    }
                  }}
                  disabled={isUpdatingExperimentalAutomation}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingExperimentalAutomation ? 'opacity-50 cursor-not-allowed' : ''
                  } ${
                    experimentalAutomation
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      experimentalAutomation ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Prevent Device Sleep Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('preventDeviceSleep')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('preventDeviceSleepDescription')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={preventDeviceSleep}
                  onClick={async () => {
                    if (isUpdatingPreventDeviceSleep) return;
                    const next = !preventDeviceSleep;
                    setIsUpdatingPreventDeviceSleep(true);
                    try {
                      const result = await window.electron.powerGuard.setPreventDeviceSleep(next);
                      if (result.success) {
                        setPreventDeviceSleepState(next);
                      } else {
                        setError(result.error || 'Failed to update prevent-device-sleep setting');
                      }
                    } catch (err) {
                      console.error('Failed to set prevent-device-sleep:', err);
                      setError('Failed to update prevent-device-sleep setting');
                    } finally {
                      setIsUpdatingPreventDeviceSleep(false);
                    }
                  }}
                  disabled={isUpdatingPreventDeviceSleep}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    isUpdatingPreventDeviceSleep ? 'opacity-50 cursor-not-allowed' : ''
                  } ${
                    preventDeviceSleep
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      preventDeviceSleep ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            {/* Appearance Section */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('appearance')}
              </h4>
              <div className="grid grid-cols-3 gap-4">
                {([
                  { value: 'light' as const, label: i18nService.t('light') },
                  { value: 'dark' as const, label: i18nService.t('dark') },
                  { value: 'system' as const, label: i18nService.t('system') },
                ]).map((option) => {
                  const isSelected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setTheme(option.value);
                        themeService.setTheme(option.value);
                      }}
                      className={`flex flex-col items-center rounded-xl border-2 p-3 transition-colors cursor-pointer ${
                        isSelected
                          ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                          : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 dark:hover:border-claude-accent/50'
                      }`}
                    >
                      <svg viewBox="0 0 120 80" className="w-full h-auto rounded-md mb-2 overflow-hidden" xmlns="http://www.w3.org/2000/svg">
                        {option.value === 'light' && (
                          <>
                            <rect width="120" height="80" fill="#F8F9FB" />
                            <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                          </>
                        )}
                        {option.value === 'dark' && (
                          <>
                            <rect width="120" height="80" fill="#0F1117" />
                            <rect x="0" y="0" width="30" height="80" fill="#151820" />
                            <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                            <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                            <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                            <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                          </>
                        )}
                        {option.value === 'system' && (
                          <>
                            <defs>
                              <clipPath id="left-half">
                                <rect x="0" y="0" width="60" height="80" />
                              </clipPath>
                              <clipPath id="right-half">
                                <rect x="60" y="0" width="60" height="80" />
                              </clipPath>
                            </defs>
                            {/* Light half */}
                            <g clipPath="url(#left-half)">
                              <rect width="120" height="80" fill="#F8F9FB" />
                              <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                            </g>
                            {/* Dark half */}
                            <g clipPath="url(#right-half)">
                              <rect width="120" height="80" fill="#0F1117" />
                              <rect x="0" y="0" width="30" height="80" fill="#151820" />
                              <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                              <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                              <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                              <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                              <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                            </g>
                            {/* Divider line */}
                            <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                          </>
                        )}
                      </svg>
                      <span className={`text-xs font-medium ${
                        isSelected
                          ? 'text-claude-accent'
                          : 'dark:text-claude-darkText text-claude-text'
                      }`}>
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* feat/legacy-data-recovery ②: data-directory visibility */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
                {i18nService.t('settingsDataDirectory')}
              </h4>
              <p className="text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText mb-3">
                {i18nService.t('settingsDataDirectoryDesc')}
              </p>
              <div className="flex items-center gap-3">
                <code
                  className="flex-1 min-w-0 break-all select-text text-xs px-3 py-2 rounded-lg dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border"
                  title={dataDirectoryPath}
                >
                  {dataDirectoryPath || '—'}
                </code>
                <button
                  type="button"
                  onClick={handleOpenDataDirectory}
                  disabled={!dataDirectoryPath}
                  className="shrink-0 px-4 py-2 text-sm font-medium rounded-xl transition-colors border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
                >
                  {i18nService.t('settingsDataDirectoryOpen')}
                </button>
              </div>
            </div>
          </div>
        );

      case 'email':
        return <EmailSkillConfig />;

      case 'skills':
        return <SkillMcpManager />;

      case 'projects':
        return <ProjectsManager autoOpenCreateForm={openNewProjectForm === true} />;

      case 'coworkSandbox':
        return (
          <div className="space-y-6">
            <div className="space-y-3">
              <label className="block text-sm font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkExecutionMode')}
              </label>
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('coworkSandboxTemporarilyUnavailable')}
              </div>
              <div className="space-y-2">
                {([
                  {
                    value: 'local',
                    label: i18nService.t('coworkExecutionModeLocal'),
                    hint: i18nService.t('coworkExecutionModeLocalHint'),
                  },
                ] as Array<{ value: CoworkExecutionMode; label: string; hint: string }>).map((option) => {
                  const isDisabled = false;
                  return (
                    <label
                      key={option.value}
                      className={`flex items-start gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                        isDisabled
                          ? 'cursor-not-allowed opacity-60 dark:border-claude-darkBorder border-claude-border'
                          : 'cursor-pointer dark:border-claude-darkBorder border-claude-border hover:border-claude-accent'
                      }`}
                    >
                      <input
                        type="radio"
                        name="cowork-execution-mode"
                        value={option.value}
                        checked={coworkExecutionMode === option.value}
                        onChange={() => setCoworkExecutionMode(option.value)}
                        disabled={isDisabled}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium dark:text-claude-darkText text-claude-text">
                          {option.label}
                        </span>
                        <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {option.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {coworkSandboxStatusHint && (
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {coworkSandboxStatusHint}
                </div>
              )}

              {coworkSandboxProgress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <span>
                      {coworkSandboxStageLabel}
                    </span>
                    {coworkSandboxPercent !== null && (
                      <span>{coworkSandboxPercent}%</span>
                    )}
                  </div>
                  <div className="h-2 rounded-full dark:bg-claude-darkBorder bg-claude-border overflow-hidden">
                    <div
                      className="h-full bg-claude-accent transition-all"
                      style={{ width: `${coworkSandboxPercent ?? 0}%` }}
                    />
                  </div>
                </div>
              )}

              {coworkSandboxDisabled && coworkSandboxStatus?.supported && (
                <button
                  type="button"
                  onClick={handleInstallCoworkSandbox}
                  disabled={coworkSandboxInstalling || coworkSandboxLoading}
                  className="btn-idchat-primary-filled inline-flex items-center justify-center px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {coworkSandboxInstalling ? i18nService.t('coworkSandboxInstalling') : i18nService.t('coworkSandboxInstall')}
                </button>
              )}

              {coworkSandboxDisabled && !coworkSandboxStatus?.supported && (
                <div className="text-xs text-blue-500 dark:text-blue-400">
                  {i18nService.t('coworkSandboxSelectionBlocked')}
                </div>
              )}
            </div>
          </div>
        );

      case 'coworkMemory':
        return <MemorySettings onClose={onClose} />;

      case 'archivedChats': {
        const totalArchivedChatPages = Math.max(1, Math.ceil(archivedChatsTotal / ARCHIVED_CHATS_PAGE_SIZE));
        const totalArchivedGroupTaskPages = Math.max(1, Math.ceil(archivedGroupTasksTotal / ARCHIVED_CHATS_PAGE_SIZE));
        const totalArchivedA2AChatPages = Math.max(1, Math.ceil(archivedA2AChatsTotal / ARCHIVED_CHATS_PAGE_SIZE));
        const archivedTabButtonClass = (active: boolean) =>
          `rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            active
              ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10 text-claude-accent dark:text-claude-darkAccent'
              : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
          }`;
        return (
          <div className="space-y-6">
            <div className="space-y-3 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
              <div>
                <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('archivedChatsTab')}
                </div>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('archivedChatsHint')}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setArchivedSubTab('chats')}
                  className={archivedTabButtonClass(archivedSubTab === 'chats')}
                >
                  {i18nService.t('archivedLocalChatsTab')}
                </button>
                <button
                  type="button"
                  onClick={() => setArchivedSubTab('groupTasks')}
                  className={archivedTabButtonClass(archivedSubTab === 'groupTasks')}
                >
                  {i18nService.t('archivedGroupTasksTab')}
                </button>
                <button
                  type="button"
                  onClick={() => setArchivedSubTab('a2a')}
                  className={archivedTabButtonClass(archivedSubTab === 'a2a')}
                >
                  {i18nService.t('archivedA2AChatsTab')}
                </button>
              </div>

              {archivedSubTab === 'chats' ? (
                <>
                <div className="flex items-center justify-between gap-3">
                <select
                  value={archivedChatsMetabotId ?? ''}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setArchivedChatsMetabotId(Number.isFinite(next) && next > 0 ? next : null);
                  }}
                  className="min-w-[160px] rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                >
                  <option value="">{i18nService.t('archivedChatsAllBots')}</option>
                  {coworkMemoryMetabots.map((metabot) => (
                    <option key={metabot.id} value={metabot.id}>
                      {metabot.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={archivedChatsQuery}
                  onChange={(event) => setArchivedChatsQuery(event.target.value)}
                  placeholder={i18nService.t('archivedChatsSearchPlaceholder')}
                  className="flex-1 min-w-0 rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                />
                <label className="flex shrink-0 items-center gap-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={archivedChatsSearchContent}
                    onChange={(event) => setArchivedChatsSearchContent(event.target.checked)}
                    className="h-3.5 w-3.5 accent-claude-accent"
                  />
                  {i18nService.t('archivedChatsSearchContent')}
                </label>
              </div>

              {archivedChatsNotice && (
                <div className="text-xs text-green-600 dark:text-green-400">{archivedChatsNotice}</div>
              )}

              <div className="max-h-[500px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
                {archivedChatsLoading ? (
                  <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('loading')}
                  </div>
                ) : archivedChats.length === 0 ? (
                  <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('archivedChatsEmpty')}
                  </div>
                ) : (
                  <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                    {archivedChats.map((session) => (
                      <div key={session.id} className="px-3 py-3 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 space-y-1 min-w-0">
                            <button
                              type="button"
                              onClick={() => handleOpenCoworkSession(session.id)}
                              className="font-medium text-claude-accent dark:text-claude-darkAccent hover:underline break-words text-left"
                              title={i18nService.t('dreamDiaryOpenSessionHint')}
                            >
                              {session.title?.trim() || session.peerName || i18nService.t('coworkNewSession')}
                            </button>
                            <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
                                {session.sessionType === 'a2a' ? i18nService.t('archivedChatsTypeA2A') : i18nService.t('archivedChatsTypeHuman')}
                              </span>
                              {session.peerName && <span>{session.peerName}</span>}
                              <span>{`${i18nService.t('archivedChatsArchivedAt')}: ${formatMemoryUpdatedAt(session.archivedAt ?? 0)}`}</span>
                              <span>{`${i18nService.t('coworkMemoryUpdatedAt')}: ${formatMemoryUpdatedAt(session.updatedAt)}`}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => { void handleUnarchiveChat(session.id); }}
                            className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors flex-shrink-0"
                          >
                            {i18nService.t('archivedChatsRestore')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!archivedChatsLoading && archivedChatsTotal > 0 && (
                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService
                      .t('archivedChatsPageInfo')
                      .replace('{page}', String(archivedChatsPage + 1))
                      .replace('{totalPages}', String(totalArchivedChatPages))
                      .replace('{total}', String(archivedChatsTotal))}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={archivedChatsPage === 0}
                      onClick={() => setArchivedChatsPage((page) => Math.max(0, page - 1))}
                      className="rounded-lg border px-3 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {i18nService.t('archivedChatsPrevPage')}
                    </button>
                    <button
                      type="button"
                      disabled={archivedChatsPage + 1 >= totalArchivedChatPages}
                      onClick={() => setArchivedChatsPage((page) => page + 1)}
                      className="rounded-lg border px-3 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {i18nService.t('archivedChatsNextPage')}
                    </button>
                  </div>
                </div>
              )}
                </>
              ) : archivedSubTab === 'groupTasks' ? (
                <>
                  {archivedGroupTasksNotice && (
                    <div className="text-xs text-green-600 dark:text-green-400">{archivedGroupTasksNotice}</div>
                  )}

                  <div className="max-h-[500px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
                    {archivedGroupTasksLoading ? (
                      <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('loading')}
                      </div>
                    ) : archivedGroupTasks.length === 0 ? (
                      <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('archivedGroupTasksEmpty')}
                      </div>
                    ) : (
                      <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                        {archivedGroupTasks.map((task) => (
                          <div key={task.id} className="px-3 py-3 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 space-y-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium dark:text-claude-darkText text-claude-text break-words">
                                    #{task.id} {task.displayName?.trim() || task.title}
                                  </span>
                                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}>
                                    {i18nService.t(groupTaskStatusLabelKey(task.status))}
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                  <span>{`${i18nService.t('archivedChatsArchivedAt')}: ${formatMemoryUpdatedAt(task.archivedAt ?? 0)}`}</span>
                                  {task.chairName && (
                                    <span>{`${task.chairName} (${i18nService.t('groupTasksChairBadge')})`}</span>
                                  )}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => { void handleUnarchiveGroupTask(task.id); }}
                                className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors flex-shrink-0"
                              >
                                {i18nService.t('archivedChatsRestore')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {!archivedGroupTasksLoading && archivedGroupTasksTotal > 0 && (
                    <div className="flex items-center justify-between gap-3 pt-1">
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService
                          .t('archivedChatsPageInfo')
                          .replace('{page}', String(archivedGroupTasksPage + 1))
                          .replace('{totalPages}', String(totalArchivedGroupTaskPages))
                          .replace('{total}', String(archivedGroupTasksTotal))}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={archivedGroupTasksPage === 0}
                          onClick={() => setArchivedGroupTasksPage((page) => Math.max(0, page - 1))}
                          className="rounded-lg border px-3 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {i18nService.t('archivedChatsPrevPage')}
                        </button>
                        <button
                          type="button"
                          disabled={archivedGroupTasksPage + 1 >= totalArchivedGroupTaskPages}
                          onClick={() => setArchivedGroupTasksPage((page) => page + 1)}
                          className="rounded-lg border px-3 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {i18nService.t('archivedChatsNextPage')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {archivedA2AChatsNotice && (
                    <div className="text-xs text-green-600 dark:text-green-400">{archivedA2AChatsNotice}</div>
                  )}

                  <div className="max-h-[500px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
                    {archivedA2AChatsLoading ? (
                      <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('loading')}
                      </div>
                    ) : archivedA2AChats.length === 0 ? (
                      <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('archivedChatsEmpty')}
                      </div>
                    ) : (
                      <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                        {archivedA2AChats.map((session) => (
                          <div key={session.id} className="px-3 py-3 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex-1 space-y-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium dark:text-claude-darkText text-claude-text break-words">
                                    {session.title?.trim() || session.peerName || i18nService.t('coworkNewSession')}
                                  </span>
                                  <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
                                    {i18nService.t('archivedChatsTypeA2A')}
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                  {session.peerName && <span>{session.peerName}</span>}
                                  <span>{`${i18nService.t('archivedChatsArchivedAt')}: ${formatMemoryUpdatedAt(session.archivedAt ?? 0)}`}</span>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => { void handleUnarchiveA2AChat(session.id); }}
                                className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors flex-shrink-0"
                              >
                                {i18nService.t('archivedChatsRestore')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {!archivedA2AChatsLoading && archivedA2AChatsTotal > 0 && (
                    <div className="flex items-center justify-between gap-3 pt-1">
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService
                          .t('archivedChatsPageInfo')
                          .replace('{page}', String(archivedA2AChatsPage + 1))
                          .replace('{totalPages}', String(totalArchivedA2AChatPages))
                          .replace('{total}', String(archivedA2AChatsTotal))}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={archivedA2AChatsPage === 0}
                          onClick={() => setArchivedA2AChatsPage((page) => Math.max(0, page - 1))}
                          className="rounded-lg border px-3 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {i18nService.t('archivedChatsPrevPage')}
                        </button>
                        <button
                          type="button"
                          disabled={archivedA2AChatsPage + 1 >= totalArchivedA2AChatPages}
                          onClick={() => setArchivedA2AChatsPage((page) => page + 1)}
                          className="rounded-lg border px-3 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {i18nService.t('archivedChatsNextPage')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      }

      case 'model': {
        return (
          <div className="flex flex-col h-full">
            <div className="flex flex-1 min-h-0">
            {/* Provider List - Left Side (fixed width so the detail pane takes all remaining space) */}
            <div className="w-[272px] shrink-0 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-1.5 overflow-y-auto">
              <div className="mb-1.5 px-1">
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('modelProviders')}
                  </h3>
                  <div className="flex items-center space-x-1">
                    <button
                      type="button"
                      onClick={handleImportProvidersClick}
                      disabled={isImportingProviders || isExportingProviders}
                      className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                    >
                      {i18nService.t('import')}
                    </button>
                    <button
                      type="button"
                      onClick={handleExportProviders}
                      disabled={isImportingProviders || isExportingProviders}
                      className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                    >
                      {i18nService.t('export')}
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleAddProviderClick}
                  className="btn-idchat-primary-filled inline-flex items-center justify-center w-full px-2 py-1 text-[10px] font-medium"
                >
                  <PlusCircleIcon className="h-2.5 w-2.5 mr-1" />
                  {i18nService.t('addProvider')}
                </button>
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleImportProviders}
              />
              {/* ID.Bots subscription entries stay together above third-party
                  providers. Both cerebellum switches edit the same state and
                  are persisted by the shared Save button. */}
              {providers[LLM_FREE_PROVIDER_KEY] && renderProviderRow(LLM_FREE_PROVIDER_KEY, providers[LLM_FREE_PROVIDER_KEY])}
              <div
                className={`flex w-full items-center rounded-xl border p-2 transition-colors ${
                  showCerebellumSettings
                    ? 'border-claude-accent/30 bg-claude-accent/10 dark:bg-claude-accent/20 shadow-subtle'
                    : 'border-transparent dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setShowProviderTemplatePicker(false);
                    setShowCerebellumSettings(true);
                  }}
                  className="-my-2 flex min-h-10 min-w-0 flex-1 items-center text-left transition-transform active:scale-[0.96]"
                >
                  <span className="mr-2 flex h-7 w-7 shrink-0 items-center justify-center dark:text-claude-darkText text-claude-text">
                    <BrainIcon className="h-5 w-5" />
                  </span>
                  <span className={`flex-1 text-sm font-medium ${showCerebellumSettings ? 'text-claude-accent' : 'dark:text-claude-darkText text-claude-text'}`}>
                    {i18nService.t('modelCerebellumTab')}
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={cerebellum.enabled}
                  aria-label={i18nService.t('cerebellumEnabled')}
                  onClick={() => handleCerebellumConfigChange('enabled', !cerebellum.enabled)}
                  className="-my-2 ml-1 flex h-10 w-10 shrink-0 items-center justify-center transition-transform active:scale-[0.96]"
                >
                  <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                    cerebellum.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                  }`}
                  >
                    <span className={`h-3 w-3 rounded-full bg-white shadow-md transform transition-transform ${
                      cerebellum.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                    />
                  </span>
                </button>
              </div>
              {thirdPartyProviderEntries.length > 0 && (
                <div className="px-1 pt-2 pb-0.5 text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('thirdPartyProviders')}
                </div>
              )}
              {thirdPartyProviderEntries.map(([provider, config]) => renderProviderRow(provider as ProviderType, config))}
            </div>

            {/* Provider Settings - Right Side (or the template picker) */}
            <div className="flex-1 min-w-0 pl-4 overflow-y-auto">
              {showProviderTemplatePicker ? (
                <ProviderTemplatePicker
                  language={language}
                  dark={isDarkTheme}
                  onCreateFromTemplate={handleCreateProviderFromTemplate}
                  onCreateCustom={handleCreateCustomProviderInstant}
                  onBack={handleCloseProviderTemplatePicker}
                />
              ) : !showCerebellumSettings ? (
              <div className="space-y-4">
              <div className="flex items-center justify-between pb-2 border-b dark:border-claude-darkBorder border-claude-border">
                <h3 className="text-base font-medium dark:text-claude-darkText text-claude-text flex items-center gap-2 min-w-0">
                  <span className="flex h-6 w-6 items-center justify-center shrink-0 dark:text-claude-darkText text-claude-text">
                    <ProviderIcon providerKey={activeProvider} config={providers[activeProvider]} dark={isDarkTheme} />
                  </span>
                  <span className="truncate">
                    {getProviderDisplayLabel(activeProvider, providers[activeProvider])} {i18nService.t('providerSettings')}
                  </span>
                </h3>
                <div className="flex items-center space-x-1.5 shrink-0">
                  <div
                    className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
                      providers[activeProvider].enabled
                        ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                        : 'bg-red-500/20 text-red-600 dark:text-red-400'
                    }`}
                  >
                    {providers[activeProvider].enabled ? i18nService.t('providerStatusOn') : i18nService.t('providerStatusOff')}
                  </div>
                  {isCustomProviderKey(activeProvider) && (
                    <button
                      type="button"
                      title={i18nService.t('deleteProvider')}
                      onClick={() => setPendingDeleteProvider(activeProvider)}
                      className="p-1.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Custom/template providers edit their display name inline (ZCode model). */}
              {isCustomProviderKey(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-name`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('providerName')}
                  </label>
                  <input
                    type="text"
                    id={`${activeProvider}-name`}
                    value={(providers[activeProvider] as ProviderConfig).name ?? ''}
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'name', e.target.value)}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('providerNamePlaceholder')}
                  />
                </div>
              )}

              {activeProvider === LLM_FREE_PROVIDER_KEY && (
                <div className="space-y-3">
                  <IdbotsPlanCard />
                  <FreeQuotaCard providers={providers} onProvisioned={handleFreeQuotaProvisioned} />
                  {/* 积分增量包 (persistent credit bucket), above the shared
                      provider fields / 测试连接 button. */}
                  <MeIncrementPackCard />
                </div>
              )}

              {providerRequiresApiKey(activeProvider) && !isBuiltInFreeProvider(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiKey`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiKey')}
                  </label>
                  <SecretInput
                    id={`${activeProvider}-apiKey`}
                    value={providers[activeProvider].apiKey}
                    onChange={(value) => handleProviderConfigChange(activeProvider, 'apiKey', value)}
                    placeholder={i18nService.t('apiKeyPlaceholder')}
                  />
                  {activeProvider === 'deepseek' && (
                    <p className="mt-1 text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('deepseekApiKeyHint')}{' '}
                      <a
                        href={DEEPSEEK_PLATFORM_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault();
                          void window.electron.shell.openExternal(DEEPSEEK_PLATFORM_URL).catch(() => {
                            window.open(DEEPSEEK_PLATFORM_URL, '_blank', 'noopener');
                          });
                        }}
                        className="text-claude-accent hover:underline"
                      >
                        {DEEPSEEK_PLATFORM_URL}
                      </a>
                    </p>
                  )}
                  {activeProvider === 'commandcode' && (
                    <p className="mt-1 text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('commandcodeApiKeyHint')}{' '}
                      <a
                        href={COMMAND_CODE_KEYS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault();
                          void window.electron.shell.openExternal(COMMAND_CODE_KEYS_URL).catch(() => {
                            window.open(COMMAND_CODE_KEYS_URL, '_blank', 'noopener');
                          });
                        }}
                        className="text-claude-accent hover:underline"
                      >
                        {COMMAND_CODE_KEYS_URL}
                      </a>
                    </p>
                  )}
                  {activeApiKeyManagementUrl && (
                    <p className="mt-1 text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('providerApiKeyUrlHint')}{' '}
                      <a
                        href={activeApiKeyManagementUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault();
                          const url = activeApiKeyManagementUrl;
                          if (!url) return;
                          void window.electron.shell.openExternal(url).catch(() => {
                            window.open(url, '_blank', 'noopener');
                          });
                        }}
                        className="text-claude-accent hover:underline"
                      >
                        {activeApiKeyManagementUrl}
                      </a>
                    </p>
                  )}
                </div>
              )}

              {!isManagedProvider(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-baseUrl`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('baseUrl')}
                  </label>
                  <input
                    type="text"
                    id={`${activeProvider}-baseUrl`}
                    value={providers[activeProvider].baseUrl}
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'baseUrl', e.target.value)}
                    onContextMenu={providerBaseUrlContextMenu.onContextMenu}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('baseUrlPlaceholder')}
                  />
                  {providerBaseUrlContextMenu.menu}
                </div>
              )}

              {/* API 格式选择器 */}
              {shouldShowApiFormatSelector(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiFormat`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiFormat')}
                  </label>
                  <div className="flex flex-col items-start space-y-1.5">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="anthropic"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'anthropic'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'anthropic')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatNative')}
                      </span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="openai"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'openai'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'openai')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatOpenAI')}
                      </span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name={`${activeProvider}-apiFormat`}
                        value="responses"
                        checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'responses'}
                        onChange={() => handleProviderConfigChange(activeProvider, 'apiFormat', 'responses')}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                      />
                      <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                        {i18nService.t('apiFormatResponses')}
                      </span>
                    </label>
                  </div>
                  <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('apiFormatHint')}
                  </p>
                </div>
              )}

              {/* 测试连接按钮 */}
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={isTesting || (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
                </button>
                {testResult && (
                  <div className={`flex items-center text-xs ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {testResult.success ? (
                      <CheckCircleIcon className="h-4 w-4 mr-1" />
                    ) : (
                      <XCircleIcon className="h-4 w-4 mr-1" />
                    )}
                    <span className="truncate max-w-[200px]">{testResult.message}</span>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('availableModels')}
                  </h3>
                  {!isBuiltInFreeProvider(activeProvider) && (
                    <div className="flex items-center space-x-3">
                      {providerSupportsModelListSync(activeProvider) && (
                        <button
                          type="button"
                          onClick={handleFetchProviderModels}
                          disabled={isFetchingModels || (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)}
                          title={i18nService.t('fetchModelsHint')}
                          className="inline-flex items-center text-xs text-claude-accent hover:text-claude-accentHover disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ArrowPathIcon className={`h-3.5 w-3.5 mr-1 ${isFetchingModels ? 'animate-spin' : ''}`} />
                          {isFetchingModels ? i18nService.t('fetchingModels') : i18nService.t('fetchModels')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="inline-flex items-center text-xs text-claude-accent hover:text-claude-accentHover"
                      >
                        <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                        {i18nService.t('addModel')}
                      </button>
                    </div>
                  )}
                </div>
                {fetchModelsResult && (
                  <div className={`flex items-center text-xs mb-1.5 ${fetchModelsResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {fetchModelsResult.success ? (
                      <CheckCircleIcon className="h-4 w-4 mr-1 shrink-0" />
                    ) : (
                      <XCircleIcon className="h-4 w-4 mr-1 shrink-0" />
                    )}
                    <span className="truncate max-w-[280px]">{fetchModelsResult.message}</span>
                  </div>
                )}

                {/* Models List */}
                <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                  {providers[activeProvider].models?.map(model => (
                    <div
                      key={model.id}
                      className="dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-2 rounded-xl dark:border-claude-darkBorder border-claude-border border transition-colors hover:border-claude-accent group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-1.5">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                          <span className="dark:text-claude-darkText text-claude-text font-medium text-[11px]">{model.name}</span>
                        </div>
                        <div className="flex items-center space-x-1">
                          {(() => {
                            // S9 §4 区块3：价签改倍率展示；仅当服务器 rates 含该模型时显示
                            const rate = findMeRateForModel(meSnapshot.rates ?? [], model.id);
                            return rate ? (
                              <span
                                title={i18nService.t('meRatesFooterNote')}
                                className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent dark:text-claude-darkAccent font-medium"
                              >
                                {rate.multiplier}x
                              </span>
                            ) : null;
                          })()}
                          <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {isBuiltInFreeProvider(activeProvider) ? getFreeProviderModelDisplayName(model.id) : model.id}
                          </span>
                          {model.contextWindow && formatContextWindowSize(model.contextWindow) && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              {formatContextWindowSize(model.contextWindow)}
                            </span>
                          )}
                          {model.supportsImage && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                              {i18nService.t('imageInput')}
                            </span>
                          )}
                          {!isBuiltInFreeProvider(activeProvider) && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleEditModel(model.id, model.name, model.supportsImage, model.contextWindow)}
                                className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <PencilIcon className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteModel(model.id)}
                                className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <TrashIcon className="h-3 w-3" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {(!providers[activeProvider].models || providers[activeProvider].models.length === 0) && (
                    <div className="dark:bg-claude-darkSurface/20 bg-claude-surface/20 p-2.5 rounded-xl border dark:border-claude-darkBorder/50 border-claude-border/50 text-center">
                      <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('noModelsAvailable')}</p>
                      {!isBuiltInFreeProvider(activeProvider) && (
                        <button
                          type="button"
                          onClick={handleAddModel}
                          className="mt-1.5 inline-flex items-center text-[11px] font-medium text-claude-accent hover:text-claude-accentHover"
                        >
                          <PlusCircleIcon className="h-3 w-3 mr-1" />
                          {i18nService.t('addFirstModel')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {/* S9 §4 区块3：价签换算说明（页脚固定一行；倍率来自 /v1/me/rates 实时返回）。
                    ME 积分扣费只属于官方订阅通道，第三方供应商不显示该说明。 */}
                {activeProvider === LLM_FREE_PROVIDER_KEY && (
                  <p className="mt-2 text-[10px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('meRatesFooterNote')}
                  </p>
                )}
              </div>
              </div>
            ) : (
            <div className="space-y-4 pr-1">
              {/* Cerebellum panel: optional fast decision model config */}
              <p className="text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('cerebellumExplainer')}
              </p>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('cerebellumEnabled')}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={cerebellum.enabled}
                  aria-label={i18nService.t('cerebellumEnabled')}
                  onClick={() => handleCerebellumConfigChange('enabled', !cerebellum.enabled)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    cerebellum.enabled
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      cerebellum.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                  {i18nService.t('cerebellumPrivacyNotice')}
                </p>
              </div>

              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('cerebellumProvider')}
                </h4>
                <div className="w-[180px] shrink-0">
                  <ThemedSelect
                    id="cerebellum-provider"
                    value={cerebellum.provider}
                    onChange={(value) => handleCerebellumProviderChange(value as CerebellumConfig['provider'])}
                    options={CEREBELLUM_PROVIDER_OPTIONS}
                  />
                </div>
              </div>

              {cerebellum.provider === CEREBELLUM_FREE_PROVIDER && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                    {i18nService.t('cerebellumIdbotsProviderHint')}
                  </p>
                </div>
              )}

              {/* Direct TypeSafe only: the IDBots relay pins its credential,
                  baseUrl, and model, so only the test button is offered there. */}
              {cerebellum.provider !== CEREBELLUM_FREE_PROVIDER && (
                <>
                  <div>
                    <label htmlFor="cerebellum-apiKey" className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                      {i18nService.t('apiKey')}
                    </label>
                    <SecretInput
                      id="cerebellum-apiKey"
                      value={cerebellum.apiKey}
                      onChange={(value) => handleCerebellumConfigChange('apiKey', value)}
                      placeholder={i18nService.t('apiKeyPlaceholder')}
                    />
                  </div>

                  <div>
                    <label htmlFor="cerebellum-baseUrl" className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                      {i18nService.t('baseUrl')}
                    </label>
                    <input
                      type="text"
                      id="cerebellum-baseUrl"
                      value={cerebellum.baseUrl}
                      onChange={(e) => handleCerebellumConfigChange('baseUrl', e.target.value)}
                      onContextMenu={cerebellumBaseUrlContextMenu.onContextMenu}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder="https://api.typesafe.ai"
                    />
                    {cerebellumBaseUrlContextMenu.menu}
                  </div>

                  <div>
                    <label htmlFor="cerebellum-model" className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                      {i18nService.t('cerebellumModel')}
                    </label>
                    <input
                      type="text"
                      id="cerebellum-model"
                      value={cerebellum.model}
                      onChange={(e) => handleCerebellumConfigChange('model', e.target.value)}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder="jev-latest"
                    />
                  </div>
                </>
              )}

              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={handleTestCerebellumConnection}
                  disabled={isTestingCerebellum || (cerebellum.provider !== CEREBELLUM_FREE_PROVIDER && !cerebellum.apiKey.trim())}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {isTestingCerebellum ? i18nService.t('testing') : i18nService.t('testConnection')}
                </button>
                {cerebellumTestResult && (
                  <div className={`flex items-center text-xs ${cerebellumTestResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {cerebellumTestResult.success ? (
                      <CheckCircleIcon className="h-4 w-4 mr-1" />
                    ) : (
                      <XCircleIcon className="h-4 w-4 mr-1" />
                    )}
                    <span className="truncate max-w-[200px]">{cerebellumTestResult.message}</span>
                  </div>
                )}
              </div>
            </div>
            )}
            </div>
            </div>
          </div>
        );
      }

      case 'shortcuts':
        return (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('keyboardShortcuts')}
              </label>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('newChat')}</span>
                  <input
                    type="text"
                    value={shortcuts.newChat}
                    onChange={(e) => handleShortcutChange('newChat', e.target.value)}
                    data-shortcut-input="true"
                    className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('search')}</span>
                  <input
                    type="text"
                    value={shortcuts.search}
                    onChange={(e) => handleShortcutChange('search', e.target.value)}
                    data-shortcut-input="true"
                    className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('openSettings')}</span>
                  <input
                    type="text"
                    value={shortcuts.settings}
                    onChange={(e) => handleShortcutChange('settings', e.target.value)}
                    data-shortcut-input="true"
                    className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
            </div>
          </div>
        );

      case 'paramsConfig': {
        const chains = [
          { key: 'btc', label: i18nService.t('feeRateNetwork_btc'), unit: i18nService.t('feeRateUnit_btc'), color: '#F7931A' },
          { key: 'mvc', label: i18nService.t('feeRateNetwork_mvc'), unit: i18nService.t('feeRateUnit_mvc'), color: '#5C6BC0' },
          { key: 'doge', label: i18nService.t('feeRateNetwork_doge'), unit: i18nService.t('feeRateUnit_doge'), color: '#C3A634' },
        ] as const;

        return (
          <div className="space-y-6">
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
                {i18nService.t('feeRateConfig')}
              </h4>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
                {i18nService.t('feeRateConfigDesc')}
              </p>

              <div className="space-y-3">
                {chains.map(({ key: chain, label, unit, color }) => {
                  const tiers = feeRateTiers[chain] ?? [];
                  const activeTier = selectedFeeTier[chain] ?? 'Fast';
                  return (
                    <div key={chain} className="rounded-xl dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted px-3 py-2.5">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold" style={{ backgroundColor: color }}>
                          {label[0]}
                        </div>
                        <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
                          {label}
                        </span>
                        <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary ml-auto">
                          {chain === 'btc' ? 'Bitcoin' : chain === 'mvc' ? 'MicroVisionChain' : 'Dogecoin'}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        {tiers.map((tier) => {
                          const isSelected = activeTier === tier.title;
                          return (
                            <button
                              key={tier.title}
                              type="button"
                              onClick={() => handleSelectFeeTier(chain, tier.title)}
                              className={`flex flex-col items-center py-1.5 px-1 rounded-md border-2 transition-all cursor-pointer ${
                                isSelected
                                  ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                                  : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg hover:border-claude-accent/40'
                              }`}
                            >
                              <span className={`text-[10px] font-medium ${
                                isSelected
                                  ? 'text-claude-accent'
                                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                              }`}>
                                {tier.title}
                              </span>
                              <span className={`text-sm font-bold tabular-nums leading-tight ${
                                isSelected
                                  ? 'dark:text-claude-darkText text-claude-text'
                                  : 'dark:text-claude-darkText text-claude-text'
                              }`}>
                                {tier.feeRate.toLocaleString()}
                              </span>
                              <span className="text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                {unit}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {feeRateLoading && (
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-2 text-center">
                  {i18nService.t('feeRateLoading')}
                </p>
              )}
            </div>

          </div>
        );
      }

      case 'im':
        return <IMSettings />;

      case 'traffic': {
        // 「积分 & 流量」: two sub-pages — the ME credits page (default)
        // and the on-chain traffic quota page, restored verbatim.
        return (
          <div>
            <div className="flex items-center gap-1 pb-4">
              {(['credits', 'traffic'] as const).map((sub) => (
                <button
                  key={sub}
                  type="button"
                  onClick={() => setCreditsSubTab(sub)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    creditsSubTab === sub
                      ? 'border-claude-accent text-claude-accent dark:text-claude-darkAccent bg-claude-accent/5'
                      : 'border-claude-border dark:border-claude-darkBorder text-claude-text dark:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                  }`}
                >
                  {i18nService.t(sub === 'credits' ? 'usageCreditsSubTabCredits' : 'usageCreditsSubTabTraffic')}
                </button>
              ))}
            </div>
            {creditsSubTab === 'credits' ? <MeUsageAndCredits /> : <TrafficSettings />}
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="flex w-[900px] h-[80vh] rounded-2xl dark:border-claude-darkBorder border-claude-border border shadow-modal overflow-hidden modal-content"
        onClick={handleSettingsClick}
      >
        {/* Left sidebar (slimmed ~1/5: 220px → 176px, per owner request) */}
        <div className="w-[176px] shrink-0 flex flex-col min-h-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted border-r dark:border-claude-darkBorder border-claude-border rounded-l-2xl">
          <div className="px-5 pt-5 pb-3 shrink-0">
            <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('settings')}</h2>
          </div>
          <nav className="flex flex-col gap-0.5 px-3 pb-2 flex-1 min-h-0 overflow-y-auto">
            {sidebarTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                  activeTab === tab.key
                    ? 'bg-claude-accent/10 text-claude-accent'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <div className="shrink-0 px-3 py-3 pt-2 border-t dark:border-claude-darkBorder border-claude-border">
            <p className="text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary select-text tabular-nums">
              {i18nService.t('settingsCurrentVersion')}
              {appVersion || '—'}
            </p>
          </div>
        </div>

        {/* Right content */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden dark:bg-claude-darkBg bg-claude-bg rounded-r-2xl">
          {/* Content header */}
          <div className="flex justify-between items-center px-6 pt-5 pb-3 shrink-0">
            <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{activeTabLabel}</h3>
            <button
              onClick={onClose}
              className="dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text p-1.5 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-lg transition-colors"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          {noticeMessage && (
            <div className="px-6">
              <ErrorMessage
                message={noticeMessage}
                onClose={() => setNoticeMessage(null)}
              />
            </div>
          )}

          {error && (
            <div className="px-6">
              <ErrorMessage
                message={error}
                onClose={() => setError(null)}
              />
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
            {/* Tab content */}
            <div
              ref={contentRef}
              className="px-6 py-4 flex-1 overflow-y-auto"
            >
              {renderTabContent()}
            </div>

            {/* Footer buttons */}
            <div className="flex justify-end space-x-4 p-4 dark:border-claude-darkBorder border-claude-border border-t dark:bg-claude-darkBg bg-claude-bg shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl transition-colors text-sm font-medium border dark:border-claude-darkBorder border-claude-border active:scale-[0.98]"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="btn-idchat-primary-filled px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </form>

          {(isAddingModel || isEditingModel) && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
              onClick={handleCancelModelEdit}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleModelDialogKeyDown}
                className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                  </h4>
                  <button
                    type="button"
                    onClick={handleCancelModelEdit}
                    className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                {modelFormError && (
                  <p className="mb-3 text-xs text-red-600 dark:text-red-400">
                    {modelFormError}
                  </p>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('modelName')}
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={newModelName}
                      onChange={(e) => {
                        setNewModelName(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder="GPT-4"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('modelId')}
                    </label>
                    <input
                      type="text"
                      value={newModelId}
                      onChange={(e) => {
                        setNewModelId(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder="gpt-4"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('contextWindowSize')}
                    </label>
                    <input
                      type="text"
                      value={newModelContextWindow}
                      onChange={(e) => {
                        setNewModelContextWindow(e.target.value);
                        if (modelFormError) {
                          setModelFormError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder="128000"
                    />
                    <p className="mt-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('contextWindowSizeHint')}
                    </p>
                    {contextWindowClampHint(newModelContextWindow) && (
                      <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        {contextWindowClampHint(newModelContextWindow)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      id={`${activeProvider}-supportsImage`}
                      type="checkbox"
                      checked={newModelSupportsImage}
                      onChange={(e) => setNewModelSupportsImage(e.target.checked)}
                      className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface border-claude-border dark:border-claude-darkBorder rounded"
                    />
                    <label
                      htmlFor={`${activeProvider}-supportsImage`}
                      className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {i18nService.t('supportsImageInput')}
                    </label>
                  </div>
                </div>

                <div className="flex justify-end space-x-2 mt-4">
                  <button
                    type="button"
                    onClick={handleCancelModelEdit}
                    className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveNewModel}
                    className="btn-idchat-primary-filled px-3 py-1.5 text-xs"
                  >
                    {i18nService.t('save')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {pendingDeleteProvider && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
              onClick={() => setPendingDeleteProvider(null)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={i18nService.t('deleteProvider')}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setPendingDeleteProvider(null);
                  }
                }}
                className="w-full max-w-sm rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
              >
                <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-1">
                  {i18nService.t('deleteProvider')}
                </h4>
                <p className="mb-4 text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('deleteCustomProviderConfirm').replace('{name}', pendingDeleteProviderName)}
                </p>
                <div className="flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setPendingDeleteProvider(null)}
                    className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomProvider(pendingDeleteProvider)}
                    className="px-3 py-1.5 text-xs font-medium rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors active:scale-[0.98]"
                  >
                    {i18nService.t('confirm')}
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default Settings; 
