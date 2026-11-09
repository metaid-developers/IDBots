import { configService } from './config';

export type ThemeType = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';
type ThemeListener = (theme: EffectiveTheme) => void;

// Cold modern color palette
const COLORS = {
  light: {
    bg: '#F8F9FB',
    text: '#1A1D23',
  },
  dark: {
    bg: '#0F1117',
    text: '#E4E5E9',
  },
};

/**
 * Liquid Glass material tokens (floating / control layers only).
 *
 * CSS owns the values — index.css defines them per theme and per degrade path
 * (reduced transparency / high contrast / forced colors / no backdrop-filter).
 * This module never duplicates a color: it exposes the variable NAMES plus a
 * live reader, so non-CSS consumers (Electron title-bar overlays, canvas,
 * portal inline styles) can resolve exactly the same material without a
 * second source of truth.
 *
 * The three core tokens:
 *   surface — the material fill  (glass-surface)
 *   tint    — the readability film (glass-tint)
 *   reduce  — the opaque fallback (glass-reduce)
 */
export const GLASS_TOKEN_VARS = {
  surface: '--glass-surface-bg',
  tint: '--glass-tint-bg',
  reduce: '--glass-reduce-bg',
} as const;

export type GlassTokenName = keyof typeof GLASS_TOKEN_VARS;
export type GlassTokens = Record<GlassTokenName, string>;

/** Attribute that forces the opaque fallback for every glass surface. */
const GLASS_REDUCE_ATTRIBUTE = 'data-glass';

class ThemeService {
  private mediaQuery: MediaQueryList | null = null;
  private currentTheme: ThemeType = 'system';
  private appliedTheme: 'light' | 'dark' | null = null;
  private initialized = false;
  private mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null;
  private listeners = new Set<ThemeListener>();

  constructor() {
    if (typeof window !== 'undefined') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
  }

  // 初始化主题
  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    try {
      const config = configService.getConfig();
      this.setTheme(config.theme);

      // 监听系统主题变化
      if (this.mediaQuery) {
        this.mediaQueryListener = (e) => {
          if (this.currentTheme === 'system') {
            this.applyTheme(e.matches ? 'dark' : 'light');
          }
        };
        this.mediaQuery.addEventListener('change', this.mediaQueryListener);
      }
    } catch (error) {
      console.error('Failed to initialize theme:', error);
      // 默认使用系统主题
      this.setTheme('system');
    }
  }

  // 设置主题
  setTheme(theme: ThemeType): void {
    const effectiveTheme = theme === 'system'
      ? (this.mediaQuery?.matches ? 'dark' : 'light')
      : theme;

    if (this.currentTheme === theme && this.appliedTheme === effectiveTheme) {
      return;
    }

    console.log(`Setting theme to: ${theme}`);
    this.currentTheme = theme;

    if (theme === 'system') {
      // 如果是系统主题，则根据系统设置应用
      console.log(`System theme detected, using: ${effectiveTheme}`);
    }

    // 直接应用指定主题
    this.applyTheme(effectiveTheme);
  }

  // 获取当前主题
  getTheme(): ThemeType {
    return this.currentTheme;
  }

  // 获取当前有效主题（实际应用的明/暗主题）
  getEffectiveTheme(): 'light' | 'dark' {
    if (this.currentTheme === 'system') {
      return this.mediaQuery?.matches ? 'dark' : 'light';
    }
    return this.currentTheme;
  }

  /**
   * Resolve the three Liquid Glass tokens from the live stylesheet.
   * When there is no DOM (tests/SSR) or the variables are not registered yet,
   * the CSS variable reference itself is returned — never an invented color.
   */
  getGlassTokens(): GlassTokens {
    const tokens = {} as GlassTokens;
    const canRead = typeof document !== 'undefined' && document.documentElement;
    const computed = canRead ? getComputedStyle(document.documentElement) : null;
    (Object.keys(GLASS_TOKEN_VARS) as GlassTokenName[]).forEach((name) => {
      const cssVar = GLASS_TOKEN_VARS[name];
      const live = computed?.getPropertyValue(cssVar).trim() ?? '';
      tokens[name] = live || `var(${cssVar})`;
    });
    return tokens;
  }

  /**
   * Force (or release) the opaque fallback for every glass surface.
   * Mirrors the OS-level prefers-reduced-transparency / prefers-contrast
   * queries so a settings toggle or a QA pass can exercise the same path.
   */
  setGlassReduced(reduced: boolean): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (reduced) {
      root.setAttribute(GLASS_REDUCE_ATTRIBUTE, 'reduce');
    } else {
      root.removeAttribute(GLASS_REDUCE_ATTRIBUTE);
    }
  }

  /** Whether the material is currently degraded to its opaque fallback. */
  isGlassReduced(): boolean {
    if (typeof document === 'undefined') return false;
    if (document.documentElement.getAttribute(GLASS_REDUCE_ATTRIBUTE) === 'reduce') {
      return true;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return (
      window.matchMedia('(prefers-reduced-transparency: reduce)').matches ||
      window.matchMedia('(prefers-contrast: more)').matches
    );
  }

  subscribe(listener: ThemeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // 应用主题到DOM
  private applyTheme(theme: 'light' | 'dark'): void {
    // 避免重复应用相同主题
    if (this.appliedTheme === theme) {
      return;
    }

    console.log(`Applying theme: ${theme}`);
    this.appliedTheme = theme;
    const root = document.documentElement;
    const colors = COLORS[theme];

    if (theme === 'dark') {
      // Apply dark theme to HTML element (for Tailwind)
      root.classList.add('dark');
      root.classList.remove('light');

      // Make sure theme is consistent across entire DOM
      document.body.classList.add('dark');
      document.body.classList.remove('light');

      // Set background and text colors
      root.style.backgroundColor = colors.bg;
      document.body.style.backgroundColor = colors.bg;
      document.body.style.color = colors.text;
    } else {
      // Apply light theme to HTML element (for Tailwind)
      root.classList.remove('dark');
      root.classList.add('light');

      // Make sure theme is consistent across entire DOM
      document.body.classList.remove('dark');
      document.body.classList.add('light');

      // Set background and text colors
      root.style.backgroundColor = colors.bg;
      document.body.style.backgroundColor = colors.bg;
      document.body.style.color = colors.text;
    }

    // Update CSS variables for color transition animations
    root.style.setProperty('--theme-transition', 'background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease');
    document.body.style.transition = 'var(--theme-transition)';

    // Ensure #root element also gets the theme
    const rootElement = document.getElementById('root');
    if (rootElement) {
      if (theme === 'dark') {
        rootElement.classList.add('dark');
        rootElement.classList.remove('light');
        rootElement.style.backgroundColor = colors.bg;
      } else {
        rootElement.classList.remove('dark');
        rootElement.classList.add('light');
        rootElement.style.backgroundColor = colors.bg;
      }
    }

    for (const listener of this.listeners) {
      try {
        listener(theme);
      } catch (error) {
        console.error('Theme listener failed:', error);
      }
    }
  }
}

export const themeService = new ThemeService();
