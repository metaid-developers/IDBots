import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { MobileMetabot } from '../../bridge/types';
import type { BotOperationResult, MobileBotInput } from '../hooks/useMetabots';
import { BotAvatar } from './BotAvatar';
import { fileToAvatarDataUrl } from '../avatarUpload';
import AvatarPickerModal, { type AvatarPickerNftItem } from '../../../renderer/components/avatar/AvatarPickerModal';
import {
  A2A_BYE_COOLDOWN_MS_OPTIONS,
  A2A_MAX_INCOMING_TURNS_OPTIONS,
  DEFAULT_A2A_AUTO_REPLY_ENABLED,
  DEFAULT_A2A_BYE_COOLDOWN_MS,
  DEFAULT_A2A_MAX_INCOMING_TURNS,
  cooldownMinutes,
} from '../a2aLimits';

/**
 * MetaBot create/edit forms, split per the UE rework (2026-10-29, A5):
 *
 * - CREATE: only Name + Role. Nothing else — no Advanced section, no tabs.
 *   Humans don't slowly fill a dozen fields at birth; everything else is
 *   completed afterwards through Edit. The real createMetaBotOnChain
 *   contract requires a primary model (`requireMetabotLlmIdForCreate`), so
 *   the form transparently auto-fills the first catalog model and says so
 *   in copy — UI transparency, not a relaxed backend contract.
 * - EDIT: full desktop-aligned field set in five tabs (Basic / Persona /
 *   Model / Chat settings / Other), mirroring the desktop edit tabs'
 *   ownership: avatar+bio (Basic), soul+goal (Persona), primary+fallback
 *   brain (Model), chat skills + A2A limits (Chat settings). Tab panels
 *   STAY MOUNTED and are only CSS-hidden, so edits survive tab switches —
 *   the same rule the desktop tabbed form follows.
 */

export interface EditorBrainOption {
  providerKey: string;
  modelId: string;
  label: string;
}

interface BotEditorState {
  bot: MobileMetabot | null;
  busy: boolean;
  outcome: BotOperationResult | null;
}

type EditorTabKey = 'basic' | 'persona' | 'model' | 'chatSettings' | 'other';

const EFFORT_LEVELS: ReadonlyArray<string> = ['', 'off', 'low', 'high', 'max'];

const TAB_PANEL_CLASS = 'mt-3 flex flex-col gap-3';

const inputClass = 'twin-input';
const labelClass = 'twin-label';

function brainValue(option: EditorBrainOption): string {
  return `${option.providerKey}\n${option.modelId}`;
}

function effortCopyKey(value: string): string {
  return `mobile.me.botEffort.${value || 'default'}`;
}

function outcomeCopy(state: BotOperationResult['state']): string {
  return t(`mobile.me.botOutcome.${state}`);
}

function Field(props: {
  htmlFor: string;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={labelClass} htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
    </div>
  );
}

function TabStrip(props: {
  tabs: ReadonlyArray<EditorTabKey>;
  value: EditorTabKey;
  disabled: boolean;
  onChange: (key: EditorTabKey) => void;
}): JSX.Element {
  return (
    <div className="twin-chip-row" role="tablist">
      {props.tabs.map((entry) => (
        <button
          key={entry}
          type="button"
          role="tab"
          aria-selected={props.value === entry}
          disabled={props.disabled}
          data-testid={`bot-tab-${entry}`}
          onClick={() => props.onChange(entry)}
          className="twin-chip"
        >
          {t(`mobile.me.botTab.${entry}`)}
        </button>
      ))}
    </div>
  );
}

/** Collapsible chat-skills block: collapsed by default, edits survive closing. */
function SkillsBlock(props: {
  skills: Array<{ id: string; name: string; description?: string }>;
  selected: string[];
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: (updater: (current: string[]) => string[]) => void;
}): JSX.Element {
  return (
    <div className="twin-panel twin-panel-flat p-3" data-testid="bot-skills-block">
      <button
        type="button"
        aria-expanded={props.expanded}
        data-testid="bot-skills-toggle"
        onClick={props.onToggleExpand}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          {t('mobile.me.botSkillsToggle')}
          <span className="ml-1 text-[var(--text-primary)]">({props.selected.length})</span>
        </span>
        {props.expanded
          ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
          : <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />}
      </button>
      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botSkillsCollapsed')}</p>
      {props.expanded ? (
        <fieldset className="mt-2 border-t border-[var(--border-color)] pt-2">
          {props.skills.map((skill) => (
            <label key={skill.id} className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={props.selected.includes(skill.id)}
                disabled={props.busy}
                onChange={(event) => props.onSelect((current) => event.target.checked
                  ? [...new Set([...current, skill.id])]
                  : current.filter((id) => id !== skill.id))}
                className="h-5 w-5"
              />
              <span>{skill.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/** One block holding the primary brain + effort (merged, owner-approved). */
function BrainBlock(props: {
  options: EditorBrainOption[];
  brain: EditorBrainOption | null;
  effort: string;
  busy: boolean;
  selectable: boolean;
  onBrainChange: (option: EditorBrainOption | null) => void;
  onEffortChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="twin-panel twin-panel-flat p-3">
      <p className={`mb-2 ${labelClass}`}>{t('mobile.me.botBrainSectionLabel')}</p>
      <Field htmlFor="bot-primary-model" label={t('mobile.me.botModelLabel')}>
        <select
          id="bot-primary-model"
          data-testid="bot-model"
          value={props.brain ? brainValue(props.brain) : ''}
          disabled={props.busy || !props.selectable || props.options.length === 0}
          onChange={(event) => {
            const [providerKey, modelId] = event.target.value.split('\n');
            props.onBrainChange(
              props.options.find((option) => option.providerKey === providerKey && option.modelId === modelId) ?? null,
            );
          }}
          className={inputClass}
        >
          {!props.brain ? <option value="">{t('mobile.me.botBrainUnavailable')}</option> : null}
          {props.options.map((option) => (
            <option key={`${option.providerKey}\n${option.modelId}`} value={brainValue(option)}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-2">
        <Field htmlFor="bot-primary-effort" label={t('mobile.me.botEffortShortLabel')}>
          <select
            id="bot-primary-effort"
            data-testid="bot-effort"
            value={props.effort}
            disabled={props.busy}
            onChange={(event) => props.onEffortChange(event.target.value)}
            className={inputClass}
          >
            {EFFORT_LEVELS.map((value) => (
              <option key={value || 'default'} value={value}>{t(effortCopyKey(value))}</option>
            ))}
          </select>
          <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botEffortMainHint')}</p>
        </Field>
      </div>
    </div>
  );
}

/** Fallback brain block, desktop-aligned: model (with provider) + effort. */
function FallbackBrainBlock(props: {
  options: EditorBrainOption[];
  brain: EditorBrainOption | null;
  effort: string;
  busy: boolean;
  onBrainChange: (option: EditorBrainOption | null) => void;
  onEffortChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="twin-panel twin-panel-flat p-3">
      <Field htmlFor="bot-fallback-model" label={t('mobile.me.botFallbackLabel')}>
        <select
          id="bot-fallback-model"
          data-testid="bot-fallback-model"
          value={props.brain ? brainValue(props.brain) : ''}
          disabled={props.busy || props.options.length === 0}
          onChange={(event) => {
            const [providerKey, modelId] = event.target.value.split('\n');
            props.onBrainChange(
              props.options.find((option) => option.providerKey === providerKey && option.modelId === modelId) ?? null,
            );
          }}
          className={inputClass}
        >
          <option value="">{t('mobile.me.botFallbackNone')}</option>
          {props.options
            .filter((option) => !props.brain || brainValue(option) !== brainValue(props.brain))
            .map((option) => (
              <option key={`${option.providerKey}\n${option.modelId}`} value={brainValue(option)}>
                {option.label}
              </option>
            ))}
        </select>
      </Field>
      {props.brain ? (
        <div className="mt-2">
          <Field htmlFor="bot-fallback-effort" label={t('mobile.me.botEffortShortLabel')}>
            <select
              id="bot-fallback-effort"
              data-testid="bot-fallback-effort"
              value={props.effort}
              disabled={props.busy}
              onChange={(event) => props.onEffortChange(event.target.value)}
              className={inputClass}
            >
              {EFFORT_LEVELS.map((value) => (
                <option key={value || 'default'} value={value}>{t(effortCopyKey(value))}</option>
              ))}
            </select>
            <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botEffortFallbackHint')}</p>
          </Field>
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botFallbackHint')}</p>
    </div>
  );
}

function AvatarField(props: {
  botId: number | null;
  ownerAddress: string;
  ownerGlobalMetaId?: string | null;
  name: string;
  avatar: string | null;
  fallbackSource?: string | null;
  busy: boolean;
  onPick: (value: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadNfts = useCallback(async (): Promise<AvatarPickerNftItem[]> => {
    if (!props.botId) return [];
    const response = await window.electron.idbots.getMetabotNfts({ metabotId: props.botId, kind: 'mrc721' });
    if (!response.success) throw new Error(response.error || 'NFT load failed');
    return (response.items ?? []) as unknown as AvatarPickerNftItem[];
  }, [props.botId]);
  return (
    <div className="flex items-center gap-3 twin-panel twin-panel-flat p-3">
      <BotAvatar name={props.name} avatar={props.avatar} fallbackSource={props.fallbackSource} testId="bot-avatar-preview" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          data-testid="bot-avatar-change"
          disabled={props.busy}
          onClick={() => setPickerOpen(true)}
          className="min-h-[36px] self-start rounded-lg border border-[var(--border-color)] px-3 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
        >
          {t('mobile.me.botAvatarSet')}
        </button>
        {props.avatar ? (
          <button
            type="button"
            data-testid="bot-avatar-remove"
            disabled={props.busy}
            onClick={props.onRemove}
            className="min-h-[36px] self-start px-1 text-xs text-red-600 disabled:opacity-40"
          >
            {t('mobile.me.botAvatarRemove')}
          </button>
        ) : null}
        <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botAvatarNote')}</p>
        {error ? <p className="text-[11px] text-red-600">{error}</p> : null}
      </div>
      {pickerOpen ? (
        <AvatarPickerModal
          ownerAddress={props.ownerAddress}
          ownerGlobalMetaId={props.ownerGlobalMetaId}
          loadNfts={loadNfts}
          maxLocalBytes={200 * 1024}
          allowNft={Boolean(props.botId)}
          readLocalFile={fileToAvatarDataUrl}
          onPick={(reference) => {
            props.onPick(reference);
            setPickerOpen(false);
          }}
          onPickLocal={(dataUrl) => {
            props.onPick(dataUrl);
            setPickerOpen(false);
          }}
          onError={setError}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function BotEditorForm(props: {
  state: BotEditorState;
  brainOptions: EditorBrainOption[];
  skills: Array<{ id: string; name: string; description?: string }>;
  catalogError: string | null;
  getBalance: (id: number) => Promise<{ success: boolean; value?: string; error?: string }>;
  onSave: (input: MobileBotInput) => Promise<void>;
  onClose: () => void;
  /** A6: surfaced so the botEdit page can guard back navigation (IA-PLAN §2.5). */
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const { bot, busy, outcome } = props.state;
  const isEdit = Boolean(bot);
  const tabs: ReadonlyArray<EditorTabKey> = ['basic', 'persona', 'model', 'chatSettings', 'other'];

  const [tab, setTab] = useState<EditorTabKey>(isEdit ? 'basic' : 'basic');

  const options = [...props.brainOptions];
  if (bot?.llm_id && !options.some((option) => option.modelId === bot.llm_id && option.providerKey === (bot.llm_provider ?? ''))) {
    options.unshift({
      providerKey: bot.llm_provider ?? '',
      modelId: bot.llm_id,
      label: t('mobile.me.botCurrentModel', { model: bot.llm_id }),
    });
  }
  const [name, setName] = useState(bot?.name ?? '');
  const [role, setRole] = useState(bot?.role ?? '');
  const [soul, setSoul] = useState(bot?.soul ?? '');
  const [goal, setGoal] = useState(bot?.goal ?? '');
  const [bio, setBio] = useState(bot?.bio ?? '');
  const [avatar, setAvatar] = useState<string | null>(bot?.avatar ?? null);
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [brain, setBrain] = useState<EditorBrainOption | null>(() => {
    if (!bot?.llm_id) return options[0] ?? null;
    const current = options.find(
      (option) => option.modelId === bot.llm_id && option.providerKey === (bot.llm_provider ?? ''),
    );
    return current ?? {
      providerKey: bot.llm_provider ?? '',
      modelId: bot.llm_id,
      label: t('mobile.me.botCurrentModel', { model: bot.llm_id }),
    };
  });
  const [effort, setEffort] = useState(bot?.llm_effort ?? '');
  const [fallbackBrain, setFallbackBrain] = useState<EditorBrainOption | null>(() => {
    if (!bot?.fallback_llm_id) return null;
    return {
      providerKey: bot.fallback_llm_provider ?? '',
      modelId: bot.fallback_llm_id,
      label: t('mobile.me.botCurrentModel', { model: bot.fallback_llm_id }),
    };
  });
  const [fallbackEffort, setFallbackEffort] = useState(bot?.fallback_llm_effort ?? '');
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot?.allow_chat_skills ?? []);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [a2aAutoReply, setA2aAutoReply] = useState<boolean>(
    bot?.a2a_auto_reply_enabled ?? DEFAULT_A2A_AUTO_REPLY_ENABLED,
  );
  const [a2aMaxIncomingTurns, setA2aMaxIncomingTurns] = useState<number>(
    bot?.a2a_max_incoming_turns ?? DEFAULT_A2A_MAX_INCOMING_TURNS,
  );
  const [a2aByeCooldownMs, setA2aByeCooldownMs] = useState<number>(
    bot?.a2a_bye_cooldown_ms ?? DEFAULT_A2A_BYE_COOLDOWN_MS,
  );
  const [balance, setBalance] = useState<{ loading: boolean; value?: string; error?: string }>({ loading: Boolean(bot) });

  // Dirty detection (A6, IA-PLAN §2.5 rule 2): any editor field differing
  // from the values the form was initialized with. avatarTouched gates the
  // avatar so an untouched pass-through never reads as dirty.
  const dirtyFields = [
    name,
    role,
    soul,
    goal,
    bio,
    avatarTouched ? avatar : null,
    brain?.providerKey ?? null,
    brain?.modelId ?? null,
    effort,
    fallbackBrain?.providerKey ?? null,
    fallbackBrain?.modelId ?? null,
    fallbackBrain ? fallbackEffort : null,
    [...selectedSkills].sort().join(','),
    a2aAutoReply,
    a2aMaxIncomingTurns,
    a2aByeCooldownMs,
  ];
  const dirtySnapshot = JSON.stringify(dirtyFields);
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) {
    initialSnapshotRef.current = dirtySnapshot;
  }
  const dirty = dirtySnapshot !== initialSnapshotRef.current;
  useEffect(() => {
    props.onDirtyChange?.(dirty);
    // The callback is a stable ref-setter on the Me screen; dirty is the trigger.
  }, [dirty]);
  useEffect(() => () => props.onDirtyChange?.(false), []);

  useEffect(() => {
    if (!bot) return;
    let active = true;
    void props.getBalance(bot.id).then((result) => {
      if (active) setBalance({ loading: false, value: result.value, error: result.error });
    });
    return () => {
      active = false;
    };
  }, [bot, props.getBalance]);

  const resolveInput = (): MobileBotInput => ({
    name: name.trim(),
    role: role.trim(),
    soul: soul.trim(),
    goal: goal.trim(),
    bio: bio.trim(),
    avatar: avatarTouched ? avatar : undefined,
    llmId: brain?.modelId ?? (isEdit ? '' : options[0]?.modelId ?? ''),
    llmProvider: brain?.providerKey ?? (isEdit ? '' : options[0]?.providerKey ?? ''),
    llmEffort: effort || null,
    fallbackLlmId: fallbackBrain?.modelId ?? '',
    fallbackLlmProvider: fallbackBrain?.providerKey ?? '',
    fallbackLlmEffort: fallbackBrain ? (fallbackEffort || null) : null,
    allowChatSkills: selectedSkills,
    a2aAutoReply,
    a2aMaxIncomingTurns,
    a2aByeCooldownMs,
  });

  // Save gating: create accepts `name only` (a default brain is auto-filled
  // from the catalog — the createMetaBotOnChain contract requires one); edit
  // keeps `name + primary brain required`.
  const saveDisabled = busy
    || !name.trim()
    || Boolean(props.catalogError)
    || (isEdit ? !brain?.modelId : options.length === 0);

  const panelHidden = (key: EditorTabKey): React.CSSProperties | undefined =>
    tab === key ? undefined : { display: 'none' };

  return (
    <div className="flex flex-col gap-3" data-testid="bot-form">
      {/* Identity pair: name + role are the only create-mode fields and stay
          top-level in edit mode (desktop persona parity). */}
      <div className="twin-panel twin-panel-padded">
        <Field htmlFor="bot-name" label={t('mobile.me.botNameLabel')}>
          <input
            id="bot-name"
            data-testid="bot-name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('mobile.me.botNamePlaceholder')}
            className={inputClass}
          />
        </Field>
        <div className="twin-field">
          <Field htmlFor="bot-role" label={t('mobile.me.botRoleLabel')}>
            <input
              id="bot-role"
              data-testid="bot-role"
              value={role}
              disabled={busy}
              onChange={(event) => setRole(event.target.value)}
              placeholder={t('mobile.me.botRolePlaceholder')}
              className={inputClass}
            />
          </Field>
        </div>
      </div>

      {!isEdit ? (
        <div data-testid="bot-create-guide" className="rounded-xl bg-[var(--bg-main)] p-3">
          <p className={`mb-1 ${labelClass}`}>{t('mobile.me.botCreateBasicTitle')}</p>
          <p className="text-sm text-[var(--text-primary)]">{t('mobile.me.botNameMinNote')}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.me.botCreateGuide')}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.me.botDefaultBrainNote')}</p>
        </div>
      ) : (
        <>
          <TabStrip tabs={tabs} value={tab} disabled={busy} onChange={setTab} />

          {/* Basic: avatar + bio (desktop Basic-tab ownership minus the
              identity pair above; metabot_type/boss stay desktop-only). */}
          <div data-testid="bot-panel-basic" className={TAB_PANEL_CLASS} style={panelHidden('basic')}>
            <AvatarField
              botId={bot?.id ?? null}
              ownerAddress={bot?.mvc_address ?? ''}
              ownerGlobalMetaId={bot?.globalmetaid}
              name={name}
              avatar={avatar}
              fallbackSource={bot?.avatar_fallback}
              busy={busy}
              onPick={(dataUrl) => {
                setAvatar(dataUrl);
                setAvatarTouched(true);
              }}
              onRemove={() => {
                setAvatar(null);
                setAvatarTouched(true);
              }}
            />
            <Field htmlFor="bot-bio" label={t('mobile.me.botBioLabel')}>
              <textarea
                id="bot-bio"
                data-testid="bot-bio"
                value={bio}
                disabled={busy}
                onChange={(event) => setBio(event.target.value)}
                placeholder={t('mobile.me.botBioPlaceholder')}
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </Field>
          </div>

          {/* Persona: soul + goal (role lives top-level above). */}
          <div data-testid="bot-panel-persona" className={TAB_PANEL_CLASS} style={panelHidden('persona')}>
            <Field htmlFor="bot-soul" label={t('mobile.me.botSoulLabel')}>
              <textarea
                id="bot-soul"
                data-testid="bot-soul"
                value={soul}
                disabled={busy}
                onChange={(event) => setSoul(event.target.value)}
                placeholder={t('mobile.me.botSoulPlaceholder')}
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </Field>
            <Field htmlFor="bot-goal" label={t('mobile.me.botGoalLabel')}>
              <textarea
                id="bot-goal"
                data-testid="bot-goal"
                value={goal}
                disabled={busy}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={t('mobile.me.botGoalPlaceholder')}
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </Field>
          </div>

          {/* Model: primary brain + effort + fallback brain. */}
          <div data-testid="bot-panel-model" className={TAB_PANEL_CLASS} style={panelHidden('model')}>
            <BrainBlock
              options={options}
              brain={brain}
              effort={effort}
              busy={busy}
              selectable={isEdit || options.length > 0}
              onBrainChange={setBrain}
              onEffortChange={setEffort}
            />
            <FallbackBrainBlock
              options={options}
              brain={fallbackBrain}
              effort={fallbackEffort}
              busy={busy}
              onBrainChange={setFallbackBrain}
              onEffortChange={setFallbackEffort}
            />
          </div>

          {/* Chat settings: chat skills + A2A private-chat limits (desktop
              Chat Settings tab). */}
          <div data-testid="bot-panel-chatSettings" className={TAB_PANEL_CLASS} style={panelHidden('chatSettings')}>
            <SkillsBlock
              skills={props.skills}
              selected={selectedSkills}
              busy={busy}
              expanded={skillsExpanded}
              onToggleExpand={() => setSkillsExpanded((current) => !current)}
              onSelect={setSelectedSkills}
            />
            <div className="twin-panel twin-panel-flat p-3">
              <p className={`mb-2 ${labelClass}`}>{t('mobile.me.botA2aSectionLabel')}</p>
              <label className="flex min-h-[44px] items-center justify-between gap-3 text-sm text-[var(--text-primary)]" htmlFor="bot-a2a-auto-reply">
                <span>
                  {t('mobile.me.botA2aAutoReplyLabel')}
                  <span className="block text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botA2aAutoReplyHint')}</span>
                </span>
                <input
                  id="bot-a2a-auto-reply"
                  type="checkbox"
                  role="switch"
                  data-testid="bot-a2a-auto-reply"
                  checked={a2aAutoReply}
                  disabled={busy}
                  onChange={(event) => setA2aAutoReply(event.target.checked)}
                  className="h-6 w-11 shrink-0"
                />
              </label>
              <div className="mt-2">
                <Field htmlFor="bot-a2a-max-turns" label={t('mobile.me.botA2aMaxTurnsLabel')}>
                  <select
                    id="bot-a2a-max-turns"
                    data-testid="bot-a2a-max-turns"
                    value={a2aMaxIncomingTurns}
                    disabled={busy}
                    onChange={(event) => setA2aMaxIncomingTurns(Number(event.target.value))}
                    className={inputClass}
                  >
                    {A2A_MAX_INCOMING_TURNS_OPTIONS.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botA2aMaxTurnsHint')}</p>
                </Field>
              </div>
              <div className="mt-2">
                <Field htmlFor="bot-a2a-bye-cooldown" label={t('mobile.me.botA2aByeCooldownLabel')}>
                  <select
                    id="bot-a2a-bye-cooldown"
                    data-testid="bot-a2a-bye-cooldown"
                    value={a2aByeCooldownMs}
                    disabled={busy}
                    onChange={(event) => setA2aByeCooldownMs(Number(event.target.value))}
                    className={inputClass}
                  >
                    {A2A_BYE_COOLDOWN_MS_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {cooldownMinutes(value)} {t('mobile.me.botA2aByeCooldownMinutes')}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botA2aByeCooldownHint')}</p>
                </Field>
              </div>
            </div>
          </div>

          {/* Other: binding notes, fees, live balance. */}
          <div data-testid="bot-panel-other" className={TAB_PANEL_CLASS} style={panelHidden('other')}>
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.botModelBindingNote')}</p>
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.botFeeHint')}</p>
            <p className="text-xs text-[var(--text-secondary)]" data-testid="bot-balance-hint">
              {balance.loading
                ? t('mobile.common.loading')
                : balance.error
                  ? t('mobile.me.botBalanceUnavailable')
                  : t('mobile.me.botBalance', { balance: balance.value ?? '' })}
            </p>
            {props.catalogError ? <p className="text-xs text-red-600">{props.catalogError}</p> : null}
          </div>
        </>
      )}

      {busy ? (
        <p className="twin-notice" data-testid="bot-create-progress" aria-live="polite">
          {t(bot ? 'mobile.me.botUpdating' : 'mobile.me.botCreating')}
        </p>
      ) : null}
      {outcome ? (
        <div
          className={`twin-notice ${outcome.state === 'synced' ? 'twin-notice-success' : 'twin-notice-warning'}`}
          data-testid="bot-operation-result"
          data-state={outcome.state}
          aria-live="polite"
        >
          <p className="text-sm font-medium">{outcomeCopy(outcome.state)}</p>
          {outcome.message ? <p className="mt-1 break-words text-xs">{outcome.message}</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        disabled={saveDisabled}
        onClick={() => void props.onSave(resolveInput())}
        className="twin-button twin-button-primary twin-button-full"
        data-testid="bot-save"
      >
        {t('mobile.me.botSave')}
      </button>
    </div>
  );
}
