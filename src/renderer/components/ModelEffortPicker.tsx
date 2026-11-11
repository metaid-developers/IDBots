import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CheckIcon, Cog6ToothIcon, CpuChipIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';
import { configService } from '../services/config';
import { placePopoverAbove, useAnchorMoveWatcher } from '../utils/anchoredPopover';
import {
  buildModelGroupsFromConfig,
  resolveBrainModelInGroups,
  type LlmEffortLevel,
} from '../services/modelCatalog';
import { themeService } from '../services/theme';
import { ProviderIcon } from './settings/providerIcons';

/**
 * Shared "model + reasoning effort" picker (DSH ui-model-selection style).
 *
 * A three-pane popover: the root pane holds a Model row and an Effort row;
 * each drills into its own list. The model list groups every usable provider
 * from app_config — built-in AND custom-* providers. The selected provider is
 * shown as a quiet subtitle under the model name on the root pane so colliding
 * model ids (same name, different vendors) stay distinguishable. The effort
 * ladder is the app-wide off/low/high/max vocabulary (null = model default).
 */

export interface ModelEffortValue {
  /** Selected model id; null when nothing has been chosen yet. */
  modelId: string | null;
  /** Provider key the model was picked from (disambiguates colliding model ids). */
  providerKey?: string | null;
  effort: LlmEffortLevel | null;
}

interface ModelEffortPickerProps {
  value: ModelEffortValue;
  onChange: (value: ModelEffortValue) => void;
  /** Applied to the trigger button (stable selector for tests/a11y). */
  id?: string;
  dropdownDirection?: 'up' | 'down';
  /** Icon-only trigger for compact toolbars (Bot Browser); the model name still shows in the tooltip. */
  compact?: boolean;
  /**
   * Visual chrome. `toolbar` is the borderless composer chip; `field` is a
   * full-width form control that matches MetaBot edit/create inputs.
   */
  variant?: 'toolbar' | 'field';
  disabled?: boolean;
  /** Trigger label when no model is selected/resolvable. */
  placeholder?: string;
  /** Global default model id, used to resolve legacy provider-key brains for display. */
  globalDefaultModel?: string | null;
  /** Opens Settings > Models from a sticky footer on the model list pane. */
  onManageModels?: () => void;
  /**
   * Render the dropdown with `position: fixed` anchored above the trigger so
   * it escapes `overflow-hidden` ancestors and overlapping sibling panes
   * (e.g. the Bot Browser sidebar next to the browser view). `dropdownDirection`
   * is ignored in this mode — the fixed popover always opens above the trigger.
   */
  useFixedDropdown?: boolean;
}

type Pane = 'root' | 'model' | 'effort';

const MODEL_POPOVER_WIDTH = 288; // w-72

const EFFORT_OPTIONS: Array<{ value: LlmEffortLevel | null; labelKey: string; descKey: string }> = [
  { value: null, labelKey: 'modelPickerEffortDefault', descKey: 'modelPickerEffortDefaultDesc' },
  { value: 'off', labelKey: 'modelPickerEffortOff', descKey: 'modelPickerEffortOffDesc' },
  { value: 'low', labelKey: 'modelPickerEffortLow', descKey: 'modelPickerEffortLowDesc' },
  { value: 'high', labelKey: 'modelPickerEffortHigh', descKey: 'modelPickerEffortHighDesc' },
  { value: 'max', labelKey: 'modelPickerEffortMax', descKey: 'modelPickerEffortMaxDesc' },
];

const effortLabel = (effort: LlmEffortLevel | null): string =>
  effort == null ? i18nService.t('modelPickerEffortDefault') : i18nService.t(`modelPickerEffort${effort[0].toUpperCase()}${effort.slice(1)}`);

const ModelEffortPicker: React.FC<ModelEffortPickerProps> = ({
  value,
  onChange,
  id,
  dropdownDirection = 'down',
  compact = false,
  variant = 'toolbar',
  disabled = false,
  placeholder,
  globalDefaultModel = null,
  onManageModels,
  useFixedDropdown = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [pane, setPane] = useState<Pane>('root');
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Fixed-mode placement (see useFixedDropdown): computed after the dropdown
  // lays out so the measured height anchors its bottom edge to the trigger.
  const [fixedDropdownStyle, setFixedDropdownStyle] = useState<React.CSSProperties | null>(null);

  const updateFixedDropdownPlacement = useCallback(() => {
    const anchorRect = triggerRef.current?.getBoundingClientRect() ?? null;
    const dropdownRect = dropdownRef.current?.getBoundingClientRect();
    const placement = placePopoverAbove(
      anchorRect,
      dropdownRect ? { width: dropdownRect.width, height: dropdownRect.height } : { width: MODEL_POPOVER_WIDTH },
      MODEL_POPOVER_WIDTH,
    );
    setFixedDropdownStyle({ position: 'fixed', top: placement.top, left: placement.left, width: placement.width });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen || !useFixedDropdown) {
      setFixedDropdownStyle(null);
      return;
    }
    updateFixedDropdownPlacement();
  }, [isOpen, useFixedDropdown, pane, updateFixedDropdownPlacement]);

  useEffect(() => {
    if (!isOpen || !useFixedDropdown) return;
    const handle = () => updateFixedDropdownPlacement();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [isOpen, useFixedDropdown, updateFixedDropdownPlacement]);

  // Re-place when the trigger MOVES without any window-level event (sidebar
  // width drag, composer textarea auto-growing and pushing the toolbar up).
  useAnchorMoveWatcher(triggerRef, isOpen && useFixedDropdown, updateFixedDropdownPlacement);

  // Catalog freshness: rebuild when the popover opens and whenever the
  // Settings dialog closes (providers may have been added/edited there).
  const [settingsClosedTrigger, setSettingsClosedTrigger] = useState(0);
  useEffect(() => {
    const handler = () => setSettingsClosedTrigger((n) => n + 1);
    window.addEventListener('app:settingsClosed', handler);
    return () => window.removeEventListener('app:settingsClosed', handler);
  }, []);

  // Template provider logos ship light/dark variants — track the live theme
  // exactly like the Settings models page does.
  const dark = React.useSyncExternalStore(
    (listener) => themeService.subscribe(listener),
    () => themeService.getEffectiveTheme() === 'dark',
    () => false,
  );

  const catalog = useMemo(() => {
    void isOpen;
    void settingsClosedTrigger;
    const config = configService.getConfig();
    return {
      groups: buildModelGroupsFromConfig(config),
      // Custom/template provider configs, keyed by provider id — only logoKey
      // is consumed (template logo resolution for the group header icon).
      providers: (config.providers ?? {}) as Record<string, { logoKey?: string } | undefined>,
    };
  }, [isOpen, settingsClosedTrigger]);
  const groups = catalog.groups;

  const resolved = useMemo(
    () => resolveBrainModelInGroups(groups, value.modelId, value.providerKey, globalDefaultModel),
    [groups, value.modelId, value.providerKey, globalDefaultModel],
  );

  const currentModelName = resolved
    ? resolved.model.name
    : value.modelId ?? placeholder ?? i18nService.t('modelPickerChooseModel');
  const currentProviderName = resolved
    ? groups.find((group) => group.id === resolved.providerKey)?.name ?? null
    : null;
  const collidingModel = Boolean(
    resolved
    && groups.filter((group) => group.models.some((model) => model.id === resolved.model.id)).length > 1,
  );
  // Compact trigger still needs an inline suffix when the same model id is
  // offered by more than one provider; the popover root pane shows the
  // vendor as its own muted line instead.
  const currentModelLabel = collidingModel && currentProviderName
    ? `${currentModelName} · ${currentProviderName}`
    : currentModelName;
  const currentEffort = value.effort ?? null;
  // An 'off' rung glued to the model name on the collapsed trigger reads like
  // the model itself is switched off, so the trigger shows no effort text for
  // it; the open popover still surfaces the rung for editing.
  const showEffortOnTrigger = currentEffort !== 'off';

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setPane('root');
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const openPicker = () => {
    if (disabled) return;
    setIsOpen((open) => !open);
    setPane('root');
  };

  const handleModelSelect = (providerKey: string, modelId: string) => {
    onChange({ modelId, providerKey, effort: currentEffort });
    // Back to the root pane so the effort can follow in the same interaction.
    setPane('root');
  };

  const handleEffortSelect = (effort: LlmEffortLevel | null) => {
    onChange({
      modelId: resolved?.model.id ?? value.modelId,
      providerKey: resolved?.providerKey ?? value.providerKey ?? null,
      effort,
    });
    setIsOpen(false);
    setPane('root');
  };

  const handleManageModels = () => {
    setIsOpen(false);
    setPane('root');
    onManageModels?.();
  };

  const isField = variant === 'field' && !compact;

  if (groups.length === 0) {
    return (
      <div
        className={isField
          ? 'w-full px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkTextSecondary text-claude-textSecondary'
          : 'px-3 py-1.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm'}
        title={i18nService.t('modelPickerNoModels')}
      >
        {compact ? <CpuChipIcon className="h-4 w-4" /> : i18nService.t('modelPickerNoModels')}
      </div>
    );
  }

  const dropdownPositionClass = dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1';
  const paneTitle = pane === 'model'
    ? i18nService.t('modelPickerModelLabel')
    : pane === 'effort'
      ? i18nService.t('modelPickerEffortLabel')
      : '';

  const triggerClassName = compact
    ? `shrink-0 inline-flex items-center p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isOpen ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text' : ''}`
    : isField
      ? `flex items-center justify-between gap-2 w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 focus:outline-none focus:ring-2 focus:ring-claude-accent transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isOpen ? 'border-claude-accent ring-2 ring-claude-accent' : ''}`
      : `flex items-center gap-2 px-3 py-1.5 rounded-xl dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isOpen ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover' : ''}`;

  return (
    <div ref={containerRef} className={isField ? 'relative w-full' : 'relative'}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        onClick={openPicker}
        disabled={disabled}
        className={triggerClassName}
        title={showEffortOnTrigger ? `${currentModelLabel} · ${effortLabel(currentEffort)}` : currentModelLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`${i18nService.t('modelPickerModelLabel')}: ${currentModelLabel}, ${i18nService.t('modelPickerEffortLabel')}: ${effortLabel(currentEffort)}`}
      >
        {compact ? (
          <CpuChipIcon className="h-4 w-4" />
        ) : isField ? (
          <>
            <span className="min-w-0 flex-1 text-left font-medium truncate">{currentModelLabel}</span>
            {!resolved && value.modelId && (
              <span className="text-xs dark:text-red-400 text-red-500 shrink-0">{i18nService.t('modelPickerUnavailable')}</span>
            )}
            {showEffortOnTrigger && (
              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder border-claude-border rounded-md px-1.5 py-0.5 shrink-0">
                {effortLabel(currentEffort)}
              </span>
            )}
            <ChevronDownIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          </>
        ) : (
          <>
            <span className="font-medium text-sm truncate max-w-44">{currentModelLabel}</span>
            {!resolved && value.modelId && (
              <span className="text-xs dark:text-red-400 text-red-500">{i18nService.t('modelPickerUnavailable')}</span>
            )}
            {showEffortOnTrigger && (
              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder border-claude-border rounded-md px-1.5 py-0.5">
                {effortLabel(currentEffort)}
              </span>
            )}
            <ChevronDownIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          </>
        )}
        {compact ? (
          <ChevronDownIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        ) : null}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className={useFixedDropdown
            ? 'fixed w-72 dark:bg-claude-darkSurface bg-claude-surface rounded-xl popover-enter shadow-popover z-50 dark:border-claude-darkBorder border-claude-border border overflow-hidden'
            : `absolute ${dropdownPositionClass} left-0 ${isField ? 'right-0' : 'w-72'} dark:bg-claude-darkSurface bg-claude-surface rounded-xl popover-enter shadow-popover z-50 dark:border-claude-darkBorder border-claude-border border overflow-hidden`}
          style={useFixedDropdown ? (fixedDropdownStyle ?? { visibility: 'hidden' }) : undefined}
        >
          {pane !== 'root' && (
            <div className="flex items-center gap-2 px-3 py-2 dark:border-claude-darkBorder border-b border-claude-border">
              <button
                type="button"
                onClick={() => setPane('root')}
                className="p-1 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-pointer"
                aria-label={i18nService.t('cancel')}
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">{paneTitle}</span>
            </div>
          )}

          {pane === 'root' && (
            <div className="py-1">
              <button
                type="button"
                onClick={() => setPane('model')}
                className="w-full px-4 py-2.5 text-left dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between gap-2 transition-colors cursor-pointer"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('modelPickerModelLabel')}</span>
                  <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
                    {currentModelName}
                    {!resolved && value.modelId && (
                      <span className="ml-1 text-xs dark:text-red-400 text-red-500">{i18nService.t('modelPickerUnavailable')}</span>
                    )}
                  </span>
                  {currentProviderName ? (
                    <span className="text-[11px] leading-tight dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                      {currentProviderName}
                    </span>
                  ) : null}
                </div>
                <ChevronRightIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              </button>
              <button
                type="button"
                onClick={() => setPane('effort')}
                className="w-full px-4 py-2.5 text-left dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between gap-2 transition-colors cursor-pointer"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('modelPickerEffortLabel')}</span>
                  <span className="text-sm dark:text-claude-darkText text-claude-text truncate">{effortLabel(currentEffort)}</span>
                </div>
                <ChevronRightIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              </button>
            </div>
          )}

          {pane === 'model' && (
            <>
              <div className="max-h-72 overflow-y-auto py-1">
                {groups.map((group) => (
                  <div key={group.id} role="group" aria-label={group.name}>
                    <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      <ProviderIcon providerKey={group.id} config={catalog.providers[group.id]} dark={dark} className="h-4 w-4" />
                      <span className="truncate">{group.name}</span>
                    </div>
                    {group.models.map((model) => {
                      const selected = resolved?.providerKey === group.id && resolved.model.id === model.id;
                      return (
                        <button
                          type="button"
                          key={model.id}
                          onClick={() => handleModelSelect(group.id, model.id)}
                          className={`w-full px-4 py-2 text-left dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text flex items-center justify-between gap-2 transition-colors cursor-pointer ${selected ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
                        >
                          <span className="text-sm truncate">{model.name}</span>
                          {selected && <CheckIcon className="h-4 w-4 shrink-0 text-claude-accent" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {onManageModels && (
                <div className="shrink-0 border-t dark:border-claude-darkBorder border-claude-border">
                  <button
                    type="button"
                    onClick={handleManageModels}
                    className="w-full px-4 py-2.5 text-left dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center gap-2 transition-colors cursor-pointer"
                  >
                    <Cog6ToothIcon className="h-4 w-4 shrink-0 text-claude-accent" />
                    <span className="text-sm text-claude-accent">{i18nService.t('modelPickerManageModels')}</span>
                  </button>
                </div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <div className="max-h-72 overflow-y-auto py-1">
              {EFFORT_OPTIONS.map((option) => {
                const selected = (value.effort ?? null) === option.value;
                return (
                  <button
                    type="button"
                    key={option.value ?? 'default'}
                    onClick={() => handleEffortSelect(option.value)}
                    className={`w-full px-4 py-2 text-left dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between gap-2 transition-colors cursor-pointer ${selected ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
                  >
                    <div className="flex flex-col">
                      <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t(option.labelKey)}</span>
                      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t(option.descKey)}</span>
                    </div>
                    {selected && <CheckIcon className="h-4 w-4 shrink-0 text-claude-accent" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelEffortPicker;
