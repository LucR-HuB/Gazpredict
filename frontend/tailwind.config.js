/** @type {import('tailwindcss').Config} */
import colors from "tailwindcss/colors";

export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Cette ligne est VITALE pour que Tremor fonctionne :
    "./node_modules/@tremor/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    transparent: "transparent",
    current: "currentColor",
    extend: {
      colors: {
        // Couleurs obligatoires pour Tremor (Light mode par défaut)
        tremor: {
          brand: {
            faint: colors.blue[50],
            muted: colors.blue[200],
            subtle: colors.blue[400],
            DEFAULT: colors.blue[500],
            emphasis: colors.blue[700],
            inverted: colors.white,
          },
          background: {
            muted: colors.gray[50],
            subtle: colors.gray[100],
            DEFAULT: colors.white,
            emphasis: colors.gray[700],
          },
          border: {
            DEFAULT: colors.gray[200],
          },
          ring: {
            DEFAULT: colors.gray[200],
          },
          content: {
            subtle: colors.gray[400],
            DEFAULT: colors.gray[500],
            emphasis: colors.gray[700],
            strong: colors.gray[900],
            inverted: colors.white,
          },
        },
        // Couleurs obligatoires pour Tremor (Dark mode)
        "dark-tremor": {
          brand: {
            faint: colors.blue[950],
            muted: colors.blue[900],
            subtle: colors.blue[800],
            DEFAULT: colors.blue[500],
            emphasis: colors.blue[400],
            inverted: colors.blue[950],
          },
          background: {
            muted: colors.slate[900],
            subtle: colors.slate[800],
            DEFAULT: colors.slate[950],
            emphasis: colors.slate[300],
          },
          border: {
            DEFAULT: colors.slate[800],
          },
          ring: {
            DEFAULT: colors.slate[800],
          },
          content: {
            subtle: colors.slate[500],
            DEFAULT: colors.slate[400],
            emphasis: colors.slate[200],
            strong: colors.slate[50],
            inverted: colors.slate[950],
          },
        },
      },
      boxShadow: {
        // Ombres douces pour les cartes
        "tremor-input": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        "tremor-card": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
        "tremor-dropdown": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
      },
      borderRadius: {
        "tremor-small": "0.375rem",
        "tremor-default": "0.5rem",
        "tremor-full": "9999px",
      },
    },
  },
  safelist: [
    {
      pattern:
        /^(bg|text|border|ring|stroke|fill)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/,
      variants: ["hover", "ui-selected"],
    },
  ],
  plugins: [],
};
