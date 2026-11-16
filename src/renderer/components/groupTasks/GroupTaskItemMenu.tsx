import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveBoxIcon, ClipboardDocumentIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { GroupTaskSummary } from '../../types/groupTask';
import { scrollEventMovesAnchor } from '../../utils/anchoredPopover';

export const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

export interface GroupTaskItemMenuRenderApi {
  isRenaming: boolean;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onRenameInputChange: (value: string) => void;
  onRenameInputKeyDown: (event: React.KeyboardEvent) => void;
  onRenameInputBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
  openMenu: (event: React.MouseEvent) => void;
  openMenuAt: (clientX: number, clientY: number) => void;
  closeMenu: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  actionButtonRef: React.RefObject<HTMLButtonElement | null>;
  menuPosition: { x: number; y: number } | null;
  renderMenu: () => React.ReactNode;
  renderArchiveConfirm: () => React.ReactNode;
}

interface GroupTaskItemMenuProps {
  task: GroupTaskSummary;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onCopyGroupId: () => void;
  children: (api: GroupTaskItemMenuRenderApi) => React.ReactNode;
}

const MENU_WIDTH = 180;
const MENU_HEIGHT = 160;
const PADDING = 8;

/**
 * Context menu for one group-task list item — copy group ID / rename (local
 * display name) / pin / archive, mirroring the cowork session item menu.
 * The list item renders its own content via the render-prop and calls
 * `openMenuAt` (right-click) / `openMenu` (action button); everything menu-
 * related (positioning, click-outside, rename input, archive confirm) lives
 * here so the sidebar and the main list share one implementation.
 */
const GroupTaskItemMenu: React.FC<GroupTaskItemMenuProps> = ({
  task,
  onTogglePin,
  onRename,
  onArchive,
  onCopyGroupId,
  children,
}) => {
  const [showConfirmArchive, setShowConfirmArchive] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(task.displayName ?? task.title);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);
  // Right-click opens the menu at the cursor; the reposition effect must not
  // snap it back to the action button.
  const menuPositionFromContextMenuRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(task.displayName ?? task.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, task.displayName, task.title]);

  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.min(
      Math.max(PADDING, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - PADDING
    );
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - PADDING);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    const position = calculateMenuPosition(MENU_HEIGHT);
    if (position) {
      setMenuPosition(position);
    }
    setShowConfirmArchive(false);
  };

  /** Open the menu at the mouse position (right-click entry point). */
  const openMenuAt = (clientX: number, clientY: number) => {
    if (isRenaming) return;
    const x = Math.min(
      Math.max(PADDING, clientX),
      window.innerWidth - MENU_WIDTH - PADDING
    );
    const y = Math.min(
      Math.max(PADDING, clientY),
      window.innerHeight - MENU_HEIGHT - PADDING
    );
    menuPositionFromContextMenuRef.current = true;
    setMenuPosition({ x, y });
    setShowConfirmArchive(false);
  };

  const closeMenu = () => {
    setMenuPosition(null);
    setShowConfirmArchive(false);
  };

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTogglePin(!task.pinned);
    closeMenu();
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setRenameValue(task.displayName ?? task.title);
    setShowConfirmArchive(false);
    setMenuPosition(null);
  };

  const handleRenameSave = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle !== (task.displayName ?? task.title)) {
      onRename(nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(task.displayName ?? task.title);
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  const handleArchiveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmArchive(true);
    setMenuPosition(null);
  };

  const handleConfirmArchive = () => {
    onArchive();
    setShowConfirmArchive(false);
  };

  const handleCancelArchive = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmArchive(false);
  };

  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    // The capture listener hears every scroll in the app — including a running
    // chat auto-pinning to the bottom on each streamed chunk. That scroll never
    // moves this row, so it must not dismiss the menu; only scrolls that move
    // the anchor (its own list container, or the document) do.
    const handleScroll = (event: Event) => {
      if (scrollEventMovesAnchor(event, actionButtonRef.current)) closeMenu();
    };
    const handleResize = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [menuPosition]);

  useEffect(() => {
    if (!menuPosition) return;
    // Right-click positioning is anchored to the cursor: keep it as-is.
    if (menuPositionFromContextMenuRef.current) {
      menuPositionFromContextMenuRef.current = false;
      return;
    }
    const menuHeight = showConfirmArchive ? 112 : MENU_HEIGHT;
    const position = calculateMenuPosition(menuHeight);
    if (position && (position.x !== menuPosition.x || position.y !== menuPosition.y)) {
      setMenuPosition(position);
    }
  }, [menuPosition, showConfirmArchive]);

  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  const pinButtonLabel = task.pinned
    ? i18nService.t('coworkUnpinSession')
    : i18nService.t('coworkPinSession');
  const copyGroupIdLabel = i18nService.t('groupTaskCopyGroupId');
  const renameLabel = i18nService.t('renameConversation');
  const archiveLabel = i18nService.t('archiveSession');

  const menuItems = useMemo(() => {
    return [
      { key: 'copy-group-id', label: copyGroupIdLabel, onClick: onCopyGroupId },
      { key: 'rename', label: renameLabel, onClick: handleRenameClick },
      { key: 'pin', label: pinButtonLabel, onClick: handleTogglePin },
      { key: 'archive', label: archiveLabel, onClick: handleArchiveClick },
    ];
  }, [
    copyGroupIdLabel,
    archiveLabel,
    onCopyGroupId,
    handleRenameClick,
    handleTogglePin,
    pinButtonLabel,
    renameLabel,
  ]);

  const renderMenu = () =>
    menuPosition ? (
      <div
        ref={menuRef}
        className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
        style={{ top: menuPosition.y, left: menuPosition.x }}
        role="menu"
      >
        {menuItems.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            {item.key === 'copy-group-id' && <ClipboardDocumentIcon className="h-4 w-4" />}
            {item.key === 'rename' && <PencilSquareIcon className="h-4 w-4" />}
            {item.key === 'pin' && (
              <PushPinIcon
                slashed={task.pinned}
                className={`h-4 w-4 ${task.pinned ? 'opacity-60' : ''}`}
              />
            )}
            {item.key === 'archive' && <ArchiveBoxIcon className="h-4 w-4" />}
            {item.label}
          </button>
        ))}
      </div>
    ) : null;

  const renderArchiveConfirm = () =>
    showConfirmArchive ? (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={handleCancelArchive}
      >
        <div
          className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="p-2 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover">
              <ArchiveBoxIcon className="h-5 w-5 text-claude-accent dark:text-claude-darkAccent" />
            </div>
            <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('groupTaskArchiveConfirmTitle')}
            </h2>
          </div>
          <div className="px-5 pb-4">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('groupTaskArchiveConfirmMessage')}
            </p>
          </div>
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
            <button
              onClick={handleCancelArchive}
              className="px-4 py-2 text-sm font-medium inline-flex items-center justify-center rounded-[var(--shape-radius-md)] border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              onClick={handleConfirmArchive}
              className="px-4 py-2 text-sm font-medium inline-flex items-center justify-center rounded-[var(--shape-radius-md)] border border-[var(--btn-primary-edge)] bg-claude-accent hover:brightness-[0.96] active:brightness-[0.9] text-claude-accentInk transition-[filter]"
            >
              {i18nService.t('archiveSession')}
            </button>
          </div>
        </div>
      </div>
    ) : null;

  const api: GroupTaskItemMenuRenderApi = {
    isRenaming,
    renameValue,
    renameInputRef,
    onRenameInputChange: setRenameValue,
    onRenameInputKeyDown: (event) => {
      if (event.key === 'Enter') {
        handleRenameSave(event);
      }
      if (event.key === 'Escape') {
        handleRenameCancel(event);
      }
    },
    onRenameInputBlur: handleRenameBlur,
    openMenu,
    openMenuAt,
    closeMenu,
    menuRef,
    actionButtonRef,
    menuPosition,
    renderMenu,
    renderArchiveConfirm,
  };

  return <>{children(api)}</>;
};

export default GroupTaskItemMenu;
