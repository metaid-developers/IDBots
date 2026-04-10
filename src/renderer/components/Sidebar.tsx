import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import { MagnifyingGlassIcon, PuzzlePieceIcon, ClockIcon, CpuChipIcon, ShoppingBagIcon } from '@heroicons/react/24/outline';
import ComposeIcon from './icons/ComposeIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import { P2PStatusBadge } from './p2p/P2PStatusBadge';
import { getSidebarPrimaryNavModel } from './sidebar/sidebarNavigation.js';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'metaapps' | 'skills' | 'scheduledTasks' | 'metabots' | 'gigSquare';
  onShowMetaApps: () => void;
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowGigSquare: () => void;
  onShowMetabots: () => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  updateBadge?: React.ReactNode;
}

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowMetaApps,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowGigSquare,
  onShowMetabots,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const isMac = window.electron.platform === 'darwin';
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running'
  );
  const primaryNavItems = getSidebarPrimaryNavModel({
    t: (key) => i18nService.t(key),
    hasRunningScheduledTask,
  });

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
  }, [isCollapsed]);

  const handleSelectSession = async (sessionId: string) => {
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.deleteSession(sessionId);
  };

  const handleTogglePin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
  };

  const handlePrimaryNavClick = (itemId: string) => {
    setIsSearchOpen(false);
    if (itemId === 'scheduledTasks') {
      onShowScheduledTasks();
      return;
    }
    if (itemId === 'gigSquare') {
      onShowGigSquare();
      return;
    }
    if (itemId === 'metaapps') {
      onShowMetaApps();
      return;
    }
    if (itemId === 'skills') {
      onShowSkills();
      return;
    }
    if (itemId === 'metabots') {
      onShowMetabots();
    }
  };

  const renderNavIcon = (icon: string) => {
    if (icon === 'clock') return <ClockIcon className="h-4 w-4" />;
    if (icon === 'shoppingBag') return <ShoppingBagIcon className="h-4 w-4 shrink-0" />;
    if (icon === 'squares2x2') return <MagnifyingGlassIcon className="h-4 w-4 opacity-0 absolute pointer-events-none" />;
    if (icon === 'puzzlePiece') return <PuzzlePieceIcon className="h-4 w-4" />;
    return <CpuChipIcon className="h-4 w-4" />;
  };

  const renderNavContent = (item: ReturnType<typeof getSidebarPrimaryNavModel>[number]) => {
    if (item.id === 'scheduledTasks') {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          {item.hasIndicator ? (
            <span
              aria-hidden
              className="scheduled-task-running-indicator shrink-0"
            />
          ) : null}
          <span className="truncate">{item.label}</span>
        </span>
      );
    }

    if (item.id === 'gigSquare') {
      return (
        <span className="inline-flex items-center gap-1 min-w-0">
          <span className="truncate">{item.label}</span>
          <span
            className="shrink-0 rounded px-0.5 py-px text-[9px] font-medium leading-none text-claude-textSecondary dark:text-claude-darkTextSecondary border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted"
            aria-hidden
          >
            {item.badge}
          </span>
        </span>
      );
    }

    return <span className="truncate">{item.label}</span>;
  };

  const renderPrimaryNavIcon = (item: ReturnType<typeof getSidebarPrimaryNavModel>[number]) => {
    if (item.icon === 'squares2x2') {
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    }

    return renderNavIcon(item.icon);
  };

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col sidebar-transition overflow-hidden ${
        isCollapsed ? 'w-0' : 'w-72'
      }`}
    >
      <div className="pt-3 pb-3">
        <div className="draggable sidebar-header-drag h-8 flex items-center justify-between px-3">
          <div className={`${isMac ? 'pl-[68px]' : ''}`}>
            {updateBadge}
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
        </div>
        <div className="mt-3 space-y-1 px-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onNewChat}
              className="btn-idchat-primary flex-1 inline-flex items-center justify-center gap-2 px-2.5 py-2 text-sm font-medium"
            >
              <ComposeIcon className="h-4 w-4" />
              {i18nService.t('newChat')}
            </button>
            <button
              type="button"
              onClick={() => {
                onShowCowork();
                setIsSearchOpen(true);
              }}
              className="shrink-0 h-[36px] w-[36px] inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              aria-label={i18nService.t('search')}
            >
              <MagnifyingGlassIcon className="h-4 w-4" />
            </button>
          </div>
          {primaryNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handlePrimaryNavClick(item.id)}
              className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-base font-medium transition-colors ${
                activeView === item.id
                  ? 'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              {renderPrimaryNavIcon(item)}
              {renderNavContent(item)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-4 pt-2 mt-1">
        <div className="px-3 pb-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkHistory')}
        </div>
        <CoworkSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRenameSession}
        />
      </div>
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onRenameSession={handleRenameSession}
      />
      <div className="px-3 pb-3 pt-1">
        <div className="mb-1">
          <P2PStatusBadge />
        </div>
        <button
          type="button"
          onClick={() => onShowSettings()}
          className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('settings')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M14 17H5" />
            <path d="M19 7h-9" />
            <circle cx="17" cy="17" r="3" />
            <circle cx="7" cy="7" r="3" />
          </svg>
          {i18nService.t('settings')}
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
