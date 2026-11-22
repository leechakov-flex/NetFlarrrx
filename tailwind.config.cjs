const defaultTheme = require('tailwindcss/defaultTheme');

// Tailwind 3 with Seerr's palette (gray-900 #111827, indigo-600 #4F46E5, ...) and Inter Variable,
// plus MonkeySee's design tokens from Figma (web/src/tokens.css): use these names in new code.
const v = (name) => `var(--${name})`;
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter Variable', ...defaultTheme.fontFamily.sans] },
      screens: { '3xl': '1920px' },
      colors: {
        app: v('bg-app'), surface: v('bg-surface'), panel: v('bg-panel'), raised: v('bg-raised'), inverse: v('bg-inverse'),
        danger: v('bg-danger'), unreleased: v('bg-unreleased'), 'not-found': v('bg-not-found'), warning: v('bg-warning'), success: v('bg-success'), 'accent-subtle': v('bg-accent-subtle'),
        accent: { DEFAULT: v('bg-accent'), strong: v('bg-accent-strong') },
        ink: {
          primary: v('text-primary'), strong: v('text-strong'), secondary: v('text-secondary'), tertiary: v('text-tertiary'),
          muted: v('text-muted'), inverse: v('text-inverse'), accent: v('text-accent'), 'on-warning': v('text-on-warning'), 'on-success': v('text-on-success'), 'accent-subtle': v('text-accent-subtle'), digital: v('text-digital'),
        },
        line: { DEFAULT: v('border-default'), strong: v('border-strong'), muted: v('border-muted'), accent: v('border-accent'), info: v('border-info'), warning: v('border-warning'), 'warning-subtle': v('border-warning-subtle') },
        rating: v('icon-rating'),
        tag: { 'digital-bg': v('tag-digital-bg'), 'digital-border': v('tag-digital-border'), 'soon-bg': v('tag-soon-bg'), 'soon-border': v('tag-soon-border') },
        glass: { fill: v('glass-fill'), stroke: v('glass-stroke'), active: v('glass-active'), tint: v('glass-tint'), shadow: v('glass-shadow') },
      },
    },
  },
  plugins: [],
};
