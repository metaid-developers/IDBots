/**
 * REQ-E-3: the real mobile bridge. Builds `window.electron` from the
 * WS-A-generated IPC contract (`src/mobile/generated/ipc-contract.json`) on
 * top of the C2 gateway client, replacing the mock bridge (REQ-E-8) when the
 * app runs against a tenant. Installed before React mounts.
 *
 * Result mapping: this shim forwards invoke promises untouched because the
 * gateway client already unwraps C2 Result frames exactly like the desktop
 * `ipcRenderer.invoke` surface the renderer is written against —
 * `HANDLER_ERROR` rejects with a bare `Error` carrying the handler message,
 * other gateway errors reject with an `Error` whose `.code` is the C2 code
 * and whose `.retryable` mirrors the frame, and `{ success: false }` handler
 * envelopes arrive as successful values and pass through unchanged (C2
 * "Handlers that already return `{ success: false, error }` keep doing so").
 *
 * Event subscriptions: C2 event frames carry `args` — the positional
 * arguments the main process sent to renderers (C2 §Frames). The desktop
 * preload wraps the same payloads as `(_event, data) => callback(data)`, and
 * every allowlisted event sends exactly one payload argument, so spreading
 * `args` into the callback reproduces the desktop semantics.
 *
 * DOM access: the S-tier layer touches `window`/`document` only at call time
 * (never at module evaluation), so tests can install minimal fakes on
 * `globalThis` before invoking and remove them afterwards.
 */

import type { IdbotsMobileOs, IdbotsMobileShell } from './types';
import type { UploadErrorCode, UploadFileOptions } from './upload';
import { toBrowserFileUrl } from '../../renderer/services/localFileUrl';
import rawIpcContract from '../generated/ipc-contract.json';
import { getNativeAdapter } from '../native/nativeAdapter';
import type { MobileNativeAdapter } from '../native/nativeAdapter';

/** Structural view of the C2 gateway client this shim is wired against. */
export interface GatewayInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  onEvent(channel: string, cb: (args: unknown[]) => void): () => void;
}

/** Where an uploaded phone file landed on the server (REQ-E-6 seam). */
export interface UploadedFileInfo {
  path: string;
  size: number;
  mime: string;
}

export type UploadFileFn = (
  file: File,
  options?: Pick<UploadFileOptions, 'onProgress'>,
) => Promise<UploadedFileInfo>;

export interface PhoneUploadProgress {
  fileIndex: number;
  fileName: string;
  fileSize: number;
  mime: string;
  loaded: number;
  total: number;
  path?: string;
}

export type PhoneFileSelectionSource = 'camera' | 'photos' | 'files';
export type PhoneFileSelectionErrorCode = UploadErrorCode | 'PERMISSION_DENIED' | 'UNAVAILABLE' | 'NATIVE_FAILED';

export interface PhoneFileSelectionOptions {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  multi?: boolean;
  source?: PhoneFileSelectionSource;
  onUploadProgress?: (progress: PhoneUploadProgress) => void;
}

export interface PhoneFileSelectionResult {
  success: boolean;
  path: string | null;
  paths?: string[];
  error?: string;
  errorCode?: PhoneFileSelectionErrorCode;
  failedIndex?: number;
}

export interface ShimDeps {
  gateway: GatewayInvoker;
  /** REQ-E-6 upload seam; required for `dialog.selectFile`, optional elsewhere. */
  uploadFile?: UploadFileFn;
  nativeAdapter?: MobileNativeAdapter;
}

export interface ShimHandle {
  electron: Window['electron'];
}

export interface IpcContractEntry {
  path: string;
  kind: 'invoke' | 'on' | 'send' | 'value';
  channel?: string;
  args?: string[];
  note?: string;
}

export interface IpcContractFile {
  contractVersion: string;
  allowlistVersion: string;
  source: string;
  methods: IpcContractEntry[];
}

const ipcContract = rawIpcContract as unknown as IpcContractFile;

// ---------------------------------------------------------------------------
// Client-fact detection (same pattern as installMockBridge.ts, which this
// file must not edit).
// ---------------------------------------------------------------------------

export function detectMobileOs(): IdbotsMobileOs {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'web';
}

export function detectMobileShell(): IdbotsMobileShell {
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : {};
  const capacitor = w.Capacitor as { isNativePlatform?: () => boolean } | undefined;
  if (typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()) {
    return 'capacitor';
  }
  const standalone = typeof navigator !== 'undefined' ? (navigator as { standalone?: boolean }).standalone : false;
  const displayModeStandalone =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
  if (standalone === true || displayModeStandalone) {
    return 'pwa';
  }
  return 'browser';
}

function browserWindow(): Window | null {
  return typeof window !== 'undefined' ? window : null;
}

function browserDocument(): Document | null {
  return typeof document !== 'undefined' ? document : null;
}

// ---------------------------------------------------------------------------
// REQ-E-4: S-tier local answers (`02` tiers table). The gateway denies these
// channels, so the shim answers them locally and they never reach the server.
// Shapes match the desktop main-process handlers (src/main/main.ts) and the
// renderer typings (src/renderer/types/electron.d.ts) so consumers behave the
// same on the phone.
// ---------------------------------------------------------------------------

type STierHandler = (...args: never[]) => unknown;

function buildSTierHandlers(deps: ShimDeps): Record<string, STierHandler> {
  return {
    // main.ts:10384 — `{ success: true, elapsedMs, startedAt }` with numbers.
    'startup:rendererInitialized': () => Promise.resolve({ success: true, elapsedMs: 0, startedAt: Date.now() }),
    // `02`: the phone has no local working directories.
    'get-recent-cwds': () => Promise.resolve([]),
    // A phone window is never maximized.
    'window:isMaximized': () => Promise.resolve(false),
    // main.ts:17331 (cancelled selectDirectory) — success with a null path.
    'dialog:selectDirectory': () => Promise.resolve({ success: true, path: null }),
    // Cancelled convention shared with selectDirectory (null path, no error).
    'dialog:saveInlineFile': () => Promise.resolve({ success: true, path: null }),
    'dialog:selectFile': ((options?: unknown) => selectFileOnPhone(deps, options)) as STierHandler,
    // main.ts:17419-17428 — http(s) only, desktop error wording preserved.
    'shell:openExternal': ((url?: unknown) => openExternalOnPhone(deps, url)) as STierHandler,
    // `02`: sign the /data path (C2 File Download) and open the signed URL.
    'shell:openPath': ((filePath?: unknown) => signAndOpen(deps.gateway, filePath)) as STierHandler,
    'shell:showItemInFolder': ((filePath?: unknown) => signAndOpen(deps.gateway, filePath)) as STierHandler,
    'shell:openWith': ((filePath?: unknown) => signAndOpen(deps.gateway, filePath)) as STierHandler,
    // `02`: the phone has no "open with" registry.
    'shell:getOpenWithApps': () => Promise.resolve({ success: true, apps: [] }),
    // Cancelled: nothing was chosen.
    'shell:chooseOpenWithApp': () => Promise.resolve({ success: false }),
  };
}

async function openExternalOnPhone(deps: ShimDeps, url: unknown): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    return { success: false, error: 'URL is empty' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'Only http and https URLs are allowed' };
    }
  } catch {
    return { success: false, error: 'Invalid URL' };
  }
  try {
    await (deps.nativeAdapter ?? getNativeAdapter()).openExternal(trimmed);
    return { success: true };
  } catch {
    return { success: false, error: 'Failed to open external URL' };
  }
}

async function signAndOpen(
  gateway: GatewayInvoker,
  filePath: unknown,
): Promise<{ success: boolean; error?: string }> {
  const path = typeof filePath === 'string' ? filePath : '';
  if (!path) {
    return { success: false, error: 'empty_path' };
  }
  try {
    const signed = (await gateway.invoke('gateway:file:sign', { path, disposition: 'inline' })) as
      | { url?: unknown; error?: unknown }
      | null
      | undefined;
    const rawUrl = signed?.url;
    if (typeof rawUrl === 'string' && rawUrl.length > 0) {
      // F-11: the signed url carries the tenant route prefix
      // (/gateway/v1/files/…), which does not exist on the origin the PWA
      // is served from; rewrite it to the same-origin /files/{token} route
      // the control plane (or dev proxy) exposes.
      const url = toBrowserFileUrl(rawUrl);
      const win = browserWindow();
      const opened = win?.open?.(url, '_blank', 'noopener,noreferrer');
      if (!opened && win) {
        // window.open after an await loses the user gesture and is
        // popup-blocked on phones; fall back to a same-tab navigation (an
        // attachment/inline GET that shows the download or preview).
        win.location.assign(url);
      }
      return { success: true };
    }
    // `{ success: false }` envelopes pass through from the gateway client.
    const error = signed?.error;
    return { success: false, error: typeof error === 'string' && error ? error : 'Failed to open file' };
  } catch (error) {
    // Gateway rejections (HANDLER_ERROR and coded errors) land here; resolve
    // with the desktop `shell:openPath` failure shape (main.ts:17401/17405).
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function acceptFromFilters(filters: PhoneFileSelectionOptions['filters']): string {
  if (!Array.isArray(filters)) return '';
  const extensions = filters.flatMap((filter) => (Array.isArray(filter?.extensions) ? filter.extensions : []));
  return extensions
    .filter((ext) => typeof ext === 'string' && ext !== '' && ext !== '*')
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
    .join(',');
}

function pickFiles(doc: Document, accept: string, multi: boolean): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.multiple = multi;
    if (accept) input.accept = accept;
    let settled = false;
    const finish = (result: File[] | null) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
      resolve(result);
    };
    const onChange = () => finish(Array.from(input.files ?? []).slice(0, multi ? undefined : 1));
    const onCancel = () => finish(null);
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    doc.body?.appendChild(input);
    input.click();
  });
}

function uploadErrorCode(error: unknown): UploadErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'TOO_LARGE' || code === 'BLOCKED_TYPE' || code === 'QUOTA_EXCEEDED') return code;
  return 'UPLOAD_FAILED';
}

function selectionErrorCode(error: unknown): PhoneFileSelectionErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'PERMISSION_DENIED' || code === 'UNAVAILABLE' || code === 'NATIVE_FAILED' || code === 'TOO_LARGE') return code;
  return 'UPLOAD_FAILED';
}

export async function selectFileOnPhone(
  deps: Pick<ShimDeps, 'uploadFile' | 'nativeAdapter'>,
  options: unknown,
): Promise<PhoneFileSelectionResult> {
  const upload = deps.uploadFile;
  if (typeof upload !== 'function') {
    console.warn('[mobile-shim] dialog.selectFile: no uploadFile provided; returning a cancelled result');
    return { success: true, path: null, paths: [] };
  }
  const doc = browserDocument();
  if (!doc) {
    console.warn('[mobile-shim] dialog.selectFile: no document available; returning a cancelled result');
    return { success: true, path: null, paths: [] };
  }
  const opts = (options ?? {}) as PhoneFileSelectionOptions;
  const source = opts.source ?? 'files';
  const adapter = deps.nativeAdapter ?? (typeof window === 'undefined' ? null : getNativeAdapter());
  const capabilities = adapter?.getCapabilities();
  let files: File[] | null;
  try {
    if (adapter && source !== 'files' && capabilities?.[source] === true) {
      const file = await adapter.pickPhoto(source);
      files = file ? [file] : null;
    } else if (adapter && source === 'files' && capabilities?.files === true) {
      files = await adapter.pickFiles(opts.multi === true);
    } else {
      const accept = acceptFromFilters(opts.filters) || (source === 'files' ? '' : 'image/*');
      files = await pickFiles(doc, accept, opts.multi === true);
    }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'CANCELLED') return { success: true, path: null, paths: [] };
    return {
      success: false,
      path: null,
      paths: [],
      error: error instanceof Error ? error.message : 'File selection failed',
      errorCode: selectionErrorCode(error),
      failedIndex: 0,
    };
  }
  if (!files || files.length === 0) {
    // Cancelled shape matches the desktop dialog: success with null path.
    return { success: true, path: null, paths: [] };
  }
  const paths: string[] = [];
  for (const [fileIndex, file] of files.entries()) {
    const progress = {
      fileIndex,
      fileName: file.name,
      fileSize: file.size,
      mime: file.type,
    };
    try {
      opts.onUploadProgress?.({ ...progress, loaded: 0, total: file.size });
      const uploaded = await upload(file, {
        onProgress: (loaded, total) => opts.onUploadProgress?.({ ...progress, loaded, total }),
      });
      paths.push(uploaded.path);
      opts.onUploadProgress?.({
        ...progress,
        fileSize: uploaded.size,
        mime: uploaded.mime,
        loaded: uploaded.size,
        total: uploaded.size,
        path: uploaded.path,
      });
    } catch (error) {
      return {
        success: false,
        path: paths[0] ?? null,
        paths,
        error: error instanceof Error ? error.message : 'Upload failed',
        errorCode: uploadErrorCode(error),
        failedIndex: fileIndex,
      };
    }
  }
  // Desktop success shape (main.ts:17345): first path plus the full list.
  return { success: true, path: paths[0], paths };
}

// ---------------------------------------------------------------------------
// Contract builder (REQ-E-3).
// ---------------------------------------------------------------------------

function buildHandler(
  entry: IpcContractEntry,
  overrides: Record<string, STierHandler>,
  deps: ShimDeps,
): unknown {
  const override = entry.channel ? overrides[entry.channel] : undefined;
  if (override) {
    return override;
  }
  switch (entry.kind) {
    case 'invoke':
      return (...args: unknown[]) => deps.gateway.invoke(entry.channel as string, ...args);
    case 'on':
      return (callback: (...callbackArgs: unknown[]) => void) =>
        deps.gateway.onEvent(entry.channel as string, (eventArgs) => callback(...eventArgs));
    case 'send':
      // `02`: renderer-to-main send channels are tier N; the shim drops them.
      return () => undefined;
    case 'value':
      // REQ-E-3: the SERVER's values (path handling depends on them), never
      // the phone's.
      if (entry.path === 'platform') return 'linux';
      if (entry.path === 'arch') return 'x64';
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Pure builder: turns a parsed IPC contract into the `window.electron`
 * surface. Exported for tests; `installShim` uses it with the generated
 * contract.
 */
export function buildElectronFromContract(contract: IpcContractFile, deps: ShimDeps): Window['electron'] {
  const overrides = buildSTierHandlers(deps);
  const root: Record<string, unknown> = {};
  for (const entry of contract.methods) {
    const segments = entry.path.split('.');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const child = node[segment];
      if (typeof child !== 'object' || child === null) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = buildHandler(entry, overrides, deps);
  }
  return root as unknown as Window['electron'];
}

/**
 * Installs the real bridge: builds `window.electron` from the generated
 * contract and records the client facts in `window.idbotsMobile` (C2 shape).
 * Safe to call outside the browser (the globals are assigned only when a
 * `window` exists), which keeps the builder testable under node:test.
 */
export function installShim(deps: ShimDeps): ShimHandle {
  const electron = buildElectronFromContract(ipcContract, deps);
  if (typeof window !== 'undefined') {
    window.electron = electron;
    window.idbotsMobile = {
      isMobile: true,
      os: detectMobileOs(),
      shell: detectMobileShell(),
    };
  }
  return { electron };
}
