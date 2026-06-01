import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  Squares2X2Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { metaAppService } from '../../services/metaApp';
import type { CommunityMetaAppRecord, MetaAppRecord } from '../../types/metaApp';
import ErrorMessage from '../ErrorMessage';
import { DEFAULT_GIG_SQUARE_PROVIDER_AVATAR } from '../gigSquare/gigSquareProviderPresentation.js';
import Tooltip from '../ui/Tooltip';
import {
  filterCommunityMetaApps,
  filterMetaApps,
  getCommunityMetaAppActionLabel,
  getCommunityMetaAppsEmptyState,
  getCommunityMetaAppStatusLabel,
  getMetaAppAiPromptModel,
  getMetaAppAuthorModel,
  getMetaAppVisualModel,
  getRecommendedMetaAppsEmptyState,
} from './metaAppPresentation.js';
import { openMetaAppDirectory } from './metaAppLaunch.js';

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
  const [openingFolderAppId, setOpeningFolderAppId] = useState<string | null>(null);
  const [startingAppId, setStartingAppId] = useState<string | null>(null);
  const [installingSourcePinId, setInstallingSourcePinId] = useState<string | null>(null);
  const [promptPanel, setPromptPanel] = useState<{ appName: string; prompt: string } | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  useEffect(() => {
    if (!promptPanel) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPromptPanel(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [promptPanel]);

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

  const openPromptPanel = (appName: string, prompt: string) => {
    setCopiedPrompt(false);
    setPromptPanel({ appName, prompt });
  };

  const handleCopyPrompt = async () => {
    if (!promptPanel?.prompt || !navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(promptPanel.prompt);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1500);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('copyToClipboard'));
    }
  };

  const renderAiPromptButton = (app: { name: string; aiPrompt?: string; developmentPrompt?: string }) => {
    const aiPrompt = getMetaAppAiPromptModel(app);
    if (!aiPrompt.visible) {
      return null;
    }

    return (
      <Tooltip content={i18nService.t('metaAppAiPrompt')} position="top">
        <button
          type="button"
          onClick={() => openPromptPanel(app.name, aiPrompt.prompt)}
          className="inline-flex h-5 shrink-0 items-center rounded-md border border-claude-accent/30 bg-claude-accent/10 px-1.5 text-[10px] font-semibold leading-none text-claude-accent transition-colors hover:border-claude-accent hover:bg-claude-accent/15"
          title={i18nService.t('metaAppAiPrompt')}
          aria-label={i18nService.t('metaAppAiPrompt')}
        >
          {aiPrompt.label}
        </button>
      </Tooltip>
    );
  };

  const renderPromptPanel = () => {
    if (!promptPanel) {
      return null;
    }

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        onClick={() => setPromptPanel(null)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={i18nService.t('metaAppAiPrompt')}
          className="w-full max-w-2xl overflow-hidden rounded-xl border border-claude-border bg-white shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 border-b border-claude-border px-4 py-3 dark:border-claude-darkBorder">
            <div className="min-w-0 flex items-center gap-2">
              <span className="inline-flex h-5 items-center rounded-md border border-claude-accent/30 bg-claude-accent/10 px-1.5 text-[10px] font-semibold text-claude-accent">
                AI
              </span>
              <div className="min-w-0 truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
                {promptPanel.appName}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip content={copiedPrompt ? i18nService.t('messageCopied') : i18nService.t('copyToClipboard')} position="top">
                <button
                  type="button"
                  onClick={() => void handleCopyPrompt()}
                  className={`rounded-md p-1.5 transition-colors hover:bg-claude-accent/10 ${
                    copiedPrompt
                      ? 'text-claude-accent'
                      : 'text-claude-textSecondary dark:text-claude-darkTextSecondary'
                  }`}
                  title={i18nService.t('copyToClipboard')}
                  aria-label={i18nService.t('copyToClipboard')}
                >
                  <ClipboardDocumentIcon className="h-4 w-4" />
                </button>
              </Tooltip>
              <Tooltip content={i18nService.t('close')} position="top">
                <button
                  type="button"
                  onClick={() => setPromptPanel(null)}
                  className="rounded-md p-1.5 text-claude-textSecondary transition-colors hover:bg-claude-surfaceMuted hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceMuted dark:hover:text-claude-darkText"
                  title={i18nService.t('close')}
                  aria-label={i18nService.t('close')}
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-auto p-4">
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-claude-surfaceMuted p-3 text-xs leading-5 text-claude-text dark:bg-claude-darkSurfaceMuted dark:text-claude-darkText">
              {promptPanel.prompt}
            </pre>
          </div>
        </div>
      </div>
    );
  };

  const handleOpenMetaAppFolder = async (app: MetaAppRecord) => {
    if (openingFolderAppId || startingAppId) return;
    setOpeningFolderAppId(app.id);
    setActionError('');
    try {
      await openMetaAppDirectory({ app, shell: window.electron.shell });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : i18nService.t('metaAppOpenFolderFailed'));
    } finally {
      setOpeningFolderAppId(null);
    }
  };

  const handleUseMetaApp = async (app: MetaAppRecord) => {
    if (!onStartTaskWithMetaApp || openingFolderAppId || startingAppId) return;
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
        {filteredApps.map((app) => {
          const author = getMetaAppAuthorModel(app, i18nService.getLanguage());
          const authorAvatarSrc = author.avatar || DEFAULT_GIG_SQUARE_PROVIDER_AVATAR;

          return (
            <div
              key={app.id}
              className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
            >
              {renderMetaAppVisual(app)}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex items-center gap-1.5">
                  <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate min-w-0">
                    {app.name}
                  </span>
                  {renderAiPromptButton(app)}
                </div>
                {app.isOfficial ? (
                  <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium text-[10px] flex-shrink-0">
                    {i18nService.t('official')}
                  </span>
                ) : null}
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
                <div className="min-w-0 flex items-center gap-2">
                  <img
                    src={authorAvatarSrc}
                    alt={author.name}
                    className="h-7 w-7 flex-shrink-0 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
                    onError={(event) => { event.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-claude-text dark:text-claude-darkText">
                      {author.name}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Tooltip content={i18nService.t('metaAppUse')} position="top">
                    <button
                      type="button"
                      disabled={!onStartTaskWithMetaApp || openingFolderAppId !== null || startingAppId !== null}
                      onClick={() => void handleUseMetaApp(app)}
                      className="p-1 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent hover:bg-claude-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={i18nService.t('metaAppUse')}
                    >
                      <PlayIcon className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip content={i18nService.t('metaAppOpenFolder')} position="top">
                    <button
                      type="button"
                      disabled={openingFolderAppId !== null || startingAppId !== null}
                      onClick={() => void handleOpenMetaAppFolder(app)}
                      className="p-1 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent hover:bg-claude-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={i18nService.t('metaAppOpenFolder')}
                    >
                      <FolderOpenIcon className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          );
        })}
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
            const language = i18nService.getLanguage();
            const statusLabel = getCommunityMetaAppStatusLabel(app.status, language);
            const actionLabel = getCommunityMetaAppActionLabel(app.status, language);
            const author = getMetaAppAuthorModel(app, language);
            const authorAvatarSrc = author.avatar || DEFAULT_GIG_SQUARE_PROVIDER_AVATAR;
            const isInstalling = installingSourcePinId === app.sourcePinId;
            const canInstall = app.status === 'install' || app.status === 'update';
            const isActionDisabled = installingSourcePinId !== null;

            return (
              <div
                key={app.sourcePinId}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50"
              >
                {renderMetaAppVisual(app)}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex items-center gap-1.5">
                    <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate min-w-0">
                      {app.name}
                    </span>
                    {renderAiPromptButton(app)}
                  </div>
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
                  <div className="min-w-0 flex items-center gap-2">
                    <img
                      src={authorAvatarSrc}
                      alt={author.name}
                      className="h-7 w-7 flex-shrink-0 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
                      onError={(event) => { event.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-claude-text dark:text-claude-darkText">
                        {author.name}
                      </div>
                    </div>
                  </div>
                  <Tooltip
                    content={app.reason || actionLabel}
                    position="top"
                  >
                    {canInstall ? (
                      <button
                        type="button"
                        disabled={isActionDisabled}
                        onClick={() => void handleInstallCommunityMetaApp(app)}
                        className="btn-idchat-primary-filled inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        title={actionLabel}
                      >
                        {isInstalling ? <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" /> : null}
                        {isInstalling ? i18nService.t('loading') : actionLabel}
                      </button>
                    ) : app.status === 'installed' ? (
                      <span className="shrink-0 whitespace-nowrap px-2.5 py-1 text-xs rounded-lg dark:bg-claude-darkBorder bg-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-not-allowed">
                        {actionLabel}
                      </span>
                    ) : (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1 text-xs rounded-lg bg-red-500/20 text-red-500 cursor-not-allowed"
                        title={app.reason || actionLabel}
                      >
                        {actionLabel}
                      </span>
                    )}
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
      {renderPromptPanel()}
    </div>
  );
};

export default MetaAppsManager;
