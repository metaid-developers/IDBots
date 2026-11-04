import { app, session } from 'electron';
import { exec, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
  /** True when this download run resumed from a previously saved partial file. */
  resumed?: boolean;
}

export interface DownloadUpdateOptions {
  /** Target app version — part of the stable temp-file identity. */
  version?: string;
  /** Optional SHA-256 of the full payload, verified when the manifest provides it. */
  expectedSha256?: string;
  /** Optional SHA-512 of the full payload, verified when the manifest provides it. */
  expectedSha512?: string;
}

/** Sidecar metadata persisted next to the partial download file. */
interface DownloadMeta {
  url: string;
  version: string;
  platform: string;
  arch: string;
  etag?: string;
  totalSize?: number;
  downloadedSize: number;
  updatedAt: number;
}

let activeDownloadController: AbortController | null = null;
let activeDownloadStableId: string | null = null;

export function cancelActiveDownload(): boolean {
  if (activeDownloadController) {
    console.log('[AppUpdate] Download cancelled by user');
    activeDownloadController.abort('cancelled');
    activeDownloadController = null;
    return true;
  }
  return false;
}

/** Escape a string for safe use as a single-quoted POSIX shell argument. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Extract the mounted volume path from hdiutil's multi-device output. */
export function parseHdiutilMountPoint(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(/\/Volumes\/.+$/);
    if (match) {
      return match[0].trimEnd();
    }
  }
  return null;
}

function execAsync(command: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstderr: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Sidecar metadata path `downloadUpdate` writes next to an installer: the same
 * base name in the temp dir with a `.meta.json` suffix
 * (`idbots-update-<stableId>.meta.json`).
 */
export function resolveDownloadMetaPath(installerPath: string): string {
  return `${installerPath.replace(/\.[^./\\]+$/, '')}.meta.json`;
}

/** Version a macOS app bundle reports about itself (`CFBundleShortVersionString`). */
export async function readMacBundleVersion(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const version = await execAsync(
    `plutil -extract CFBundleShortVersionString raw ${shellEscape(plistPath)}`,
    15_000,
  );
  if (!version) {
    throw new Error(`${plistPath} reports no CFBundleShortVersionString`);
  }
  return version;
}

/** Minimum interval between progress IPC events (ms). */
const PROGRESS_THROTTLE_MS = 200;

/** Abort download if no data received for this duration (ms). */
const DOWNLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

/** Remove stale download artifacts older than this (ms). */
const STALE_DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stable identity for a download target (version + platform + arch + URL).
 * The same target always maps to the same temp files, so an interrupted
 * download can be resumed after an app restart.
 */
export function computeStableDownloadId(url: string, version?: string): string {
  const key = `${version ?? ''}|${process.platform}|${process.arch}|${url}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

async function readDownloadMeta(metaPath: string): Promise<DownloadMeta | null> {
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as DownloadMeta;
    if (typeof parsed.url !== 'string' || typeof parsed.downloadedSize !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeDownloadMeta(metaPath: string, meta: DownloadMeta): Promise<void> {
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

/** Version recorded for an installer by its download sidecar, when present. */
async function readDeclaredInstallerVersion(installerPath: string): Promise<string | null> {
  const meta = await readDownloadMeta(resolveDownloadMetaPath(installerPath));
  const version = typeof meta?.version === 'string' ? meta.version.trim() : '';
  return version === '' ? null : version;
}

/**
 * Refuse a mislabeled package before anything touches the installed app.
 *
 * v1.0.1 shipped a bundle whose Info.plist still said 1.0.0, so the client kept
 * judging itself outdated and re-downloaded the same installer. The bundle's own
 * version is compared against the version recorded by the downloader's sidecar
 * metadata. Every macOS install path (silent swap AND the interactive fallback
 * the renderer drops to when the silent swap fails) must run this gate: a
 * refusal on one path is pointless if the other path installs the same DMG.
 *
 * No sidecar (e.g. an installer copied in by hand) keeps the legacy behavior
 * instead of failing hard.
 */
export async function assertInstallerBundleVersion(installerPath: string, sourceApp: string): Promise<void> {
  const declaredVersion = await readDeclaredInstallerVersion(installerPath);
  if (!declaredVersion) {
    console.log('[AppUpdate] No download metadata sidecar; skipping bundle version check');
    return;
  }
  const incomingVersion = await readMacBundleVersion(sourceApp);
  if (incomingVersion !== declaredVersion) {
    throw new Error(
      `Refusing to install a mislabeled update: the bundle reports ${incomingVersion} but the update manifest declares ${declaredVersion}`,
    );
  }
  console.log(
    `[AppUpdate] Bundle version check passed: ${incomingVersion} matches update manifest ${declaredVersion}`,
  );
}

/**
 * Remove stale `idbots-update-*` artifacts (partials, metadata, completed
 * installers) older than STALE_DOWNLOAD_TTL_MS. Failed partial files are kept
 * for resume until they age out; the in-flight download is never touched.
 */
export async function cleanupStaleDownloads(): Promise<number> {
  const tempDir = app.getPath('temp');
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tempDir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    // New stable-named artifacts (16 hex chars), plus legacy timestamp-named
    // installers/partials from older releases (13-digit timestamps).
    const match = entry.match(/^idbots-update-([0-9a-f]{16})/);
    const legacy = /^idbots-update-\d+\.(dmg|exe|zip)(\.download)?$/.test(entry);
    if (!match && !legacy) {
      continue;
    }
    if (match && match[1] === activeDownloadStableId) {
      continue;
    }
    const fullPath = path.join(tempDir, entry);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (now - stat.mtimeMs < STALE_DOWNLOAD_TTL_MS) {
        continue;
      }
      await fs.promises.unlink(fullPath);
      removed += 1;
    } catch {
      // Best effort
    }
  }
  if (removed > 0) {
    console.log(`[AppUpdate] Cleaned up ${removed} stale download artifact(s)`);
  }
  return removed;
}

async function hashFile(filePath: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Verify size (and optional hash), then atomically rename the partial file
 * into the final path and persist the completed metadata so the same target
 * can be reused (not re-downloaded) after a restart.
 */
async function finalizeDownload(
  downloadPath: string,
  finalPath: string,
  metaPath: string,
  meta: DownloadMeta,
  total: number | undefined,
  options: DownloadUpdateOptions,
): Promise<string> {
  const stat = await fs.promises.stat(downloadPath);
  console.log(`[AppUpdate] Download complete: ${stat.size} bytes`);

  if (stat.size === 0) {
    throw new Error('Downloaded file is empty');
  }
  if (total !== undefined && Number.isFinite(total) && stat.size !== total) {
    throw new Error(`Download incomplete: expected ${total} bytes but got ${stat.size}`);
  }

  if (options.expectedSha256 || options.expectedSha512) {
    const algorithm = options.expectedSha512 ? 'sha512' : 'sha256';
    const expected = (options.expectedSha512 ?? options.expectedSha256) as string;
    const actual = await hashFile(downloadPath, algorithm);
    if (actual !== expected) {
      // Corrupt bytes can never be fixed by resuming; discard them so the next
      // attempt starts fresh instead of failing on the same bytes forever.
      await fs.promises.unlink(downloadPath).catch(() => {});
      await fs.promises.unlink(metaPath).catch(() => {});
      throw new Error(`Download checksum mismatch: expected ${expected}, got ${actual}`);
    }
    console.log(`[AppUpdate] Checksum verified (${algorithm})`);
  }

  // Atomic rename into the final path (same filesystem, temp dir).
  try {
    await fs.promises.rename(downloadPath, finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows cannot overwrite an existing destination with a plain rename.
    if (code === 'EEXIST' || code === 'EPERM') {
      await fs.promises.unlink(finalPath).catch(() => {});
      await fs.promises.rename(downloadPath, finalPath);
    } else {
      throw error;
    }
  }

  meta.downloadedSize = stat.size;
  meta.totalSize = total ?? stat.size;
  meta.updatedAt = Date.now();
  await writeDownloadMeta(metaPath, meta);
  console.log(`[AppUpdate] File saved to: ${finalPath}`);
  return finalPath;
}

export async function downloadUpdate(
  url: string,
  onProgress: (progress: AppUpdateDownloadProgress) => void,
  options: DownloadUpdateOptions = {},
): Promise<string> {
  if (activeDownloadController) {
    throw new Error('A download is already in progress');
  }

  console.log(`[AppUpdate] Starting download: ${url}`);

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }

  const ext = path.extname(parsedUrl.pathname) || (process.platform === 'darwin' ? '.dmg' : '.exe');
  const tempDir = app.getPath('temp');
  const stableId = computeStableDownloadId(url, options.version);
  const downloadPath = path.join(tempDir, `idbots-update-${stableId}${ext}.download`);
  const finalPath = path.join(tempDir, `idbots-update-${stableId}${ext}`);
  const metaPath = path.join(tempDir, `idbots-update-${stableId}.meta.json`);

  console.log(`[AppUpdate] Stable id: ${stableId}`);
  console.log(`[AppUpdate] Temp path: ${downloadPath}`);
  console.log(`[AppUpdate] Final path: ${finalPath}`);

  const controller = new AbortController();
  activeDownloadController = controller;
  activeDownloadStableId = stableId;

  let meta: DownloadMeta | null = null;
  let writeStream: fs.WriteStream | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  const clearInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  };

  const resetInactivityTimer = () => {
    clearInactivityTimer();
    inactivityTimer = setTimeout(() => {
      console.error('[AppUpdate] Download inactivity timeout (60s), aborting');
      controller.abort('timeout');
    }, DOWNLOAD_INACTIVITY_TIMEOUT_MS);
  };

  /**
   * Stream the response body into the partial file and finalize it.
   * `initialReceived` is the byte offset already on disk for resumed runs.
   */
  const streamDownload = async (
    response: Response,
    initialReceived: number,
    total: number | undefined,
    resumed: boolean,
  ): Promise<string> => {
    if (!response.body) {
      throw new Error('Response has no body');
    }

    console.log(`[AppUpdate] Content-Length: ${total ?? 'unknown'}`);

    // Persist the total size once known, so a failure later still leaves a
    // complete metadata record (completeness check + reuse depend on it).
    if (total !== undefined && Number.isFinite(total)) {
      meta.totalSize = total;
      await writeDownloadMeta(metaPath, meta);
    }

    let received = initialReceived;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = received;
    let currentSpeed: number | undefined = undefined;
    let lastProgressTime = 0;

    const emitProgress = () => {
      onProgress({
        received,
        total: total && Number.isFinite(total) ? total : undefined,
        percent: total && Number.isFinite(total) ? received / total : undefined,
        speed: currentSpeed,
        resumed,
      });
    };

    // Emit initial progress
    emitProgress();

    await fs.promises.mkdir(path.dirname(downloadPath), { recursive: true });
    writeStream = fs.createWriteStream(downloadPath, { flags: resumed ? 'a' : 'w' });

    const nodeStream = Readable.fromWeb(response.body as any);

    // Start inactivity timer
    resetInactivityTimer();

    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;

      // Reset inactivity timer on each chunk
      resetInactivityTimer();

      // Calculate speed with 1-second window
      const now = Date.now();
      const elapsed = now - lastSpeedTime;
      if (elapsed >= 1000) {
        currentSpeed = ((received - lastSpeedBytes) / elapsed) * 1000;
        lastSpeedTime = now;
        lastSpeedBytes = received;
      }

      // Throttle progress events to avoid flooding IPC channel
      if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
        lastProgressTime = now;
        emitProgress();
      }
    });

    await pipeline(nodeStream, writeStream);
    writeStream = null;
    clearInactivityTimer();

    const savedPath = await finalizeDownload(downloadPath, finalPath, metaPath, meta!, total, options);

    // Emit final 100% progress
    onProgress({
      received,
      total: total && Number.isFinite(total) ? total : received,
      percent: 1,
      speed: currentSpeed,
      resumed,
    });

    return savedPath;
  };

  const discardPartial = async () => {
    await fs.promises.unlink(downloadPath).catch(() => {});
    await fs.promises.unlink(metaPath).catch(() => {});
  };

  try {
    // Sweep stale artifacts from previous sessions; never the active download.
    void cleanupStaleDownloads().catch(() => {});

    meta = await readDownloadMeta(metaPath);
    const partialStat = await fs.promises.stat(downloadPath).catch(() => null);

    const metaMatches = (m: DownloadMeta): boolean =>
      m.url === url &&
      m.version === (options.version ?? '') &&
      m.platform === process.platform &&
      m.arch === process.arch;

    // A previously completed download of the same target can be reused as-is.
    if (meta && metaMatches(meta) && meta.totalSize !== undefined && meta.downloadedSize === meta.totalSize) {
      const finalStat = await fs.promises.stat(finalPath).catch(() => null);
      if (finalStat && finalStat.size === meta.totalSize && finalStat.size > 0) {
        console.log(`[AppUpdate] Reusing previously completed download: ${finalPath}`);
        onProgress({ received: meta.totalSize, total: meta.totalSize, percent: 1, speed: undefined });
        return finalPath;
      }
    }

    // Decide whether this run can resume from an existing partial file.
    let canResume = false;
    let resumeOffset = 0;
    let resumeEtag: string | undefined;
    if (meta && metaMatches(meta) && partialStat && partialStat.size > 0 && partialStat.size === meta.downloadedSize) {
      if (meta.totalSize !== undefined && partialStat.size > meta.totalSize) {
        console.warn(`[AppUpdate] Partial file (${partialStat.size}B) exceeds expected size, restarting`);
      } else if (meta.totalSize === undefined || partialStat.size < meta.totalSize) {
        canResume = true;
        resumeOffset = partialStat.size;
        resumeEtag = meta.etag;
        console.log(`[AppUpdate] Found partial download (${resumeOffset} bytes), will resume`);
      } else {
        // The partial already covers the full payload — no network needed.
        console.log('[AppUpdate] Partial file is already complete, verifying...');
        return await finalizeDownload(downloadPath, finalPath, metaPath, meta, meta.totalSize, options);
      }
    }

    let offset = canResume ? resumeOffset : 0;
    let resumed = canResume;
    let etag = resumeEtag;
    let attempts = 0;

    for (;;) {
      attempts += 1;

      // Persist (or refresh) metadata before each attempt so a crash mid-run
      // still leaves a consistent sidecar for the next launch.
      if (!meta || !metaMatches(meta)) {
        meta = {
          url,
          version: options.version ?? '',
          platform: process.platform,
          arch: process.arch,
          downloadedSize: 0,
          updatedAt: Date.now(),
        };
      }
      meta.downloadedSize = offset;
      meta.updatedAt = Date.now();
      if (etag) {
        meta.etag = etag;
      }
      await writeDownloadMeta(metaPath, meta);

      const headers: Record<string, string> = {};
      if (resumed && offset > 0) {
        headers['Range'] = `bytes=${offset}-`;
        if (etag) {
          headers['If-Range'] = etag;
        }
        console.log(`[AppUpdate] Resuming download from byte ${offset}`);
      }

      const response = await session.defaultSession.fetch(url, {
        signal: controller.signal,
        headers,
      });

      console.log(`[AppUpdate] HTTP response: ${response.status} ${response.statusText}`);

      if (response.status === 416) {
        // Range not satisfiable. A partial that already covers the payload is
        // finalized; anything else is discarded and re-downloaded.
        if (resumed && meta.totalSize !== undefined && offset >= meta.totalSize) {
          return await finalizeDownload(downloadPath, finalPath, metaPath, meta, meta.totalSize, options);
        }
        if (resumed && attempts < 2) {
          console.warn('[AppUpdate] Range not satisfiable, restarting download from scratch');
          await discardPartial();
          meta = null;
          offset = 0;
          resumed = false;
          etag = undefined;
          continue;
        }
        throw new Error(`Download failed (HTTP 416)`);
      }

      if (response.status === 206) {
        const contentRange = response.headers.get('content-range');
        const rangeMatch = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/);
        const responseEtag = response.headers.get('etag') ?? undefined;
        const start = rangeMatch ? Number(rangeMatch[1]) : NaN;
        const rangeTotal = rangeMatch && rangeMatch[3] !== '*' ? Number(rangeMatch[3]) : undefined;
        const validResume =
          resumed &&
          !!rangeMatch &&
          start === offset &&
          (meta.totalSize === undefined || rangeTotal === undefined || rangeTotal === meta.totalSize) &&
          (!etag || !responseEtag || responseEtag === etag);
        if (validResume) {
          const total = rangeTotal ?? meta.totalSize;
          if (responseEtag) {
            meta.etag = responseEtag;
          }
          return await streamDownload(response, offset, total, true);
        }
        if (resumed && attempts < 2) {
          console.warn(
            `[AppUpdate] Invalid 206 resume response (${contentRange ?? 'no content-range'}), restarting download`,
          );
          await discardPartial();
          meta = null;
          offset = 0;
          resumed = false;
          etag = undefined;
          continue;
        }
        throw new Error(`Download failed (HTTP 206)`);
      }

      if (response.status === 200) {
        if (resumed && attempts < 2) {
          console.log('[AppUpdate] Server ignored Range request (HTTP 200), restarting download from scratch');
          await discardPartial();
          meta = null;
          offset = 0;
          resumed = false;
          etag = undefined;
          continue;
        }
        const totalHeader = response.headers.get('content-length');
        const total = totalHeader ? Number(totalHeader) : undefined;
        return await streamDownload(response, 0, total, false);
      }

      if (!response.ok) {
        throw new Error(`Download failed (HTTP ${response.status})`);
      }
      throw new Error(`Unexpected HTTP status ${response.status}`);
    }
  } catch (error) {
    clearInactivityTimer();
    console.error('[AppUpdate] Download error:', error);

    // Keep the partial file and sync the metadata so the next attempt can
    // resume from the exact byte count actually on disk.
    try {
      if (writeStream) {
        writeStream.destroy();
      }
      const size = (await fs.promises.stat(downloadPath).catch(() => null))?.size;
      if (meta && size !== undefined) {
        meta.downloadedSize = size;
        meta.updatedAt = Date.now();
        await writeDownloadMeta(metaPath, meta);
      }
    } catch {
      // Ignore cleanup errors
    }

    if (controller.signal.aborted) {
      if (controller.signal.reason === 'timeout') {
        throw new Error('Download timed out: no data received for 60 seconds');
      }
      throw new Error('Download cancelled');
    }
    throw error;
  } finally {
    activeDownloadController = null;
    activeDownloadStableId = null;
  }
}

export async function installUpdate(filePath: string): Promise<void> {
  console.log(`[AppUpdate] Installing update from: ${filePath}`);
  console.log(`[AppUpdate] Platform: ${process.platform}, Arch: ${process.arch}`);

  // Verify the file exists before attempting install
  try {
    const stat = await fs.promises.stat(filePath);
    console.log(`[AppUpdate] Installer file size: ${stat.size} bytes`);
    if (stat.size === 0) {
      throw new Error('Update file is empty');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Update file not found');
    }
    throw error;
  }

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
    // Mount the DMG (timeout 60s)
    console.log('[AppUpdate] Mounting DMG...');
    const mountOutput = await execAsync(
      `hdiutil attach ${shellEscape(dmgPath)} -nobrowse -noautoopen -noverify`,
      60_000,
    );

    const detectedMountPoint = parseHdiutilMountPoint(mountOutput);
    if (!detectedMountPoint) {
      throw new Error('Failed to determine mount point from hdiutil output');
    }
    mountPoint = detectedMountPoint;
    console.log(`[AppUpdate] Mounted at: ${mountPoint}`);

    // Find .app bundle in mount point
    const entries = await fs.promises.readdir(mountPoint);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) {
      throw new Error('No .app bundle found in DMG');
    }

    const sourceApp = path.join(mountPoint, appBundle);
    console.log(`[AppUpdate] Source app: ${sourceApp}`);

    await assertInstallerBundleVersion(dmgPath, sourceApp);

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
    console.log(`[AppUpdate] Target app: ${targetApp}`);

    // Try to copy the .app bundle (use shellEscape to prevent injection)
    try {
      console.log('[AppUpdate] Copying app bundle...');
      await execAsync(
        `rm -rf ${shellEscape(targetApp)} && cp -R ${shellEscape(sourceApp)} ${shellEscape(targetApp)}`,
        300_000,
      );
      console.log('[AppUpdate] Copy succeeded');
    } catch {
      // Permission denied: try with admin privileges via osascript
      console.log('[AppUpdate] Normal copy failed, requesting admin privileges...');
      try {
        // For osascript, escape backslashes and double quotes for the inner shell
        const escapeForInnerShell = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
        const escapedTarget = escapeForInnerShell(targetApp);
        const escapedSource = escapeForInnerShell(sourceApp);
        await execAsync(
          `osascript -e 'do shell script "rm -rf \\"${escapedTarget}\\" && cp -R \\"${escapedSource}\\" \\"${escapedTarget}\\"" with administrator privileges'`,
          300_000,
        );
        console.log('[AppUpdate] Admin copy succeeded');
      } catch (adminError) {
        throw new Error(
          `Installation failed: insufficient permissions. ${adminError instanceof Error ? adminError.message : ''}`,
        );
      }
    }

    // Detach DMG (timeout 30s)
    try {
      await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
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
      console.log(`[AppUpdate] Relaunching: ${path.join(executablePath, executable)}`);
      app.relaunch({ execPath: path.join(executablePath, executable) });
    } else {
      console.log('[AppUpdate] Relaunching (default)');
      app.relaunch();
    }
    app.quit();
  } catch (error) {
    console.error('[AppUpdate] macOS install error:', error);
    // Clean up mount point on error
    if (mountPoint) {
      try {
        await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
      } catch {
        // Best effort
      }
    }
    throw error;
  }
}

/**
 * Relaunch target recorded after a successful silent macOS apply.
 * Consumed by relaunchPendingMacUpdate() when the user confirms the restart.
 */
let pendingMacRelaunch: { execPath?: string } | null = null;

/** Relaunch into the silently-applied macOS update. Returns false when no update is pending. */
export async function relaunchPendingMacUpdate(): Promise<boolean> {
  if (!pendingMacRelaunch) {
    return false;
  }
  const { execPath } = pendingMacRelaunch;
  pendingMacRelaunch = null;
  if (execPath) {
    console.log(`[AppUpdate] Relaunching into updated app: ${execPath}`);
    app.relaunch({ execPath });
  } else {
    console.log('[AppUpdate] Relaunching (default)');
    app.relaunch();
  }
  app.quit();
  return true;
}

function isMacPermissionError(message: string): boolean {
  return /permission denied|operation not permitted|read-only file system/i.test(message);
}

/**
 * Silently replace the running .app bundle with the one inside the DMG.
 * No elevation prompt and no relaunch — on success the relaunch target is
 * stored for relaunchPendingMacUpdate(). On permission failure the thrown
 * error carries code 'EACCES' so the caller can fall back to the elevated
 * interactive install path. The DMG is deleted on success but kept on
 * failure so the fallback install can reuse it without re-downloading.
 */
export async function applyMacUpdateSilently(dmgPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Silent apply is only supported on macOS');
  }

  console.log(`[AppUpdate] Silent apply from: ${dmgPath}`);
  let mountPoint: string | null = null;

  try {
    const stat = await fs.promises.stat(dmgPath);
    if (stat.size === 0) {
      throw new Error('Update file is empty');
    }

    console.log('[AppUpdate] Mounting DMG...');
    const mountOutput = await execAsync(
      `hdiutil attach ${shellEscape(dmgPath)} -nobrowse -noautoopen -noverify`,
      60_000,
    );
    const detectedMountPoint = parseHdiutilMountPoint(mountOutput);
    if (!detectedMountPoint) {
      throw new Error('Failed to determine mount point from hdiutil output');
    }
    mountPoint = detectedMountPoint;

    const entries = await fs.promises.readdir(mountPoint);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) {
      throw new Error('No .app bundle found in DMG');
    }
    const sourceApp = path.join(mountPoint, appBundle);

    await assertInstallerBundleVersion(dmgPath, sourceApp);

    const currentAppPath = path.resolve(process.resourcesPath, '..', '..', '..');
    const targetApp = currentAppPath.endsWith('.app') ? currentAppPath : `/Applications/${appBundle}`;
    console.log(`[AppUpdate] Target app: ${targetApp}`);

    // Copy to a sibling directory first, then swap via mv: this keeps a valid
    // .app at the target path at all times (unlike rm -rf && cp -R).
    const ts = Date.now();
    const tmpApp = `${targetApp}.idbots-new-${ts}`;
    const oldApp = `${targetApp}.idbots-old-${ts}`;
    try {
      await execAsync(
        `cp -R ${shellEscape(sourceApp)} ${shellEscape(tmpApp)} && mv ${shellEscape(targetApp)} ${shellEscape(oldApp)} && mv ${shellEscape(tmpApp)} ${shellEscape(targetApp)} && rm -rf ${shellEscape(oldApp)}`,
        300_000,
      );
      console.log('[AppUpdate] Silent swap succeeded');
    } catch (copyError) {
      // Best-effort rollback: drop the partial copy, restore the original app
      // if the swap left the target path empty.
      await execAsync(
        `if [ -d ${shellEscape(tmpApp)} ]; then rm -rf ${shellEscape(tmpApp)}; fi; if [ ! -d ${shellEscape(targetApp)} ] && [ -d ${shellEscape(oldApp)} ]; then mv ${shellEscape(oldApp)} ${shellEscape(targetApp)}; fi`,
        60_000,
      ).catch(() => {});
      throw copyError;
    }

    try {
      await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
    } catch {
      // Best effort
    }
    mountPoint = null;

    try {
      await fs.promises.unlink(dmgPath);
    } catch {
      // Best effort
    }

    const executableDir = path.join(targetApp, 'Contents', 'MacOS');
    const execEntries = await fs.promises.readdir(executableDir);
    pendingMacRelaunch = { execPath: execEntries[0] ? path.join(executableDir, execEntries[0]) : undefined };
    console.log('[AppUpdate] Silent apply complete, update pending restart');
  } catch (error) {
    console.error('[AppUpdate] Silent apply error:', error);
    if (mountPoint) {
      try {
        await execAsync(`hdiutil detach ${shellEscape(mountPoint)} -force`, 30_000);
      } catch {
        // Best effort
      }
    }
    if (error instanceof Error && isMacPermissionError(error.message)) {
      (error as NodeJS.ErrnoException).code = 'EACCES';
    }
    throw error;
  }
}

export function launchWindowsNsisInstaller(
  exePath: string,
  spawnImpl: typeof spawn = spawn,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const installer = spawnImpl(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    installer.once('error', (error) => {
      reject(new Error(`Failed to launch the Windows installer: ${error.message}`));
    });
    installer.once('spawn', () => {
      installer.unref();
      resolve(installer.pid);
    });
  });
}

async function installWindowsNsis(exePath: string): Promise<void> {
  console.log(`[AppUpdate] Windows NSIS install (interactive mode)`);
  console.log(`[AppUpdate]   installer: ${exePath}`);
  console.log(`[AppUpdate]   appPid: ${process.pid}`);

  const installerPid = await launchWindowsNsisInstaller(exePath);
  console.log(`[AppUpdate] Installer PID: ${installerPid}, calling app.quit()`);
  app.quit();
}
