/**
 * Tabbed MetaBot edit form (Studio Linear Style B).
 *
 * Six tabs — Basic / Persona / Chat Settings / Knowledge Base / Surf /
 * Advanced. Profile tabs keep scoped dirty tracking and per-tab on-chain sync
 * grouping; Knowledge Base and Surf apply via immediate IPC channels. All
 * panels stay mounted (inactive ones are CSS-hidden) so unsaved edits in other
 * tabs survive tab switches.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  DocumentTextIcon,
  FlagIcon,
  GlobeAltIcon,
  HeartIcon,
  IdentificationIcon,
  LinkIcon,
  PhotoIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Squares2X2Icon,
  StarIcon,
  UserGroupIcon,
  UserIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import {
  buildModelGroupsFromConfig,
  isLlmEffortLevel,
  resolveBrainModelInGroups,
  type LlmEffortLevel,
} from '../../services/modelCatalog';
import ModelEffortPicker from '../ModelEffortPicker';
import type { Metabot } from '../../types/metabot';
import type { Skill } from '../../types/skill';
import type { SyncStepKey } from './MetaBotCreateSuccessModal';
import {
  addAllowChatSkill,
  normalizeAllowChatSkills,
  removeAllowChatSkill,
} from './allowChatSkills.ts';
import MetaBotAdvancedActionsSection from './MetaBotAdvancedActionsSection';
import MetaBotHomepageSection, { composeHomepageForSave } from './MetaBotHomepageSection';
import AvatarPickerModal, { type AvatarPickerNftItem } from '../avatar/AvatarPickerModal';
import NftAvatarFrame from './NftAvatarFrame';
import { parseNftAvatarReference } from './nftAvatarPresentation.js';
import KnowledgeBasePanel from './KnowledgeBasePanel';
import SurfSection from './SurfSection';
import DailyReportSection from './DailyReportSection';
import {
  buildMetaBotToggleViewModel,
  canShowMetabotTwinSwitch,
  formatGlobalMetaIdShort,
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_CLEAN_INPUT_CLASS,
  METABOT_COMPACT_SELECT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_NOTE_CLASS,
  METABOT_GROUP_ROW_CLASS,
  METABOT_GROUP_ROW_TOP_CLASS,
  METABOT_MICRO_BADGE_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';
import Tooltip from '../ui/Tooltip';

const AVATAR_MAX_SIZE_BYTES = 200 * 1024; // 200KB

// A2A private-chat limits; keep in sync with src/main/services/a2aChatLimits.ts
// (pinned by tests/quotaRendererSync.test.mjs).
const A2A_MAX_INCOMING_TURNS_OPTIONS: readonly number[] = [20, 30, 50, 80, 100, 150, 200];
const A2A_BYE_COOLDOWN_MS_OPTIONS: readonly number[] = [60_000, 300_000, 600_000, 1_800_000, 3_600_000];
const DEFAULT_A2A_MAX_INCOMING_TURNS = 50;
const DEFAULT_A2A_BYE_COOLDOWN_MS = 300_000;
export const DEFAULT_A2A_AUTO_REPLY_ENABLED = true;

export const normalizeA2AMaxIncomingTurnsOption = (value: unknown): number =>
  A2A_MAX_INCOMING_TURNS_OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_A2A_MAX_INCOMING_TURNS;
export const normalizeA2AByeCooldownMsOption = (value: unknown): number =>
  A2A_BYE_COOLDOWN_MS_OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_A2A_BYE_COOLDOWN_MS;
export const normalizeA2AAutoReplyEnabledOption = (value: unknown): boolean =>
  value == null
    ? DEFAULT_A2A_AUTO_REPLY_ENABLED
    : typeof value === 'number'
      ? value !== 0
      : Boolean(value);

// Keep in sync with OPENTEAM_ALLOW_REMOTE_COLLAB_KEY in src/main/services/openTeamGuestService.ts.
const OPENTEAM_ALLOW_REMOTE_COLLAB_KEY = 'openteam.allowRemoteCollab';
// Keep in sync with COWORK_MOUNT_MCP_TOOLS_KEY in src/main/services/coworkMcpToolsPreference.ts.
const COWORK_MOUNT_MCP_TOOLS_KEY = 'cowork.mountMcpTools';
// Keep in sync with src/main/services/coworkAutomationPreference.ts.
const COWORK_BROWSER_AUTOMATION_KEY = 'cowork.browserAutomation';
const COWORK_COMPUTER_USE_KEY = 'cowork.computerUse';

export interface MetaBotEditValues {
  name: string;
  avatar: string;
  metabot_type: 'twin' | 'worker' | 'welcome';
  role: string;
  soul: string;
  goal: string;
  bio: string;
  boss_global_metaid: string;
  boss_id: string;
  llm_id: string;
  llm_provider: string;
  llm_effort: string;
  fallback_llm_id: string;
  fallback_llm_provider: string;
  fallback_llm_effort: string;
  allow_chat_skills: string[];
  a2a_max_incoming_turns: number;
  a2a_bye_cooldown_ms: number;
  a2a_auto_reply_enabled: boolean;
  homepage_source: 'default' | 'metafile' | 'metaapp';
  homepage_metafile_uri: string;
  homepage_metafile_content_type: string;
  homepage_metaapp_pin: string;
  homepage_initial: string | null;
  homepage?: string | null;
}

export interface LlmOption {
  id: string;
  label: string;
}

export type MetaBotEditTabKey = 'basic' | 'persona' | 'chatSettings' | 'knowledgeBase' | 'surf' | 'advanced';

export const EDIT_TAB_FIELDS: Partial<Record<MetaBotEditTabKey, readonly (keyof MetaBotEditValues)[]>> = {
  basic: ['name', 'avatar', 'bio', 'metabot_type', 'boss_global_metaid', 'llm_id', 'llm_provider', 'llm_effort', 'fallback_llm_id', 'fallback_llm_provider', 'fallback_llm_effort'],
  persona: ['role', 'soul', 'goal'],
  chatSettings: ['allow_chat_skills', 'a2a_max_incoming_turns', 'a2a_bye_cooldown_ms', 'a2a_auto_reply_enabled'],
  advanced: ['homepage_source', 'homepage_metafile_uri', 'homepage_metafile_content_type', 'homepage_metaapp_pin'],
};

export const EDIT_TAB_SYNC_GROUPS: Partial<Record<MetaBotEditTabKey, readonly SyncStepKey[]>> = {
  basic: ['name', 'avatar', 'bio', 'owner', 'llm'],
  persona: ['persona'],
  chatSettings: ['chatSkills'],
  advanced: ['homepage'],
};

const EDIT_TAB_ORDER: readonly MetaBotEditTabKey[] = ['basic', 'persona', 'chatSettings', 'knowledgeBase', 'surf', 'advanced'];

const EDIT_TAB_LABEL_KEYS: Record<
  MetaBotEditTabKey,
  'metabotTabBasic' | 'metabotTabPersona' | 'metabotTabChatSettings' | 'metabotTabKnowledgeBase' | 'metabotTabSurf' | 'metabotTabAdvanced'
> = {
  basic: 'metabotTabBasic',
  persona: 'metabotTabPersona',
  chatSettings: 'metabotTabChatSettings',
  knowledgeBase: 'metabotTabKnowledgeBase',
  surf: 'metabotTabSurf',
  advanced: 'metabotTabAdvanced',
};

const defaultValues: MetaBotEditValues = {
  name: '',
  avatar: '',
  metabot_type: 'worker',
  role: '',
  soul: '',
  goal: '',
  bio: '',
  boss_global_metaid: '',
  boss_id: '',
  llm_id: '',
  llm_provider: '',
  llm_effort: '',
  fallback_llm_id: '',
  fallback_llm_provider: '',
  fallback_llm_effort: '',
  allow_chat_skills: [],
  a2a_max_incoming_turns: DEFAULT_A2A_MAX_INCOMING_TURNS,
  a2a_bye_cooldown_ms: DEFAULT_A2A_BYE_COOLDOWN_MS,
  a2a_auto_reply_enabled: DEFAULT_A2A_AUTO_REPLY_ENABLED,
  homepage_source: 'default',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_metaapp_pin: '',
  homepage_initial: null,
};

const buildInitialValues = (initialValues?: Partial<MetaBotEditValues> | null): MetaBotEditValues => ({
  ...defaultValues,
  ...(initialValues || {}),
  allow_chat_skills: normalizeAllowChatSkills(initialValues?.allow_chat_skills ?? defaultValues.allow_chat_skills),
  a2a_max_incoming_turns: normalizeA2AMaxIncomingTurnsOption(
    initialValues?.a2a_max_incoming_turns ?? defaultValues.a2a_max_incoming_turns
  ),
  a2a_bye_cooldown_ms: normalizeA2AByeCooldownMsOption(
    initialValues?.a2a_bye_cooldown_ms ?? defaultValues.a2a_bye_cooldown_ms
  ),
  a2a_auto_reply_enabled: normalizeA2AAutoReplyEnabledOption(
    initialValues?.a2a_auto_reply_enabled ?? defaultValues.a2a_auto_reply_enabled
  ),
});

const editFieldEquals = (a: MetaBotEditValues[keyof MetaBotEditValues], b: MetaBotEditValues[keyof MetaBotEditValues]): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(normalizeAllowChatSkills(a as string[])) === JSON.stringify(normalizeAllowChatSkills(b as string[]));
  }
  return a === b;
};

interface MetaBotEditTabsProps {
  /** Optional identity header rendered inside the Studio Linear top bar card above the underline tabs. */
  headerSlot?: React.ReactNode;
  initialValues?: Partial<MetaBotEditValues> | null;
  metabotId: number;
  onCancel: () => void;
  onSaveTab: (tab: MetaBotEditTabKey, values: MetaBotEditValues) => Promise<void>;
  llmOptions: LlmOption[];
  skillOptions: Skill[];
  onRequestModelSettings?: () => void;
  onCheckNameExists?: (name: string, excludeId?: number) => Promise<boolean>;
  hasOtherTwin?: boolean;
  ownerBindingPinId?: string | null;
  onOpenDefaultHomepage?: () => void;
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  onRequestMetaApps?: () => void;
  metabot?: Metabot | null;
  onDelete?: () => void;
}

const MetaBotEditTabs: React.FC<MetaBotEditTabsProps> = ({
  headerSlot,
  initialValues,
  metabotId,
  onCancel,
  onSaveTab,
  llmOptions,
  skillOptions,
  onRequestModelSettings,
  onCheckNameExists,
  hasOtherTwin = false,
  ownerBindingPinId,
  onOpenDefaultHomepage,
  onPreviewMetaAppHomepage,
  onRequestMetaApps,
  metabot,
  onDelete,
}) => {
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [values, setValues] = useState<MetaBotEditValues>(() => buildInitialValues(initialValues));
  const [baseline, setBaseline] = useState<MetaBotEditValues>(() => buildInitialValues(initialValues));
  const [activeTab, setActiveTab] = useState<MetaBotEditTabKey>('basic');
  const [savingTab, setSavingTab] = useState<MetaBotEditTabKey | null>(null);
  const [tabErrors, setTabErrors] = useState<Partial<Record<MetaBotEditTabKey, string>>>({});
  const [nameDuplicate, setNameDuplicate] = useState(false);
  const [selectedAllowChatSkillId, setSelectedAllowChatSkillId] = useState('');

  const loadAvatarNfts = useCallback(async (): Promise<AvatarPickerNftItem[]> => {
    const response = await window.electron.idbots.getMetabotNfts({ metabotId, kind: 'mrc721' });
    if (!response.success) throw new Error(response.error || i18nService.t('metabotNftLoadFailed'));
    return (response.items ?? []) as unknown as AvatarPickerNftItem[];
  }, [metabotId]);

  const [openTeamRemoteCollab, setOpenTeamRemoteCollab] = useState(true);
  const [openTeamRemoteCollabLoaded, setOpenTeamRemoteCollabLoaded] = useState(false);
  const [openTeamRemoteCollabSaving, setOpenTeamRemoteCollabSaving] = useState(false);

  const [coworkMcpTools, setCoworkMcpTools] = useState(false);
  const [coworkMcpToolsLoaded, setCoworkMcpToolsLoaded] = useState(false);
  const [coworkMcpToolsSaving, setCoworkMcpToolsSaving] = useState(false);
  const [coworkBrowserAutomation, setCoworkBrowserAutomation] = useState(false);
  const [coworkBrowserAutomationLoaded, setCoworkBrowserAutomationLoaded] = useState(false);
  const [coworkBrowserAutomationSaving, setCoworkBrowserAutomationSaving] = useState(false);
  const [coworkComputerUse, setCoworkComputerUse] = useState(false);
  const [coworkComputerUseLoaded, setCoworkComputerUseLoaded] = useState(false);
  const [coworkComputerUseSaving, setCoworkComputerUseSaving] = useState(false);
  const [twinDemoteConfirmOpen, setTwinDemoteConfirmOpen] = useState(false);

  useEffect(() => {
    const next = buildInitialValues(initialValues);
    setValues(next);
    setBaseline(next);
    setActiveTab('basic');
    setSavingTab(null);
    setTabErrors({});
    setNameDuplicate(false);
    setSelectedAllowChatSkillId('');
    setTwinDemoteConfirmOpen(false);
  }, [metabotId]);

  useEffect(() => {
    let cancelled = false;
    setOpenTeamRemoteCollab(true);
    setOpenTeamRemoteCollabLoaded(false);
    setOpenTeamRemoteCollabSaving(false);
    window.electron.metabot.getSetting(metabotId, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY)
      .then((result) => {
        if (cancelled) return;
        setOpenTeamRemoteCollab(result.success ? result.value !== '0' : true);
        setOpenTeamRemoteCollabLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setOpenTeamRemoteCollab(true);
        setOpenTeamRemoteCollabLoaded(true);
      });
    return () => { cancelled = true; };
  }, [metabotId]);

  useEffect(() => {
    let cancelled = false;
    const resetters = [
      [setCoworkMcpTools, setCoworkMcpToolsLoaded, setCoworkMcpToolsSaving, COWORK_MOUNT_MCP_TOOLS_KEY, false],
      [setCoworkBrowserAutomation, setCoworkBrowserAutomationLoaded, setCoworkBrowserAutomationSaving, COWORK_BROWSER_AUTOMATION_KEY, false],
      [setCoworkComputerUse, setCoworkComputerUseLoaded, setCoworkComputerUseSaving, COWORK_COMPUTER_USE_KEY, false],
    ] as const;
    for (const [setValue, setLoaded, setSaving, key, fallback] of resetters) {
      setValue(fallback);
      setLoaded(false);
      setSaving(false);
      window.electron.metabot.getSetting(metabotId, key)
        .then((result) => {
          if (cancelled) return;
          setValue(result.success && result.value != null ? result.value === '1' : fallback);
          setLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          setValue(fallback);
          setLoaded(true);
        });
    }
    return () => { cancelled = true; };
  }, [metabotId]);

  const setTabError = (tab: MetaBotEditTabKey, message: string) => {
    setTabErrors((prev) => ({ ...prev, [tab]: message }));
  };

  const handleChange = <K extends keyof MetaBotEditValues>(field: K, value: MetaBotEditValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setTabErrors((prev) => ({ ...prev, [activeTab]: '' }));
    if (field === 'name') setNameDuplicate(false);
  };

  const isTabDirty = (tab: MetaBotEditTabKey): boolean =>
    (EDIT_TAB_FIELDS[tab] ?? []).some((field) => !editFieldEquals(values[field], baseline[field]));

  const handleTabClick = (tab: MetaBotEditTabKey) => {
    if (tab === activeTab) return;
    if (isTabDirty(activeTab)) {
      if (!window.confirm(i18nService.t('metabotUnsavedChangesConfirm'))) return;
      setValues((prev) => {
        const next = { ...prev };
        for (const field of EDIT_TAB_FIELDS[activeTab] ?? []) {
          (next as unknown as Record<string, unknown>)[field] = baseline[field];
        }
        return next;
      });
      setTabErrors((prev) => ({ ...prev, [activeTab]: '' }));
      setNameDuplicate(false);
    }
    setActiveTab(tab);
  };

  const handleNameBlur = async () => {
    const name = values.name.trim();
    if (!name || !onCheckNameExists) return;
    const exists = await onCheckNameExists(name, metabotId);
    setNameDuplicate(exists);
  };

  const handleGetOwnerMetaId = async () => {
    try {
      const result = await window.electron.userIdentity.get();
      const globalMetaId = result.success && result.identity ? (result.identity.globalmetaid ?? '').trim() : '';
      if (!globalMetaId) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotOwnerNeedUserIdentity') }));
        return;
      }
      handleChange('boss_global_metaid', globalMetaId);
    } catch {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotOwnerNeedUserIdentity') }));
    }
  };

  const availableSkillOptions = useMemo(
    () => skillOptions.filter((skill) => skill.enabled && !skill.isBuiltIn),
    [skillOptions],
  );
  const bundledSkillOptions = useMemo(
    () => skillOptions.filter((skill) => skill.enabled && skill.isBuiltIn),
    [skillOptions],
  );
  const skillNameById = useMemo(
    () => new Map(skillOptions.map((skill) => [skill.id, skill.name])),
    [skillOptions],
  );
  const normalizedAllowChatSkills = useMemo(
    () => normalizeAllowChatSkills(values.allow_chat_skills),
    [values.allow_chat_skills],
  );
  const canAddSelectedAllowChatSkill =
    Boolean(selectedAllowChatSkillId) && !normalizedAllowChatSkills.includes(selectedAllowChatSkillId);

  useEffect(() => {
    if (!selectedAllowChatSkillId) return;
    if (!availableSkillOptions.some((skill) => skill.id === selectedAllowChatSkillId)) {
      setSelectedAllowChatSkillId('');
    }
  }, [availableSkillOptions, selectedAllowChatSkillId]);

  const handleAddAllowChatSkill = () => {
    if (!canAddSelectedAllowChatSkill) return;
    handleChange('allow_chat_skills', addAllowChatSkill(values.allow_chat_skills, selectedAllowChatSkillId));
    setSelectedAllowChatSkillId('');
  };

  const handleRemoveAllowChatSkill = (skillId: string) => {
    handleChange('allow_chat_skills', removeAllowChatSkill(values.allow_chat_skills, skillId));
  };

  const handleOpenTeamRemoteCollabToggle = () => {
    if (!openTeamRemoteCollabLoaded || openTeamRemoteCollabSaving) return;
    const next = !openTeamRemoteCollab;
    setOpenTeamRemoteCollab(next);
    setOpenTeamRemoteCollabSaving(true);
    const revertWithToast = () => {
      setOpenTeamRemoteCollab(!next);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotOpenTeamRemoteCollabSaveFailed') }));
    };
    window.electron.metabot.setSetting(metabotId, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY, next ? '1' : '0')
      .then((result) => {
        if (!result.success) revertWithToast();
      })
      .catch(revertWithToast)
      .finally(() => setOpenTeamRemoteCollabSaving(false));
  };

  const makeSettingToggle = (
    key: string,
    value: boolean,
    setValue: (v: boolean) => void,
    loaded: boolean,
    saving: boolean,
    setSaving: (v: boolean) => void,
    failureToastKey: string,
  ) => () => {
    if (!loaded || saving) return;
    const next = !value;
    setValue(next);
    setSaving(true);
    const revertWithToast = () => {
      setValue(!next);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t(failureToastKey) }));
    };
    window.electron.metabot.setSetting(metabotId, key, next ? '1' : '0')
      .then((result) => {
        if (!result.success) revertWithToast();
      })
      .catch(revertWithToast)
      .finally(() => setSaving(false));
  };
  const handleCoworkMcpToolsToggle = makeSettingToggle(
    COWORK_MOUNT_MCP_TOOLS_KEY, coworkMcpTools, setCoworkMcpTools,
    coworkMcpToolsLoaded, coworkMcpToolsSaving, setCoworkMcpToolsSaving,
    'metabotCoworkMcpToolsSaveFailed',
  );
  const handleCoworkBrowserAutomationToggle = makeSettingToggle(
    COWORK_BROWSER_AUTOMATION_KEY, coworkBrowserAutomation, setCoworkBrowserAutomation,
    coworkBrowserAutomationLoaded, coworkBrowserAutomationSaving, setCoworkBrowserAutomationSaving,
    'metabotCoworkBrowserAutomationSaveFailed',
  );
  const handleCoworkComputerUseToggle = makeSettingToggle(
    COWORK_COMPUTER_USE_KEY, coworkComputerUse, setCoworkComputerUse,
    coworkComputerUseLoaded, coworkComputerUseSaving, setCoworkComputerUseSaving,
    'metabotCoworkComputerUseSaveFailed',
  );

  const handleSaveTab = async (tab: MetaBotEditTabKey) => {
    if (savingTab) return;
    if (tab === 'basic') {
      if (!values.name.trim()) {
        setTabError(tab, i18nService.t('metabotNameRequired'));
        return;
      }
      if (nameDuplicate) {
        setTabError(tab, i18nService.t('metabotNameDuplicate'));
        return;
      }
      if (onCheckNameExists) {
        const exists = await onCheckNameExists(values.name.trim(), metabotId);
        if (exists) {
          setTabError(tab, i18nService.t('metabotNameDuplicate'));
          setNameDuplicate(true);
          return;
        }
      }
    }
    let homepageForSave: string | null = null;
    if (tab === 'advanced') {
      try {
        homepageForSave = composeHomepageForSave(values);
      } catch (e) {
        setTabError(tab, e instanceof Error ? e.message : i18nService.t('metabotSaveFailed'));
        return;
      }
    }
    setSavingTab(tab);
    setTabError(tab, '');
    try {
      await onSaveTab(tab, {
        ...values,
        allow_chat_skills: normalizeAllowChatSkills(values.allow_chat_skills),
        ...(tab === 'advanced' ? { homepage: homepageForSave } : {}),
      });
      setBaseline((prev) => {
        const next = { ...prev };
        for (const field of EDIT_TAB_FIELDS[tab] ?? []) {
          (next as unknown as Record<string, unknown>)[field] = values[field];
        }
        next.allow_chat_skills = tab === 'chatSettings'
          ? normalizeAllowChatSkills(values.allow_chat_skills)
          : prev.allow_chat_skills;
        return next;
      });
    } catch (err) {
      setTabError(tab, err instanceof Error ? err.message : i18nService.t('metabotSaveFailed'));
    } finally {
      setSavingTab(null);
    }
  };

  const hasNoAvailableLlm = llmOptions.length === 0;
  const appConfig = configService.getConfig();
  const globalDefaultModel = appConfig.model?.defaultModel ?? null;
  const globalDefaultProvider = appConfig.model?.defaultProvider ?? null;
  const catalogGroups = buildModelGroupsFromConfig(appConfig);
  const resolvedGlobalDefault = resolveBrainModelInGroups(
    catalogGroups,
    globalDefaultModel,
    globalDefaultProvider,
    globalDefaultModel,
  );
  const globalDefaultDisplayName = resolvedGlobalDefault?.model.name ?? globalDefaultModel;
  const primaryFollowGlobalPlaceholder = globalDefaultDisplayName
    ? i18nService.t('metabotPrimaryLlmFollowGlobal').replace('{model}', globalDefaultDisplayName)
    : i18nService.t('metabotPrimaryLlmFollowGlobalEmpty');
  const fallbackSeedModelId = values.llm_id.trim()
    || resolvedGlobalDefault?.model.id
    || catalogGroups[0]?.models[0]?.id
    || '';
  const fallbackSeedProvider = values.llm_id.trim()
    ? values.llm_provider
    : (resolvedGlobalDefault?.providerKey ?? catalogGroups[0]?.id ?? '');
  const fallbackSeedEffort = values.llm_id.trim() ? values.llm_effort : '';
  const brainEffortOf = (value: string): LlmEffortLevel | null =>
    isLlmEffortLevel(value) ? value : null;

  const isTwin = values.metabot_type === 'twin';
  const showTwinSwitch = canShowMetabotTwinSwitch({
    metabotType: baseline.metabot_type,
    hasOtherTwin,
  });
  const twinToggleView = buildMetaBotToggleViewModel({ enabled: isTwin, disabled: false });
  const a2aAutoReplyToggleView = buildMetaBotToggleViewModel({ enabled: values.a2a_auto_reply_enabled, disabled: false });
  const openTeamRemoteCollabToggleView = buildMetaBotToggleViewModel({
    enabled: openTeamRemoteCollab,
    disabled: !openTeamRemoteCollabLoaded || openTeamRemoteCollabSaving,
  });
  const coworkMcpToolsToggleView = buildMetaBotToggleViewModel({
    enabled: coworkMcpTools,
    disabled: !coworkMcpToolsLoaded || coworkMcpToolsSaving,
  });
  const coworkBrowserAutomationToggleView = buildMetaBotToggleViewModel({
    enabled: coworkBrowserAutomation,
    disabled: !coworkBrowserAutomationLoaded || coworkBrowserAutomationSaving,
  });
  const coworkComputerUseToggleView = buildMetaBotToggleViewModel({
    enabled: coworkComputerUse,
    disabled: !coworkComputerUseLoaded || coworkComputerUseSaving,
  });

  const renderPanelError = (tab: MetaBotEditTabKey) => {
    const message = tabErrors[tab];
    if (!message) return null;
    return (
      <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-[8px] px-3.5 py-2.5">
        {message}
      </div>
    );
  };

  const renderPanelSaveRow = (tab: MetaBotEditTabKey) => (
    <div className="flex items-center justify-end gap-2 pt-1">
      <button
        type="button"
        onClick={onCancel}
        disabled={savingTab !== null}
        className={`${METABOT_BTN_FLAT_CLASS} !h-[34px] !px-3.5 !rounded-[8px]`}
      >
        {i18nService.t('cancel')}
      </button>
      <button
        type="button"
        data-slot={`metabot-edit-save-${tab}`}
        onClick={() => void handleSaveTab(tab)}
        disabled={savingTab !== null}
        className={METABOT_BTN_PRIMARY_CLASS}
      >
        {savingTab === tab ? i18nService.t('saving') : i18nService.t('metabotSaveAndSyncChain')}
      </button>
    </div>
  );

  const ownerMetaIdTrimmed = values.boss_global_metaid.trim();

  return (
    <div className="space-y-5">
      {/* Studio Linear Header Card + Underline Tab Bar */}
      <div className="rounded-[10px] border border-slate-900/[0.095] dark:border-white/[0.085] bg-white dark:bg-[#182538] px-4 pt-3.5 pb-0">
        {headerSlot}
        <div
          className="flex items-center gap-5 overflow-x-auto border-t border-slate-900/[0.06] dark:border-white/[0.06] pt-0.5"
          role="tablist"
        >
          {EDIT_TAB_ORDER.map((tab) => {
            const isActive = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-slot={`metabot-edit-tab-${tab}`}
                onClick={() => handleTabClick(tab)}
                className={`relative py-2.5 px-0.5 text-[13px] whitespace-nowrap transition-colors ${
                  isActive
                    ? 'font-bold text-[#181d25] dark:text-[#f3f5f8]'
                    : 'font-semibold text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                }`}
              >
                <span>{i18nService.t(EDIT_TAB_LABEL_KEYS[tab])}</span>
                {isTabDirty(tab) ? <span className="ml-1 text-claude-accent">•</span> : null}
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-[-1px] h-[2px] rounded-full bg-claude-accent"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. Basic tab: Public Profile + Seat/Owner + Language Model Brain */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-basic"
        className={`space-y-5 ${activeTab === 'basic' ? '' : 'hidden'}`}
      >
        {renderPanelError('basic')}

        {/* Group 1: Public Profile */}
        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupPublicProfile')}</span>
            <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupPublicProfileNote')}</span>
          </div>
          <div className={METABOT_GROUP_BOX_CLASS}>
            {/* Avatar Row */}
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-12 h-12 shrink-0">
                  <NftAvatarFrame
                    avatar={values.avatar}
                    fallbackSource={values.avatar === metabot?.avatar ? metabot?.avatar_fallback : null}
                    frameClassName="w-12 h-12 rounded-[10px] ring-1 ring-black/[0.08] dark:ring-white/[0.1]"
                    fallback={(
                      <div className="w-12 h-12 rounded-[10px] bg-[#eef1f5] dark:bg-white/[0.05] ring-1 ring-black/[0.08] dark:ring-white/[0.1] overflow-hidden flex items-center justify-center">
                        <PhotoIcon className="h-6 w-6 text-[#5a6577] dark:text-[#94a3b8]" />
                      </div>
                    )}
                  />
                </div>
                <div className="min-w-0">
                  <div className={METABOT_ROW_TITLE_CLASS}>{i18nService.t('metabotAvatar')}</div>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotAvatarPlaceholder')}</p>
                  {parseNftAvatarReference(values.avatar) && (
                    <p className="mt-0.5 text-[11px] text-[#8c96a6] dark:text-[#64748b]">
                      {i18nService.t('metabotNftAvatarSyncHint')}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-slot="metabot-avatar-set"
                  onClick={() => setAvatarPickerOpen(true)}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  {i18nService.t('metabotAvatarSet')}
                </button>
                {values.avatar && (
                  <button
                    type="button"
                    onClick={() => handleChange('avatar', '')}
                    className="text-xs font-semibold text-red-600 dark:text-rose-400 hover:underline px-1"
                  >
                    {i18nService.t('metabotAvatarClear')}
                  </button>
                )}
              </div>
            </div>

            {/* Name Row */}
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <UserIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-name" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotName')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotNameHint')}</p>
                </div>
              </div>
              <div className="w-full sm:max-w-[420px]">
                <input
                  id="metabot-name"
                  type="text"
                  value={values.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  onBlur={handleNameBlur}
                  placeholder={i18nService.t('metabotNamePlaceholder')}
                  className={`${METABOT_CLEAN_INPUT_CLASS} ${nameDuplicate ? '!border-red-500' : ''}`}
                />
                {nameDuplicate && (
                  <p className="text-xs text-red-500 mt-1">
                    {i18nService.t('metabotNameDuplicate')}
                  </p>
                )}
              </div>
            </div>

            {/* Bio Row */}
            <div className={METABOT_GROUP_ROW_TOP_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <DocumentTextIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-bio" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotBio')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotBioHint')}</p>
                </div>
              </div>
              <div className="w-full sm:max-w-[420px]">
                <textarea
                  id="metabot-bio"
                  value={values.bio}
                  onChange={(e) => handleChange('bio', e.target.value)}
                  placeholder={i18nService.t('metabotBioPlaceholder')}
                  rows={2}
                  className={`${METABOT_CLEAN_INPUT_CLASS} resize-y leading-relaxed`}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Group 2: Seat & Ownership */}
        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupSeatAndOwner')}</span>
          </div>
          <div className={METABOT_GROUP_BOX_CLASS}>
            {showTwinSwitch && (
              <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-twin-switch-row">
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <StarIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                  <div>
                    <label id="metabot-twin-switch-label" className={METABOT_ROW_TITLE_CLASS}>
                      {i18nService.t('metabotTwinSwitchLabel')}
                    </label>
                    <p className={METABOT_ROW_HINT_CLASS}>
                      {isTwin ? i18nService.t('metabotTwinSwitchHintCurrent') : i18nService.t('metabotTwinSwitchHint')}
                    </p>
                  </div>
                </div>
                <div
                  role="switch"
                  aria-checked={isTwin}
                  aria-labelledby="metabot-twin-switch-label"
                  data-slot="metabot-twin-switch"
                  title={isTwin ? i18nService.t('metabotTwinSwitchHintCurrent') : i18nService.t('metabotTwinSwitchHint')}
                  className={twinToggleView.trackClass}
                  onClick={() => {
                    if (isTwin) {
                      setTwinDemoteConfirmOpen(true);
                      return;
                    }
                    handleChange('metabot_type', 'twin');
                  }}
                >
                  <div className={twinToggleView.knobClass} />
                </div>
              </div>
            )}

            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <LinkIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div className="min-w-0 flex-1">
                  <label htmlFor="metabot-boss-metaid" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotBossMetaId')}
                  </label>
                  <input
                    id="metabot-boss-metaid"
                    type="text"
                    value={values.boss_global_metaid}
                    readOnly
                    className="sr-only"
                    tabIndex={-1}
                  />
                  {ownerMetaIdTrimmed ? (
                    <p className={METABOT_ROW_HINT_CLASS}>
                      <span
                        className={
                          ownerBindingPinId
                            ? 'font-semibold text-[#0f9d68] dark:text-[#34d399]'
                            : 'font-semibold text-amber-600 dark:text-amber-400'
                        }
                      >
                        {ownerBindingPinId ? `✓ ${i18nService.t('metabotOwnerSigned')}` : i18nService.t('metabotOwnerUnsigned')}
                      </span>
                      {' · '}
                      <span className="font-mono tabular-nums" title={ownerMetaIdTrimmed}>
                        {formatGlobalMetaIdShort(ownerMetaIdTrimmed)}
                      </span>
                    </p>
                  ) : (
                    <p className={METABOT_ROW_HINT_CLASS}>
                      {i18nService.t('metabotBossMetaIdHint')}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => { void handleGetOwnerMetaId(); }}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  {i18nService.t('metabotGetOwnerMetaId')}
                </button>
                {ownerMetaIdTrimmed && (
                  <button
                    type="button"
                    onClick={() => handleChange('boss_global_metaid', '')}
                    className="text-xs font-semibold text-red-600 dark:text-rose-400 hover:underline px-1"
                  >
                    {i18nService.t('metabotClearOwner')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Group 3: Language Model Brain */}
        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupBrain')}</span>
            <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupBrainNote')}</span>
          </div>
          <div className={METABOT_GROUP_BOX_CLASS}>
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <CpuChipIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-llm" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotLlmProvider')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotPrimaryLlmHint')}</p>
                </div>
              </div>

              <div className="w-full sm:max-w-[420px] flex items-center sm:justify-end gap-2">
                {hasNoAvailableLlm ? (
                  <div className="w-full rounded-[8px] border border-slate-900/[0.095] dark:border-white/[0.09] px-3 py-2.5 bg-[#f8fafc] dark:bg-[#131d2c]">
                    <p className="text-xs text-[#5a6577] dark:text-[#94a3b8]">
                      {i18nService.t('metabotNoAvailableLlm')}
                    </p>
                    {onRequestModelSettings && (
                      <button
                        type="button"
                        onClick={onRequestModelSettings}
                        className="mt-1.5 text-xs font-semibold text-claude-accent hover:underline"
                      >
                        {i18nService.t('metabotGoToModelSettings')}
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <ModelEffortPicker
                        id="metabot-llm"
                        variant="field"
                        value={{
                          modelId: values.llm_id || null,
                          providerKey: values.llm_provider || null,
                          effort: brainEffortOf(values.llm_effort),
                        }}
                        onChange={(selection) => {
                          handleChange('llm_id', selection.modelId ?? '');
                          handleChange('llm_provider', selection.providerKey ?? '');
                          handleChange('llm_effort', selection.effort ?? '');
                        }}
                        placeholder={primaryFollowGlobalPlaceholder}
                        globalDefaultModel={globalDefaultModel}
                        onManageModels={onRequestModelSettings}
                      />
                    </div>
                    {values.llm_id.trim() && (
                      <button
                        type="button"
                        data-slot="metabot-clear-primary-llm"
                        onClick={() => {
                          handleChange('llm_id', '');
                          handleChange('llm_provider', '');
                          handleChange('llm_effort', '');
                        }}
                        className={METABOT_BTN_FLAT_CLASS}
                      >
                        {i18nService.t('metabotPrimaryLlmFollowGlobalAction')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {!hasNoAvailableLlm && (
              <div className={METABOT_GROUP_ROW_CLASS}>
                <div className="flex items-start gap-2.5 min-w-[180px]">
                  <ShieldCheckIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                  <div>
                    <label htmlFor="metabot-fallback-llm" className={METABOT_ROW_TITLE_CLASS}>
                      {i18nService.t('metabotFallbackLlmLabel')}
                    </label>
                    <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotFallbackLlmHint')}</p>
                  </div>
                </div>

                <div className="w-full sm:max-w-[420px] flex items-center sm:justify-end gap-2">
                  {values.fallback_llm_id.trim() ? (
                    <>
                      <div className="flex-1 min-w-0">
                        <ModelEffortPicker
                          id="metabot-fallback-llm"
                          variant="field"
                          value={{
                            modelId: values.fallback_llm_id || null,
                            providerKey: values.fallback_llm_provider || null,
                            effort: brainEffortOf(values.fallback_llm_effort),
                          }}
                          onChange={(selection) => {
                            handleChange('fallback_llm_id', selection.modelId ?? '');
                            handleChange('fallback_llm_provider', selection.providerKey ?? '');
                            handleChange('fallback_llm_effort', selection.effort ?? '');
                          }}
                          globalDefaultModel={globalDefaultModel}
                          onManageModels={onRequestModelSettings}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          handleChange('fallback_llm_id', '');
                          handleChange('fallback_llm_provider', '');
                          handleChange('fallback_llm_effort', '');
                        }}
                        className="text-xs font-semibold text-red-600 dark:text-rose-400 hover:underline px-1 shrink-0"
                      >
                        {i18nService.t('metabotClearOwner')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      id="metabot-fallback-llm"
                      onClick={() => {
                        handleChange('fallback_llm_id', fallbackSeedModelId);
                        handleChange('fallback_llm_provider', fallbackSeedProvider);
                        handleChange('fallback_llm_effort', fallbackSeedEffort);
                      }}
                      disabled={!fallbackSeedModelId}
                      className={METABOT_BTN_FLAT_CLASS}
                    >
                      {i18nService.t('metabotFallbackLlmSetup')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {renderPanelSaveRow('basic')}
      </div>

      {/* 2. Persona tab: Role / Soul / Goal */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-persona"
        className={`space-y-5 ${activeTab === 'persona' ? '' : 'hidden'}`}
      >
        {renderPanelError('persona')}

        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupPersona')}</span>
            <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotPersonaOptionalHint')}</span>
          </div>

          <div className={METABOT_GROUP_BOX_CLASS}>
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <IdentificationIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-role" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotRole')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotRoleHint')}</p>
                </div>
              </div>
              <div className="w-full sm:max-w-[420px]">
                <input
                  id="metabot-role"
                  type="text"
                  value={values.role}
                  onChange={(e) => handleChange('role', e.target.value)}
                  placeholder={i18nService.t('metabotRolePlaceholder')}
                  className={METABOT_CLEAN_INPUT_CLASS}
                />
              </div>
            </div>

            <div className={METABOT_GROUP_ROW_TOP_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <HeartIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-soul" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotSoul')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotSoulHint')}</p>
                </div>
              </div>
              <div className="w-full sm:max-w-[420px]">
                <textarea
                  id="metabot-soul"
                  value={values.soul}
                  onChange={(e) => handleChange('soul', e.target.value)}
                  placeholder={i18nService.t('metabotSoulPlaceholder')}
                  rows={4}
                  className={`${METABOT_CLEAN_INPUT_CLASS} resize-y leading-relaxed`}
                />
              </div>
            </div>

            <div className={METABOT_GROUP_ROW_TOP_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <FlagIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-goal" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotGoal')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotGoalHint')}</p>
                </div>
              </div>
              <div className="w-full sm:max-w-[420px]">
                <textarea
                  id="metabot-goal"
                  value={values.goal}
                  onChange={(e) => handleChange('goal', e.target.value)}
                  placeholder={i18nService.t('metabotGoalPlaceholder')}
                  rows={2}
                  className={`${METABOT_CLEAN_INPUT_CLASS} resize-y leading-relaxed`}
                />
              </div>
            </div>
          </div>
        </div>

        {renderPanelSaveRow('persona')}
      </div>

      {/* 3. Chat Settings tab: Response & Collab / Session Limits / Skill Permissions */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-chatSettings"
        className={`space-y-5 ${activeTab === 'chatSettings' ? '' : 'hidden'}`}
      >
        {renderPanelError('chatSettings')}

        {/* Group 1: Chat & Collaboration */}
        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupResponseCollab')}</span>
          </div>
          <div className={METABOT_GROUP_BOX_CLASS}>
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <ChatBubbleLeftRightIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label id="metabot-a2a-auto-reply-label" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotA2aAutoReply')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotA2aAutoReplyHint')}</p>
                </div>
              </div>
              <div
                role="switch"
                aria-checked={values.a2a_auto_reply_enabled}
                aria-labelledby="metabot-a2a-auto-reply-label"
                data-slot="metabot-a2a-auto-reply-switch"
                title={i18nService.t('metabotA2aAutoReplyHint')}
                className={a2aAutoReplyToggleView.trackClass}
                onClick={() => handleChange('a2a_auto_reply_enabled', !values.a2a_auto_reply_enabled)}
              >
                <div className={a2aAutoReplyToggleView.knobClass} />
              </div>
            </div>

            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <UserGroupIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label id="metabot-openteam-remote-collab-label" className={METABOT_ROW_TITLE_CLASS}>
                    <span>{i18nService.t('metabotOpenTeamRemoteCollab')}</span>
                    <span className={METABOT_MICRO_BADGE_CLASS}>{i18nService.t('metabotBadgeImmediate')}</span>
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotOpenTeamRemoteCollabHint')}</p>
                </div>
              </div>
              <div
                role="switch"
                aria-checked={openTeamRemoteCollab}
                aria-labelledby="metabot-openteam-remote-collab-label"
                data-slot="metabot-openteam-remote-collab-switch"
                title={i18nService.t('metabotOpenTeamRemoteCollabHint')}
                className={openTeamRemoteCollabToggleView.trackClass}
                onClick={handleOpenTeamRemoteCollabToggle}
              >
                <div className={openTeamRemoteCollabToggleView.knobClass} />
              </div>
            </div>
          </div>
        </div>

        {/* Group 2: A2A Session Throttling */}
        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupThrottle')}</span>
            <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupThrottleNote')}</span>
          </div>
          <div className={METABOT_GROUP_BOX_CLASS}>
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <ChartBarIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-a2a-max-turns" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotA2aMaxTurns')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotA2aMaxTurnsHint')}</p>
                </div>
              </div>
              <select
                id="metabot-a2a-max-turns"
                value={values.a2a_max_incoming_turns}
                onChange={(e) => handleChange('a2a_max_incoming_turns', normalizeA2AMaxIncomingTurnsOption(e.target.value))}
                className={`${METABOT_COMPACT_SELECT_CLASS} tabular-nums shrink-0`}
              >
                {A2A_MAX_INCOMING_TURNS_OPTIONS.map((turns) => (
                  <option key={turns} value={turns}>
                    {turns}
                  </option>
                ))}
              </select>
            </div>

            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <ClockIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-a2a-bye-cooldown" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotA2aByeCooldown')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotA2aByeCooldownHint')}</p>
                </div>
              </div>
              <select
                id="metabot-a2a-bye-cooldown"
                value={values.a2a_bye_cooldown_ms}
                onChange={(e) => handleChange('a2a_bye_cooldown_ms', normalizeA2AByeCooldownMsOption(e.target.value))}
                className={`${METABOT_COMPACT_SELECT_CLASS} tabular-nums shrink-0`}
              >
                {A2A_BYE_COOLDOWN_MS_OPTIONS.map((cooldownMs) => (
                  <option key={cooldownMs} value={cooldownMs}>
                    {`${cooldownMs / 60_000} ${i18nService.t('metabotA2aByeCooldownMinutes')}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Group 3: Skill Permissions */}
        <div>
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupSkills')}</span>
            <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupSkillsNote')}</span>
          </div>
          <div className={METABOT_GROUP_BOX_CLASS}>
            <div className="px-4 py-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <SparklesIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                  <div>
                    <label htmlFor="metabot-allow-chat-skills" className={METABOT_ROW_TITLE_CLASS}>
                      {i18nService.t('metabotAllowChatSkills')}
                    </label>
                    <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotAllowChatSkillsHint')}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <select
                    id="metabot-allow-chat-skills"
                    value={selectedAllowChatSkillId}
                    onChange={(e) => setSelectedAllowChatSkillId(e.target.value)}
                    className={`${METABOT_COMPACT_SELECT_CLASS} max-w-[220px]`}
                    disabled={availableSkillOptions.length === 0}
                  >
                    <option value="">{i18nService.t('metabotAllowChatSkillsPlaceholder')}</option>
                    {availableSkillOptions.map((skill) => (
                      <option key={skill.id} value={skill.id}>
                        {skill.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleAddAllowChatSkill}
                    disabled={!canAddSelectedAllowChatSkill}
                    className={METABOT_BTN_FLAT_CLASS}
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span>{i18nService.t('metabotAdd')}</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 sm:pl-[28px]">
                {normalizedAllowChatSkills.length > 0 ? (
                  normalizedAllowChatSkills.map((skillId) => (
                    <span
                      key={skillId}
                      className="inline-flex max-w-full items-center gap-1 rounded-[6px] border border-slate-900/[0.095] dark:border-white/[0.09] bg-[#eef1f5] dark:bg-white/[0.05] pl-2.5 pr-1.5 py-1 text-[12px] font-semibold text-[#181d25] dark:text-[#f3f5f8]"
                    >
                      <span className="max-w-[12rem] truncate" title={skillId}>
                        {skillNameById.get(skillId) || skillId}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveAllowChatSkill(skillId)}
                        className="inline-flex h-4 w-4 items-center justify-center rounded text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] hover:bg-black/5 dark:hover:bg-white/10"
                        aria-label={i18nService.t('metabotDelete')}
                        title={i18nService.t('metabotDelete')}
                      >
                        <XMarkIcon className="h-3 w-3" />
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="text-[12px] text-[#8c96a6] dark:text-[#64748b]">
                    {i18nService.t('metabotAllowChatSkillsDefault')}
                  </span>
                )}
              </div>

              {availableSkillOptions.length === 0 && (
                <p className="text-[11.5px] text-amber-600 dark:text-amber-400 sm:pl-[28px]">
                  {i18nService.t('metabotNoAvailableSkills')}
                </p>
              )}
            </div>

            {bundledSkillOptions.length > 0 && (
              <div className="px-4 py-3" data-slot="metabot-bundled-skills">
                <details className="group">
                  <summary className="cursor-pointer list-none select-none flex items-center justify-between gap-2 text-[12.5px] font-semibold text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]">
                    <span className="inline-flex items-center gap-2.5">
                      <Squares2X2Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                      <span>
                        {i18nService.t('metabotBundledSkillsSummary').replace('{count}', String(bundledSkillOptions.length))}
                      </span>
                    </span>
                    <span className="text-[11.5px] text-[#8c96a6] dark:text-[#64748b] group-open:rotate-180 transition-transform">▾</span>
                  </summary>
                  <div className="mt-2.5 flex flex-wrap gap-1.5 sm:pl-[28px]" data-slot="metabot-bundled-skills-list">
                    {bundledSkillOptions.map((skill) => (
                      <span
                        key={skill.id}
                        title={skill.id}
                        className="inline-flex max-w-full items-center rounded-[5px] bg-[#eef1f5] dark:bg-white/[0.05] px-2 py-0.5 text-[11px] text-[#5a6577] dark:text-[#94a3b8]"
                      >
                        <span className="max-w-[11rem] truncate">{skill.name}</span>
                      </span>
                    ))}
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>

        {renderPanelSaveRow('chatSettings')}
      </div>

      {/* 4. Knowledge Base tab */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-knowledgeBase"
        className={`space-y-5 ${activeTab === 'knowledgeBase' ? '' : 'hidden'}`}
      >
        <KnowledgeBasePanel metabotId={metabotId} />
      </div>

      {/* 5. Surf tab */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-surf"
        className={`space-y-5 ${activeTab === 'surf' ? '' : 'hidden'}`}
      >
        <SurfSection metabotId={metabotId} metabotType={baseline.metabot_type} />
      </div>

      {/* 6. Advanced tab: Homepage / Capabilities & Daily Briefing / Assets & Security */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-advanced"
        className={`space-y-5 ${activeTab === 'advanced' ? '' : 'hidden'}`}
      >
        {renderPanelError('advanced')}

        <MetaBotHomepageSection
          values={values}
          onChange={(field, value) => handleChange(field, value)}
          metabotId={metabotId}
          onOpenDefaultHomepage={onOpenDefaultHomepage}
          onPreviewMetaAppHomepage={onPreviewMetaAppHomepage}
          onRequestMetaApps={onRequestMetaApps}
          saveAction={(
            <button
              type="button"
              data-slot="metabot-edit-save-advanced"
              onClick={() => void handleSaveTab('advanced')}
              disabled={savingTab !== null}
              className={`${METABOT_BTN_PRIMARY_CLASS} !h-8 !px-3 !rounded-[7px] !text-[12px]`}
            >
              {savingTab === 'advanced' ? i18nService.t('saving') : i18nService.t('metabotSaveHomepageChain')}
            </button>
          )}
        />

        {/* Group 2: Cowork Capabilities + Twin Daily Briefing */}
        <div data-slot="metabot-cowork-capabilities-section">
          <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupCapabilities')}</span>
            <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupImmediateNote')}</span>
          </div>

          <div className={METABOT_GROUP_BOX_CLASS}>
            {/* MCP Tools */}
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <WrenchScrewdriverIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div className="min-w-0">
                  <label id="metabot-cowork-mcp-tools-label" className={METABOT_ROW_TITLE_CLASS}>
                    <span>{i18nService.t('metabotCoworkMcpTools')}</span>
                    <Tooltip content={i18nService.t('metabotCoworkMcpToolsTooltip')}>
                      <QuestionMarkCircleIcon
                        className="h-3.5 w-3.5 cursor-help text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] transition-colors"
                        aria-label={i18nService.t('metabotCoworkMcpToolsTooltip')}
                      />
                    </Tooltip>
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotCoworkMcpToolsHint')}</p>
                </div>
              </div>
              <div
                role="switch"
                aria-checked={coworkMcpTools}
                aria-labelledby="metabot-cowork-mcp-tools-label"
                data-slot="metabot-cowork-mcp-tools-switch"
                title={i18nService.t('metabotCoworkMcpToolsTooltip')}
                className={coworkMcpToolsToggleView.trackClass}
                onClick={handleCoworkMcpToolsToggle}
              >
                <div className={coworkMcpToolsToggleView.knobClass} />
              </div>
            </div>

            {/* Browser Automation */}
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <GlobeAltIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div className="min-w-0">
                  <label id="metabot-cowork-browser-automation-label" className={METABOT_ROW_TITLE_CLASS}>
                    <span>{i18nService.t('metabotCoworkBrowserAutomation')}</span>
                    <span className={METABOT_MICRO_BADGE_CLASS}>{i18nService.t('metabotBadgeExperimentalShort')}</span>
                    <Tooltip content={i18nService.t('metabotCoworkBrowserAutomationTooltip')}>
                      <QuestionMarkCircleIcon
                        className="h-3.5 w-3.5 cursor-help text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] transition-colors"
                        aria-label={i18nService.t('metabotCoworkBrowserAutomationTooltip')}
                      />
                    </Tooltip>
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotCoworkBrowserAutomationHint')}</p>
                </div>
              </div>
              <div
                role="switch"
                aria-checked={coworkBrowserAutomation}
                aria-labelledby="metabot-cowork-browser-automation-label"
                data-slot="metabot-cowork-browser-automation-switch"
                title={i18nService.t('metabotCoworkBrowserAutomationTooltip')}
                className={coworkBrowserAutomationToggleView.trackClass}
                onClick={handleCoworkBrowserAutomationToggle}
              >
                <div className={coworkBrowserAutomationToggleView.knobClass} />
              </div>
            </div>

            {/* Desktop Computer Use */}
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <ComputerDesktopIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div className="min-w-0">
                  <label id="metabot-cowork-computer-use-label" className={METABOT_ROW_TITLE_CLASS}>
                    <span>{i18nService.t('metabotCoworkComputerUse')}</span>
                    <span className={METABOT_MICRO_BADGE_CLASS}>{i18nService.t('metabotBadgeExperimentalShort')}</span>
                    <Tooltip content={i18nService.t('metabotCoworkComputerUseTooltip')}>
                      <QuestionMarkCircleIcon
                        className="h-3.5 w-3.5 cursor-help text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] transition-colors"
                        aria-label={i18nService.t('metabotCoworkComputerUseTooltip')}
                      />
                    </Tooltip>
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotCoworkComputerUseHint')}</p>
                </div>
              </div>
              <div
                role="switch"
                aria-checked={coworkComputerUse}
                aria-labelledby="metabot-cowork-computer-use-label"
                data-slot="metabot-cowork-computer-use-switch"
                title={i18nService.t('metabotCoworkComputerUseTooltip')}
                className={coworkComputerUseToggleView.trackClass}
                onClick={handleCoworkComputerUseToggle}
              >
                <div className={coworkComputerUseToggleView.knobClass} />
              </div>
            </div>

            {/* Daily Report (Twin-only) */}
            {isTwin && (
              <div data-slot="metabot-daily-report-panel">
                <DailyReportSection metabotId={metabotId} />
              </div>
            )}
          </div>
        </div>

        {/* Group 3: Wallet / NFT / Backup / Delete */}
        {metabot && onDelete && (
          <MetaBotAdvancedActionsSection metabot={metabot} onDelete={onDelete} />
        )}
      </div>

      {showTwinSwitch && twinDemoteConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          data-slot="metabot-twin-demote-confirm"
        >
          <div
            className="absolute inset-0 bg-black/50 dark:bg-black/60"
            onClick={() => setTwinDemoteConfirmOpen(false)}
            role="presentation"
          />
          <div className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
            <div className="px-6 py-6">
              <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('metabotTwinDemoteConfirmTitle')}
              </h2>
              <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metabotTwinDemoteConfirm')}
              </p>
              <div className="mt-6 flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setTwinDemoteConfirmOpen(false)}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  data-slot="metabot-twin-demote-confirm-action"
                  onClick={() => {
                    handleChange('metabot_type', 'worker');
                    setTwinDemoteConfirmOpen(false);
                  }}
                  className={METABOT_BTN_PRIMARY_CLASS}
                >
                  {i18nService.t('metabotTwinDemoteConfirmAction')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {avatarPickerOpen && (
        <AvatarPickerModal
          ownerAddress={metabot?.mvc_address ?? ''}
          ownerGlobalMetaId={metabot?.globalmetaid}
          currentReference={values.avatar}
          loadNfts={loadAvatarNfts}
          maxLocalBytes={AVATAR_MAX_SIZE_BYTES}
          onPick={(reference) => {
            handleChange('avatar', reference);
            setAvatarPickerOpen(false);
          }}
          onPickLocal={(dataUrl) => {
            handleChange('avatar', dataUrl);
            setAvatarPickerOpen(false);
          }}
          onError={(message) => {
            setTabError('basic', message);
            window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
          }}
          onClose={() => setAvatarPickerOpen(false)}
        />
      )}
    </div>
  );
};

export default MetaBotEditTabs;
