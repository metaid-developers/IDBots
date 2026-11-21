/**
 * Login palette, keyed on the effective dark flag (see login/theme.ts).
 *
 * Values mirror the Twin UI Daylight and Nocturne tokens so the login page
 * reads as the same product in both schemes. Brand yellow stays identical in
 * dark mode, and deep gold carries small light-mode accent text.
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
  pageBg: '#F2F3F5',
  surface: '#FFFFFF',
  text: '#242425',
  textSecondary: '#626267',
  checkboxRow: '#626267',
  border: '#D7D9DE',
  link: '#6B5200',
  noteSmall: '#76767C',
  error: '#B42318',
  placeholder: '#76767C',
};

const DARK: LoginPalette = {
  pageBg: '#111112',
  surface: '#19191B',
  text: '#F4F3EF',
  textSecondary: '#AAA9A4',
  checkboxRow: '#AAA9A4',
  border: '#49494D',
  link: '#FFDC51',
  noteSmall: '#7E7D79',
  error: '#F87171',
  placeholder: '#7E7D79',
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
    loginCard: {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 380,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: '26px 22px',
      borderRadius: 24,
      border: `1px solid ${p.border}`,
      backgroundColor: p.surface,
      boxShadow: isDark ? '0 16px 50px rgba(0, 0, 0, 0.36)' : '0 16px 50px rgba(36, 36, 37, 0.08)',
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
      boxSizing: 'border-box',
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
      borderRadius: 18,
      objectFit: 'cover',
      imageRendering: 'pixelated',
      boxShadow: '0 8px 22px rgba(100, 80, 10, 0.12)',
    },
    title: { fontSize: 24, fontWeight: 650, letterSpacing: '-0.03em', margin: 0 },
    subtitle: { fontSize: 14, color: p.textSecondary, margin: 0, lineHeight: 1.5 },
    subtitleLeft: { fontSize: 14, color: p.textSecondary, textAlign: 'left', margin: 0, lineHeight: 1.6 },
    // Composite phone field: fixed +86 prefix plus a borderless input. The
    // field spans the card content width; the prefix removes the need for a
    // long "include country code" placeholder.
    phoneField: {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'stretch',
      width: '100%',
      minHeight: 46,
      borderRadius: 14,
      border: `1px solid ${p.border}`,
      backgroundColor: p.surface,
      overflow: 'hidden',
    },
    phonePrefix: {
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      fontSize: 16,
      fontWeight: 600,
      color: p.text,
      borderRight: `1px solid ${p.border}`,
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(36, 36, 37, 0.03)',
    },
    phoneInput: {
      flex: 1,
      minWidth: 0,
      border: 'none',
      backgroundColor: 'transparent',
      padding: '11px 14px',
      fontSize: 16,
      color: p.text,
    },
    input: {
      boxSizing: 'border-box',
      width: '100%',
      minHeight: 46,
      borderRadius: 14,
      border: `1px solid ${p.border}`,
      backgroundColor: p.surface,
      padding: '11px 14px',
      fontSize: 16,
      color: p.text,
    },
    codeInput: {
      boxSizing: 'border-box',
      width: '100%',
      minHeight: 46,
      borderRadius: 14,
      border: `1px solid ${p.border}`,
      backgroundColor: p.surface,
      padding: '11px 14px',
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: 6,
      color: p.text,
    },
    button: {
      boxSizing: 'border-box',
      width: '100%',
      minHeight: 46,
      borderRadius: 14,
      border: 'none',
      backgroundColor: '#ffdc51',
      color: '#2c290f',
      fontSize: 15,
      fontWeight: 650,
    },
    buttonDisabled: {
      opacity: 0.52,
      cursor: 'not-allowed',
    },
    field: {
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    },
    label: {
      color: p.text,
      fontSize: 13,
      fontWeight: 600,
      lineHeight: 1.4,
    },
    preparingActions: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
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
      fontSize: 13,
      lineHeight: 1.5,
      color: p.checkboxRow,
    },
    checkbox: {
      accentColor: '#ffdc51',
      width: 18,
      height: 18,
      margin: 0,
      marginTop: 1,
      flexShrink: 0,
    },
    link: { color: p.link, textDecoration: 'none' },
    note: { fontSize: 13, color: p.textSecondary, textAlign: 'center', margin: 0 },
    noteSmall: { fontSize: 12, color: p.noteSmall, textAlign: 'center', margin: 0 },
    error: { fontSize: 13, color: p.error, textAlign: 'center', margin: 0 },
    errorLeft: { fontSize: 13, color: p.error, textAlign: 'left', margin: 0, lineHeight: 1.45 },
    statusWord: { fontSize: 16, fontWeight: 600, margin: 0 },
    a2hsCard: {
      boxSizing: 'border-box',
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
 * is a pseudo-element), and the same is true for :focus/:focus-within, so the
 * login entry injects these themed rules at mount (inline styles would win a
 * specificity fight, hence !important). Everything else stays inline-styled.
 */
export function loginPlaceholderStyleTag(isDark: boolean): string {
  const p = loginPalette(isDark);
  return [
    `input::placeholder { color: ${p.placeholder}; opacity: 1; }`,
    `.login-ui-input:focus { outline: none; border-color: #ffdc51 !important; }`,
    `.login-ui-field:focus-within { border-color: #ffdc51 !important; }`,
    `.login-ui-input:focus::placeholder { color: transparent; }`,
  ].join('\n');
}
