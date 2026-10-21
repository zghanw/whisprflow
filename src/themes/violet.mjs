// Violet: WhisprFlow's own purple, from the app icon (#6C5CF6, deepening to #4F3FD1), on the listening wave, the main buttons, and the check mark.
// On the dark bar the purple is lifted so the wave reads over it; the window gradient runs from the icon's purple to its deeper end, with a lilac glow behind.

export default {
  id: "violet",
  bar: {
    surface: "oklch(0.19 0.03 281)",
    edge: "oklch(0.36 0.045 281)",
    ink: "oklch(0.97 0.006 281)",
    muted: "oklch(0.78 0.03 281)",
    ghost: "oklch(0.34 0.05 281)",
    live: "oklch(0.74 0.15 281)",
    working: "oklch(0.74 0.15 281)",
    go: "oklch(0.74 0.15 281)",
    onGo: "oklch(0.19 0.03 281)",
    problem: "oklch(0.84 0.15 82)",
  },
  window: {
    light: {
      bg: "oklch(0.99 0.003 286)",
      raised: "oklch(0.965 0.008 286)",
      border: "oklch(0.91 0.015 286)",
      ink: "oklch(0.21 0.02 281)",
      ink2: "oklch(0.47 0.03 281)",
      primary: "oklch(0.55 0.22 281)",
      onPrimary: "oklch(1 0 0)",
      ok: "oklch(0.5 0.12 155)",
      problem: "oklch(0.52 0.14 62)",
      glow: "oklch(0.482 0.213 279)",
      aura: "oklch(0.93 0.03 286)",
      aura2: "oklch(0.95 0.02 305)",
    },
    dark: {
      bg: "oklch(0.17 0.014 281)",
      raised: "oklch(0.23 0.018 281)",
      border: "oklch(0.31 0.022 281)",
      ink: "oklch(0.96 0.005 281)",
      ink2: "oklch(0.75 0.02 281)",
      primary: "oklch(0.74 0.14 281)",
      onPrimary: "oklch(0.17 0.014 281)",
      ok: "oklch(0.8 0.13 155)",
      problem: "oklch(0.84 0.15 82)",
      glow: "oklch(0.68 0.16 279)",
      aura: "oklch(0.26 0.04 281)",
      aura2: "oklch(0.23 0.03 305)",
    },
  },
};
