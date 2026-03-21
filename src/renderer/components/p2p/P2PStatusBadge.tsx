import React, { useEffect, useState } from 'react';

interface P2PStatus {
  running?: boolean;
  peerCount?: number;
  storageLimitReached?: boolean;
  storageUsedBytes?: number;
  dataSource?: string;
  syncMode?: string;
  runtimeMode?: string;
  peerId?: string;
  listenAddrs?: string[];
  error?: string;
}

export const P2PStatusBadge: React.FC = () => {
  const [status, setStatus] = useState<P2PStatus>({});

  useEffect(() => {
    // Initial fetch
    window.electron.p2p.getStatus().then(s => setStatus(s as P2PStatus));

    // Push updates from main process
    const unsubscribe = window.electron.p2p.onStatusUpdate((s) => setStatus(s as P2PStatus));

    // Polling fallback every 30s
    const interval = setInterval(async () => {
      const s = await window.electron.p2p.getStatus();
      setStatus(s as P2PStatus);
    }, 30_000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  const renderDot = (colorClass: string, animate?: boolean) => (
    <div
      className={`w-2 h-2 rounded-full ${colorClass}${animate ? ' animate-pulse' : ''}`}
    />
  );

  const renderDataSourceBadge = (dataSource: string) => (
    <span className='text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'>
      {dataSource}
    </span>
  );

  const renderModeBadge = (label: string) => (
    <span className='text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'>
      {label}
    </span>
  );

  if (status.storageLimitReached) {
    return (
      <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400'>
        🔶 Storage full
        {status.runtimeMode && renderModeBadge(status.runtimeMode)}
      </span>
    );
  }

  if (!status.running) {
    return (
      <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400'>
        {renderDot('bg-gray-400')}
        P2P offline
        {status.error ? (
          <span className='text-xs text-red-500 dark:text-red-400 max-w-32 truncate' title={status.error}>
            {status.error}
          </span>
        ) : null}
      </span>
    );
  }

  if (status.peerCount === 0 || status.peerCount === undefined) {
    return (
      <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400'>
        {renderDot('bg-yellow-400', true)}
        Connecting...
        {status.runtimeMode && renderModeBadge(status.runtimeMode)}
        {status.dataSource && renderDataSourceBadge(status.dataSource)}
      </span>
    );
  }

  return (
    <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400'>
      {renderDot('bg-green-400')}
      {status.peerCount} peers
      {status.runtimeMode && renderModeBadge(status.runtimeMode)}
      {status.dataSource && renderDataSourceBadge(status.dataSource)}
    </span>
  );
};

export default P2PStatusBadge;
