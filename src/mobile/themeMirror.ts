/**
 * Same-origin theme-preference mirror shared by the app and login bundles.
 *
 * The R-store (`window.electron.store` key `app_config`) stays authoritative:
 * the app writes the theme there through the gateway (or the mock bridge in
 * dev) and mirrors the confirmed value into `window.localStorage` so the
 * login bundle — which runs BEFORE any bridge exists and must resolve the
 * theme synchronously before first paint — can read the same preference on
 * the same origin without installing a gateway client (80 KB login budget,
 * REQ-E-19). localStorage is only ever a read-through mirror: when it is
 * empty the login entry falls back to the OS scheme, matching the app
 * default (`system`).
 */

/** Theme preference values, mirroring `app_config.theme` on the R-store. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** localStorage key the app settings service mirrors the theme into. */
export const THEME_MIRROR_STORAGE_KEY = 'idbots.mobile.app_config.theme.v1';

/** Anything other than an explicit light/dark is treated as system default. */
export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** `system` tracks the OS scheme; explicit light/dark win over it. */
export function resolveIsDark(mode: ThemeMode, prefersDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && prefersDark);
}
