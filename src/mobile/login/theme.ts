/**
 * Login-bundle theme resolution (REQ-E-10 companion): the login page must
 * render in the same theme as the app, but it is served by the control plane
 * BEFORE any bridge/session exists and shares the 80 KB login gzip budget
 * (REQ-E-19) — no gateway client, no settings service import graph.
 *
 * It reads the same-origin localStorage mirror the app settings service
 * writes on every confirmed theme change (themeMirror.THEME_MIRROR_STORAGE_KEY)
 * and falls back to the OS scheme, which matches the app default (`system`).
 *
 * initLoginTheme() is called at module-eval time in login/main.tsx, before
 * ReactDOM renders: the documentElement class/background/color-scheme are
 * applied synchronously so the first paint is already correct. A
 * prefers-color-scheme listener keeps `system` mode live. login/index.html
 * additionally carries a tiny inline head script that applies the same
 * resolution during HTML parsing (it must stay in sync with this module).
 */

import { normalizeThemeMode, resolveIsDark, THEME_MIRROR_STORAGE_KEY, type ThemeMode } from '../themeMirror';

/** Page backgrounds match the Twin UI Daylight and Nocturne canvas tokens. */
export const LOGIN_PAGE_BG = { light: '#F2F3F5', dark: '#111112' } as const;

/** Storage abstraction so resolution is testable without a real window. */
type ThemeStorage = Pick<Storage, 'getItem'>;

/** Reads the app-mirrored theme preference; unknown/missing → `system`. */
export function readStoredThemeMode(storage?: ThemeStorage | null): ThemeMode {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!target) return 'system';
  try {
    return normalizeThemeMode(target.getItem(THEME_MIRROR_STORAGE_KEY));
  } catch {
    // Storage can throw in private modes; treat as "no stored preference".
    return 'system';
  }
}

/** OS dark-scheme query, false wherever matchMedia is unavailable. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

export interface LoginThemeHandle {
  /** The resolved preference (light/dark/system), not the effective scheme. */
  getMode: () => ThemeMode;
  /** Effective dark flag the UI palette is keyed on. */
  isDark: () => boolean;
  /** Notified on every effective change (OS scheme flip in system mode). */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Applies the theme to the document synchronously (pre-paint: called from
 * the login entry module before ReactDOM renders) and keeps `system` mode
 * live via a matchMedia listener. All DOM access is guarded so the module
 * stays importable under node-based tests.
 */
export function initLoginTheme(options?: { storage?: ThemeStorage | null }): LoginThemeHandle {
  const mode = readStoredThemeMode(options?.storage);
  let dark = resolveIsDark(mode, systemPrefersDark());
  const listeners = new Set<() => void>();

  const applyDocument = (): void => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', dark);
    // color-scheme also flips native form controls (checkbox/inputs).
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.style.backgroundColor = dark ? LOGIN_PAGE_BG.dark : LOGIN_PAGE_BG.light;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      (document.head ?? document).appendChild(meta);
    }
    meta.setAttribute('content', dark ? LOGIN_PAGE_BG.dark : LOGIN_PAGE_BG.light);
  };

  const sync = (): void => {
    const nextDark = resolveIsDark(mode, systemPrefersDark());
    if (nextDark === dark) return;
    dark = nextDark;
    applyDocument();
    for (const listener of [...listeners]) listener();
  };

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
  }

  applyDocument();

  return {
    getMode: () => mode,
    isDark: () => dark,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
