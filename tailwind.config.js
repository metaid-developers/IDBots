/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic theme tokens (CSS variables; light/dark in index.css)
        main: 'var(--bg-main)',
        sidebar: 'var(--bg-sidebar)',
        panel: 'var(--bg-panel)',
        hover: 'var(--bg-hover)',
        brand: 'var(--color-primary)',
        accent: 'var(--color-accent)',
        content: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
        },
        border: 'var(--border-color)',
        // Legacy claude palette (mapped to vars for gradual migration)
        claude: {
          bg: 'var(--bg-main)',
          surface: 'var(--bg-panel)',
          surfaceHover: 'var(--bg-hover)',
          surfaceMuted: 'var(--bg-sidebar)',
          surfaceInset: 'var(--bg-panel)',
          border: 'var(--border-color)',
          borderLight: 'var(--border-color)',
          text: 'var(--text-primary)',
          textSecondary: 'var(--text-secondary)',
          darkBg: 'var(--bg-main)',
          darkSurface: 'var(--bg-panel)',
          darkSurfaceHover: 'var(--bg-hover)',
          darkSurfaceMuted: 'var(--bg-sidebar)',
          darkSurfaceInset: 'var(--bg-panel)',
          darkBorder: 'var(--border-color)',
          darkBorderLight: 'var(--border-color)',
          darkText: 'var(--text-primary)',
          darkTextSecondary: 'var(--text-secondary)',
          accent: 'var(--color-primary)',
          accentHover: 'var(--color-primary)',
          accentLight: 'var(--color-accent)',
          accentMuted: 'rgba(234, 179, 8, 0.12)',
        },
        primary: {
          DEFAULT: 'var(--color-primary)',
          dark: 'var(--color-primary)',
        },
        secondary: {
          DEFAULT: 'var(--text-secondary)',
          dark: 'var(--border-color)',
        },
      },
      boxShadow: {
        subtle: '0 1px 2px rgba(0,0,0,0.05)',
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        elevated: '0 4px 12px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.04)',
        modal: '0 8px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)',
        popover: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.05)',
        'glow-accent': '0 0 20px rgba(59,130,246,0.15)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.25s ease-out',
        'fade-in-down': 'fade-in-down 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        shimmer: 'shimmer 1.5s infinite',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      typography: {
        DEFAULT: {
          css: {
            color: 'var(--text-primary)',
            a: {
              color: 'var(--color-accent)',
              '&:hover': {
                color: 'var(--color-primary)',
              },
            },
            code: {
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-hover)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              backgroundColor: 'var(--bg-panel)',
              color: 'var(--text-primary)',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: 'var(--color-accent)',
              color: 'var(--text-secondary)',
            },
            h1: { color: 'var(--text-primary)' },
            h2: { color: 'var(--text-primary)' },
            h3: { color: 'var(--text-primary)' },
            h4: { color: 'var(--text-primary)' },
            strong: { color: 'var(--text-primary)' },
          },
        },
        dark: {
          css: {
            color: 'var(--text-primary)',
            a: {
              color: 'var(--color-accent)',
              '&:hover': {
                color: 'var(--color-primary)',
              },
            },
            code: {
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-hover)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            pre: {
              backgroundColor: 'var(--bg-panel)',
              color: 'var(--text-primary)',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: 'var(--color-accent)',
              color: 'var(--text-secondary)',
            },
            h1: { color: 'var(--text-primary)' },
            h2: { color: 'var(--text-primary)' },
            h3: { color: 'var(--text-primary)' },
            h4: { color: 'var(--text-primary)' },
            strong: { color: 'var(--text-primary)' },
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
