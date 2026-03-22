import type http from 'http';

export interface ListenWithRetryOptions {
  retryDelayMs?: number;
  maxAttempts?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
  onListening?: () => void;
}

const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_ATTEMPTS = 120;

export function listenWithRetry(
  server: http.Server,
  port: number,
  host: string,
  options: ListenWithRetryOptions = {},
): void {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logger = options.logger ?? console;

  let attempt = 0;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const clearRetryTimer = () => {
    if (!retryTimer) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const tryListen = () => {
    if (stopped || server.listening) {
      return;
    }

    attempt += 1;

    const onError = (error: NodeJS.ErrnoException) => {
      if (stopped) {
        return;
      }

      if (error.code === 'EADDRINUSE' && attempt < maxAttempts) {
        logger.warn(`[MetaID RPC] Port ${host}:${port} busy; retrying bind (${attempt}/${maxAttempts})`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          tryListen();
        }, retryDelayMs);
        return;
      }

      stopped = true;
      logger.error(`[MetaID RPC] Failed to bind ${host}:${port}: ${error.message}`);
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      clearRetryTimer();
      stopped = true;
      options.onListening?.();
    });
  };

  server.once('close', () => {
    stopped = true;
    clearRetryTimer();
  });

  tryListen();
}
