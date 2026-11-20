const defaultTheme = require('tailwindcss/defaultTheme');

// Tailwind 3 to match Seerr: same default palette (gray-900 #111827, indigo-600 #4F46E5, ...)
// and the same Inter Variable font.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter Variable', ...defaultTheme.fontFamily.sans] },
      screens: { '3xl': '1920px' },
    },
  },
  plugins: [],
};
