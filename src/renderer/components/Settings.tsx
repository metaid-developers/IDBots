import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { configService, mergeProvidersConfig } from '../services/config';
import { apiService } from '../services/api';
import { buildOpenCodeGoSessionHeaders } from '../services/opencodeGatewayHeaders';
import { themeService } from '../services/theme';
import { i18nService, LanguageType } from '../services/i18n';
import { decryptSecret, encryptWithPassword, decryptWithPassword, EncryptedPayload, PasswordEncryptedPayload } from '../services/encryption';
import { coworkService } from '../services/cowork';
import { imService } from '../services/im';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import ErrorMessage from './ErrorMessage';
import FreeQuotaCard from './FreeQuotaCard';
import { XMarkIcon, Cog6ToothIcon, PlusCircleIcon, TrashIcon, PencilIcon, SignalIcon, CheckCircleIcon, XCircleIcon, CubeIcon, ChatBubbleLeftIcon, UserCircleIcon, ArchiveBoxIcon, PuzzlePieceIcon, BriefcaseIcon, BoltIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import BrainIcon from './icons/BrainIcon';
import { CustomProviderIcon, CommandCodeIcon, OpenCodeIcon } from './icons/providers';
import { fetchProviderModelList, providerSupportsModelListSync } from '../services/providerModels';
import { useDispatch, useSelector } from 'react-redux';
import { setAvailableModels, setSelectedModel } from '../store/slices/modelSlice';
import { RootState } from '../store';
import ThemedSelect from './ui/ThemedSelect';
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
import UserSettings from './user/UserSettings';
import TrafficSettings from './traffic/TrafficSettings';
import { defaultConfig, type AppConfig, getVisibleProviders } from '../config';
import { LLM_FREE_PROVIDER_KEY, FREE_PROVIDER_DISPLAY_NAME, getFreeProviderModelDisplayName } from '../services/llmFreeQuotaGate.js';

type TabType = 'user' | 'general' | 'model' | 'skills' | 'projects' | 'coworkSandbox' | 'coworkMemory' | 'archivedChats' | 'shortcuts' | 'im' | 'email' | 'paramsConfig' | 'traffic';

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


const providerKeys = [
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

type ProviderType = (typeof providerKeys)[number];
type ProvidersConfig = NonNullable<AppConfig['providers']>;
// name 字段来自 AppConfig.providers 的 index signature（自定义供应商显示名），
// 命名的内置供应商成员类型不含该字段，这里显式补上以便统一访问。
type ProviderConfig = ProvidersConfig[string] & { name?: string };
type Model = NonNullable<ProviderConfig['models']>[number];
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

const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  'metaid-free': {
    label: FREE_PROVIDER_DISPLAY_NAME,
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}><title>IDBots-Free</title><path fill="currentColor" d="M12 1.5l2.1 6.4 6.4 2.1-6.4 2.1L12 18.5l-2.1-6.4-6.4-2.1 6.4-2.1L12 1.5zM19.2 14.8l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7z"></path></svg>
    ),
  },
  openai: {
    label: 'OpenAI',
    icon: (
      <svg fill="currentColor" fillRule="evenodd" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}><title>OpenAI</title><path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"></path></svg>
    ),
  },
  deepseek: {
    label: 'DeepSeek',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}><title>DeepSeek</title><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" fill="#4D6BFE"></path></svg>
    ),
  },
  gemini: {
    label: 'Gemini',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}><title>Gemini</title><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"></path><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#lobe-icons-gemini-fill-0)"></path><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#lobe-icons-gemini-fill-1)"></path><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#lobe-icons-gemini-fill-2)"></path><defs><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-fill-0" x1="7" x2="11" y1="15.5" y2="12"><stop stopColor="#08B962"></stop><stop offset="1" stopColor="#08B962" stopOpacity="0"></stop></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-fill-1" x1="8" x2="11.5" y1="5.5" y2="11"><stop stopColor="#F94543"></stop><stop offset="1" stopColor="#F94543" stopOpacity="0"></stop></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-fill-2" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stopColor="#FABC12"></stop><stop offset=".46" stopColor="#FABC12" stopOpacity="0"></stop></linearGradient></defs></svg>
    ),
  },
  anthropic: {
    label: 'Anthropic',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}><title>Anthropic</title><path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0l6.569-16.96zm2.327 5.295L6.27 14.71h5.252l-2.626-5.894z" fill="#D97757"></path></svg>
    ),
  },
  moonshot: {
    label: 'Moonshot',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>Kimi</title><path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" fill="#1783FF"></path><path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" fill="currentColor"></path></svg>
    ),
  },
  zhipu: {
    label: 'Zhipu',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>Zhipu</title><path d="M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z" fill="#3859FF" fillRule="nonzero"></path></svg>
    ),
  },
  minimax: {
    label: 'MiniMax',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>Minimax</title><defs><linearGradient id="lobe-icons-minimax-fill" x1="0%" x2="100.182%" y1="50.057%" y2="50.057%"><stop offset="0%" stopColor="#E2167E"></stop><stop offset="100%" stopColor="#FE603C"></stop></linearGradient></defs><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z" fill="url(#lobe-icons-minimax-fill)" fillRule="nonzero"></path></svg>
    ),
  },
  qwen: {
    label: 'Qwen',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>Qwen</title><path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill="url(#lobe-icons-qwen-fill)" fillRule="nonzero"></path><defs><linearGradient id="lobe-icons-qwen-fill" x1="0%" x2="100%" y1="0%" y2="0%"><stop offset="0%" stopColor="#6336E7" stopOpacity=".84"></stop><stop offset="100%" stopColor="#6F69F7" stopOpacity=".84"></stop></linearGradient></defs></svg>
    ),
  },
  volcengine: {
    label: 'Volcengine Ark',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>Volcengine Ark</title><defs><linearGradient id="idbots-volcengine-fill" x1="0%" x2="0%" y1="0%" y2="100%"><stop offset="0%" stopColor="#4D8DFF"></stop><stop offset="100%" stopColor="#1664FF"></stop></linearGradient></defs><path d="M9.4 2.2c.35-.44 1.02-.2 1.05.36.03.62.24 1.1.63 1.5.3-.62.74-1.1 1.3-1.42.42-.24.9.13.78.6-.17.66-.1 1.2.2 1.66l4.82 8.35c.9 1.55.36 3.54-1.2 4.43-.48.28-1.03.43-1.6.43H8.62A3.62 3.62 0 0 1 5 14.69c0-.64.17-1.26.5-1.81l3.4-5.6c.32-.53.5-1.13.53-1.75.02-.5.13-1.32.37-2.08.1-.33.33-.83.6-1.25z" fill="url(#idbots-volcengine-fill)"></path><circle cx="10.1" cy="15.4" r="1.3" fill="#ffffff" opacity=".85"></circle><circle cx="14.2" cy="16.6" r=".9" fill="#ffffff" opacity=".7"></circle></svg>
    ),
  },
  xiaomi: {
    label: 'Xiaomi',
    icon: (
      <svg height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>Xiaomi</title><defs><linearGradient id="lobe-icons-xiaomi-fill" x1="0%" x2="100%" y1="0%" y2="0%"><stop offset="0%" stopColor="#FF6900" stopOpacity=".84"></stop><stop offset="100%" stopColor="#FF8533" stopOpacity=".84"></stop></linearGradient></defs><path d="M.958 15.936a.459.459 0 01.459.44v2.729a.46.46 0 01-.918 0v-2.729a.459.459 0 01.459-.44zm4.814-2.035a.46.46 0 01.553.45v4.754a.458.458 0 11-.918 0V15.48L3.74 17.202a.462.462 0 01-.655.016.462.462 0 01-.065-.082L.628 14.67a.459.459 0 01.658-.637l2.124 2.187 2.127-2.188a.46.46 0 01.235-.13zm2.068.004a.46.46 0 01.458.445v4.755a.46.46 0 01-.458.458.459.459 0 01-.458-.458V14.35a.459.459 0 01.458-.445zm1.973 2.014a.46.46 0 01.46.457v2.729a.46.46 0 01-.784.324.46.46 0 01-.134-.324v-2.729a.46.46 0 01.458-.458zm.002-2.045a.458.458 0 01.328.157l2.127 2.19 2.125-2.19a.459.459 0 01.784.318v4.756a.46.46 0 01-.455.458.46.46 0 01-.458-.458V15.48l-1.667 1.723a.46.46 0 01-.65.008l-.005-.005c0-.002-.002-.002-.004-.003l-2.455-2.534a.46.46 0 01-.008-.667.461.461 0 01.338-.128zm6.797 1.206a.46.46 0 01.53.651A1.966 1.966 0 0019.81 18.4a.462.462 0 01.623.18.46.46 0 01-.181.624 2.863 2.863 0 01-1.38.353l-.142-.004a2.88 2.88 0 01-2.393-4.263.461.461 0 01.274-.21zm.864-.931a2.884 2.884 0 013.915 3.914.46.46 0 01-.402.24l-.057-.004a.458.458 0 01-.164-.055.46.46 0 01-.182-.622 1.967 1.967 0 00-2.669-2.67.459.459 0 11-.441-.803zM9.59 6.368c1.481 0 1.696 1.202 1.696 1.654v2.648h-.917v-.432c-.26.346-.792.535-1.36.535-.133 0-1.289-.03-1.384-1.136-.082-.932.675-1.61 2.053-1.61h.691c0-.563-.367-.886-.983-.886-.44.013-.864.174-1.2.458l-.36-.664c.484-.379 1.012-.567 1.764-.567zm4.427.1c1.263 0 2.082.97 2.083 2.15 0 1.181-.824 2.154-2.083 2.154-1.26 0-2.084-.972-2.084-2.152 0-1.18.82-2.153 2.084-2.153zm6.801.015c.68 0 1.202.465 1.197 1.548v2.642H21.1V8.29c0-.312-.002-.98-.63-.98s-.628.667-.628.838v2.524h-.89V8.148c0-.17-.001-.838-.63-.838-.628 0-.628.668-.628.98v2.383h-.917v-4.03h.917V7a1.22 1.22 0 01.947-.516c.398 0 .76.193.982.686a1.321 1.321 0 011.195-.686zm-18.093.872l1.457-1.772H5.32L3.311 8.07l2.14 2.602H4.24L2.725 8.796 1.21 10.672H0L2.138 8.07.13 5.583h1.138l1.458 1.772zm4.149 3.317h-.916V6.644h.916v4.028zm16.99 0h-.916V6.644h.916v4.028zM9.925 8.71c-1.055 0-1.359.412-1.326.742.032.329.324.537.757.537a1.013 1.013 0 001.014-.968l.002-.31h-.447zM14.018 7.3c-.663 0-1.184.487-1.184 1.32 0 .832.52 1.32 1.184 1.32.662 0 1.182-.49 1.182-1.32 0-.832-.52-1.32-1.182-1.32zM6.417 5.001a.568.568 0 01.587.582.588.588 0 01-1.175 0A.57.57 0 016.417 5zm16.991 0a.57.57 0 01.592.582.588.588 0 01-1.174 0 .57.57 0 01.357-.542.572.572 0 01.225-.04z" fill="url(#lobe-icons-xiaomi-fill)" fillRule="evenodd"></path></svg>
    ),
  },
  openrouter: {
    label: 'OpenRouter',
    icon: (
      <svg fill="currentColor" fillRule="evenodd" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{ flex: '0 0 auto', lineHeight: 1 }}><title>OpenRouter</title><path d="M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z"></path></svg>
    ),
  },
  ollama: {
    label: 'Ollama',
    icon: (
      <svg fill="currentColor" fillRule="evenodd" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}><title>Ollama</title><path d="M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"></path></svg>
    ),
  },
  opencode: {
    label: 'OpenCode',
    icon: <OpenCodeIcon />,
  },
  commandcode: {
    label: 'Command Code',
    icon: <CommandCodeIcon />,
  },
};

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
  // one key, three protocol endpoints. Responses is the default.
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
 * unless relay-provisioned (IDBots-Free).
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
const buildOpenAIResponsesUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/responses';
  }
  if (normalized.endsWith('/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
};
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
// 不在 providerKeys / providerMeta 内置注册表内，显示名存于配置的 name 字段。
const isCustomProviderKey = (key: string): boolean => (
  !(providerKeys as readonly string[]).includes(key)
);

const getProviderDisplayLabel = (key: ProviderType, config?: ProviderConfig): string => {
  if (isCustomProviderKey(key)) {
    return config?.name?.trim() || key.charAt(0).toUpperCase() + key.slice(1);
  }
  return providerMeta[key]?.label ?? key;
};

const getProviderIcon = (key: ProviderType): React.ReactNode => {
  if (isCustomProviderKey(key)) {
    return <CustomProviderIcon />;
  }
  return providerMeta[key]?.icon;
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

  // State for the custom provider add dialog
  const [isAddingCustomProvider, setIsAddingCustomProvider] = useState(false);
  const [customProviderName, setCustomProviderName] = useState('');
  const [customProviderBaseUrl, setCustomProviderBaseUrl] = useState('');
  const [customProviderApiKey, setCustomProviderApiKey] = useState('');
  // release-review P2: custom relays are overwhelmingly OpenAI-compatible; an
  // ignored format dropdown must not default new providers into Anthropic
  // Messages format (every request fails). The normalize default for stored
  // values stays 'anthropic' for legacy-row compatibility.
  const [customProviderApiFormat, setCustomProviderApiFormat] = useState<'anthropic' | 'openai' | 'responses'>('openai');
  const [customProviderModels, setCustomProviderModels] = useState<Model[]>([]);
  const [customModelName, setCustomModelName] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  // Raw input for the draft model's optional context window (empty = default 128K).
  const [customModelContextWindow, setCustomModelContextWindow] = useState('');
  const [customProviderError, setCustomProviderError] = useState<string | null>(null);

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

  // All LLM providers shown uniformly (no language filtering per SDD),
  // plus user-created custom providers (keys outside the built-in registry).
  const visibleProviders = useMemo(() => {
    const visibleKeys = getVisibleProviders(language);
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of visibleKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    for (const key of Object.keys(providers)) {
      if (visibleKeys.includes(key)) {
        continue;
      }
      filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
    }
    return filtered as ProvidersConfig;
  }, [language, providers]);

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
      handleCancelCustomProvider();
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

  // --- 自定义供应商添加/删除 ---
  const handleAddCustomProviderClick = () => {
    setCustomProviderName('');
    setCustomProviderBaseUrl('');
    setCustomProviderApiKey('');
    setCustomProviderApiFormat('openai');
    setCustomProviderModels([]);
    setCustomModelName('');
    setCustomModelId('');
    // Same as the add-model form: the window field starts empty so no wrong
    // default gets persisted; resolution falls back to the catalog / 128K.
    setCustomModelContextWindow('');
    setCustomProviderError(null);
    setIsAddingCustomProvider(true);
  };

  const handleCancelCustomProvider = () => {
    setIsAddingCustomProvider(false);
    setCustomProviderError(null);
  };

  const handleAddCustomModelDraft = () => {
    const modelName = customModelName.trim();
    const modelId = customModelId.trim();
    if (!modelName || !modelId) {
      setCustomProviderError(i18nService.t('modelNameAndIdRequired'));
      return;
    }
    if (customProviderModels.some(model => model.id === modelId)) {
      setCustomProviderError(i18nService.t('modelIdExists'));
      return;
    }
    const parsedContextWindow = parseContextWindowSizeInput(customModelContextWindow);
    if (parsedContextWindow === null) {
      setCustomProviderError(i18nService.t('contextWindowSizeInvalid'));
      return;
    }
    setCustomProviderModels(prev => [
      ...prev,
      {
        id: modelId,
        name: modelName,
        supportsImage: false,
        // Same rationale as the add-model form: draft entries pin the 128K
        // output ceiling so they match the main-process default (clamped
        // against the window at resolution).
        maxOutputTokens: NEW_MODEL_DEFAULT_MAX_OUTPUT_TOKENS,
        // Omitted when left empty so resolution keeps the known-model catalog
        // / 128K default instead of pinning an explicit value.
        ...(parsedContextWindow !== undefined ? { contextWindow: parsedContextWindow } : {}),
      },
    ]);
    setCustomModelName('');
    setCustomModelId('');
    setCustomModelContextWindow('');
    setCustomProviderError(null);
  };

  const handleRemoveCustomModelDraft = (modelId: string) => {
    setCustomProviderModels(prev => prev.filter(model => model.id !== modelId));
  };

  const handleAddCustomProvider = () => {
    const name = customProviderName.trim();
    const baseUrl = customProviderBaseUrl.trim();
    if (!name) {
      setCustomProviderError(i18nService.t('providerNameRequired'));
      return;
    }
    if (!baseUrl) {
      setCustomProviderError(i18nService.t('providerBaseUrlRequired'));
      return;
    }
    const providerKey = generateCustomProviderKey(name, Object.keys(providers));
    setProviders(prev => ({
      ...prev,
      [providerKey]: {
        enabled: false,
        apiKey: customProviderApiKey.trim(),
        baseUrl,
        apiFormat: customProviderApiFormat,
        name,
        models: customProviderModels.length > 0 ? customProviderModels : undefined,
      },
    }));
    setTestResult(null);
    setIsAddingCustomProvider(false);
    setCustomProviderError(null);
    setActiveProvider(providerKey as ProviderType);
  };

  const handleCustomProviderDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelCustomProvider();
    }
  };

  const handleDeleteCustomProvider = (providerKey: string) => {
    const displayName = providers[providerKey]?.name?.trim() || providerKey;
    if (!window.confirm(i18nService.t('deleteCustomProviderConfirm').replace('{name}', displayName))) {
      return;
    }
    setProviders(prev => {
      const next = { ...prev };
      delete next[providerKey];
      return next;
    });
    setTestResult(null);
    if (activeProvider === providerKey) {
      const remainingKeys = Object.keys(visibleProviders).filter(key => key !== providerKey);
      const firstEnabled = remainingKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider((firstEnabled ?? remainingKeys[0]) as ProviderType);
    }
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
          ? buildOpenAIResponsesUrl(normalizedBaseUrl)
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
    { key: 'user',           label: i18nService.t('userSettingsTab'), icon: <UserCircleIcon className="h-5 w-5" /> },
    { key: 'general',        label: i18nService.t('general'),        icon: <Cog6ToothIcon className="h-5 w-5" /> },
    { key: 'model',          label: i18nService.t('model'),          icon: <CubeIcon className="h-5 w-5" /> },
    { key: 'coworkMemory',   label: i18nService.t('coworkMemoryTitle'), icon: <BrainIcon className="h-5 w-5" /> },
    { key: 'traffic',        label: i18nService.t('trafficTab'),     icon: <BoltIcon className="h-5 w-5" /> },
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
      case 'user':
        return <UserSettings />;

      case 'general':
        return (
          <div className="space-y-8">
            {/* Language Section */}
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

            {/* Experimental automation kill-switch (browser automation + desktop computer use) */}
            <div>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
                {i18nService.t('experimentalAutomation')}
              </h4>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
                  {i18nService.t('experimentalAutomationDescription')}
                </span>
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

      case 'model':
        return (
          <div className="flex h-full">
            {/* Provider List - Left Side */}
            <div className="w-2/5 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-1.5 overflow-y-auto">
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
                  onClick={handleAddCustomProviderClick}
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
              {Object.entries(visibleProviders).map(([provider, config]) => {
                const providerKey = provider as ProviderType;
                const missingApiKey = providerRequiresApiKey(providerKey) && !config.apiKey.trim();
                const canToggleProvider = config.enabled || !missingApiKey;
                return (
                  <div
                    key={provider}
                    onClick={() => handleProviderChange(providerKey)}
                    className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors group ${
                      activeProvider === provider
                        ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30 shadow-subtle'
                        : 'dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent'
                    }`}
                  >
                    <div className="flex flex-1 items-center">
                      <div className="mr-2 flex h-7 w-7 items-center justify-center">
                        <span className="dark:text-claude-darkText text-claude-text">
                          {getProviderIcon(providerKey)}
                        </span>
                      </div>
                      <span className={`text-sm font-medium truncate ${
                        activeProvider === provider
                          ? 'text-claude-accent'
                          : 'dark:text-claude-darkText text-claude-text'
                      }`}>
                        {getProviderDisplayLabel(providerKey, config)}
                      </span>
                      {providerKey === 'deepseek' && (
                        <span className="ml-1.5 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent font-medium">
                          {i18nService.t('providerRecommendedBadge')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center ml-2">
                      {isCustomProviderKey(providerKey) && (
                        <button
                          type="button"
                          title={i18nService.t('deleteProvider')}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCustomProvider(providerKey);
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
              })}
            </div>

            {/* Provider Settings - Right Side */}
            <div className="w-3/5 pl-4 space-y-4 overflow-y-auto">
              <div className="flex items-center justify-between pb-2 border-b dark:border-claude-darkBorder border-claude-border">
                <h3 className="text-base font-medium dark:text-claude-darkText text-claude-text">
                  {getProviderDisplayLabel(activeProvider, providers[activeProvider])} {i18nService.t('providerSettings')}
                </h3>
                <div
                  className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
                    providers[activeProvider].enabled
                      ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                      : 'bg-red-500/20 text-red-600 dark:text-red-400'
                  }`}
                >
                  {providers[activeProvider].enabled ? i18nService.t('providerStatusOn') : i18nService.t('providerStatusOff')}
                </div>
              </div>

              {activeProvider === LLM_FREE_PROVIDER_KEY && (
                <div>
                  <FreeQuotaCard providers={providers} onProvisioned={handleFreeQuotaProvisioned} />
                  <p className="text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('freeQuotaNotice')}
                  </p>
                </div>
              )}

              {providerRequiresApiKey(activeProvider) && !isBuiltInFreeProvider(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiKey`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiKey')}
                  </label>
                  <input
                    type="password"
                    id={`${activeProvider}-apiKey`}
                    value={providers[activeProvider].apiKey}
                    onChange={(e) => handleProviderConfigChange(activeProvider, 'apiKey', e.target.value)}
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
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
                    className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    placeholder={i18nService.t('baseUrlPlaceholder')}
                  />
                </div>
              )}

              {/* API 格式选择器 */}
              {shouldShowApiFormatSelector(activeProvider) && (
                <div>
                  <label htmlFor={`${activeProvider}-apiFormat`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
                    {i18nService.t('apiFormat')}
                  </label>
                  <div className="flex items-center space-x-4 flex-wrap gap-y-1.5">
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
                        </div>
                      </div>
                    </div>
                  ))}

                  {(!providers[activeProvider].models || providers[activeProvider].models.length === 0) && (
                    <div className="dark:bg-claude-darkSurface/20 bg-claude-surface/20 p-2.5 rounded-xl border dark:border-claude-darkBorder/50 border-claude-border/50 text-center">
                      <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('noModelsAvailable')}</p>
                      <button
                        type="button"
                        onClick={handleAddModel}
                        className="mt-1.5 inline-flex items-center text-[11px] font-medium text-claude-accent hover:text-claude-accentHover"
                      >
                        <PlusCircleIcon className="h-3 w-3 mr-1" />
                        {i18nService.t('addFirstModel')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );

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

      case 'traffic':
        return <TrafficSettings />;

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
        {/* Left sidebar */}
        <div className="w-[220px] shrink-0 flex flex-col min-h-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted border-r dark:border-claude-darkBorder border-claude-border rounded-l-2xl">
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

          {isAddingCustomProvider && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
              onClick={handleCancelCustomProvider}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={i18nService.t('addCustomProviderTitle')}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleCustomProviderDialogKeyDown}
                className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
              >
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    {i18nService.t('addCustomProviderTitle')}
                  </h4>
                  <button
                    type="button"
                    onClick={handleCancelCustomProvider}
                    className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>
                <p className="mb-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('addCustomProviderDesc')}
                </p>

                {customProviderError && (
                  <p className="mb-3 text-xs text-red-600 dark:text-red-400">
                    {customProviderError}
                  </p>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('providerName')}
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={customProviderName}
                      onChange={(e) => {
                        setCustomProviderName(e.target.value);
                        if (customProviderError) {
                          setCustomProviderError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder={i18nService.t('providerNamePlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('baseUrl')}
                    </label>
                    <input
                      type="text"
                      value={customProviderBaseUrl}
                      onChange={(e) => {
                        setCustomProviderBaseUrl(e.target.value);
                        if (customProviderError) {
                          setCustomProviderError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder={i18nService.t('providerBaseUrlPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('apiKey')}
                    </label>
                    <input
                      type="password"
                      value={customProviderApiKey}
                      onChange={(e) => {
                        setCustomProviderApiKey(e.target.value);
                        if (customProviderError) {
                          setCustomProviderError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                      placeholder={i18nService.t('apiKeyPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('apiFormat')}
                    </label>
                    <select
                      value={customProviderApiFormat}
                      onChange={(e) => {
                        setCustomProviderApiFormat(e.target.value as 'anthropic' | 'openai' | 'responses');
                        if (customProviderError) {
                          setCustomProviderError(null);
                        }
                      }}
                      className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                    >
                      <option value="anthropic">{i18nService.t('apiFormatNative')}</option>
                      <option value="openai">{i18nService.t('apiFormatOpenAI')}</option>
                      <option value="responses">{i18nService.t('apiFormatResponses')}</option>
                    </select>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('availableModels')}
                      </label>
                      <button
                        type="button"
                        onClick={handleAddCustomModelDraft}
                        className="inline-flex items-center text-xs text-claude-accent hover:text-claude-accentHover"
                      >
                        <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
                        {i18nService.t('addModel')}
                      </button>
                    </div>
                    <div className="flex items-center space-x-2 mb-1.5">
                      <input
                        type="text"
                        value={customModelName}
                        onChange={(e) => setCustomModelName(e.target.value)}
                        className="block w-1/2 rounded-lg bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-2.5 py-1.5 text-xs"
                        placeholder={i18nService.t('modelName')}
                      />
                      <input
                        type="text"
                        value={customModelId}
                        onChange={(e) => setCustomModelId(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddCustomModelDraft();
                          }
                        }}
                        className="block w-1/2 rounded-lg bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-2.5 py-1.5 text-xs"
                        placeholder={i18nService.t('modelId')}
                      />
                    </div>
                    <div className="mb-2">
                      <input
                        type="text"
                        value={customModelContextWindow}
                        onChange={(e) => {
                          setCustomModelContextWindow(e.target.value);
                          if (customProviderError) {
                            setCustomProviderError(null);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddCustomModelDraft();
                          }
                        }}
                        className="block w-full rounded-lg bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-2.5 py-1.5 text-xs"
                        placeholder={i18nService.t('contextWindowSizePlaceholder')}
                      />
                      <p className="mt-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('contextWindowSizeHint')}
                      </p>
                      {contextWindowClampHint(customModelContextWindow) && (
                        <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                          {contextWindowClampHint(customModelContextWindow)}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                      {customProviderModels.map(model => (
                        <div
                          key={model.id}
                          className="dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-2 rounded-lg dark:border-claude-darkBorder border-claude-border border group/model"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-1.5 min-w-0">
                              <span className="dark:text-claude-darkText text-claude-text font-medium text-[11px] truncate">{model.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">{model.id}</span>
                              {model.contextWindow && formatContextWindowSize(model.contextWindow) && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                  {formatContextWindowSize(model.contextWindow)}
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveCustomModelDraft(model.id)}
                              className="p-0.5 ml-1 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 opacity-0 group-hover/model:opacity-100 transition-opacity"
                            >
                              <TrashIcon className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                      {customProviderModels.length === 0 && (
                        <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {i18nService.t('noModelsAvailable')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-2 mt-4">
                  <button
                    type="button"
                    onClick={handleCancelCustomProvider}
                    className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleAddCustomProvider}
                    className="btn-idchat-primary-filled px-3 py-1.5 text-xs"
                  >
                    {i18nService.t('addProvider')}
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
