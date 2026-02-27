import { app, session } from 'electron';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

let activeDownloadController: AbortController | null = null;

export function cancelActiveDownload(): boolean {
  if (activeDownloadController) {
    activeDownloadController.abort();
    activeDownloadController = null;
    return true;
  }
  return false;
}

function execAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstderr: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function downloadUpdate(
  url: string,
  onProgress: (progress: AppUpdateDownloadProgress) => void,
): Promise<string> {
  if (activeDownloadController) {
    throw new Error('A download is already in progress');
  }

  // Determine file extension from URL
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath) || (process.platform === 'darwin' ? '.dmg' : '.exe');
  const tempDir = app.getPath('temp');
  const downloadPath = path.join(tempDir, `lobsterai-update-${Date.now()}${ext}.download`);
  const finalPath = path.join(tempDir, `lobsterai-update-${Date.now()}${ext}`);

  const controller = new AbortController();
  activeDownloadController = controller;

  let writeStream: fs.WriteStream | null = null;

  try {
    const response = await session.defaultSession.fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }

    if (!response.body) {
      throw new Error('Response has no body');
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : undefined;
    let received = 0;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = 0;
    let currentSpeed: number | undefined = undefined;

    onProgress({
      received: 0,
      total: total && Number.isFinite(total) ? total : undefined,
      percent: total && Number.isFinite(total) ? 0 : undefined,
      speed: undefined,
    });

    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });
    writeStream = fs.createWriteStream(downloadPath);

    const nodeStream = Readable.fromWeb(response.body as any);

    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;

      // Calculate speed with 1-second window
      const now = Date.now();
      const elapsed = now - lastSpeedTime;
      if (elapsed >= 1000) {
        currentSpeed = ((received - lastSpeedBytes) / elapsed) * 1000;
        lastSpeedTime = now;
        lastSpeedBytes = received;
      }

      onProgress({
        received,
        total: total && Number.isFinite(total) ? total : undefined,
        percent: total && Number.isFinite(total) ? received / total : undefined,
        speed: currentSpeed,
      });
    });

    await pipeline(nodeStream, writeStream);
    writeStream = null;

    // Rename to final path (atomic on same filesystem)
    await fs.promises.rename(downloadPath, finalPath);

    onProgress({
      received,
      total: total && Number.isFinite(total) ? total : received,
      percent: 1,
      speed: currentSpeed,
    });

    return finalPath;
  } catch (error) {
    // Clean up partial download
    try {
      if (writeStream) {
        writeStream.destroy();
      }
      await fs.promises.unlink(downloadPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }

    if (controller.signal.aborted) {
      throw new Error('Download cancelled');
    }
    throw error;
  } finally {
    activeDownloadController = null;
  }
}

export async function installUpdate(filePath: string): Promise<void> {
  if (process.platform === 'darwin') {
    return installMacDmg(filePath);
  }
  if (process.platform === 'win32') {
    return installWindowsNsis(filePath);
  }
  throw new Error('Unsupported platform');
}

async function installMacDmg(dmgPath: string): Promise<void> {
  let mountPoint: string | null = null;

  try {
    // Mount the DMG
    const mountOutput = await execAsync(
      `hdiutil attach "${dmgPath}" -nobrowse -noautoopen -noverify`,
    );

    // Parse mount point from output (last line, last column)
    const lines = mountOutput.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    const mountMatch = lastLine?.match(/\t(\/Volumes\/.+)$/);
    if (!mountMatch) {
      throw new Error('Failed to determine mount point from hdiutil output');
    }
    mountPoint = mountMatch[1];

    // Find .app bundle in mount point
    const entries = await fs.promises.readdir(mountPoint);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) {
      throw new Error('No .app bundle found in DMG');
    }

    const sourceApp = path.join(mountPoint, appBundle);

    // Determine target path: current running app location
    // process.resourcesPath is .app/Contents/Resources, go up 3 levels
    const currentAppPath = path.resolve(process.resourcesPath, '..', '..', '..');
    let targetApp: string;

    if (currentAppPath.endsWith('.app')) {
      targetApp = currentAppPath;
    } else {
      // Fallback to /Applications
      targetApp = `/Applications/${appBundle}`;
    }

    // Try to copy the .app bundle
    try {
      await execAsync(`rm -rf "${targetApp}" && cp -R "${sourceApp}" "${targetApp}"`);
    } catch {
      // Permission denied: try with admin privileges via osascript
      console.log('[AppUpdate] Normal copy failed, requesting admin privileges...');
      try {
        await execAsync(
          `osascript -e 'do shell script "rm -rf \\"${targetApp}\\" && cp -R \\"${sourceApp}\\" \\"${targetApp}\\"" with administrator privileges'`,
        );
      } catch (adminError) {
        throw new Error(
          `Installation failed: insufficient permissions. ${adminError instanceof Error ? adminError.message : ''}`,
        );
      }
    }

    // Detach DMG
    try {
      await execAsync(`hdiutil detach "${mountPoint}" -force`);
    } catch {
      // Best effort
    }
    mountPoint = null;

    // Clean up downloaded DMG
    try {
      await fs.promises.unlink(dmgPath);
    } catch {
      // Best effort
    }

    // Relaunch from the new app location
    const executablePath = path.join(targetApp, 'Contents', 'MacOS');
    const execEntries = await fs.promises.readdir(executablePath);
    const executable = execEntries[0]; // Should be the app executable

    if (executable) {
      app.relaunch({ execPath: path.join(executablePath, executable) });
    } else {
      app.relaunch();
    }
    app.quit();
  } catch (error) {
    // Clean up mount point on error
    if (mountPoint) {
      try {
        await execAsync(`hdiutil detach "${mountPoint}" -force`);
      } catch {
        // Best effort
      }
    }
    throw error;
  }
}

async function installWindowsNsis(exePath: string): Promise<void> {
  // Get the current installation directory
  const installDir = path.dirname(app.getPath('exe'));

  // Launch NSIS installer in silent mode with the same install directory
  // The NSIS customInit macro will kill the running instance
  // runAfterFinish: true in electron-builder.json ensures restart
  const child = spawn(exePath, ['/S', `/D=${installDir}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Give the installer a moment to start, then quit
  await new Promise((resolve) => setTimeout(resolve, 500));
  app.quit();
}
