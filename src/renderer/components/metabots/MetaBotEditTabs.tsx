/**
 * Tabbed MetaBot edit form (replaces the old single-page MetaBotForm edit mode).
 *
 * Six tabs — Basic / Persona / Chat Settings / Knowledge Base / Surf /
 * Advanced. The four profile tabs each have their own save button, per-tab
 * dirty tracking and per-tab on-chain sync grouping, so a user can iterate on
 * one slice of the profile without publishing unrelated edits. The Knowledge
 * Base and Surf tabs are different: Knowledge Base manages the bot's document
 * corpora through the knowledgeBase:* IPC surface, and Surf hosts the
 * immediate-effect MetaWeb surf switches plus the surf reports panel, so
 * neither owns MetaBotEditValues fields, dirty tracking nor on-chain sync
 * (deliberately absent from EDIT_TAB_FIELDS / EDIT_TAB_SYNC_GROUPS). All
 * panels stay mounted (inactive
 * ones are CSS-hidden) so unsaved edits in other tabs survive tab switches;
 * switching away from a dirty tab asks for confirmation and reverts that tab's
 * fields on confirm.
 *
 * Field state is a single MetaBotEditValues object plus a `baseline` snapshot
 * of the last saved/loaded values; dirty = tab fields differ from baseline.
 * After a tab saves successfully the baseline adopts that tab's fields only,
 * keeping unsaved edits in the other tabs intact.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PhotoIcon, PlusIcon, QuestionMarkCircleIcon, WrenchScrewdriverIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { isLlmEffortLevel, type LlmEffortLevel } from '../../services/modelCatalog';
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
import BuiltinAvatarPickerModal from './BuiltinAvatarPickerModal';
import NftAvatarFrame from './NftAvatarFrame';
import { parseNftAvatarReference } from './nftAvatarPresentation.js';
import KnowledgeBasePanel from './KnowledgeBasePanel';
import SurfSection from './SurfSection';
import DailyReportSection from './DailyReportSection';
import { buildMetaBotToggleViewModel, canShowMetabotTwinSwitch } from './metaBotCardPresentation.js';
import Tooltip from '../ui/Tooltip';

const AVATAR_MAX_SIZE_BYTES = 200 * 1024; // 200KB

// A2A private-chat limits; keep in sync with src/main/services/a2aChatLimits.ts
// (pinned by tests/quotaRendererSync.test.mjs — the quota audit 2026-09-17
// raised the main default and this copy lagged, silently downgrading every
// edited bot back to the old cap).
const A2A_MAX_INCOMING_TURNS_OPTIONS: readonly number[] = [20, 30, 50, 80, 100, 150, 200];
const A2A_BYE_COOLDOWN_MS_OPTIONS: readonly number[] = [60_000, 300_000, 600_000, 1_800_000, 3_600_000];
const DEFAULT_A2A_MAX_INCOMING_TURNS = 50;
const DEFAULT_A2A_BYE_COOLDOWN_MS = 300_000;
// Pinned to src/main/services/a2aChatLimits.ts by tests/quotaRendererSync.test.mjs.
export const DEFAULT_A2A_AUTO_REPLY_ENABLED = true;

export const normalizeA2AMaxIncomingTurnsOption = (value: unknown): number =>
  A2A_MAX_INCOMING_TURNS_OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_A2A_MAX_INCOMING_TURNS;
export const normalizeA2AByeCooldownMsOption = (value: unknown): number =>
  A2A_BYE_COOLDOWN_MS_OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_A2A_BYE_COOLDOWN_MS;
// NULL/undefined means "use default" (on); accepts booleans and the 1/0 integer form.
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
  /** Primary brain: model id (legacy provider-key values still resolve at call time). */
  llm_id: string;
  /** Provider key the primary brain model was picked from; '' = unset. */
  llm_provider: string;
  /** Primary brain reasoning effort (off/low/high/max); '' = model default. */
  llm_effort: string;
  /** First-class edit field (Basic tab); empty string means "no fallback". */
  fallback_llm_id: string;
  fallback_llm_provider: string;
  /** Fallback brain reasoning effort; '' = model default. */
  fallback_llm_effort: string;
  allow_chat_skills: string[];
  /** Max incoming turns per active A2A private-chat session before forcing "bye". */
  a2a_max_incoming_turns: number;
  /** Cooldown after an auto-bye before the A2A conversation may reopen. */
  a2a_bye_cooldown_ms: number;
  /** Whether this bot auto-replies in A2A private chats. */
  a2a_auto_reply_enabled: boolean;
  homepage_source: 'default' | 'metafile' | 'metaapp';
  homepage_metafile_uri: string;
  homepage_metafile_content_type: string;
  homepage_metaapp_pin: string;
  /** DB homepage JSON at form open (for diff in the parent save pipeline). */
  homepage_initial: string | null;
  /** Composed final homepage JSON string (or null) set on Advanced-tab save. */
  homepage?: string | null;
}

export interface LlmOption {
  id: string;
  label: string;
}

export type MetaBotEditTabKey = 'basic' | 'persona' | 'chatSettings' | 'knowledgeBase' | 'surf' | 'advanced';

/** Editable fields owned by each tab; drives dirty tracking and save scoping. */
// 'knowledgeBase' and 'surf' are deliberately absent: Knowledge Base manages
// the bot's document corpora via the knowledgeBase:* IPC surface and Surf
// hosts the immediate-effect metabot_settings surf switches, so neither owns
// MetaBotEditValues fields nor needs dirty tracking.
export const EDIT_TAB_FIELDS: Partial<Record<MetaBotEditTabKey, readonly (keyof MetaBotEditValues)[]>> = {
  basic: ['name', 'avatar', 'bio', 'metabot_type', 'boss_global_metaid', 'llm_id', 'llm_provider', 'llm_effort', 'fallback_llm_id', 'fallback_llm_provider', 'fallback_llm_effort'],
  persona: ['role', 'soul', 'goal'],
  chatSettings: ['allow_chat_skills', 'a2a_max_incoming_turns', 'a2a_bye_cooldown_ms', 'a2a_auto_reply_enabled'],
  advanced: ['homepage_source', 'homepage_metafile_uri', 'homepage_metafile_content_type', 'homepage_metaapp_pin'],
};

// metabot_type is deliberately absent from EDIT_TAB_SYNC_GROUPS: the Twin/Worker
// role is a local-only setting and is never published on-chain.
// 'knowledgeBase' and 'surf' are likewise absent: nothing in those panels
// syncs on-chain on save.
/** On-chain sync step groups each tab is allowed to publish on save. */
export const EDIT_TAB_SYNC_GROUPS: Partial<Record<MetaBotEditTabKey, readonly SyncStepKey[]>> = {
  basic: ['name', 'avatar', 'bio', 'owner', 'llm'],
  persona: ['persona'],
  chatSettings: ['chatSkills'],
  advanced: ['homepage'],
};

const EDIT_TAB_ORDER: readonly MetaBotEditTabKey[] = ['basic', 'persona', 'chatSettings', 'knowledgeBase', 'surf', 'advanced'];

const EDIT_TAB_LABEL_KEYS: Record<MetaBotEditTabKey, 'metabotTabBasic' | 'metabotTabPersona' | 'metabotTabDirectives' | 'metabotTabChatSettings' | 'metabotTabKnowledgeBase' | 'metabotTabSurf' | 'metabotTabAdvanced'> = {
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
  initialValues?: Partial<MetaBotEditValues> | null;
  /** Metabot being edited; also used for name-check exclusion and homepage upload. */
  metabotId: number;
  onCancel: () => void;
  /** Save one tab. Receives the full values object; the parent scopes persistence and chain sync to the tab. */
  onSaveTab: (tab: MetaBotEditTabKey, values: MetaBotEditValues) => Promise<void>;
  /** Available LLM providers for selection. Multiple MetaBots may share the same LLM. Empty = none available. */
  llmOptions: LlmOption[];
  /** Available local skills for private-chat allowlist selection. */
  skillOptions: Skill[];
  /** Called when user clicks "Go to Model Settings" (e.g. to open Settings tab). */
  onRequestModelSettings?: () => void;
  /** Check if name already exists (for uniqueness). Returns true if duplicate. */
  onCheckNameExists?: (name: string, excludeId?: number) => Promise<boolean>;
  /** True when some other bot already holds the Twin role (not the one being edited). */
  hasOtherTwin?: boolean;
  /** Signed /info/owner binding pin id of the bot being edited. */
  ownerBindingPinId?: string | null;
  /** Open the current Bot's default template homepage in Bot Browser. */
  onOpenDefaultHomepage?: () => void;
  /** Open a MetaApp homepage preview by its pin id (best-effort; browser may fail to resolve). */
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  /** Open the MetaApps surface so the user can publish a MetaApp for this Bot. */
  onRequestMetaApps?: () => void;
  /**
   * Full Metabot row for the Advanced-tab Wallet / Backup / Delete actions.
   * Optional so SSR/unit renders can mount the editor without a live row; when
   * absent the Advanced actions section is hidden.
   */
  metabot?: Metabot | null;
  /** Open the manager-level safe-delete flow from the Advanced tab. */
  onDelete?: () => void;
}

const MetaBotEditTabs: React.FC<MetaBotEditTabsProps> = ({
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
  const [builtinAvatarPickerOpen, setBuiltinAvatarPickerOpen] = useState(false);
  const [values, setValues] = useState<MetaBotEditValues>(() => buildInitialValues(initialValues));
  const [baseline, setBaseline] = useState<MetaBotEditValues>(() => buildInitialValues(initialValues));
  const [activeTab, setActiveTab] = useState<MetaBotEditTabKey>('basic');  const [savingTab, setSavingTab] = useState<MetaBotEditTabKey | null>(null);
  const [tabErrors, setTabErrors] = useState<Partial<Record<MetaBotEditTabKey, string>>>({});
  const [nameDuplicate, setNameDuplicate] = useState(false);
  const [selectedAllowChatSkillId, setSelectedAllowChatSkillId] = useState('');
  const loadAvatarNfts = useCallback(async (): Promise<AvatarPickerNftItem[]> => {
    const response = await window.electron.idbots.getMetabotNfts({ metabotId, kind: 'mrc721' });
    if (!response.success) throw new Error(response.error || i18nService.t('metabotNftLoadFailed'));
    return (response.items ?? []) as unknown as AvatarPickerNftItem[];
  }, [metabotId]);
  // The OpenTeam remote-collaboration switch lives in the metabot_settings kv
  // store (not in the metabot:update column whitelist), so it applies
  // immediately on toggle instead of joining this tab's dirty/save flow.
  const [openTeamRemoteCollab, setOpenTeamRemoteCollab] = useState(true);
  const [openTeamRemoteCollabLoaded, setOpenTeamRemoteCollabLoaded] = useState(false);
  const [openTeamRemoteCollabSaving, setOpenTeamRemoteCollabSaving] = useState(false);
  // Cowork capability switches: same metabot_settings kv channel as OpenTeam.
  // Defaults mirror the main process: MCP mounting is per-bot opt-in (no
  // record = OFF), while browser automation and desktop computer use ship
  // enabled (no record = ON; an explicit '0' opts the bot out).
  const [coworkMcpTools, setCoworkMcpTools] = useState(false);
  const [coworkMcpToolsLoaded, setCoworkMcpToolsLoaded] = useState(false);
  const [coworkMcpToolsSaving, setCoworkMcpToolsSaving] = useState(false);
  const [coworkBrowserAutomation, setCoworkBrowserAutomation] = useState(true);
  const [coworkBrowserAutomationLoaded, setCoworkBrowserAutomationLoaded] = useState(false);
  const [coworkBrowserAutomationSaving, setCoworkBrowserAutomationSaving] = useState(false);
  const [coworkComputerUse, setCoworkComputerUse] = useState(true);
  const [coworkComputerUseLoaded, setCoworkComputerUseLoaded] = useState(false);
  const [coworkComputerUseSaving, setCoworkComputerUseSaving] = useState(false);
  const [twinDemoteConfirmOpen, setTwinDemoteConfirmOpen] = useState(false);

  // Re-initialize when a different bot is loaded into the same mounted editor.
  // Saves only update the baseline (see handleSaveTab), so unsaved edits in
  // other tabs are not clobbered by the parent refreshing its list state.
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
    // initialValues is re-created by the parent on every list refresh; key off metabotId only.
  }, [metabotId]);

  // Load the OpenTeam remote-collab switch for the bot being edited. The kv
  // default (no record) means "allowed", so a missing/failed read falls back to on.
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

  // Load the cowork MCP-tools / browser-automation / computer-use switches
  // for the bot being edited. A missing or failed read falls back to the
  // per-switch default, matching the main process: MCP mounting off, browser
  // automation and computer use on. An explicit '1'/'0' always wins.
  useEffect(() => {
    let cancelled = false;
    const resetters = [
      [setCoworkMcpTools, setCoworkMcpToolsLoaded, setCoworkMcpToolsSaving, COWORK_MOUNT_MCP_TOOLS_KEY, false],
      [setCoworkBrowserAutomation, setCoworkBrowserAutomationLoaded, setCoworkBrowserAutomationSaving, COWORK_BROWSER_AUTOMATION_KEY, true],
      [setCoworkComputerUse, setCoworkComputerUseLoaded, setCoworkComputerUseSaving, COWORK_COMPUTER_USE_KEY, true],
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
      // Discard the outgoing tab's unsaved edits.
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

  // Assignment model: bundled skills are implicitly available to every bot,
  // so only external (installed) skills are assignable here.
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

  // Immediate-effect toggle: optimistic flip, persisted via metabot:setSetting;
  // a failed write reverts the switch and surfaces a toast.
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

  // Same immediate-effect pattern as the OpenTeam toggle above.
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
      // Success: this tab's fields become the new clean baseline; other tabs
      // keep their unsaved edits and stay dirty.
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
  const globalDefaultModel = configService.getConfig().model?.defaultModel ?? null;
  const brainEffortOf = (value: string): LlmEffortLevel | null =>
    isLlmEffortLevel(value) ? value : null;
  // Twin switch: the current Twin can turn itself off; Workers see it only
  // when no Twin exists. The Welcome Bot never gets this control.
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
  const rowClass = 'grid grid-cols-1 md:grid-cols-[152px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
  const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
  const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
  // Keep primary and fallback brain pickers the same half-column width.
  const llmPickerWidthClass = 'w-1/2 min-w-0 shrink-0';
  const inputChromeClass = 'px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
  const inputClass = `w-full ${inputChromeClass}`;
  const clearActionClass = 'shrink-0 px-3 py-2 text-xs rounded-xl border dark:border-claude-darkBorder border-claude-border text-red-500 dark:text-red-400 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors whitespace-nowrap';

  const renderPanelError = (tab: MetaBotEditTabKey) => {
    const message = tabErrors[tab];
    if (!message) return null;
    return (
      <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2">
        {message}
      </div>
    );
  };

  const renderPanelSaveRow = (tab: MetaBotEditTabKey) => (
    <div className={rowClass}>
      <div className="hidden md:block" />
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={savingTab !== null}
          className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          data-slot={`metabot-edit-save-${tab}`}
          onClick={() => void handleSaveTab(tab)}
          disabled={savingTab !== null}
          className="btn-idchat-primary-filled px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {savingTab === tab ? i18nService.t('saving') : i18nService.t('metabotSaveAndSyncChain')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1 border-b dark:border-claude-darkBorder border-claude-border" role="tablist">
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
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-claude-accent text-claude-accent'
                  : 'border-transparent dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'
              }`}
            >
              {i18nService.t(EDIT_TAB_LABEL_KEYS[tab])}
              {isTabDirty(tab) ? <span className="ml-1 text-claude-accent">•</span> : null}
            </button>
          );
        })}
      </div>

      {/* Basic tab: identity + owner + LLM brain */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-basic"
        className={`space-y-3 ${activeTab === 'basic' ? '' : 'hidden'}`}
      >
        {renderPanelError('basic')}

        <div className={rowClass}>
          <label htmlFor="metabot-name" className={labelClass}>
            {i18nService.t('metabotName')}
          </label>
          <div className="min-w-0">
            <input
              id="metabot-name"
              type="text"
              value={values.name}
              onChange={(e) => handleChange('name', e.target.value)}
              onBlur={handleNameBlur}
              placeholder={i18nService.t('metabotNamePlaceholder')}
              className={`${inputClass} ${nameDuplicate ? 'border-red-500 dark:border-red-500' : ''}`}
            />
            {nameDuplicate && (
              <p className="text-xs text-red-500 mt-1">
                {i18nService.t('metabotNameDuplicate')}
              </p>
            )}
          </div>
        </div>

        <div className={rowClass}>
          <label className={labelClass}>
            {i18nService.t('metabotAvatar')}
          </label>
          <div className="min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="w-16 h-16 flex-shrink-0">
              <NftAvatarFrame
                avatar={values.avatar}
                fallbackSource={values.avatar === metabot?.avatar ? metabot?.avatar_fallback : null}
                frameClassName="w-16 h-16 rounded-xl"
                imgClassName="border dark:border-claude-darkBorder border-claude-border"
                fallback={(
                  <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex items-center justify-center">
                    <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                  </div>
                )}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-slot="metabot-avatar-set"
                  onClick={() => setAvatarPickerOpen(true)}
                  className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                >
                  {i18nService.t('metabotAvatarSet')}
                </button>
                <button
                  type="button"
                  data-slot="metabot-avatar-pick-builtin"
                  onClick={() => setBuiltinAvatarPickerOpen(true)}
                  className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                >
                  {i18nService.t('metabotAvatarPickBuiltin')}
                </button>
              </div>
              <p className={hintClass}>
                {i18nService.t('metabotAvatarPlaceholder')}
              </p>
              {parseNftAvatarReference(values.avatar) && (
                <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('metabotNftAvatarSyncHint')}
                </p>
              )}
              {values.avatar && (
                <button
                  type="button"
                  onClick={() => handleChange('avatar', '')}
                  className="mt-1 text-xs text-red-500 dark:text-red-400 hover:underline"
                >
                  {i18nService.t('metabotAvatarClear')}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className={rowClass}>
          <label htmlFor="metabot-bio" className={labelClass}>
            {i18nService.t('metabotBio')}
          </label>
          <div className="min-w-0">
            <textarea
              id="metabot-bio"
              value={values.bio}
              onChange={(e) => handleChange('bio', e.target.value)}
              placeholder={i18nService.t('metabotBioPlaceholder')}
              rows={2}
              className={`${inputClass} resize-y`}
            />
          </div>
        </div>

        {showTwinSwitch && (
          <div className={rowClass} data-slot="metabot-twin-switch-row">
            <label id="metabot-twin-switch-label" className={labelClass}>
              {i18nService.t('metabotTwinSwitchLabel')}
            </label>
            <div className="min-w-0">
              <div className="flex items-center gap-3 pt-1">
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
              <p className={hintClass}>
                {isTwin ? i18nService.t('metabotTwinSwitchHintCurrent') : i18nService.t('metabotTwinSwitchHint')}
              </p>
            </div>
          </div>
        )}

        <div className={rowClass}>
          <label htmlFor="metabot-boss-metaid" className={labelClass}>
            {i18nService.t('metabotBossMetaId')}
            <span className="ml-1 font-normal opacity-60">{i18nService.t('metabotBossMetaIdOptional')}</span>
          </label>
          <div className="min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <input
                id="metabot-boss-metaid"
                type="text"
                value={values.boss_global_metaid}
                readOnly
                placeholder={i18nService.t('metabotBossMetaIdPlaceholder')}
                className={`${inputClass} flex-1 min-w-0 font-mono opacity-80`}
              />
              <button
                type="button"
                onClick={() => { void handleGetOwnerMetaId(); }}
                className="shrink-0 px-3 py-2 text-xs rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors whitespace-nowrap"
              >
                {i18nService.t('metabotGetOwnerMetaId')}
              </button>
                  {values.boss_global_metaid.trim() && (
                <button
                  type="button"
                  onClick={() => handleChange('boss_global_metaid', '')}
                  className={clearActionClass}
                >
                  {i18nService.t('metabotClearOwner')}
                </button>
              )}
            </div>
            {values.boss_global_metaid.trim() ? (
              ownerBindingPinId ? (
                <p className="text-xs mt-1 text-green-600 dark:text-green-400">
                  {i18nService.t('metabotOwnerSigned')}
                </p>
              ) : (
                <p className="text-xs mt-1 text-amber-600 dark:text-amber-400">
                  {i18nService.t('metabotOwnerUnsigned')}
                </p>
              )
            ) : (
              <p className={`${hintClass} opacity-70`}>
                {i18nService.t('metabotBossMetaIdHint')}
              </p>
            )}
          </div>
        </div>

        <div className={rowClass}>
          <label htmlFor="metabot-llm" className={labelClass}>
            {i18nService.t('metabotLlmProvider')}
          </label>
          <div className="min-w-0">
            {hasNoAvailableLlm ? (
              <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-3 dark:bg-claude-darkSurface/50 bg-claude-surface/50">
                <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metabotNoAvailableLlm')}
                </p>
                {onRequestModelSettings && (
                  <button
                    type="button"
                    onClick={onRequestModelSettings}
                    className="mt-2 text-sm text-claude-accent hover:underline"
                  >
                    {i18nService.t('metabotGoToModelSettings')}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className={llmPickerWidthClass}>
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
                    globalDefaultModel={globalDefaultModel}
                    onManageModels={onRequestModelSettings}
                  />
                </div>
                <span className="relative inline-flex shrink-0 group">
                  <button
                    type="button"
                    className="rounded-full p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                    aria-label={i18nService.t('metabotPrimaryLlmHint')}
                  >
                    <QuestionMarkCircleIcon className="h-4 w-4" />
                  </button>
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute left-0 bottom-full mb-1.5 z-50 w-56 rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2.5 py-1.5 text-[11px] leading-relaxed dark:text-claude-darkText text-claude-text shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 whitespace-normal"
                  >
                    {i18nService.t('metabotPrimaryLlmHint')}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        {!hasNoAvailableLlm && (
          <div className={rowClass}>
            <label htmlFor="metabot-fallback-llm" className={labelClass}>
              {i18nService.t('metabotFallbackLlmLabel')}
            </label>
            <div className="min-w-0">
              {values.fallback_llm_id.trim() ? (
                <div className="flex items-center gap-2">
                  <div className={llmPickerWidthClass}>
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
                    className={clearActionClass}
                  >
                    {i18nService.t('metabotClearOwner')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  id="metabot-fallback-llm"
                  onClick={() => {
                    // Seed the fallback with the primary brain so the picker has
                    // a concrete starting selection; the user adjusts from there.
                    handleChange('fallback_llm_id', values.llm_id);
                    handleChange('fallback_llm_provider', values.llm_provider);
                    handleChange('fallback_llm_effort', values.llm_effort);
                  }}
                  disabled={!values.llm_id.trim()}
                  className="px-3 py-1.5 rounded-xl border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {i18nService.t('metabotFallbackLlmSetup')}
                </button>
              )}
              <p className={hintClass}>
                {i18nService.t('metabotFallbackLlmHint')}
              </p>
            </div>
          </div>
        )}

        {renderPanelSaveRow('basic')}
      </div>

      {/* Persona tab: role / soul / goal — all optional in edit mode */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-persona"
        className={`space-y-3 ${activeTab === 'persona' ? '' : 'hidden'}`}
      >
        {renderPanelError('persona')}

        <p className={hintClass}>
          {i18nService.t('metabotPersonaOptionalHint')}
        </p>

        <div className={rowClass}>
          <label htmlFor="metabot-role" className={labelClass}>
            {i18nService.t('metabotRole')}
          </label>
          <div className="min-w-0">
            <input
              id="metabot-role"
              type="text"
              value={values.role}
              onChange={(e) => handleChange('role', e.target.value)}
              placeholder={i18nService.t('metabotRolePlaceholder')}
              className={inputClass}
            />
          </div>
        </div>

        <div className={rowClass}>
          <label htmlFor="metabot-soul" className={labelClass}>
            {i18nService.t('metabotSoul')}
          </label>
          <div className="min-w-0">
            <textarea
              id="metabot-soul"
              value={values.soul}
              onChange={(e) => handleChange('soul', e.target.value)}
              placeholder={i18nService.t('metabotSoulPlaceholder')}
              rows={4}
              className={`${inputClass} resize-y`}
            />
          </div>
        </div>

        <div className={rowClass}>
          <label htmlFor="metabot-goal" className={labelClass}>
            {i18nService.t('metabotGoal')}
          </label>
          <div className="min-w-0">
            <textarea
              id="metabot-goal"
              value={values.goal}
              onChange={(e) => handleChange('goal', e.target.value)}
              placeholder={i18nService.t('metabotGoalPlaceholder')}
              rows={2}
              className={`${inputClass} resize-y`}
            />
          </div>
        </div>

        {renderPanelSaveRow('persona')}
      </div>

      {/* Chat Settings tab: private/group chat skill allowlist */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-chatSettings"
        className={`space-y-3 ${activeTab === 'chatSettings' ? '' : 'hidden'}`}
      >
        {renderPanelError('chatSettings')}

        <div className={rowClass}>
          <label id="metabot-a2a-auto-reply-label" className={labelClass}>
            {i18nService.t('metabotA2aAutoReply')}
          </label>
          <div className="min-w-0">
            <div className="flex items-center gap-3 pt-1">
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
            <p className={hintClass}>
              {i18nService.t('metabotA2aAutoReplyHint')}
            </p>
          </div>
        </div>

        {/* OpenTeam remote collab: immediate-effect kv switch, outside this tab's dirty/save flow. */}
        <div className={rowClass}>
          <label id="metabot-openteam-remote-collab-label" className={labelClass}>
            {i18nService.t('metabotOpenTeamRemoteCollab')}
          </label>
          <div className="min-w-0">
            <div className="flex items-center gap-3 pt-1">
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
            <p className={hintClass}>
              {i18nService.t('metabotOpenTeamRemoteCollabHint')}
            </p>
          </div>
        </div>

        <div className={rowClass}>
          <label htmlFor="metabot-allow-chat-skills" className={labelClass}>
            {i18nService.t('metabotAllowChatSkills')}
          </label>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <select
                id="metabot-allow-chat-skills"
                value={selectedAllowChatSkillId}
                onChange={(e) => setSelectedAllowChatSkillId(e.target.value)}
                className={inputClass}
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
                className="shrink-0 px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <PlusIcon className="h-4 w-4" />
                <span>{i18nService.t('metabotAdd')}</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {normalizedAllowChatSkills.length > 0 ? (
                normalizedAllowChatSkills.map((skillId) => (
                  <span
                    key={skillId}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-xs dark:text-claude-darkText text-claude-text"
                  >
                    <span className="max-w-[10rem] truncate" title={skillId}>
                      {skillNameById.get(skillId) || skillId}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveAllowChatSkill(skillId)}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-black/10 dark:hover:bg-white/10"
                      aria-label={i18nService.t('metabotDelete')}
                      title={i18nService.t('metabotDelete')}
                    >
                      <XMarkIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))
              ) : (
                <p className={hintClass}>
                  {i18nService.t('metabotAllowChatSkillsDefault')}
                </p>
              )}
            </div>
            <p className={hintClass}>
              {i18nService.t('metabotAllowChatSkillsHint')}
            </p>
            {availableSkillOptions.length === 0 && (
              <p className={`${hintClass} text-amber-500 dark:text-amber-400`}>
                {i18nService.t('metabotNoAvailableSkills')}
              </p>
            )}
          </div>
        </div>

        {/* Bundled skills are implicitly available to every bot (work sessions
            plus every chat-routing surface since the routing-baseline change);
            a collapsed read-only list keeps that discoverable without implying
            they are assignable here. */}
        {bundledSkillOptions.length > 0 && (
          <div className={rowClass} data-slot="metabot-bundled-skills">
            <label className={labelClass}>
              {i18nService.t('metabotBundledSkills')}
            </label>
            <div className="min-w-0">
              <details className="group">
                <summary className="cursor-pointer select-none text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText">
                  {i18nService.t('metabotBundledSkillsSummary').replace('{count}', String(bundledSkillOptions.length))}
                </summary>
                <div className="mt-2 flex flex-wrap gap-2" data-slot="metabot-bundled-skills-list">
                  {bundledSkillOptions.map((skill) => (
                    <span
                      key={skill.id}
                      title={skill.id}
                      className="inline-flex max-w-full items-center rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      <span className="max-w-[10rem] truncate">{skill.name}</span>
                    </span>
                  ))}
                </div>
              </details>
              <p className={hintClass}>
                {i18nService.t('metabotBundledSkillsHint')}
              </p>
            </div>
          </div>
        )}

        <div className={rowClass}>
          <label htmlFor="metabot-a2a-max-turns" className={labelClass}>
            {i18nService.t('metabotA2aMaxTurns')}
          </label>
          <div className="min-w-0">
            <select
              id="metabot-a2a-max-turns"
              value={values.a2a_max_incoming_turns}
              onChange={(e) => handleChange('a2a_max_incoming_turns', normalizeA2AMaxIncomingTurnsOption(e.target.value))}
              className={inputClass}
            >
              {A2A_MAX_INCOMING_TURNS_OPTIONS.map((turns) => (
                <option key={turns} value={turns}>
                  {turns}
                </option>
              ))}
            </select>
            <p className={hintClass}>
              {i18nService.t('metabotA2aMaxTurnsHint')}
            </p>
          </div>
        </div>

        <div className={rowClass}>
          <label htmlFor="metabot-a2a-bye-cooldown" className={labelClass}>
            {i18nService.t('metabotA2aByeCooldown')}
          </label>
          <div className="min-w-0">
            <select
              id="metabot-a2a-bye-cooldown"
              value={values.a2a_bye_cooldown_ms}
              onChange={(e) => handleChange('a2a_bye_cooldown_ms', normalizeA2AByeCooldownMsOption(e.target.value))}
              className={inputClass}
            >
              {A2A_BYE_COOLDOWN_MS_OPTIONS.map((cooldownMs) => (
                <option key={cooldownMs} value={cooldownMs}>
                  {`${cooldownMs / 60_000} ${i18nService.t('metabotA2aByeCooldownMinutes')}`}
                </option>
              ))}
            </select>
            <p className={hintClass}>
              {i18nService.t('metabotA2aByeCooldownHint')}
            </p>
          </div>
        </div>

        {renderPanelSaveRow('chatSettings')}
      </div>

      {/* Knowledge Base tab: per-bot document corpora, IPC-managed (no save row). */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-knowledgeBase"
        className={`space-y-3 ${activeTab === 'knowledgeBase' ? '' : 'hidden'}`}
      >
        <KnowledgeBasePanel metabotId={metabotId} />
      </div>

      {/* Surf tab: MetaWeb surf settings, "Surf now" trigger and the
          run-history reports panel — immediate effects (no save row). */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-surf"
        className={`space-y-3 ${activeTab === 'surf' ? '' : 'hidden'}`}
      >
        {/* Persisted type (baseline, not the edited value): the surf
            before-dream toggle's unset default is twin-only. */}
        <SurfSection metabotId={metabotId} metabotType={baseline.metabot_type} />
      </div>

      {/* Advanced tab: on-chain homepage source */}
      <div
        role="tabpanel"
        data-slot="metabot-edit-panel-advanced"
        className={`space-y-3 ${activeTab === 'advanced' ? '' : 'hidden'}`}
      >
        {renderPanelError('advanced')}

        <MetaBotHomepageSection
          values={values}
          onChange={(field, value) => handleChange(field, value)}
          metabotId={metabotId}
          onOpenDefaultHomepage={onOpenDefaultHomepage}
          onPreviewMetaAppHomepage={onPreviewMetaAppHomepage}
          onRequestMetaApps={onRequestMetaApps}
        />

        {renderPanelSaveRow('advanced')}

        {/* Cowork capability switches (moved here from the Chat Settings tab,
            into the slot the Surf section used to occupy before Surf got its
            own tab): immediate-effect kv switches, kept out of the homepage
            save above. */}
        <div
          className="space-y-3 pt-4 mt-4 border-t dark:border-claude-darkBorder border-claude-border"
          data-slot="metabot-cowork-capabilities-section"
        >
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <WrenchScrewdriverIcon className="h-3.5 w-3.5" aria-hidden />
            <span>{i18nService.t('metabotCoworkCapabilitiesTitle')}</span>
          </div>

          {/* Cowork MCP tools: immediate-effect kv switch, default off (per-bot opt-in). */}
          <div className={rowClass}>
            <label id="metabot-cowork-mcp-tools-label" className={labelClass}>
              {i18nService.t('metabotCoworkMcpTools')}
              <Tooltip content={i18nService.t('metabotCoworkMcpToolsTooltip')}>
                <QuestionMarkCircleIcon
                  className="h-4 w-4 inline ml-1.5 cursor-help dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-accent hover:text-claude-accent transition-colors"
                  aria-label={i18nService.t('metabotCoworkMcpToolsTooltip')}
                />
              </Tooltip>
            </label>
            <div className="min-w-0">
              <div className="flex items-center gap-3 pt-1">
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
            </div>
          </div>

          {/* Browser automation (experimental): ships enabled, explicit '0' opts out; immediate effect. */}
          <div className={rowClass}>
            <label id="metabot-cowork-browser-automation-label" className={labelClass}>
              {i18nService.t('metabotCoworkBrowserAutomation')}
              <Tooltip content={i18nService.t('metabotCoworkBrowserAutomationTooltip')}>
                <QuestionMarkCircleIcon
                  className="h-4 w-4 inline ml-1.5 cursor-help dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-accent hover:text-claude-accent transition-colors"
                  aria-label={i18nService.t('metabotCoworkBrowserAutomationTooltip')}
                />
              </Tooltip>
            </label>
            <div className="min-w-0">
              <div className="flex items-center gap-3 pt-1">
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
            </div>
          </div>

          {/* Desktop computer use (experimental): ships enabled, explicit '0' opts out; immediate effect. */}
          <div className={rowClass}>
            <label id="metabot-cowork-computer-use-label" className={labelClass}>
              {i18nService.t('metabotCoworkComputerUse')}
              <Tooltip content={i18nService.t('metabotCoworkComputerUseTooltip')}>
                <QuestionMarkCircleIcon
                  className="h-4 w-4 inline ml-1.5 cursor-help dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-accent hover:text-claude-accent transition-colors"
                  aria-label={i18nService.t('metabotCoworkComputerUseTooltip')}
                />
              </Tooltip>
            </label>
            <div className="min-w-0">
              <div className="flex items-center gap-3 pt-1">
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
            </div>
          </div>
        </div>

        {/* Daily Report ("每日汇报"): Twin-only proactive daily briefing —
            immediate-effect kv settings, gated by the global experimental
            automation switch inside the section. */}
        {isTwin && (
          <div
            className="space-y-3 pt-4 mt-4 border-t dark:border-claude-darkBorder border-claude-border"
            data-slot="metabot-daily-report-panel"
          >
            <DailyReportSection metabotId={metabotId} />
          </div>
        )}

        {/* Wallet / Backup / Delete — OAC-aligned Advanced actions. Immediate
            effects (panels / delete flow), kept out of the homepage save above. */}
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
                  className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:opacity-90"
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
                  className="btn-idchat-primary-filled px-4 py-2 text-sm"
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

      {builtinAvatarPickerOpen && (
        <BuiltinAvatarPickerModal
          currentReference={values.avatar}
          onPick={(reference) => {
            handleChange('avatar', reference);
            setBuiltinAvatarPickerOpen(false);
          }}
          onClose={() => setBuiltinAvatarPickerOpen(false)}
        />
      )}

    </div>
  );
};

export default MetaBotEditTabs;
