import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { PaperAirplaneIcon, StopIcon, FolderIcon } from '@heroicons/react/24/solid';
import { PaperClipIcon, XMarkIcon, SparklesIcon, ChevronDownIcon, PlusIcon, PuzzlePieceIcon, CommandLineIcon } from '@heroicons/react/24/outline';
import { placePopoverAbove, useAnchorMoveWatcher } from '../../utils/anchoredPopover';
import ModelEffortPicker, { type ModelEffortValue } from '../ModelEffortPicker';
import ContextUsageRing from '../ContextUsageRing';
import FolderSelectorPopover from './FolderSelectorPopover';
import PermissionModeSelector from './PermissionModeSelector';
import ComposerCommandPicker from './ComposerCommandPicker';
import {
  commandToken,
  filterComposerCommands,
  parseLeadingCommand,
  slashQueryOf,
  type ComposerClaim,
  type ComposerCommand,
  type ComposerCommandContext,
} from './composerCommands';
import { SkillsPopover, ActiveSkillBadge } from '../skills';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setDraftPrompt, setSessionDraft } from '../../store/slices/coworkSlice';
import { setSkills, toggleActiveSkill } from '../../store/slices/skillSlice';
import { Skill } from '../../types/skill';
import type {
  CoworkContextUsage,
  CoworkPermissionMode,
  CoworkQuotedSelection,
  CoworkWorkspaceSelection,
} from '../../types/cowork';
import CoworkQuotedSelectionTiles from './CoworkQuotedSelectionTiles';
import {
  QUOTED_SELECTION_SOURCE_KEYS,
  composeSubmittedCoworkPrompt,
  removeQuotedSelection,
} from './coworkQuotedSelections';
import type { ProjectRecord } from '../../types/project';
import { getCompactFolderName } from '../../utils/path';
import {
  createVersionedComposerField,
  runComposerSubmission,
  type VersionedComposerField,
  type VersionedComposerSnapshot,
} from './coworkPromptSubmission';
import {
  composerTextareaHeight,
  shouldRemeasureComposerHeight,
  type ComposerHeightMeasurement,
} from './composerTextareaResize';

type CoworkAttachment = {
  path: string;
  name: string;
};

interface CoworkPromptInputStateOptions {
  value: string;
  isStreaming: boolean;
  disabled: boolean;
  steerDisabled: boolean;
  attachmentCount: number;
  /** Quoted transcript excerpts waiting in the composer; they can be sent on their own. */
  quotedSelectionCount?: number;
}

export const deriveCoworkPromptInputState = ({
  value,
  isStreaming,
  disabled,
  steerDisabled,
  attachmentCount,
  quotedSelectionCount = 0,
}: CoworkPromptInputStateOptions) => {
  const hasTextInput = Boolean(value.trim());
  // A steer can carry typed text and/or quoted transcript excerpts (they ride
  // into the steer prompt body). File attachments are a disabled semantic
  // while a turn streams, so they never make a steer sendable.
  const hasSteerContent = hasTextInput || quotedSelectionCount > 0;
  const isSteerSubmit = isStreaming && hasSteerContent && !steerDisabled;
  const showStopButton = isStreaming && (!hasSteerContent || steerDisabled);
  const canSubmit = !disabled && (!isStreaming
    ? hasTextInput || attachmentCount > 0 || quotedSelectionCount > 0
    : isSteerSubmit);
  return { hasTextInput, isSteerSubmit, showStopButton, canSubmit };
};

export interface CoworkComposerPlaceholderInput {
  isStreaming: boolean;
  steerDisabled: boolean;
  /** The quote slot holds a fragment: the composer is in reply mode. */
  hasQuotedSelections: boolean;
  /** Fallback shown when idle with an empty quote slot. */
  idlePlaceholder: string;
}

/**
 * Effective placeholder of the composer. A filled quote slot is a reply, so
 * its copy wins over every other hint — including the steer copy while a turn
 * streams, since the slot can be filled by replying to a streaming message.
 */
export const deriveCoworkComposerPlaceholder = ({
  isStreaming,
  steerDisabled,
  hasQuotedSelections,
  idlePlaceholder,
}: CoworkComposerPlaceholderInput): string => {
  if (hasQuotedSelections) return i18nService.t('coworkQuoteReplyPlaceholder');
  if (isStreaming) {
    return i18nService.t(steerDisabled
      ? 'coworkSteerSandboxUnavailablePlaceholder'
      : 'coworkSteerPlaceholder');
  }
  return idlePlaceholder;
};

export interface CoworkContextMenuDerivedState {
  canCut: boolean;
  canCopy: boolean;
  canSelectAll: boolean;
}

export const deriveCoworkContextMenuState = ({
  valueLength,
  selectionStart,
  selectionEnd,
  disabled,
}: {
  valueLength: number;
  selectionStart: number;
  selectionEnd: number;
  disabled: boolean;
}): CoworkContextMenuDerivedState => {
  const hasSelection = selectionStart >= 0 && selectionEnd > selectionStart;
  return {
    canCut: !disabled && hasSelection,
    canCopy: hasSelection,
    canSelectAll: !disabled && valueLength > 0,
  };
};

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 168;
const CONTEXT_MENU_PADDING = 8;

/** DOM id of the '/' command picker listbox (aria wiring). */
const COMMAND_PICKER_ID = 'cowork-command-picker';

const ContextMenuItem: React.FC<{
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, shortcut, disabled = false, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-40 disabled:hover:bg-transparent disabled:dark:hover:bg-transparent disabled:cursor-not-allowed"
  >
    <span className="flex-1 truncate">{label}</span>
    {shortcut && (
      <span className="flex-shrink-0 text-xs opacity-50 dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {shortcut}
      </span>
    )}
  </button>
);

const getFileNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

interface PlusMenuButtonProps {
  open: boolean;
  showAttachment: boolean;
  showCommands: boolean;
  buttonRef: React.RefObject<HTMLButtonElement>;
  menuRef: React.RefObject<HTMLDivElement>;
  onToggle: () => void;
  onAddAttachment: () => void;
  onUseSkill: () => void;
  onUseCommand: () => void;
}

const PLUS_MENU_WIDTH = 256; // w-64

/**
 * The composer's '+' trigger with its quick-action menu (add attachment /
 * use a skill / pick a '/' command), ported from the DSH composer layout:
 * the plus icon sits at the far left of the toolbar.
 */
const PlusMenuButton: React.FC<PlusMenuButtonProps> = ({
  open,
  showAttachment,
  showCommands,
  buttonRef,
  menuRef,
  onToggle,
  onAddAttachment,
  onUseSkill,
  onUseCommand,
}) => {
  const itemClass = 'w-full flex items-center gap-3 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors';
  // The menu floats with position:fixed above the trigger so it escapes
  // overflow-hidden ancestors (the Bot Browser sidebar); same placement
  // pattern as the SkillsPopover anchored to this very button.
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);

  const updateMenuPlacement = useCallback(() => {
    const anchorRect = buttonRef.current?.getBoundingClientRect() ?? null;
    const menuRect = menuRef.current?.getBoundingClientRect();
    const placement = placePopoverAbove(
      anchorRect,
      menuRect ? { width: menuRect.width, height: menuRect.height } : { width: PLUS_MENU_WIDTH },
      PLUS_MENU_WIDTH,
    );
    setMenuStyle({ position: 'fixed', top: placement.top, left: placement.left, width: placement.width });
  }, [buttonRef, menuRef]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    updateMenuPlacement();
    window.addEventListener('resize', updateMenuPlacement);
    window.addEventListener('scroll', updateMenuPlacement, true);
    return () => {
      window.removeEventListener('resize', updateMenuPlacement);
      window.removeEventListener('scroll', updateMenuPlacement, true);
    };
  }, [open, updateMenuPlacement]);

  // Re-place when the trigger MOVES without any window-level event (sidebar
  // width drag, the composer textarea auto-growing beneath it).
  useAnchorMoveWatcher(buttonRef, open, updateMenuPlacement);

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center justify-center p-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
        title={i18nService.t('composerPlusMenuTitle')}
        aria-label={i18nService.t('composerPlusMenuTitle')}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 w-64 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-lg overflow-hidden py-1"
          style={menuStyle ?? { visibility: 'hidden' }}
        >
          {showAttachment && (
            <button type="button" role="menuitem" onClick={onAddAttachment} className={itemClass}>
              <PaperClipIcon className="h-4 w-4 flex-shrink-0" />
              <span>{i18nService.t('composerMenuAddAttachment')}</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={onUseSkill} className={itemClass}>
            <PuzzlePieceIcon className="h-4 w-4 flex-shrink-0" />
            <span>{i18nService.t('composerMenuUseSkill')}</span>
          </button>
          {showCommands && (
            <button type="button" role="menuitem" onClick={onUseCommand} className={itemClass}>
              <CommandLineIcon className="h-4 w-4 flex-shrink-0" />
              <span>{i18nService.t('composerMenuUseCommand')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const getSkillDirectoryFromPath = (skillPath: string): string => {
  const normalized = skillPath.trim().replace(/\\/g, '/');
  return normalized.replace(/\/SKILL\.md$/i, '') || normalized;
};

const buildInlinedSkillPrompt = (skill: Skill): string => {
  const skillDirectory = getSkillDirectoryFromPath(skill.skillPath);
  return [
    `## Skill: ${skill.name}`,
    '<skill_context>',
    `  <location>${skill.skillPath}</location>`,
    `  <directory>${skillDirectory}</directory>`,
    '  <path_rules>',
    '    Resolve relative file references from this skill against <directory>.',
    '    Do not assume skills are under the current workspace directory.',
    '  </path_rules>',
    '</skill_context>',
    '',
    skill.prompt,
  ].join('\n');
};

export interface CoworkPromptInputRef {
  /** 设置输入框值 */
  setValue: (value: string) => void;
  /** 聚焦输入框 */
  focus: () => void;
  /** 从外部（如宿主面板自带的附件按钮）追加附件 */
  addAttachments: (paths: string[]) => void;
  /**
   * Put one quoted transcript fragment into the composer's quote slot (the
   * transcript's selection action bar and the per-message reply entry both
   * call this). The slot is single-target: a new quote replaces the previous
   * one, so the two entries never keep two parallel slots. Tracked separately
   * from file attachments.
   */
  addQuotedSelection: (selection: CoworkQuotedSelection) => void;
}

interface CoworkPromptInputProps {
  onSubmit: (prompt: string, skillPrompt?: string) => void | boolean | Promise<void | boolean>;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  steerDisabled?: boolean;
  scopeKey?: string;
  size?: 'normal' | 'large';
  /** Large variant only: collapse to a single text row, like the DSH WebUI docked session composer. */
  singleLine?: boolean;
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  /** Controlled workspace selection (project / folder / bot workspace). */
  workspaceSelection?: CoworkWorkspaceSelection | null;
  onWorkspaceSelectionChange?: (selection: CoworkWorkspaceSelection) => void;
  /** Open the Settings > Projects > New Project form. */
  onOpenNewProject?: () => void;
  showModelSelector?: boolean;
  /** Show the built-in attachment (paperclip) button. Hosts with their own attachment button can hide it. */
  showAttachmentButton?: boolean;
  /** Controlled per-session model+effort value for the picker (null = fall back to defaults). */
  modelEffortValue?: ModelEffortValue | null;
  onModelEffortChange?: (value: ModelEffortValue) => void;
  /** Estimated context-window usage of the current conversation; shows a ring indicator when provided. */
  contextUsage?: CoworkContextUsage | null;
  onManageSkills?: () => void;
  /** Context-aware follow-up suggestions from the SDK; rendered as clickable chips. */
  suggestedPrompts?: string[];
  /** Show the permission-mode selector in the footer (new-session creation). */
  showPermissionModeSelector?: boolean;
  /** Controlled permission-mode value for the footer selector. */
  permissionMode?: CoworkPermissionMode;
  /** Callback when the footer permission-mode selector changes. */
  onPermissionModeChange?: (mode: CoworkPermissionMode) => void;
  /**
   * Slash-command catalog for the composer (DSH-style '/' picker + claimed
   * `/name ` token rendering). Empty/undefined disables command affordances;
   * the '+' menu then only offers attachments and skills.
   */
  commands?: ComposerCommand[];
  /** Session's bot binding; narrows the skills picker to that bot's view. */
  sessionMetabotId?: number | null;
}

const CoworkPromptInput = React.forwardRef<CoworkPromptInputRef, CoworkPromptInputProps>(
  (props, ref) => {
    const {
      onSubmit,
      onStop,
      isStreaming = false,
      placeholder = 'Enter your task...',
      disabled = false,
      steerDisabled = false,
      scopeKey,
      size = 'normal',
      singleLine = false,
      workingDirectory = '',
      onWorkingDirectoryChange,
      showFolderSelector = false,
      workspaceSelection = null,
      onWorkspaceSelectionChange,
      onOpenNewProject,
      showModelSelector = false,
      showAttachmentButton = true,
      modelEffortValue = null,
      onModelEffortChange,
      contextUsage,
      onManageSkills,
      suggestedPrompts,
      showPermissionModeSelector = false,
      permissionMode,
      onPermissionModeChange,
      commands,
      sessionMetabotId,
    } = props;
    const isMac = (window as { electron?: { platform?: string } }).electron?.platform === 'darwin';
    const dispatch = useDispatch();
    const draftPrompt = useSelector((state: RootState) => state.cowork.draftPrompt);
    const sessionDrafts = useSelector((state: RootState) => state.cowork.sessionDrafts);
    // Scoped composers (session steer input, Bot Browser panel) restore their
    // draft from the per-scope store entry, so switching sessions keeps each
    // session's typed text; the unscoped New Task composer owns the global draft.
    const initialDraftRef = useRef(scopeKey ? (sessionDrafts[scopeKey]?.value ?? '') : draftPrompt);
    const initialAttachmentsRef = useRef(scopeKey ? (sessionDrafts[scopeKey]?.attachments ?? []) : []);
    // Quoted transcript excerpts ride along with the draft (same lifetime, same
    // store entry) but stay a list of their own: they are conversation text,
    // not host paths.
    const initialQuotedSelectionsRef = useRef(scopeKey ? (sessionDrafts[scopeKey]?.quotedSelections ?? []) : []);
    const [value, setValue] = useState(initialDraftRef.current);
    const [attachments, setAttachments] = useState<CoworkAttachment[]>(initialAttachmentsRef.current);
    const [quotedSelections, setQuotedSelections] = useState<CoworkQuotedSelection[]>(initialQuotedSelectionsRef.current);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [plusMenuOpen, setPlusMenuOpen] = useState(false);
    const [skillsMenuOpen, setSkillsMenuOpen] = useState(false);
    // '/' picker: dismissal is user intent (Escape), tracked separately from
    // the query so re-typing '/' after a dismissal still reopens the picker.
    const [commandPickerDismissed, setCommandPickerDismissed] = useState(false);
    const [commandPickerHighlight, setCommandPickerHighlight] = useState(0);
    const [claim, setClaim] = useState<ComposerClaim | null>(null);
    const [commandNotice, setCommandNotice] = useState<string | null>(null);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // The composer card anchors the '/' command picker (fixed placement).
    const composerCardRef = useRef<HTMLDivElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const dragDepthRef = useRef(0);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const plusButtonRef = useRef<HTMLButtonElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Selection captured when the context menu opened; only drives the
    // enabled/disabled state of the menu items. Actions re-read the live
    // selection from the textarea so streaming updates cannot desync them.
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
    const [contextMenuSelection, setContextMenuSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
    const activeScopeKeyRef = useRef(scopeKey);
    // Publish composer state: scoped composers write to the per-session draft
    // store, the unscoped New Task composer keeps owning the global draft. The
    // versioned fields call this on every change, including takeAndClear after
    // a submit, which is what makes drafts persist across session switches.
    const publishComposerState = useCallback((
      nextValue: string,
      nextAttachments: CoworkAttachment[],
      nextQuotedSelections: CoworkQuotedSelection[],
    ) => {
      const scope = activeScopeKeyRef.current;
      if (scope) {
        dispatch(setSessionDraft({
          sessionId: scope,
          value: nextValue,
          attachments: nextAttachments,
          quotedSelections: nextQuotedSelections,
        }));
      } else {
        dispatch(setDraftPrompt(nextValue));
      }
    }, [dispatch]);
    const draftFieldRef = useRef<VersionedComposerField<string> | null>(null);
    const attachmentFieldRef = useRef<VersionedComposerField<CoworkAttachment[]> | null>(null);
    const quotedSelectionFieldRef = useRef<VersionedComposerField<CoworkQuotedSelection[]> | null>(null);
    if (!draftFieldRef.current) {
      draftFieldRef.current = createVersionedComposerField(initialDraftRef.current, () => '', (nextValue) => {
        setValue(nextValue);
        publishComposerState(
          nextValue,
          attachmentFieldRef.current?.get() ?? [],
          quotedSelectionFieldRef.current?.get() ?? [],
        );
      });
    }
    if (!attachmentFieldRef.current) {
      attachmentFieldRef.current = createVersionedComposerField(initialAttachmentsRef.current, () => [], (nextAttachments) => {
        setAttachments(nextAttachments);
        publishComposerState(
          draftFieldRef.current?.get() ?? '',
          nextAttachments,
          quotedSelectionFieldRef.current?.get() ?? [],
        );
      });
    }
    if (!quotedSelectionFieldRef.current) {
      quotedSelectionFieldRef.current = createVersionedComposerField(initialQuotedSelectionsRef.current, () => [], (nextQuotedSelections) => {
        setQuotedSelections(nextQuotedSelections);
        publishComposerState(
          draftFieldRef.current?.get() ?? '',
          attachmentFieldRef.current?.get() ?? [],
          nextQuotedSelections,
        );
      });
    }

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const inputFileLabel = i18nService.t('coworkInputFileLabel');

  const isLarge = size === 'large';
  const minHeight = isLarge ? (singleLine ? 42 : 60) : 24;
  const maxHeight = isLarge ? 336 : 200;

  // Load skills on mount
  useEffect(() => {
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();
  }, [dispatch]);

  useEffect(() => {
    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    });
    return () => {
      unsubscribe();
    };
  }, [dispatch]);

  // Auto-resize textarea.
  //
  // Reading `scrollHeight` forces a synchronous layout of the whole document
  // and the height write right after invalidates it again, so measuring on
  // every keystroke re-lays out a transcript of hundreds of session rows plus
  // thousands of message nodes per key. The read and the write therefore share
  // one rAF callback - coalesced per frame through `resizeFrameRef`, so a burst
  // of keystrokes measures once - and are skipped outright while the rendered
  // row count provably cannot change (see composerTextareaResize).
  const resizeFrameRef = useRef<number | null>(null);
  const resizeMeasurementRef = useRef<ComposerHeightMeasurement | null>(null);
  const observedWidthRef = useRef<number | null>(null);

  const applyTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // 'auto' first, so scrollHeight reports the content height instead of the
    // height applied by the previous pass.
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${composerTextareaHeight(contentHeight, minHeight, maxHeight)}px`;
    // The layout is clean after the read above, so these metrics come without a
    // second flush. They are what the next skip decision is based on.
    const style = getComputedStyle(textarea);
    const glyphWidth = (parseFloat(style.fontSize) || 0) + (parseFloat(style.letterSpacing) || 0);
    const contentWidth = textarea.clientWidth
      - (parseFloat(style.paddingLeft) || 0)
      - (parseFloat(style.paddingRight) || 0);
    resizeMeasurementRef.current = {
      // Taken from the DOM, not from the `value` state: by the time this runs
      // the commit has already written the new text, and scrollHeight describes
      // what the DOM holds.
      value: textarea.value,
      contentWidth,
      glyphWidth,
      minHeight,
      maxHeight,
    };
    observedWidthRef.current = contentWidth;
  }, [minHeight, maxHeight]);

  const scheduleTextareaHeight = useCallback(() => {
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      applyTextareaHeight();
    });
  }, [applyTextareaHeight]);

  const cancelScheduledTextareaHeight = useCallback(() => {
    if (resizeFrameRef.current === null) return;
    cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = null;
  }, []);

  // The measurement taken when the composer mounts (or when min/max height
  // change with it) lands before the browser paints, so the textarea never
  // shows a frame at its default rows height; everything after that goes
  // through the rAF above.
  useLayoutEffect(() => {
    cancelScheduledTextareaHeight();
    applyTextareaHeight();
  }, [applyTextareaHeight, cancelScheduledTextareaHeight]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!shouldRemeasureComposerHeight(resizeMeasurementRef.current, {
      value: textarea.value,
      currentWidth: observedWidthRef.current,
      minHeight,
      maxHeight,
    })) {
      return;
    }
    scheduleTextareaHeight();
  }, [value, minHeight, maxHeight, scheduleTextareaHeight]);

  useEffect(() => cancelScheduledTextareaHeight, [cancelScheduledTextareaHeight]);

  // The box width is the one input of the skip decision the value cannot carry:
  // it decides how much text fits per row. ResizeObserver reports it without a
  // layout read, keeping the keystroke path read-free.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      observedWidthRef.current = entry.contentRect.width;
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [isLarge]);

  // 暴露方法给父组件
  React.useImperativeHandle(ref, () => ({
    setValue: (newValue: string) => {
      draftFieldRef.current?.set(newValue);
      // Prefills and clears go through the same frame-coalesced measurement as
      // the keystroke path, so both agree on what the current height is.
      scheduleTextareaHeight();
    },
    focus: () => {
      textareaRef.current?.focus();
    },
    addAttachments: (paths: string[]) => {
      const field = attachmentFieldRef.current;
      if (!field) return;
      const next = [...field.get()];
      for (const path of paths) {
        if (!path || next.some((attachment) => attachment.path === path)) continue;
        next.push({ path, name: getFileNameFromPath(path) });
      }
      field.set(next);
    },
    addQuotedSelection: (selection: CoworkQuotedSelection) => {
      const field = quotedSelectionFieldRef.current;
      if (!field || !selection || !selection.text.trim()) return;
      // Single-target slot: the newest quote (a hand-picked passage or a
      // message reply) replaces the previous one instead of stacking up; the
      // fragment model still supports N for a future multi-select.
      field.set([selection]);
    },
  }));

  React.useLayoutEffect(() => () => {
    draftFieldRef.current?.invalidate();
    attachmentFieldRef.current?.invalidate();
    quotedSelectionFieldRef.current?.invalidate();
  }, []);

  useEffect(() => {
    if (activeScopeKeyRef.current !== scopeKey) {
      // The composer is reused with a different scope (normally CoworkSessionDetail
      // remounts it per session via key, so this is defensive): invalidate any
      // in-flight submission snapshots and load the new scope's stored draft.
      activeScopeKeyRef.current = scopeKey;
      draftFieldRef.current?.invalidate();
      attachmentFieldRef.current?.invalidate();
      quotedSelectionFieldRef.current?.invalidate();
      if (scopeKey) {
        const stored = sessionDrafts[scopeKey];
        draftFieldRef.current?.set(stored?.value ?? '');
        attachmentFieldRef.current?.set(stored?.attachments ?? []);
        quotedSelectionFieldRef.current?.set(stored?.quotedSelections ?? []);
      } else {
        draftFieldRef.current?.set(draftPrompt);
        attachmentFieldRef.current?.set([]);
        quotedSelectionFieldRef.current?.set([]);
      }
    }
  }, [scopeKey, sessionDrafts, draftPrompt]);

  useEffect(() => {
    const handleFocusInput = (event: Event) => {
      // Navigation events (New Chat, session shortcuts) only focus the input;
      // they must never clear it. Drafts are owned by their scope: the New
      // Task composer keeps the global draft and each session keeps its own
      // stored draft. They are cleared only by a successful submit or when
      // the session itself is deleted.
      //
      // 「新建任务」预填（长期任务看板反馈⑤）：detail.text 在清空逻辑之后
      // 应用（App.tsx 在 clearSession/clearSelection 之后的 setTimeout(0) 里
      // 才派发本事件），经版本化草稿字段写入并落回全局 setDraftPrompt；
      // 聚焦后光标落在 textarea 末尾。
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
      requestAnimationFrame(() => {
        if (typeof text === 'string' && text) {
          draftFieldRef.current?.set(text);
        }
        textareaRef.current?.focus();
        const textarea = textareaRef.current;
        if (textarea && typeof text === 'string' && text) {
          const end = textarea.value.length;
          textarea.setSelectionRange(end, end);
        }
      });
    };
    window.addEventListener('cowork:focus-input', handleFocusInput);
    return () => {
      window.removeEventListener('cowork:focus-input', handleFocusInput);
    };
  }, []);

  useEffect(() => {
    if (workingDirectory?.trim() || workspaceSelection) {
      setShowFolderRequiredWarning(false);
    }
  }, [workingDirectory, workspaceSelection]);

  // ----- Slash commands (DSH-style '+' menu / picker / claim token) -----

  // Any size composer can carry commands: the large home/session composers
  // and the normal Bot Browser panel alike.
  const commandsEnabled = !disabled && commands !== undefined && commands.length > 0;
  const slashQuery = commandsEnabled && !isStreaming ? slashQueryOf(value) : null;
  const commandPickerOpen = slashQuery !== null && !commandPickerDismissed;
  const filteredCommands = React.useMemo(
    () => filterComposerCommands(commands ?? [], slashQuery ?? ''),
    [commands, slashQuery],
  );
  const effectiveCommandHighlight = filteredCommands.length === 0
    ? -1
    : Math.min(commandPickerHighlight, filteredCommands.length - 1);
  // A live claim requires a non-streaming composer: during streaming the
  // draft is a steer message (command adjudication is off), so the amber
  // token must not render as if the command would execute.
  const claimActive = claim !== null && !isStreaming && value.startsWith(claim.token);

  // Leaving the slash-token shape (or a dismissal) resets the picker state.
  useEffect(() => {
    if (slashQuery === null) {
      setCommandPickerDismissed(false);
      setCommandPickerHighlight(0);
    }
  }, [slashQuery]);

  // Claim lifecycle: the claim survives while the draft keeps the `/name `
  // prefix; a draft that already leads with a claimable token (restored
  // draft, manual typing) re-claims automatically. Streaming releases the
  // claim (commands never execute mid-stream).
  useEffect(() => {
    if (isStreaming) {
      if (claim) setClaim(null);
      return;
    }
    if (claim && !value.startsWith(claim.token)) {
      setClaim(null);
      return;
    }
    if (!claim && commandsEnabled) {
      const leading = parseLeadingCommand(value, commands ?? []);
      if (leading && leading.command.hint) {
        const token = commandToken(leading.command);
        if (value.startsWith(token)) {
          setClaim({ command: leading.command, token, hint: leading.command.hint });
        }
      }
    }
  }, [value, claim, commandsEnabled, commands, isStreaming]);

  const showCommandNotice = useCallback((text: string) => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    setCommandNotice(text);
    noticeTimerRef.current = setTimeout(() => {
      setCommandNotice(null);
      noticeTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
  }, []);

  // Close the '+' menu on outside clicks (its items each close it on click).
  const plusMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!plusMenuOpen) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !plusMenuRef.current?.contains(target)
        && !plusButtonRef.current?.contains(target)
      ) {
        setPlusMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [plusMenuOpen]);

  /** Message submit used by commands that steer text into the conversation. */
  const submitMessageForCommand = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return false;
    if (showFolderSelector && !workingDirectory?.trim() && !workspaceSelection) {
      setShowFolderRequiredWarning(true);
      return false;
    }
    setShowFolderRequiredWarning(false);
    try {
      const accepted = await onSubmit(trimmed, undefined);
      return accepted !== false;
    } catch (error) {
      console.error('Composer command message submit failed:', error);
      return false;
    }
  }, [isStreaming, showFolderSelector, workingDirectory, workspaceSelection, onSubmit]);

  /** Execute a command and clear the composer (DSH command-submit behavior). */
  const runCommand = useCallback(async (command: ComposerCommand, args: string) => {
    const ctx: ComposerCommandContext = { submitMessage: submitMessageForCommand };
    try {
      const notice = await command.run(args, ctx);
      if (typeof notice === 'string' && notice) {
        showCommandNotice(notice);
      }
    } catch (error) {
      console.error('Composer command failed:', error);
      showCommandNotice(i18nService.t('composerCommandFailed'));
    }
    draftFieldRef.current?.set('');
    attachmentFieldRef.current?.set([]);
    quotedSelectionFieldRef.current?.set([]);
    setClaim(null);
  }, [showCommandNotice, submitMessageForCommand]);

  /** Picker pick: input commands claim `/name `, no-input commands execute now. */
  const pickCommand = useCallback((command: ComposerCommand) => {
    if (command.hint) {
      const token = commandToken(command);
      draftFieldRef.current?.set(token);
      setClaim({ command, token, hint: command.hint });
      setCommandPickerDismissed(true);
      setCommandPickerHighlight(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    void runCommand(command, '');
  }, [runCommand]);

  const handlePlusMenuAddAttachment = () => {
    setPlusMenuOpen(false);
    void handleAddFile();
  };

  const handlePlusMenuUseSkill = () => {
    setPlusMenuOpen(false);
    setSkillsMenuOpen(true);
  };

  const handlePlusMenuUseCommand = () => {
    setPlusMenuOpen(false);
    if (!commandsEnabled) return;
    if (!value.trim()) {
      draftFieldRef.current?.set('/');
      setCommandPickerDismissed(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      requestAnimationFrame(() => textareaRef.current?.focus());
      showCommandNotice(i18nService.t('composerCommandSeedHint'));
    }
  };

  const handleSubmit = useCallback(async () => {
    if (disabled || (isStreaming && steerDisabled)) return;

    const draftField = draftFieldRef.current;
    const attachmentField = attachmentFieldRef.current;
    const quotedSelectionField = quotedSelectionFieldRef.current;
    if (!draftField || !attachmentField || !quotedSelectionField) return;
    const submittedValue = draftField.get();
    const submittedAttachments = attachmentField.get();
    const submittedQuotedSelections = quotedSelectionField.get();
    const trimmedValue = submittedValue.trim();
    // A steer is sendable when it carries text or quoted excerpts. An empty
    // steer returns before anything is composed or consumed.
    if (isStreaming && !trimmedValue && submittedQuotedSelections.length === 0) return;
    // Slash-command adjudication (DSH port): a live claim, a bare `/name`
    // line, or a manually typed `/name <args>` executes the command instead
    // of sending a message; unknown /-leading text falls through as a
    // normal message.
    if (!isStreaming && commandsEnabled && trimmedValue.startsWith('/')) {
      const activeClaim = claim && submittedValue.startsWith(claim.token) ? claim : null;
      if (activeClaim) {
        const args = submittedValue.slice(activeClaim.token.length).trimStart();
        void runCommand(activeClaim.command, args);
        return;
      }
      const leading = parseLeadingCommand(submittedValue, commands ?? []);
      if (leading && (leading.command.hint || leading.args === '')) {
        void runCommand(leading.command, leading.args);
        return;
      }
    }
    if (!isStreaming && showFolderSelector && !workingDirectory?.trim() && !workspaceSelection) {
      setShowFolderRequiredWarning(true);
      return;
    }
    if (!isStreaming && !trimmedValue && submittedAttachments.length === 0 && submittedQuotedSelections.length === 0) return;
    setShowFolderRequiredWarning(false);

    // Get active skills prompts and combine them
    const activeSkills = isStreaming
      ? []
      : activeSkillIds
        .map(id => skills.find(s => s.id === id))
        .filter((s): s is Skill => s !== undefined);
    const skillPrompt = activeSkills.length > 0
      ? activeSkills.map(buildInlinedSkillPrompt).join('\n\n')
      : undefined;

    const attachmentLines = submittedAttachments.map((attachment) =>
      `${inputFileLabel}: ${attachment.path}`
    ).join('\n');
    // Quoted excerpts are written into the prompt BODY, not merely rendered
    // next to it: the bot re-reads the conversation as plain text each turn, so
    // a highlight alone would never reach it. A steer (mid-turn correction)
    // composes through this same path — replying to a selected passage while
    // the turn runs must carry the excerpt too. Attachment lines stay idle-only:
    // attachments are a disabled semantic while a turn streams and never ride
    // into a steer.
    const finalPrompt = composeSubmittedCoworkPrompt({
      value: trimmedValue,
      quotedSelections: submittedQuotedSelections,
      attachmentLines: isStreaming ? undefined : attachmentLines,
      labels: {
        header: i18nService.t('coworkQuoteBlockHeader'),
        item: i18nService.t('coworkQuoteBlockItem'),
        sourceLabel: {
          user: i18nService.t(QUOTED_SELECTION_SOURCE_KEYS.user),
          assistant: i18nService.t(QUOTED_SELECTION_SOURCE_KEYS.assistant),
          other: i18nService.t(QUOTED_SELECTION_SOURCE_KEYS.other),
        },
        // Whole-message replies label themselves with role + position (and a
        // generating mark) instead of the passage template.
        replyBlockHeader: i18nService.t('coworkQuoteReplyBlockHeader'),
        replyBlockItem: i18nService.t('coworkQuoteReplyBlockItem'),
        replyStreamingMark: i18nService.t('coworkQuoteReplyStreamingMark'),
        replySourceLabel: {
          user: i18nService.t('coworkQuoteReplySourceUser'),
          assistant: i18nService.t('coworkQuoteReplySourceAssistant'),
          other: i18nService.t('coworkQuoteReplySourceOther'),
        },
        truncatedNote: i18nService.t('coworkQuoteTruncatedNote'),
      },
    });

    const draftSnapshot = draftField.takeAndClear();
    let attachmentSnapshot: VersionedComposerSnapshot<CoworkAttachment[]> | null = null;
    // Excerpts are consumed on every submit path (steer included); only the
    // attachment list stays idle-only.
    const quotedSelectionSnapshot = quotedSelectionField.takeAndClear();
    if (!isStreaming) {
      attachmentSnapshot = attachmentField.takeAndClear();
    }
    try {
      const accepted = await runComposerSubmission(
        draftField,
        draftSnapshot,
        () => onSubmit(finalPrompt, isStreaming ? undefined : skillPrompt),
      );
      if (accepted === false) {
        if (attachmentSnapshot) {
          attachmentField.restoreIfUnchanged(attachmentSnapshot);
        }
        quotedSelectionField.restoreIfUnchanged(quotedSelectionSnapshot);
      }
    } catch (error) {
      if (attachmentSnapshot) {
        attachmentField.restoreIfUnchanged(attachmentSnapshot);
      }
      quotedSelectionField.restoreIfUnchanged(quotedSelectionSnapshot);
      console.error('Cowork prompt submission failed:', error);
    }
  }, [isStreaming, disabled, steerDisabled, onSubmit, activeSkillIds, skills, inputFileLabel, showFolderSelector, workingDirectory, workspaceSelection, commandsEnabled, claim, commands, runCommand]);

  const handleSelectSkill = useCallback((skill: Skill) => {
    dispatch(toggleActiveSkill(skill.id));
  }, [dispatch]);

  const handleManageSkills = useCallback(() => {
    if (onManageSkills) {
      onManageSkills();
    }
  }, [onManageSkills]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to submit, Shift+Enter for new line
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    // Claimed token: Backspace with the caret at the token end removes the
    // whole `/name ` token (DSH occurrence-delete behavior).
    if (claimActive && event.key === 'Backspace' && !isComposing && textareaRef.current) {
      const textarea = textareaRef.current;
      if (
        textarea.selectionStart === textarea.selectionEnd
        && textarea.selectionStart === claim!.token.length
      ) {
        event.preventDefault();
        draftFieldRef.current?.set('');
        setClaim(null);
        return;
      }
    }
    if (commandPickerOpen && !isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredCommands.length > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = effectiveCommandHighlight < 0
            ? (delta > 0 ? 0 : filteredCommands.length - 1)
            : (effectiveCommandHighlight + delta + filteredCommands.length) % filteredCommands.length;
          setCommandPickerHighlight(next);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCommandPickerDismissed(true);
        return;
      }
      if (event.key === ' ') {
        // Space after an exact input-command name claims the token.
        const exact = (commands ?? []).find((entry) => entry.name === slashQuery && entry.hint);
        if (exact) {
          event.preventDefault();
          pickCommand(exact);
          return;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey && !disabled) {
        if (effectiveCommandHighlight >= 0 && filteredCommands[effectiveCommandHighlight]) {
          event.preventDefault();
          pickCommand(filteredCommands[effectiveCommandHighlight]);
          return;
        }
        // No matches highlighted: dismiss and fall through to submit.
        setCommandPickerDismissed(true);
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !isComposing && !disabled) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  const handleStopClick = () => {
    if (onStop) {
      onStop();
    }
  };

  const containerClass = isLarge
    ? 'relative rounded-[22px] border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-card focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-claude-accent/40 focus-within:border-claude-accent'
    : 'relative flex items-end gap-2 p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface';

  const textareaClass = isLarge
    ? `w-full resize-none bg-transparent px-4 pt-2.5 pb-2 dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary/60 placeholder:text-claude-textSecondary/60 focus:outline-none text-[14px] leading-[24px] min-h-[${minHeight}px] max-h-[${maxHeight}px]`
    : 'flex-1 resize-none bg-transparent dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary placeholder:text-claude-textSecondary focus:outline-none text-sm leading-relaxed min-h-[24px] max-h-[200px]';

  // Claimed-command variant of the large textarea: glyphs transparent (the
  // backdrop layer paints them), caret keeps a visible accent color.
  const claimTextareaClass = 'w-full resize-none bg-transparent px-4 pt-2.5 pb-2 placeholder:dark:text-claude-darkTextSecondary/60 placeholder:text-claude-textSecondary/60 focus:outline-none text-[14px] leading-[24px] text-transparent caret-claude-accent';

  const handleBackdropScrollSync = (event: React.UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  };

  const truncatePath = (path: string, maxLength = 30): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };

  // In project mode the workspace choice flows through onWorkspaceSelectionChange
  // (project / folder / bot-workspace). Fall back to the legacy directory
  // callback for hosts that only need a raw path.
  const handleWorkspaceSelect = useCallback((selection: CoworkWorkspaceSelection) => {
    if (onWorkspaceSelectionChange) {
      onWorkspaceSelectionChange(selection);
      return;
    }
    if (selection.kind === 'folder' || selection.kind === 'project') {
      onWorkingDirectoryChange?.(selection.cwd);
    }
  }, [onWorkspaceSelectionChange, onWorkingDirectoryChange]);

  const handleSelectProject = useCallback((project: ProjectRecord) => {
    handleWorkspaceSelect({
      kind: 'project',
      projectId: project.id,
      name: project.name,
      cwd: project.sourceDir?.trim() || workingDirectory,
    });
  }, [handleWorkspaceSelect, workingDirectory]);

  const handleSelectBotWorkspace = useCallback(() => {
    handleWorkspaceSelect({ kind: 'botWorkspace' });
  }, [handleWorkspaceSelect]);

  // Label shown on the folder button: project name (or path / bot-workspace).
  const workspaceLabel = workspaceSelection
    ? (workspaceSelection.kind === 'project'
        ? workspaceSelection.name
        : workspaceSelection.kind === 'folder'
          ? truncatePath(workspaceSelection.cwd)
          : i18nService.t('coworkBotWorkspace'))
    : truncatePath(workingDirectory);
  const workspaceTooltip = workspaceSelection
    ? (workspaceSelection.kind === 'project'
        ? workspaceSelection.cwd
        : workspaceSelection.kind === 'folder'
          ? workspaceSelection.cwd
          : i18nService.t('coworkBotWorkspace'))
    : truncatePath(workingDirectory, 120);

  const addAttachment = useCallback((path: string) => {
    if (!path) return;
    const field = attachmentFieldRef.current;
    if (!field) return;
    const prev = field.get();
    if (prev.some((attachment) => attachment.path === path)) {
      return;
    }
    field.set([...prev, { path, name: getFileNameFromPath(path) }]);
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const getNativeFilePath = useCallback((file: File): string | null => {
    const maybePath = (file as File & { path?: string }).path;
    if (typeof maybePath === 'string' && maybePath.trim()) {
      return maybePath;
    }
    return null;
  }, []);

  const saveInlineFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const dataBase64 = await fileToBase64(file);
      if (!dataBase64) {
        return null;
      }
      const result = await window.electron.dialog.saveInlineFile({
        dataBase64,
        fileName: file.name,
        mimeType: file.type,
        cwd: workingDirectory,
      });
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to save inline file:', error);
      return null;
    }
  }, [fileToBase64, workingDirectory]);

  const handleIncomingFiles = useCallback(async (fileList: FileList | File[]) => {
    if (disabled || isStreaming) return;
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      const nativePath = getNativeFilePath(file);
      if (nativePath) {
        addAttachment(nativePath);
        continue;
      }

      const stagedPath = await saveInlineFile(file);
      if (stagedPath) {
        addAttachment(stagedPath);
      }
    }
  }, [addAttachment, disabled, getNativeFilePath, isStreaming, saveInlineFile]);

  const handleAddFile = useCallback(async () => {
    try {
      const result = await window.electron.dialog.selectFile({
        title: i18nService.t('coworkAddFile'),
      });
      if (result.success && result.path) {
        addAttachment(result.path);
      }
    } catch (error) {
      console.error('Failed to select file:', error);
    }
  }, [addAttachment]);

  const handleRemoveAttachment = useCallback((path: string) => {
    const field = attachmentFieldRef.current;
    if (!field) return;
    field.set(field.get().filter((attachment) => attachment.path !== path));
  }, []);

  const handleRemoveQuotedSelection = useCallback((id: string) => {
    const field = quotedSelectionFieldRef.current;
    if (!field) return;
    field.set(removeQuotedSelection(field.get(), id));
  }, []);

  const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    if (dataTransfer.files.length > 0) return true;
    return Array.from(dataTransfer.types).includes('Files');
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (!disabled && !isStreaming) {
      setIsDraggingFiles(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || isStreaming ? 'none' : 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (disabled || isStreaming) return;
    void handleIncomingFiles(event.dataTransfer.files);
  };

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || isStreaming) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void handleIncomingFiles(files);
  }, [disabled, handleIncomingFiles, isStreaming]);

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null);
  }, []);

  const handleTextareaContextMenu = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    if (disabled || (isStreaming && steerDisabled)) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenuSelection({
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    });
    const x = Math.min(
      Math.max(CONTEXT_MENU_PADDING, event.clientX),
      window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_PADDING
    );
    const y = Math.min(
      Math.max(CONTEXT_MENU_PADDING, event.clientY),
      window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_PADDING
    );
    setContextMenuPosition({ x, y });
  };

  const contextMenuDerived = deriveCoworkContextMenuState({
    valueLength: value.length,
    selectionStart: contextMenuSelection.start,
    selectionEnd: contextMenuSelection.end,
    disabled: disabled || (isStreaming && steerDisabled),
  });

  /** Re-read the live selection from the focused textarea (menu keeps it focused). */
  const readLiveSelection = (): { start: number; end: number } => {
    const textarea = textareaRef.current;
    if (!textarea) return { start: 0, end: 0 };
    return { start: textarea.selectionStart, end: textarea.selectionEnd };
  };

  /**
   * Apply a text change through the DOM and let React's onChange drive the
   * versioned composer field, keeping cursor/selection semantics intact.
   */
  const applyTextareaChange = (replaceFrom: number, replaceTo: number, text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.setRangeText(text, replaceFrom, replaceTo, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const runContextMenuSelectAll = () => {
    closeContextMenu();
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.select();
  };

  const runContextMenuCopy = () => {
    closeContextMenu();
    const { start, end } = readLiveSelection();
    const selectedText = (draftFieldRef.current?.get() ?? '').slice(start, end);
    if (!selectedText) return;
    void navigator.clipboard.writeText(selectedText).catch((error) => {
      console.error('Failed to copy from cowork input:', error);
    });
  };

  const runContextMenuCut = () => {
    closeContextMenu();
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readLiveSelection();
    const selectedText = (draftFieldRef.current?.get() ?? '').slice(start, end);
    if (!selectedText) return;
    void (async () => {
      try {
        // Only remove the text after the clipboard write succeeds, otherwise
        // a failed copy would silently delete the selection.
        await navigator.clipboard.writeText(selectedText);
        applyTextareaChange(start, end, '');
      } catch (error) {
        console.error('Failed to cut from cowork input:', error);
      }
    })();
  };

  const runContextMenuPaste = () => {
    closeContextMenu();
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = readLiveSelection();
    void (async () => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch (error) {
        console.error('Failed to read clipboard for cowork paste:', error);
        return;
      }
      // Clipboard items without text (e.g. copied files) must not replace
      // the current selection with nothing.
      if (!text) return;
      applyTextareaChange(start, end, text);
    })();
  };

  useEffect(() => {
    if (!contextMenuPosition) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!contextMenuRef.current?.contains(target)) {
        closeContextMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };
    const handleScroll = () => closeContextMenu();
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [contextMenuPosition, closeContextMenu]);

  const { isSteerSubmit, showStopButton, canSubmit } = deriveCoworkPromptInputState({
    value,
    isStreaming,
    disabled,
    steerDisabled,
    attachmentCount: attachments.length,
    quotedSelectionCount: quotedSelections.length,
  });
  const effectivePlaceholder = deriveCoworkComposerPlaceholder({
    isStreaming,
    steerDisabled,
    hasQuotedSelections: quotedSelections.length > 0,
    idlePlaceholder: placeholder,
  });
  const enhancedContainerClass = isDraggingFiles
    ? `${containerClass} ring-2 ring-claude-accent/50 border-claude-accent/60`
    : containerClass;

  return (
    <div className="relative">
      <CoworkQuotedSelectionTiles
        selections={quotedSelections}
        onRemove={handleRemoveQuotedSelection}
        disabled={disabled || isStreaming}
      />
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
              <div
                key={attachment.path}
                className="inline-flex items-center gap-1.5 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2.5 py-1 text-xs dark:text-claude-darkText text-claude-text max-w-full"
                title={attachment.path}
              >
                <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate max-w-[180px]">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(attachment.path)}
                  disabled={disabled || isStreaming}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('coworkAttachmentRemove')}
                  title={i18nService.t('coworkAttachmentRemove')}
                >
                  <XMarkIcon className="h-3 w-3" />
                </button>
              </div>
          ))}
        </div>
      )}
      <div
        ref={composerCardRef}
        className={enhancedContainerClass}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-claude-accent/10 text-xs font-medium text-claude-accent">
            {i18nService.t('coworkDropFileHint')}
          </div>
        )}
        {commandPickerOpen && (
          <ComposerCommandPicker
            commands={filteredCommands}
            highlightIndex={effectiveCommandHighlight}
            listboxId={COMMAND_PICKER_ID}
            onHighlight={setCommandPickerHighlight}
            onPick={pickCommand}
            anchorRef={composerCardRef}
          />
        )}
        {isLarge ? (
          <>
            <div className="relative">
              {/* Mirror-layer command token (DSH port): while a `/name ` claim
                  is live the textarea's glyphs turn transparent and this
                  backdrop paints the token in the command color plus the ghost
                  hint, sharing the textarea's exact metrics. */}
              {claimActive && claim && (
                <div
                  ref={backdropRef}
                  aria-hidden
                  data-decoration="command-token"
                  className="pointer-events-none absolute inset-0 z-10 overflow-hidden px-4 pt-2.5 pb-2 text-[14px] leading-[24px] whitespace-pre-wrap break-words dark:text-claude-darkText text-claude-text"
                >
                  <span className="font-medium text-amber-600 dark:text-amber-400">{claim.token}</span>
                  {value.slice(claim.token.length)}
                  {value.slice(claim.token.length) === '' && (
                    <span className="dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                      {claim.hint}
                    </span>
                  )}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => draftFieldRef.current?.set(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onContextMenu={handleTextareaContextMenu}
                onScroll={claimActive ? handleBackdropScrollSync : undefined}
                placeholder={effectivePlaceholder}
                disabled={disabled || (isStreaming && steerDisabled)}
                rows={isLarge && singleLine ? 1 : 2}
                className={claimActive ? claimTextareaClass : textareaClass}
                style={{ minHeight: `${minHeight}px` }}
                role={commandPickerOpen ? 'combobox' : undefined}
                aria-expanded={commandPickerOpen || undefined}
                aria-controls={commandPickerOpen ? COMMAND_PICKER_ID : undefined}
                aria-autocomplete={commandPickerOpen ? 'list' : undefined}
                aria-activedescendant={
                  commandPickerOpen && effectiveCommandHighlight >= 0 && filteredCommands[effectiveCommandHighlight]
                    ? `${COMMAND_PICKER_ID}-option-${filteredCommands[effectiveCommandHighlight].name}`
                    : undefined
                }
              />
            </div>
            <div className="flex items-center justify-between px-4 pb-2 pt-1.5">
              <fieldset
                className="flex items-center gap-2 relative border-0 p-0 m-0 min-w-0"
                disabled={disabled || isStreaming}
              >
                <PlusMenuButton
                  open={plusMenuOpen}
                  showAttachment={showAttachmentButton}
                  showCommands={commandsEnabled}
                  buttonRef={plusButtonRef}
                  menuRef={plusMenuRef}
                  onToggle={() => setPlusMenuOpen(!plusMenuOpen)}
                  onAddAttachment={handlePlusMenuAddAttachment}
                  onUseSkill={handlePlusMenuUseSkill}
                  onUseCommand={handlePlusMenuUseCommand}
                />
                {showModelSelector && (
                  <ModelEffortPicker
                    dropdownDirection="up"
                    value={modelEffortValue ?? { modelId: null, providerKey: null, effort: null }}
                    onChange={(value) => onModelEffortChange?.(value)}
                    globalDefaultModel={configService.getConfig().model?.defaultModel ?? null}
                  />
                )}
                <ActiveSkillBadge />
              </fieldset>
              <div className="flex items-center gap-2">
                {contextUsage && (
                  <ContextUsageRing
                    usedTokens={contextUsage.usedTokens}
                    contextWindow={contextUsage.contextWindow}
                    isRealUsage={contextUsage.isRealUsage}
                    categories={contextUsage.categories}
                  />
                )}
                {/* Composer send/stop icon ink: deep orange #9A3412 — a deliberate
                    exception to the near-black accentInk used by every other
                    yellow-fill button (user preference, do not unify). */}
                {showStopButton ? (
                  <button
                    type="button"
                    onClick={handleStopClick}
                    className="p-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-[#9A3412] transition-all shadow-subtle hover:shadow-card active:scale-95"
                    aria-label={i18nService.t('stop')}
                  >
                    <StopIcon className="h-5 w-5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { void handleSubmit(); }}
                    disabled={!canSubmit}
                    className="p-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-[#9A3412] transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={isSteerSubmit ? i18nService.t('coworkSendSteer') : i18nService.t('sendMessage')}
                  >
                    <PaperAirplaneIcon className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <PlusMenuButton
              open={plusMenuOpen}
              showAttachment={showAttachmentButton}
              showCommands={commandsEnabled}
              buttonRef={plusButtonRef}
              menuRef={plusMenuRef}
              onToggle={() => setPlusMenuOpen(!plusMenuOpen)}
              onAddAttachment={handlePlusMenuAddAttachment}
              onUseSkill={handlePlusMenuUseSkill}
              onUseCommand={handlePlusMenuUseCommand}
            />
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => draftFieldRef.current?.set(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onContextMenu={handleTextareaContextMenu}
              placeholder={effectivePlaceholder}
              disabled={disabled || (isStreaming && steerDisabled)}
              rows={1}
              className={textareaClass}
            />

            {/* Same composer-only deep-orange ink as the wide layout above. */}
            {showStopButton ? (
              <button
                type="button"
                onClick={handleStopClick}
                className="flex-shrink-0 p-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-[#9A3412] transition-all shadow-subtle hover:shadow-card active:scale-95"
                aria-label={i18nService.t('stop')}
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { void handleSubmit(); }}
                disabled={!canSubmit}
                className="flex-shrink-0 p-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-[#9A3412] transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={isSteerSubmit ? i18nService.t('coworkSendSteer') : i18nService.t('sendMessage')}
              >
                <PaperAirplaneIcon className="h-4 w-4" />
              </button>
            )}
          </>
        )}
      </div>
      {(showFolderSelector || (showPermissionModeSelector && onPermissionModeChange)) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {showFolderSelector && (
            <>
              <div className="relative group">
                <button
                  ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                  type="button"
                  onClick={() => setShowFolderMenu(!showFolderMenu)}
                  disabled={disabled || isStreaming}
                  className="flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset dark:hover:text-claude-darkText hover:text-claude-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label={i18nService.t('coworkWorkingDirectory')}
                >
                  <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="max-w-[180px] truncate">
                    {workspaceLabel}
                  </span>
                  <ChevronDownIcon
                    className={`h-3 w-3 flex-shrink-0 opacity-60 transition-transform ${showFolderMenu ? 'rotate-180' : ''}`}
                  />
                </button>
                {/* Tooltip - hidden when folder menu is open */}
                {!showFolderMenu && (
                  <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-50 max-w-[400px] break-all whitespace-nowrap">
                    {workspaceTooltip}
                  </div>
                )}
              </div>
              <FolderSelectorPopover
                isOpen={showFolderMenu}
                onClose={() => setShowFolderMenu(false)}
                onSelectFolder={(path) => handleWorkspaceSelect({ kind: 'folder', cwd: path })}
                onSelectProject={handleSelectProject}
                onOpenNewProject={onOpenNewProject}
                onSelectBotWorkspace={handleSelectBotWorkspace}
                anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                currentFolder={workingDirectory}
              />
            </>
          )}
          {showPermissionModeSelector && onPermissionModeChange && (
            <PermissionModeSelector
              currentMode={permissionMode ?? 'default'}
              onModeChange={onPermissionModeChange}
              disabled={disabled || isStreaming}
              chevron
            />
          )}
        </div>
      )}
      {commandNotice && (
        <div className="mt-2 text-xs text-amber-600 dark:text-amber-400" role="status">
          {commandNotice}
        </div>
      )}
      <SkillsPopover
        isOpen={skillsMenuOpen}
        onClose={() => setSkillsMenuOpen(false)}
        onSelectSkill={handleSelectSkill}
        onManageSkills={handleManageSkills}
        anchorRef={plusButtonRef as React.RefObject<HTMLElement>}
        metabotId={sessionMetabotId}
      />
      {showFolderRequiredWarning && (
        <div className="mt-2 text-xs text-red-500 dark:text-red-400">
          {i18nService.t('coworkSelectFolderFirst')}
        </div>
      )}
      {suggestedPrompts && suggestedPrompts.length > 0 && !disabled && (
        <div className="mt-2 flex flex-wrap gap-2">
          {suggestedPrompts.map((suggestion, index) => (
            <button
              key={`prompt-suggestion-${index}`}
              type="button"
              onClick={() => {
                draftFieldRef.current?.set(suggestion);
                textareaRef.current?.focus();
              }}
              className="inline-flex items-center gap-1 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset hover:dark:text-claude-darkText hover:text-claude-text transition-colors max-w-full text-left"
            >
              <SparklesIcon className="h-3 w-3 flex-shrink-0 text-claude-accent" />
              <span className="truncate">{suggestion}</span>
            </button>
          ))}
        </div>
      )}
      {contextMenuPosition && (
        <div
          ref={contextMenuRef}
          role="menu"
          className="fixed z-50 min-w-[176px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden py-1"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ContextMenuItem
            label={i18nService.t('contextMenuCut')}
            shortcut={isMac ? '⌘X' : 'Ctrl+X'}
            disabled={!contextMenuDerived.canCut}
            onClick={runContextMenuCut}
          />
          <ContextMenuItem
            label={i18nService.t('contextMenuCopy')}
            shortcut={isMac ? '⌘C' : 'Ctrl+C'}
            disabled={!contextMenuDerived.canCopy}
            onClick={runContextMenuCopy}
          />
          <ContextMenuItem
            label={i18nService.t('contextMenuPaste')}
            shortcut={isMac ? '⌘V' : 'Ctrl+V'}
            disabled={disabled || (isStreaming && steerDisabled)}
            onClick={runContextMenuPaste}
          />
          <div className="my-1 h-px dark:bg-claude-darkBorder bg-claude-border" />
          <ContextMenuItem
            label={i18nService.t('contextMenuSelectAll')}
            shortcut={isMac ? '⌘A' : 'Ctrl+A'}
            disabled={!contextMenuDerived.canSelectAll}
            onClick={runContextMenuSelectAll}
          />
        </div>
      )}
    </div>
  );
  }
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
