import { BrowserWindow } from 'electron';

const STARTUP_BACKUP_PROGRESS_DELAY_MS = 400;

const progressHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>IDBots</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: "Segoe UI", sans-serif; color: #20242c; background: #f8f9fb; }
    main { width: 100%; padding: 36px; text-align: center; }
    h1 { margin: 18px 0 10px; font-size: 20px; font-weight: 600; }
    p { margin: 0; color: #606775; font-size: 13px; line-height: 1.6; }
    .spinner { width: 30px; height: 30px; margin: auto; border: 3px solid #dce1e8; border-top-color: #5964e8; border-radius: 50%; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: #5964e8; } }
  </style>
</head>
<body>
  <main>
    <div class="spinner" aria-hidden="true"></div>
    <h1>Preparing IDBots</h1>
    <p>Backing up your data before the update.<br>This can take a moment on the first launch.</p>
  </main>
</body>
</html>`;

export interface StartupBackupProgressHandle {
  close: () => void;
}

export function scheduleStartupBackupProgress(
  delayMs = STARTUP_BACKUP_PROGRESS_DELAY_MS,
): StartupBackupProgressHandle {
  let progressWindow: BrowserWindow | null = null;
  const timer = setTimeout(() => {
    progressWindow = new BrowserWindow({
      width: 420,
      height: 240,
      center: true,
      title: 'IDBots',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: '#F8F9FB',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
        disableDialogs: true,
      },
    });
    progressWindow.once('ready-to-show', () => {
      if (progressWindow && !progressWindow.isDestroyed()) {
        progressWindow.show();
      }
    });
    void progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressHtml)}`).catch((error) => {
      console.warn('[Startup] Failed to show backup progress:', error);
    });
  }, delayMs);

  return {
    close: () => {
      clearTimeout(timer);
      if (progressWindow && !progressWindow.isDestroyed()) {
        progressWindow.destroy();
      }
      progressWindow = null;
    },
  };
}
