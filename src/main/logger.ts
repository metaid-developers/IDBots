/**
 * Logger module using electron-log
 * Intercepts console.* methods and writes to file + console simultaneously.
 *
 * Log file locations:
 *   macOS:   ~/Library/Logs/IDBots/main.log
 *   Windows: %USERPROFILE%\AppData\Roaming\IDBots\logs\main.log
 *   Linux:   ~/.config/IDBots/logs/main.log
 */

import log from 'electron-log/main';

/**
 * Initialize logging system.
 * Must be called early in main process, before any console output.
 */
export function initLogger(): void {
  // File transport config
  log.transports.file.level = 'debug';
  log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB, then rotate to main.old.log
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

  // Console transport config
  log.transports.console.level = 'debug';
  log.transports.console.format = '{text}';

  // Intercept console.* methods so all existing console.log/error/warn
  // across 25+ files are automatically captured without any code changes.
  // electron-log correctly serializes Error objects (with stack traces),
  // unlike JSON.stringify which outputs '{}' for Error instances.
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  console.log = (...args: any[]) => {
    originalLog.apply(console, args);
    log.info(...args);
  };
  console.error = (...args: any[]) => {
    originalError.apply(console, args);
    log.error(...args);
  };
  console.warn = (...args: any[]) => {
    originalWarn.apply(console, args);
    log.warn(...args);
  };
  console.info = (...args: any[]) => {
    originalInfo.apply(console, args);
    log.info(...args);
  };
  console.debug = (...args: any[]) => {
    originalDebug.apply(console, args);
    log.debug(...args);
  };

  // Disable electron-log's own console transport to avoid double printing
  // (we already call originalLog above, so electron-log only needs to write to file)
  log.transports.console.level = false;

  // Log startup marker
  log.info('='.repeat(60));
  log.info(`IDBots started (${process.platform} ${process.arch})`);
  log.info('='.repeat(60));
}

/**
 * Get the current log file path
 */
export function getLogFilePath(): string {
  return log.transports.file.getFile().path;
}

/**
 * Log instance for direct usage if needed
 */
export { log };
