/**
 * Listener Hub View (MetaWebListener)
 * Control panel and event radar terminal for MetaWeb chain data listening.
 * Isolated from IM Gateway; uses dedicated IPC channels.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { i18nService } from '../../services/i18n';
import { SignalIcon } from '@heroicons/react/24/outline';

export type ListenerConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ListenerConfig {
  groupChats: boolean;
  privateChats: boolean;
  serviceRequests: boolean;
}

const MAX_LOGS = 200;

export interface ListenerHubViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode | null;
}

const ListenerHubView: React.FC<ListenerHubViewProps> = ({
  isSidebarCollapsed: _isSidebarCollapsed,
  onToggleSidebar: _onToggleSidebar,
  onNewChat: _onNewChat,
  updateBadge: _updateBadge,
}) => {
  const [connectionStatus, setConnectionStatus] = useState<ListenerConnectionStatus>('disconnected');
  const [config, setConfig] = useState<ListenerConfig>({
    groupChats: false,
    privateChats: false,
    serviceRequests: false,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const result = await window.electron.metaWebListener.getListenerConfig();
      if (result?.config) {
        setConfig(result.config);
      }
    } catch (e) {
      console.warn('[ListenerHub] getListenerConfig failed:', e);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Subscribe to real listener logs from main process
  useEffect(() => {
    const unsubscribe = window.electron.metaWebListener.onListenerLog((log: string) => {
      setLogs((prev) => [...prev, log].slice(-MAX_LOGS));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleToggle = useCallback(async (type: 'groupChats' | 'privateChats' | 'serviceRequests', enabled: boolean) => {
    try {
      await window.electron.metaWebListener.toggleListener({ type, enabled });
      setConfig((c) => ({ ...c, [type]: enabled }));
    } catch (e) {
      console.warn('[ListenerHub] toggleListener failed:', e);
    }
  }, []);

  const handleStartRestart = useCallback(async () => {
    setConnectionStatus('connecting');
    try {
      await window.electron.metaWebListener.startMetaWebListener();
      setConnectionStatus('connected');
    } catch (e) {
      console.warn('[ListenerHub] startMetaWebListener failed:', e);
      setConnectionStatus('disconnected');
    }
  }, []);

  const statusBadgeClass =
    connectionStatus === 'connected'
      ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
      : connectionStatus === 'connecting'
        ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 animate-pulse'
        : 'bg-gray-500/20 text-gray-600 dark:text-gray-400';

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex min-h-0">
        {/* Left: Control Panel ~40% */}
        <div className="w-[40%] min-w-[280px] flex flex-col gap-6 p-6 border-r border-claude-border dark:border-claude-darkBorder">
          <div>
            <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('listenerHub')}
            </h1>
            <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              MetaWeb Listener (isolated from IM)
            </p>
          </div>

          {/* Connection status badge */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  connectionStatus === 'connected'
                    ? 'bg-emerald-500'
                    : connectionStatus === 'connecting'
                      ? 'bg-amber-500'
                      : 'bg-gray-400 dark:bg-gray-500'
                }`}
              />
              {connectionStatus === 'connected'
                ? i18nService.t('listenerHubStatusConnected')
                : connectionStatus === 'connecting'
                  ? i18nService.t('listenerHubStatusConnecting')
                  : i18nService.t('listenerHubStatusDisconnected')}
            </span>
          </div>

          {/* Global toggles */}
          <div className="space-y-4">
            <label className="flex flex-col gap-1.5 rounded-xl p-4 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('listenerHubToggleGroupChats')}
                </span>
                <input
                  type="checkbox"
                  checked={config.groupChats}
                  onChange={(e) => handleToggle('groupChats', e.target.checked)}
                  className="rounded border-claude-border dark:border-claude-darkBorder"
                />
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('listenerHubToggleGroupChatsDesc')}
              </p>
            </label>
            <label className="flex flex-col gap-1.5 rounded-xl p-4 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('listenerHubTogglePrivateChats')}
                </span>
                <input
                  type="checkbox"
                  checked={config.privateChats}
                  onChange={(e) => handleToggle('privateChats', e.target.checked)}
                  className="rounded border-claude-border dark:border-claude-darkBorder"
                />
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('listenerHubTogglePrivateChatsDesc')}
              </p>
            </label>
            <label className="flex flex-col gap-1.5 rounded-xl p-4 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('listenerHubToggleServiceRequests')}
                </span>
                <input
                  type="checkbox"
                  checked={config.serviceRequests}
                  onChange={(e) => handleToggle('serviceRequests', e.target.checked)}
                  className="rounded border-claude-border dark:border-claude-darkBorder"
                />
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('listenerHubToggleServiceRequestsDesc')}
              </p>
            </label>
          </div>

          <button
            type="button"
            onClick={handleStartRestart}
            className="btn-idchat-primary-filled inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium"
          >
            <SignalIcon className="h-4 w-4" />
            {i18nService.t('listenerHubStartRestart')}
          </button>
        </div>

        {/* Right: Event Radar Terminal ~60% */}
        <div className="flex-1 flex flex-col min-w-0 p-4">
          <h2 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('listenerHubEventLogTitle')}
          </h2>
          <div className="flex-1 min-h-0 rounded-lg bg-gray-900 overflow-hidden flex flex-col font-mono text-xs text-gray-300">
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {logs.length === 0 && (
                <div className="text-gray-500">Waiting for events...</div>
              )}
              {logs.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ListenerHubView;
