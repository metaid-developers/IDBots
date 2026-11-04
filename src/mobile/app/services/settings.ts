import { mobileI18n } from '../../i18n';
import type { MobileLanguage } from '../../i18n';
import { normalizeThemeMode, THEME_MIRROR_STORAGE_KEY, type ThemeMode } from '../../themeMirror';
import { getMobileElectron } from '../appBridge';

export type { ThemeMode };

export interface MobileAppConfig {
  language?: string;
  theme?: string;
  [key: string]: unknown;
}

/**
 * App-level preferences (language, theme) persisted in the R-store's
 * `app_config` key, mirroring the desktop shape. Writes are field patches;
 * the gateway serializes them against the latest stored config. A setting is
 * applied locally only after the tenant confirms the write and readback.
 *
 * The theme value is additionally mirrored into `window.localStorage`
 * (THEME_MIRROR_STORAGE_KEY) after every confirmed change so the login
 * bundle — served by the control plane before any bridge exists — resolves
 * the same preference synchronously pre-paint (src/mobile/login/theme.ts).
 */

const listeners = new Set<() => void>();
let themeMode: ThemeMode = 'system';

/**
 * Best-effort localStorage mirror of the authoritative theme preference.
 * Silently skipped where localStorage is unavailable (SSR/tests, private
 * mode, quota): the R-store readback remains the source of truth.
 */
function mirrorThemePreference(mode: ThemeMode): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(THEME_MIRROR_STORAGE_KEY, mode);
  } catch {
    // Mirror is best-effort only; never fail a settings write over it.
  }
}

function syncDarkClass(): void {
  const prefersDark =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', themeMode === 'dark' || (themeMode === 'system' && prefersDark));
}

export function getThemeMode(): ThemeMode {
  return themeMode;
}

export function applyThemeMode(mode: ThemeMode): void {
  themeMode = mode;
  syncDarkClass();
  for (const listener of [...listeners]) listener();
}

/** Re-evaluates the dark class when the OS scheme flips (system mode only). */
export function initSystemThemeListener(): void {
  if (typeof window.matchMedia !== 'function') return;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncDarkClass);
  syncDarkClass();
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hydrates language + theme from `app_config` before first paint. */
export async function loadSettings(): Promise<void> {
  mobileI18n.initFromDeviceLocale();
  try {
    const config = (await getMobileElectron().store.get('app_config')) as MobileAppConfig | null;
    if (config?.language === 'zh' || config?.language === 'en') {
      mobileI18n.setLanguage(config.language as MobileLanguage);
    }
    const theme = normalizeThemeMode(config?.theme);
    applyThemeMode(theme);
    mirrorThemePreference(theme);
  } catch (error) {
    console.warn('[mobile-settings] hydration failed; using device defaults', error);
    applyThemeMode('system');
  }
}

async function persistSettings(patch: Partial<MobileAppConfig>): Promise<void> {
  await getMobileElectron().store.set('app_config', patch);
  const saved = (await getMobileElectron().store.get('app_config')) as MobileAppConfig | null;
  for (const [key, value] of Object.entries(patch)) {
    if (saved?.[key] !== value) {
      throw new Error(`Settings save could not be confirmed for ${key}`);
    }
  }
}

export async function setLanguage(language: MobileLanguage): Promise<void> {
  await persistSettings({ language });
  mobileI18n.setLanguage(language);
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  await persistSettings({ theme: mode });
  applyThemeMode(mode);
  // Only after the R-store write is confirmed (persistSettings throws on a
  // failed readback), so the mirror never drifts ahead of the source of truth.
  mirrorThemePreference(mode);
}
