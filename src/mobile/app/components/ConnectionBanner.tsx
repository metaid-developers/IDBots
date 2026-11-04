import { t } from '../../i18n';
import type { ConnectionState } from '../../bridge/types';
import { useConnectionState } from '../hooks/useConnectionState';

const STATE_LABEL_KEY: Record<ConnectionState, string> = {
  connecting: 'mobile.connection.connecting',
  online: 'mobile.connection.online',
  reconnecting: 'mobile.connection.reconnecting',
  offline: 'mobile.connection.offline',
  upgrading: 'mobile.connection.upgrading',
};

const STATE_CLASS: Record<ConnectionState, string> = {
  connecting: 'twin-notice-warning',
  online: 'hidden',
  reconnecting: 'twin-notice-warning',
  offline: 'twin-notice-error',
  upgrading: 'twin-notice',
};

/** Connection banner (REQ-E-11): hidden while online, visible otherwise. */
export function ConnectionBanner(): JSX.Element {
  const state = useConnectionState();
  const className = STATE_CLASS[state];
  if (className === 'hidden') {
    return <div className="hidden" data-connection-state={state} />;
  }
  return (
    <div
      data-connection-state={state}
      className={`flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium ${className}`}
      role="status"
    >
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
      <span>{t(STATE_LABEL_KEY[state])}</span>
    </div>
  );
}
