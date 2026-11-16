/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        'surface-hover': 'var(--surface-hover)',
        line: 'var(--border)',
        'line-soft': 'var(--border-soft)',
        ink: 'var(--text)',
        'ink-2': 'var(--text-secondary)',
        'ink-3': 'var(--text-muted)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-soft': 'var(--accent-soft)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        pop: 'var(--shadow-pop)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.45' },
        },
      },
      animation: {
        'fade-in': 'fade-in .18s var(--ease-standard) both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
