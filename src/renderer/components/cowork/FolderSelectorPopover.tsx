import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { FolderPlusIcon, ClockIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, BriefcaseIcon, PlusIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { projectsService } from '../../services/projects';
import { getCompactFolderName } from '../../utils/path';
import { placePopoverAbove, useAnchorMoveWatcher } from '../../utils/anchoredPopover';
import type { ProjectRecord } from '../../types/project';

// Custom tooltip for folder paths
interface PathTooltipProps {
  path: string;
  anchorRect: DOMRect | null;
  visible: boolean;
}

const PathTooltip: React.FC<PathTooltipProps> = ({ path, anchorRect, visible }) => {
  if (!visible || !anchorRect) return null;

  // Position tooltip above the item, centered
  const style: React.CSSProperties = {
    position: 'fixed',
    top: anchorRect.top - 8,
    left: anchorRect.left + anchorRect.width / 2,
    transform: 'translate(-50%, -100%)',
    maxWidth: '400px',
    zIndex: 100,
  };

  return (
    <div
      style={style}
      className="glass-surface px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl break-all pointer-events-none"
    >
      {path}
    </div>
  );
};

interface FolderSelectorPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFolder: (path: string) => void;
  anchorRef: React.RefObject<HTMLElement>;
  currentFolder?: string;
  onOpenCurrentFolder?: (path: string) => Promise<void> | void;
  /** Present in the New Task home composer: enables the project-aware menu. */
  onSelectProject?: (project: ProjectRecord) => void;
  /** Open the Settings > Projects > New Project form. */
  onOpenNewProject?: () => void;
  /** Select the default bot workspace ({botid}/{date}) resolution. */
  onSelectBotWorkspace?: () => void;
}

const FolderSelectorPopover: React.FC<FolderSelectorPopoverProps> = ({
  isOpen,
  onClose,
  onSelectFolder,
  anchorRef,
  currentFolder = '',
  onOpenCurrentFolder,
  onSelectProject,
  onOpenNewProject,
  onSelectBotWorkspace,
}) => {
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [showRecentSubmenu, setShowRecentSubmenu] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [submenuPosition, setSubmenuPosition] = useState({ top: 0, left: 0 });
  const [tooltipState, setTooltipState] = useState<{
    visible: boolean;
    path: string;
    rect: DOMRect | null;
  }>({ visible: false, path: '', rect: null });
  const popoverRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const recentFoldersRef = useRef<HTMLDivElement>(null);
  const tooltipTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);

  // Project-aware menu shows Settings > Projects entries instead of the legacy
  // folder-centric menu. Kept distinct so Bot Browser's folder picker is unaffected.
  const projectMode = typeof onSelectProject === 'function';

  const FOLDER_POPOVER_WIDTH = 224; // w-56

  // Position the main popover with position:fixed so it is anchored purely to
  // the folder button and escapes the sidebar's relative/overflow-hidden
  // ancestors (otherwise it lands at the panel's top-left). Grows to the left by
  // default and flips to the right when space is tight.
  const updatePlacement = useCallback(() => {
    if (!anchorRef.current || !popoverRef.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const popoverRect = popoverRef.current.getBoundingClientRect();
    const placement = placePopoverAbove(
      anchorRect,
      { width: popoverRect.width, height: popoverRect.height },
      FOLDER_POPOVER_WIDTH,
    );
    setPopoverStyle({
      position: 'fixed',
      top: placement.top,
      left: placement.left,
      width: placement.width,
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePlacement();
  }, [isOpen, updatePlacement]);

  // Re-place when the anchor MOVES without any window-level event (sidebar
  // width drag, the composer textarea auto-growing beneath it).
  useAnchorMoveWatcher(anchorRef, isOpen, updatePlacement);

  useEffect(() => {
    if (!isOpen) return;
    const handle = () => updatePlacement();
    window.addEventListener('resize', handle);
    window.addEventListener('scroll', handle, true);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener('scroll', handle, true);
    };
  }, [isOpen, updatePlacement]);

  // Cleanup tooltip timer on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) {
        clearTimeout(tooltipTimerRef.current);
      }
    };
  }, []);

  // Load menu data when popover opens: projects (project mode) or recent folders.
  useEffect(() => {
    if (isOpen) {
      if (projectMode) {
        (async () => {
          try {
            const loaded = await projectsService.loadProjects();
            setProjects([...loaded]);
          } catch (error) {
            console.error('Failed to load projects:', error);
            setProjects([]);
          }
        })();
      } else {
        const loadRecentFolders = async () => {
          setIsLoading(true);
          try {
            const folders = await coworkService.getRecentCwds(10);
            setRecentFolders(folders);
          } catch (error) {
            console.error('Failed to load recent folders:', error);
            setRecentFolders([]);
          } finally {
            setIsLoading(false);
          }
        };
        loadRecentFolders();
      }
    } else {
      setShowRecentSubmenu(false);
      // Clear tooltip when popover closes
      setTooltipState({ visible: false, path: '', rect: null });
      if (tooltipTimerRef.current) {
        clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
    }
  }, [isOpen, projectMode]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideSubmenu = submenuRef.current?.contains(target);
      const isInsideAnchor = anchorRef.current?.contains(target);

      if (!isInsidePopover && !isInsideSubmenu && !isInsideAnchor) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Calculate submenu position relative to the Recent Folders button
  useEffect(() => {
    if (showRecentSubmenu && recentFoldersRef.current) {
      const rect = recentFoldersRef.current.getBoundingClientRect();
      setSubmenuPosition({
        top: rect.top,
        left: rect.right + 4, // 4px gap
      });
    }
  }, [showRecentSubmenu]);

  const handleAddFolder = async () => {
    try {
      const result = await window.electron.dialog.selectDirectory();
      if (result.success && result.path) {
        onSelectFolder(result.path);
        onClose();
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleSelectRecentFolder = (path: string) => {
    onSelectFolder(path);
    onClose();
  };

  const handleSelectProject = (project: ProjectRecord) => {
    if (!onSelectProject) return;
    onSelectProject(project);
    onClose();
  };

  const handleOpenNewProject = () => {
    if (!onOpenNewProject) return;
    onOpenNewProject();
    onClose();
  };

  const handleSelectBotWorkspace = () => {
    if (!onSelectBotWorkspace) return;
    onSelectBotWorkspace();
    onClose();
  };

  const handleFolderMouseEnter = useCallback((path: string, event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Clear any existing timer
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current);
    }
    // Show tooltip after a short delay
    tooltipTimerRef.current = setTimeout(() => {
      setTooltipState({
        visible: true,
        path: getCompactFolderName(path, 120) || i18nService.t('noFolderSelected'),
        rect,
      });
    }, 300);
  }, []);

  const handleFolderMouseLeave = useCallback(() => {
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setTooltipState({ visible: false, path: '', rect: null });
  }, []);

  const truncatePath = (path: string, maxLength = 40): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };
  const trimmedCurrentFolder = currentFolder.trim();
  const showOpenCurrentFolder = trimmedCurrentFolder.length > 0;

  const handleOpenCurrentFolder = async () => {
    if (!showOpenCurrentFolder) return;

    try {
      if (onOpenCurrentFolder) {
        await onOpenCurrentFolder(trimmedCurrentFolder);
      } else {
        await window.electron.shell.openPath(trimmedCurrentFolder);
      }
    } catch (error) {
      console.error('Failed to open current folder:', error);
    } finally {
      onClose();
    }
  };

  if (!isOpen) return null;

  const itemClass = 'w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-black/[0.045] dark:hover:bg-white/[0.07] transition-colors';

  return (
    <>
      {/* Main popover */}
      <div
        ref={popoverRef}
        className="glass-surface fixed w-56 rounded-lg z-50"
        style={popoverStyle ?? { visibility: 'hidden' }}
      >
        {projectMode ? (
          <>
            {/* Projects from Settings > Projects */}
            {projects.map((project, index) => (
              <button
                key={project.id}
                onClick={() => handleSelectProject(project)}
                className={`${itemClass} ${index === 0 ? 'rounded-t-lg' : ''}`}
                title={project.sourceDir || project.name}
              >
                {project.icon ? (
                  <img src={project.icon} alt="" className="h-4 w-4 flex-shrink-0 rounded-sm object-cover" />
                ) : (
                  <BriefcaseIcon className="h-4 w-4 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                )}
                <span className="truncate">{project.name}</span>
              </button>
            ))}

            {/* New project */}
            <button
              onClick={handleOpenNewProject}
              className={`${itemClass} ${projects.length === 0 ? 'rounded-t-lg' : ''}`}
            >
              <PlusIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <span>{i18nService.t('coworkNewProject')}</span>
            </button>

            {/* Divider */}
            <div className="my-1 border-t border-glass-line" />

            {/* Open folder */}
            <button onClick={handleAddFolder} className={itemClass}>
              <FolderOpenIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <span>{i18nService.t('coworkOpenFolderPicker')}</span>
            </button>

            {/* Bot workspace */}
            <button onClick={handleSelectBotWorkspace} className={`${itemClass} rounded-b-lg`}>
              <FolderIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <span>{i18nService.t('coworkBotWorkspace')}</span>
            </button>
          </>
        ) : (
          <>
            {showOpenCurrentFolder && (
              <button
                onClick={handleOpenCurrentFolder}
                className={`${itemClass} rounded-t-lg`}
              >
                <FolderOpenIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('coworkOpenCurrentFolder')}</span>
              </button>
            )}

            {/* Add Folder option */}
            <button
              onClick={handleAddFolder}
              className={`${itemClass} ${showOpenCurrentFolder ? '' : 'rounded-t-lg'}`}
            >
              <FolderPlusIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <span>{i18nService.t('addFolder')}</span>
            </button>

            {/* Recent Folders option */}
            <div
              ref={recentFoldersRef}
              className="relative"
              onMouseEnter={() => setShowRecentSubmenu(true)}
              onMouseLeave={() => setShowRecentSubmenu(false)}
            >
              <button className={`${itemClass} justify-between rounded-b-lg`}>
                <div className="flex items-center gap-3">
                  <ClockIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                  <span>{i18nService.t('recentFolders')}</span>
                </div>
                <ChevronRightIcon className="h-3 w-3 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              </button>
            </div>
          </>
        )}

        {/* Workspace instructions hint: sessions honor AGENTS.md / CLAUDE.md
            from the chosen folder, its ancestor git repositories, and any
            symlinked files (the same discovery the DeepSeek Harness web UI
            applies). */}
        <div className="px-3 pb-2 pt-0.5 text-[10px] leading-3 glass-text-secondary">
          {i18nService.t('workspaceInstructionsHint')}
        </div>
      </div>

      {/* Recent folders submenu - rendered as a portal-like fixed element */}
      {!projectMode && showRecentSubmenu && (
        <div
          ref={submenuRef}
          className="glass-surface fixed w-64 max-h-80 overflow-y-auto rounded-lg z-[60]"
          style={{ top: submenuPosition.top, left: submenuPosition.left }}
          onMouseEnter={() => setShowRecentSubmenu(true)}
          onMouseLeave={() => setShowRecentSubmenu(false)}
        >
          {isLoading ? (
            <div className="px-3 py-2.5 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          ) : recentFolders.length === 0 ? (
            <div className="px-3 py-2.5 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('noRecentFolders')}
            </div>
          ) : (
            recentFolders.map((folder, index) => (
              <button
                key={index}
                onClick={() => handleSelectRecentFolder(folder)}
                onMouseEnter={(e) => handleFolderMouseEnter(folder, e)}
                onMouseLeave={handleFolderMouseLeave}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-black/[0.045] dark:hover:bg-white/[0.07] transition-colors text-left first:rounded-t-lg last:rounded-b-lg"
              >
                <FolderIcon className="h-4 w-4 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span className="truncate">{truncatePath(folder)}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* Path tooltip */}
      <PathTooltip
        path={tooltipState.path}
        anchorRect={tooltipState.rect}
        visible={tooltipState.visible}
      />
    </>
  );
};

export default FolderSelectorPopover;
