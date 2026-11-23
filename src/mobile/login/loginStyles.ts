/**
 * Login palette, keyed on the effective dark flag (see login/theme.ts).
 *
 * Values mirror the Twin UI Daylight and Nocturne tokens plus the approved
 * Variant A segmented login/invite-signup card layout.
 */

import type React from 'react';

interface LoginPalette {
  pageBg: string;
  surface: string;
  inset: string;
  text: string;
  textSecondary: string;
  checkboxRow: string;
  border: string;
  borderSubtle: string;
  link: string;
  noteSmall: string;
  error: string;
  placeholder: string;
  successFg: string;
  successBg: string;
  warnFg: string;
  warnBg: string;
}

const LIGHT: LoginPalette = {
  pageBg: '#F2F3F5',
  surface: '#FFFFFF',
  inset: '#E9EAEE',
  text: '#242425',
  textSecondary: '#626267',
  checkboxRow: '#626267',
  border: '#D7D9DE',
  borderSubtle: 'rgba(20, 20, 25, 0.09)',
  link: '#6B5200',
  noteSmall: '#76767C',
  error: '#B42318',
  placeholder: '#76767C',
  successFg: '#167149',
  successBg: '#EAF8F0',
  warnFg: '#825600',
  warnBg: '#FFF7DB',
};

const DARK: LoginPalette = {
  pageBg: '#111112',
  surface: '#19191B',
  inset: '#27272B',
  text: '#F4F3EF',
  textSecondary: '#AAA9A4',
  checkboxRow: '#AAA9A4',
  border: '#49494D',
  borderSubtle: 'rgba(255, 255, 255, 0.09)',
  link: '#FFDC51',
  noteSmall: '#7E7D79',
  error: '#F87171',
  placeholder: '#7E7D79',
  successFg: '#70D9A4',
  successBg: 'rgba(48, 180, 120, 0.14)',
  warnFg: '#F2CC60',
  warnBg: 'rgba(255, 220, 81, 0.12)',
};

export function loginPalette(isDark: boolean): LoginPalette {
  return isDark ? DARK : LIGHT;
}

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
      padding: 'max(env(safe-area-inset-top), 20px) 22px max(env(safe-area-inset-bottom), 28px)',
      backgroundColor: p.pageBg,
      color: p.text,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif',
    },
    loginCard: {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 380,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '24px 20px',
      borderRadius: 24,
      border: `1px solid ${p.borderSubtle}`,
      backgroundColor: p.surface,
      boxShadow: isDark ? '0 16px 40px rgba(0, 0, 0, 0.38)' : '0 12px 32px rgba(36, 36, 37, 0.08)',
    },
    brandHead: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 2,
    },
    brandLogo: {
      width: 48,
      height: 48,
      borderRadius: 14,
      objectFit: 'cover',
      imageRendering: 'pixelated',
      boxShadow: '0 6px 18px rgba(100, 80, 10, 0.12)',
      flexShrink: 0,
    },
    brandTitle: {
      margin: 0,
      fontSize: 21,
      fontWeight: 680,
      letterSpacing: '-0.03em',
      color: p.text,
    },
    brandSubtitle: {
      margin: '2px 0 0',
      fontSize: 12.5,
      color: p.textSecondary,
      lineHeight: 1.4,
    },
    segBar: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      backgroundColor: p.inset,
      padding: 3,
      borderRadius: 12,
      gap: 3,
    },
    segBtn: {
      border: 'none',
      backgroundColor: 'transparent',
      color: p.textSecondary,
      fontSize: 13.5,
      fontWeight: 600,
      padding: '8px 0',
      borderRadius: 9.5,
      cursor: 'pointer',
      transition: 'background-color 0.16s ease, color 0.16s ease',
    },
    segBtnActive: {
      backgroundColor: p.surface,
      color: p.text,
      boxShadow: isDark ? '0 2px 8px rgba(0, 0, 0, 0.28)' : '0 2px 8px rgba(0, 0, 0, 0.07)',
    },
    softAlert: {
      borderRadius: 12,
      padding: '10px 12px',
      fontSize: 12.5,
      lineHeight: 1.45,
      backgroundColor: p.warnBg,
      color: p.warnFg,
    },
    fieldGroup: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
    },
    inputRow: {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      minHeight: 48,
      borderRadius: 14,
      border: `1px solid ${p.border}`,
      backgroundColor: p.surface,
      overflow: 'hidden',
      transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
    },
    phonePrefix: {
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      height: 48,
      fontSize: 15,
      fontWeight: 600,
      color: p.text,
      borderRight: `1px solid ${p.borderSubtle}`,
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(128, 128, 135, 0.05)',
      flexShrink: 0,
    },
    bareInput: {
      flex: 1,
      minWidth: 0,
      border: 'none',
      outline: 'none',
      backgroundColor: 'transparent',
      padding: '0 13px',
      height: 46,
      fontSize: 15,
      color: p.text,
    },
    monoInput: {
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      letterSpacing: '0.06em',
      fontWeight: 650,
      textTransform: 'uppercase',
    },
    inlineAction: {
      border: 'none',
      borderLeft: `1px solid ${p.borderSubtle}`,
      backgroundColor: 'transparent',
      color: p.link,
      fontSize: 13,
      fontWeight: 650,
      padding: '0 13px',
      height: 32,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      flexShrink: 0,
    },
    inlineActionDisabled: {
      color: p.noteSmall,
      cursor: 'default',
    },
    inlineBadge: {
      marginRight: 10,
      padding: '3px 8px',
      borderRadius: 99,
      fontSize: 11,
      fontWeight: 650,
      backgroundColor: p.successBg,
      color: p.successFg,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    },
    agreeLine: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      fontSize: 12,
      lineHeight: 1.4,
      color: p.checkboxRow,
      cursor: 'pointer',
      userSelect: 'none',
    },
    agreeCheckbox: {
      accentColor: isDark ? '#FFDC51' : '#242425',
      width: 16,
      height: 16,
      margin: 0,
      flexShrink: 0,
    },
    guidePage: {
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-end',
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
    button: {
      boxSizing: 'border-box',
      width: '100%',
      minHeight: 48,
      borderRadius: 14,
      border: 'none',
      backgroundColor: '#FFDC51',
      color: '#242425',
      fontSize: 15,
      fontWeight: 680,
      cursor: 'pointer',
    },
    buttonDisabled: {
      opacity: 0.45,
      cursor: 'not-allowed',
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
    link: {
      color: p.link,
      textDecoration: 'underline',
      textUnderlineOffset: 2,
    },
    note: { fontSize: 13, color: p.textSecondary, textAlign: 'center', margin: 0 },
    noteSmall: { fontSize: 12, color: p.noteSmall, textAlign: 'center', margin: 0 },
    error: { fontSize: 12.5, color: p.error, textAlign: 'center', margin: 0, lineHeight: 1.45 },
    errorLeft: { fontSize: 12.5, color: p.error, textAlign: 'left', margin: 0, lineHeight: 1.45 },
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
      backgroundColor: '#FFDC51',
      borderRadius: 10,
      padding: '8px 12px',
      fontSize: 13,
      fontWeight: 600,
      color: '#111',
      flexShrink: 0,
    },
  };
}

export function loginPlaceholderStyleTag(isDark: boolean): string {
  const p = loginPalette(isDark);
  return [
    `input::placeholder { color: ${p.placeholder}; opacity: 1; }`,
    `.login-ui-input:focus { outline: none; border-color: #C79F12 !important; }`,
    `.login-ui-field:focus-within { border-color: #C79F12 !important; box-shadow: 0 0 0 3px rgba(255, 220, 81, 0.22); }`,
    `.login-ui-input:focus::placeholder { color: transparent; }`,
  ].join('\n');
}
