import React from 'react';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import MetabotsManager from './MetabotsManager';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface MetabotsViewProps {
  isSidebarCollapsed?: boolean;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  onRequestModelSettings?: () => void;
  onOpenMetabotInBrowser?: (metabot: Metabot) => void;
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  onRequestMetaApps?: () => void;
}

const MetabotsView: React.FC<MetabotsViewProps> = ({
  isSidebarCollapsed,
  onNewChat,
  updateBadge,
  onRequestModelSettings,
  onOpenMetabotInBrowser,
  onPreviewMetaAppHomepage,
  onRequestMetaApps,
}) => {
  const isMac = window.electron.platform === 'darwin';
  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      <div className="draggable flex h-[52px] items-center justify-between px-6 border-b border-slate-900/[0.095] dark:border-white/[0.085] shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-[8px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-[15.5px] font-bold tracking-[-0.015em] text-[#181d25] dark:text-[#f3f5f8]">
            {i18nService.t('metabots')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-[1020px] mx-auto px-6 py-6">
          <MetabotsManager
            onRequestModelSettings={onRequestModelSettings}
            onOpenMetabotInBrowser={onOpenMetabotInBrowser}
            onPreviewMetaAppHomepage={onPreviewMetaAppHomepage}
            onRequestMetaApps={onRequestMetaApps}
          />
        </div>
      </div>
    </div>
  );
};

export default MetabotsView;
