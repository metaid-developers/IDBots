import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownTrayIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { metaAppService } from '../../services/metaApp';
import type { CommunityMetaAppRecord, MetaAppRecord } from '../../types/metaApp';
import ErrorMessage from '../ErrorMessage';
import Tooltip from '../ui/Tooltip';
import {
  filterCommunityMetaApps,
  filterMetaApps,
  getCommunityMetaAppActionLabel,
  getCommunityMetaAppsEmptyState,
  getCommunityMetaAppStatusLabel,
  getMetaAppVisualModel,
  getRecommendedMetaAppsEmptyState,
} from './metaAppPresentation.js';

interface MetaAppsManagerProps {
  onStartTaskWithMetaApp?: (app: MetaAppRecord) => Promise<void> | void;
}

const COMMUNITY_PAGE_SIZE = 30;
const COMMUNITY_ROOT_CURSOR = '0';

const MetaAppsManager: React.FC<MetaAppsManagerProps> = ({ onStartTaskWithMetaApp }) => {
  const [activeTab, setActiveTab] = useState<'local' | 'recommended' | 'chainCommunity'>('local');
  const [apps, setApps] = useState<MetaAppRecord[]>([]);
  const [communityApps, setCommunityApps] = useState<CommunityMetaAppRecord[]>([]);
  const [communityCursor, setCommunityCursor] = useState(COMMUNITY_ROOT_CURSOR);
  const [communityCursorStack, setCommunityCursorStack] = useState<string[]>([]);
  const [communityNextCursor, setCommunityNextCursor] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isCommunityLoading, setIsCommunityLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [openingAppId, setOpeningAppId] = useState<string | null>(null);
  const [startingAppId, setStartingAppId] = useState<string | null>(null);
  const [installingSourcePinId, setInstallingSourcePinId] = useState<string | null>(null);

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
      if (activeTab === 'chainCommunity') {
        void loadCommunityApps();
      }
    });

    async function loadCommunityApps(cursor = communityCursor) {
      setIsCommunityLoading(true);
      setActionError('');
      try {
        const result = await metaAppService.listCommunityMetaApps({
          cursor,
          size: COMMUNITY_PAGE_SIZE,
        });
        if (!isActive) return;
        if (result.success && result.apps) {
          setCommunityApps(result.apps);
          setCommunityNextCursor(result.nextCursor || null);
        } else {
          setCommunityApps([]);
          setCommunityNextCursor(null);
          setActionError(result.error || i18nService.t('metaAppsLoadFailed'));
        }
      } catch (error) {
        if (!isActive) return;
        setCommunityApps([]);
        setCommunityNextCursor(null);
        setActionError(error instanceof Error ? error.message : i18nService.t('metaAppsLoadFailed'));
      } finally {
        if (isActive) {
          setIsCommunityLoading(false);
        }
      }
    }

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [activeTab, communityCursor]);

  useEffect(() => {
    if (activeTab !== 'chainCommunity') {
      return;
    }

    let isActive = true;

    const loadCommunity = async () => {
      setIsCommunityLoading(true);
      setActionError('');
      try {
        const result = await metaAppService.listCommunityMetaApps({
          cursor: communityCursor,
          size: COMMUNITY_PAGE_SIZE,
        });
        if (!isActive) return;
        if (result.success && result.apps) {
          setCommunityApps(result.apps);
          setCommunityNextCursor(result.nextCursor || null);
        } else {
          setCommunityApps([]);
          setCommunityNextCursor(null);
          setActionError(result.error || i18nService.t('metaAppsLoadFailed'));
        }
      } catch (error) {
        if (!isActive) return;
        setCommunityApps([]);
        setCommunityNextCursor(null);
        setActionError(error instanceof Error ? error.message : i18nService.t('metaAppsLoadFailed'));
      } finally {
        if (isActive) {
          setIsCommunityLoading(false);
        }
      }
    };

    void loadCommunity();

    return () => {
      isActive = false;
    };
  }, [activeTab, communityCursor]);

  const filteredApps = useMemo(
    () => filterMetaApps(apps, searchQuery),
    [apps, searchQuery],
  );

  const filteredCommunityApps = useMemo(
    () => filterCommunityMetaApps(communityApps, searchQuery),
    [communityApps, searchQuery],
  );

  const recommendedEmptyState = getRecommendedMetaAppsEmptyState(i18nService.getLanguage());
  const communityEmptyState = getCommunityMetaAppsEmptyState(i18nService.getLanguage());
  const hasPreviousCommunityPage = communityCursorStack.length > 0;
  const hasNextCommunityPage = Boolean(communityNextCursor && communityNextCursor !== communityCursor);
  const communityPageNumber = communityCursorStack.length + 1;

  const renderMetaAppVisual = (app: { name: string; cover?: string; icon?: string }) => {
    const visual = getMetaAppVisualModel(app);

    if (visual.kind === 'none' || !visual.src) {
      return (
        <div className="mb-3 aspect-[16/7] rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border flex items-center justify-center">
          <Squares2X2Icon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        </div>
      );
    }

    return (
      <div className="mb-3 aspect-[16/7] rounded-xl overflow-hidden dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
        <img
          src={visual.src}
          alt={app.name}
          className={`h-full w-full ${visual.kind === 'cover' ? 'object-cover' : 'object-contain p-4'}`}
        />
      </div>
    );
  };

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

  const handleInstallCommunityMetaApp = async (app: CommunityMetaAppRecord) => {
    if (installingSourcePinId || app.status === 'installed' || app.status === 'uninstallable') return;
    setInstallingSourcePinId(app.sourcePinId);
    setActionError('');
    try {
      const result = await metaAppService.installCommunityMetaApp(app.sourcePinId);
      if (!result.success) {
        setActionError(result.error || i18nService.t('metaAppInstallFailed'));
      }

      const refreshed = await metaAppService.listCommunityMetaApps({
        cursor: communityCursor,
        size: COMMUNITY_PAGE_SIZE,
      });
      if (refreshed.success && refreshed.apps) {
        setCommunityApps(refreshed.apps);
        setCommunityNextCursor(refreshed.nextCursor || null);
      }

      const localResult = await window.electron.metaapps.list();
      if (localResult.success && localResult.apps) {
        setApps(localResult.apps);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('metaAppInstallFailed'));
    } finally {
      setInstallingSourcePinId(null);
    }
  };

  const handlePreviousCommunityPage = () => {
    if (isCommunityLoading || !hasPreviousCommunityPage) return;
    const previousCursor = communityCursorStack[communityCursorStack.length - 1] || COMMUNITY_ROOT_CURSOR;
    setActionError('');
    setCommunityCursorStack((prev) => prev.slice(0, -1));
    setCommunityCursor(previousCursor);
  };

  const handleNextCommunityPage = () => {
    if (isCommunityLoading || !hasNextCommunityPage || !communityNextCursor) return;
    setActionError('');
    setCommunityCursorStack((prev) => [...prev, communityCursor]);
    setCommunityCursor(communityNextCursor);
  };

  const renderChainCommunityPagination = () => {
    if (!hasPreviousCommunityPage && !hasNextCommunityPage) {
      return null;
    }

    const pageInfo = i18nService.t('metaAppsCommunityPageInfo')
      .replace('{page}', String(communityPageNumber))
      .replace('{size}', String(COMMUNITY_PAGE_SIZE));

    return (
      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/40 bg-claude-surface/40 px-3 py-2">
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {pageInfo}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isCommunityLoading || !hasPreviousCommunityPage}
            onClick={handlePreviousCommunityPage}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 hover:text-claude-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('metaAppsPreviousPage')}
          </button>
          <button
            type="button"
            disabled={isCommunityLoading || !hasNextCommunityPage}
            onClick={handleNextCommunityPage}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 hover:text-claude-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('metaAppsNextPage')}
          </button>
        </div>
      </div>
    );
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
            {renderMetaAppVisual(app)}
            <div className="flex items-start justify-between mb-2">
              <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate min-w-0">
                {app.name}
              </span>
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

  const renderChainCommunityTab = () => {
    if (isCommunityLoading) {
      return (
        <div className="py-12 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('loading')}
        </div>
      );
    }

    if (communityApps.length === 0) {
      return (
        <div className="space-y-4">
          <div className="py-12 text-center">
            <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {communityEmptyState.title}
            </div>
            <div className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {communityEmptyState.description}
            </div>
          </div>
          {renderChainCommunityPagination()}
        </div>
      );
    }

    return (
      <div>
        <div className="grid grid-cols-2 gap-3">
          {filteredCommunityApps.map((app) => {
            const statusLabel = getCommunityMetaAppStatusLabel(app.status, i18nService.getLanguage());
            const actionLabel = getCommunityMetaAppActionLabel(app.status, i18nService.getLanguage());
            const disabled =
              app.status === 'installed'
              || app.status === 'uninstallable'
              || installingSourcePinId !== null;

            return (
              <div
                key={app.sourcePinId}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
              >
                {renderMetaAppVisual(app)}
                <div className="flex items-start justify-between mb-2">
                  <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate min-w-0">
                    {app.name}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-claude-accent/10 text-claude-accent font-medium">
                    {statusLabel}
                  </span>
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
                    <span className="truncate">v{app.version}</span>
                    <span>·</span>
                    <span className="truncate">{app.creatorMetaId || '-'}</span>
                  </div>
                  <Tooltip
                    content={app.reason || actionLabel}
                    position="top"
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void handleInstallCommunityMetaApp(app)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent hover:bg-claude-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={actionLabel}
                    >
                      <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                      <span>{actionLabel}</span>
                    </button>
                  </Tooltip>
                </div>

                {app.reason ? (
                  <div className="mt-2 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2">
                    {app.reason}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {renderChainCommunityPagination()}
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
        <button
          type="button"
          onClick={() => setActiveTab('chainCommunity')}
          className={`px-3 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            activeTab === 'chainCommunity'
              ? 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border-b-2 border-transparent -mb-[1px]'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('chainCommunityMetaApps')}
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
          {activeTab === 'chainCommunity' ? renderChainCommunityTab() : renderLocalTab()}
        </>
      )}
    </div>
  );
};

export default MetaAppsManager;
