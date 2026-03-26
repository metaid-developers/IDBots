import React, { useEffect, useMemo, useState } from 'react';
import {
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { metaAppService } from '../../services/metaApp';
import type { MetaAppRecord } from '../../types/metaApp';
import ErrorMessage from '../ErrorMessage';
import Tooltip from '../ui/Tooltip';
import {
  filterMetaApps,
  getRecommendedMetaAppsEmptyState,
} from './metaAppPresentation.js';

interface MetaAppsManagerProps {
  onStartTaskWithMetaApp?: (app: MetaAppRecord) => Promise<void> | void;
}

const MetaAppsManager: React.FC<MetaAppsManagerProps> = ({ onStartTaskWithMetaApp }) => {
  const [activeTab, setActiveTab] = useState<'local' | 'recommended'>('local');
  const [apps, setApps] = useState<MetaAppRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [openingAppId, setOpeningAppId] = useState<string | null>(null);
  const [startingAppId, setStartingAppId] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    const loadApps = async () => {
      setIsLoading(true);
      setActionError('');
      try {
        const result = await window.electron.metaapps.list();
        if (!isActive) return;
        if (result.success && result.apps) {
          setApps(result.apps);
        } else {
          setApps([]);
          setActionError(result.error || i18nService.t('metaAppsLoadFailed'));
        }
      } catch (error) {
        if (!isActive) return;
        setApps([]);
        setActionError(error instanceof Error ? error.message : i18nService.t('metaAppsLoadFailed'));
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    void loadApps();
    const unsubscribe = metaAppService.onMetaAppsChanged(() => {
      void loadApps();
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, []);

  const filteredApps = useMemo(
    () => filterMetaApps(apps, searchQuery),
    [apps, searchQuery],
  );

  const recommendedEmptyState = getRecommendedMetaAppsEmptyState(i18nService.getLanguage());

  const handleOpenMetaApp = async (app: MetaAppRecord) => {
    if (openingAppId || startingAppId) return;
    setOpeningAppId(app.id);
    setActionError('');
    const result = await metaAppService.openMetaApp(app.id, app.entry);
    if (!result.success) {
      setActionError(result.error || i18nService.t('metaAppOpenFailed'));
    }
    setOpeningAppId(null);
  };

  const handleUseMetaApp = async (app: MetaAppRecord) => {
    if (!onStartTaskWithMetaApp || openingAppId || startingAppId) return;
    setStartingAppId(app.id);
    setActionError('');
    try {
      await onStartTaskWithMetaApp(app);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('metaAppUseFailed'));
    } finally {
      setStartingAppId(null);
    }
  };

  const renderLocalTab = () => {
    if (isLoading) {
      return (
        <div className="py-12 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('loading')}
        </div>
      );
    }

    if (filteredApps.length === 0) {
      return (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('noMetaAppsAvailable')}
          </div>
          <div className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('metaAppsLocalEmptyDescription')}
          </div>
        </div>
      );
    }

    return (
      <div className="grid grid-cols-2 gap-3">
        {filteredApps.map((app) => (
          <div
            key={app.id}
            className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                  <Squares2X2Icon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                  {app.name}
                </span>
              </div>
            </div>

            <Tooltip
              content={app.description}
              position="bottom"
              maxWidth="360px"
              className="block w-full"
            >
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                {app.description}
              </p>
            </Tooltip>

            <div className="flex items-center justify-between gap-2 mt-1">
              <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary min-w-0">
                {app.isOfficial ? (
                  <>
                    <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium flex-shrink-0">
                      {i18nService.t('official')}
                    </span>
                    <span>·</span>
                  </>
                ) : null}
                <span className="truncate">v{app.version}</span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Tooltip content={i18nService.t('metaAppUse')} position="top">
                  <button
                    type="button"
                    disabled={!onStartTaskWithMetaApp || openingAppId !== null || startingAppId !== null}
                    onClick={() => void handleUseMetaApp(app)}
                    className="p-1 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent hover:bg-claude-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={i18nService.t('metaAppUse')}
                  >
                    <PlayIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content={i18nService.t('metaAppOpen')} position="top">
                  <button
                    type="button"
                    disabled={openingAppId !== null || startingAppId !== null}
                    onClick={() => void handleOpenMetaApp(app)}
                    className="p-1 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent hover:bg-claude-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={i18nService.t('metaAppOpen')}
                  >
                    <FolderOpenIcon className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border -mx-1 px-1">
        <button
          type="button"
          onClick={() => setActiveTab('local')}
          className={`px-3 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            activeTab === 'local'
              ? 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border-b-2 border-transparent -mb-[1px]'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('localMetaApps')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('recommended')}
          className={`px-3 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            activeTab === 'recommended'
              ? 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border-b-2 border-transparent -mb-[1px]'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('recommended')}
        </button>
      </div>

      <div>
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metaAppsDescription')}
        </p>
      </div>

      {actionError ? (
        <ErrorMessage
          message={actionError}
          onClose={() => setActionError('')}
        />
      ) : null}

      {activeTab === 'recommended' ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {recommendedEmptyState.title}
          </div>
          <div className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {recommendedEmptyState.description}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <input
                type="text"
                placeholder={i18nService.t('searchMetaApps')}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
            </div>
          </div>
          {renderLocalTab()}
        </>
      )}
    </div>
  );
};

export default MetaAppsManager;
