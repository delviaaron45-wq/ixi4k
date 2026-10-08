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
        ixi: {
          // Pro Dark Theme: negro carbón profundo + cristal esmerilado
          bg: '#0B0B0E',
          bgSecondary: '#141419',
          bgCard: '#141419',
          border: 'rgba(255, 255, 255, 0.12)',
          // Acento único: Carmesí → Rojo Neón (CTA, focos, degradados)
          cyan: '#FF1E42',
          cyanGlow: '#E50914',
          violet: '#E50914',
          violetGlow: '#FF1E42',
          text: '#F5F5F7',
          textMuted: '#9A9FA8',
          success: '#10b981',
          warning: '#f59e0b',
          danger: '#FF3B52',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'float': 'float 3s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.5', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.05)' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      boxShadow: {
        'glow-cyan': '0 0 20px rgba(229, 9, 20, 0.4), 0 0 44px rgba(255, 30, 66, 0.18)',
        'glow-violet': '0 0 20px rgba(229, 9, 20, 0.35), 0 0 44px rgba(255, 30, 66, 0.15)',
        'glow-cyan-sm': '0 0 10px rgba(229, 9, 20, 0.35)',
        'glow-violet-sm': '0 0 10px rgba(229, 9, 20, 0.3)',
        'inner-glow': 'inset 0 0 20px rgba(255, 30, 66, 0.1)',
        'neon-red': '0 0 20px rgba(229, 9, 20, 0.4)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
}