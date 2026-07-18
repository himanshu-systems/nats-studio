import type { Config } from "tailwindcss";

/** Map a CSS custom property (RGB triplet) to a Tailwind color with alpha support. */
const token = (name: string): string => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic surface / text tokens — resolved from CSS vars per theme.
        canvas: token("--c-canvas"),
        surface: token("--c-surface"),
        "surface-2": token("--c-surface-2"),
        overlay: token("--c-overlay"),
        border: token("--c-border"),
        "border-strong": token("--c-border-strong"),
        content: token("--c-content"),
        muted: token("--c-muted"),
        faint: token("--c-faint"),
        accent: token("--c-accent"),
        "accent-hover": token("--c-accent-hover"),
        "accent-content": token("--c-accent-content"),
        positive: token("--c-positive"),
        warning: token("--c-warning"),
        danger: token("--c-danger"),
        // Fixed brand hues (the logo's blue → teal on navy).
        brand: {
          blue: "#2e8de8",
          teal: "#27c6a0",
          navy: "#131a29",
        },
      },
      fontFamily: {
        sans: [
          '"Inter"',
          '"Inter var"',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          '"Cascadia Code"',
          '"Cascadia Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        panel: "0 1px 2px rgb(2 6 23 / 0.04), 0 1px 3px rgb(2 6 23 / 0.06)",
        pop: "0 10px 34px rgb(2 6 23 / 0.16)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.16s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
