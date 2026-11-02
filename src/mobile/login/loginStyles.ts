/**
 * Login palette, keyed on the effective dark flag (see login/theme.ts).
 *
 * Values mirror the app theme tokens in src/renderer/index.css so the login
 * page reads as the same product in both schemes:
 *
 *   token            light        dark
 *   --bg-main        #F5F7F9      #142030   (page background)
 *   --bg-panel       #FFFFFF      #1f2937   (cards, sheets, inputs)
 *   --text-primary   #303133      #ffffff
 *   --text-secondary #64748B      #94A3B8
 *   --border-color   #BFC2CC      #6b7280
 *   --color-primary  #ffdc51      #ffdc51   (brand yellow, both schemes)
 *
 * Brand yellow stays identical in dark mode (the app's --color-primary does
 * not change), so every #ffdc51/#111 pairing below is theme-invariant, not a
 * leftover light color.
 */

import type React from 'react';

interface LoginPalette {
  pageBg: string;
  surface: string;
  text: string;
  textSecondary: string;
  checkboxRow: string;
  border: string;
  link: string;
  noteSmall: string;
  error: string;
  placeholder: string;
}

const LIGHT: LoginPalette = {
  pageBg: '#F5F7F9',
  surface: '#fff',
  text: '#303133',
  textSecondary: '#64748B',
  checkboxRow: '#475569',
  border: '#BFC2CC',
  link: '#1D4ED8',
  noteSmall: '#94A3B8',
  error: '#B42318',
  placeholder: '#94A3B8',
};

const DARK: LoginPalette = {
  pageBg: '#142030',
  surface: '#1f2937',
  text: '#fff',
  textSecondary: '#94A3B8',
  checkboxRow: '#CBD5E1',
  border: '#6b7280',
  link: '#60A5FA',
  noteSmall: '#64748B',
  error: '#F87171',
  placeholder: '#64748B',
};

export function loginPalette(isDark: boolean): LoginPalette {
  return isDark ? DARK : LIGHT;
}

/**
 * Builds the login screen styles for the active scheme. Shape and layout
 * values are identical to the previous light-only table; only colors are
 * keyed on the palette so the login page follows the stored theme
 * preference instead of hardcoding light.
 */
export function buildStyles(
  isDark: boolean,
): Record<string, React.CSSProperties> {
  const p = loginPalette(isDark);
  return {
    page: {
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      padding: 'max(env(safe-area-inset-top), 24px) 24px max(env(safe-area-inset-bottom), 24px)',
      backgroundColor: p.pageBg,
      color: p.text,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    guidePage: {
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-end',
      // Theme-invariant dark scrim over the webview content in both schemes.
      backgroundColor: 'rgba(15, 23, 42, 0.45)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    guideSheet: {
      width: '100%',
      maxWidth: 480,
      backgroundColor: p.surface,
      color: p.text,
      borderRadius: '20px 20px 0 0',
      padding: '24px 24px max(env(safe-area-inset-bottom), 24px)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      boxShadow: '0 -8px 30px rgba(15, 23, 42, 0.18)',
    },
    logo: {
      width: 64,
      height: 64,
      borderRadius: 16,
      backgroundColor: '#ffdc51',
      color: '#111',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 24,
      fontWeight: 700,
    },
    title: { fontSize: 20, fontWeight: 600, margin: 0 },
    subtitle: { fontSize: 14, color: p.textSecondary, textAlign: 'center', margin: 0 },
    subtitleLeft: { fontSize: 14, color: p.textSecondary, textAlign: 'left', margin: 0, lineHeight: 1.6 },
    input: {
      width: '100%',
      maxWidth: 320,
      borderRadius: 12,
      border: `1px solid ${p.border}`,
      backgroundColor: p.surface,
      padding: '12px 16px',
      fontSize: 14,
      color: p.text,
    },
    button: {
      width: '100%',
      maxWidth: 320,
      minHeight: 44,
      borderRadius: 12,
      border: 'none',
      backgroundColor: '#ffdc51',
      color: '#111',
      fontSize: 15,
      fontWeight: 600,
    },
    textButton: {
      border: 'none',
      backgroundColor: 'transparent',
      color: p.textSecondary,
      fontSize: 13,
      padding: 8,
    },
    checkboxRow: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      width: '100%',
      maxWidth: 320,
      fontSize: 13,
      lineHeight: 1.5,
      color: p.checkboxRow,
    },
    link: { color: p.link, textDecoration: 'none' },
    note: { fontSize: 13, color: p.textSecondary, textAlign: 'center', margin: 0 },
    noteSmall: { fontSize: 12, color: p.noteSmall, textAlign: 'center', margin: 0 },
    error: { fontSize: 13, color: p.error, textAlign: 'center', margin: 0 },
    statusWord: { fontSize: 16, fontWeight: 600, margin: 0 },
    a2hsCard: {
      position: 'fixed',
      left: 12,
      right: 12,
      bottom: 'max(env(safe-area-inset-bottom), 12px)',
      maxWidth: 456,
      margin: '0 auto',
      backgroundColor: p.surface,
      borderRadius: 16,
      padding: '14px 16px',
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      boxShadow: '0 8px 30px rgba(15, 23, 42, 0.14)',
      zIndex: 10,
    },
    a2hsTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 4px', color: p.text },
    a2hsDismiss: {
      border: 'none',
      backgroundColor: '#ffdc51',
      borderRadius: 10,
      padding: '8px 12px',
      fontSize: 13,
      fontWeight: 600,
      color: '#111',
      flexShrink: 0,
    },
  };
}

/**
 * Placeholder color cannot be expressed as a React inline style (::placeholder
 * is a pseudo-element), so the login entry injects this one themed rule at
 * mount. Everything else on the page stays inline-styled.
 */
export function loginPlaceholderStyleTag(isDark: boolean): string {
  const p = loginPalette(isDark);
  return `input::placeholder { color: ${p.placeholder}; opacity: 1; }`;
}
