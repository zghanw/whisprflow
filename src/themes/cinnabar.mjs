// Cinnabar: one warm red, used wherever "it's working for you": the listening wave, the cleanup wave, the main button, the check mark on completion.
// Like the light on a tape recorder. Errors use yellow, kept apart from red: red here means "working", not "broken".
// The window gradient runs from cinnabar to orange, with a red and an orange glow behind, like a lamp through frosted glass.

export default {
  id: "cinnabar",
  bar: {
    surface: "oklch(0.17 0.008 32)",
    edge: "oklch(0.34 0.012 32)",
    ink: "oklch(0.97 0.004 32)",
    muted: "oklch(0.75 0.012 32)",
    ghost: "oklch(0.32 0.014 32)",
    live: "oklch(0.74 0.17 32)",
    working: "oklch(0.74 0.17 32)",
    go: "oklch(0.74 0.17 32)",
    onGo: "oklch(0.17 0.008 32)",
    problem: "oklch(0.86 0.15 90)",
  },
  window: {
    light: {
      bg: "oklch(1 0 0)",
      raised: "oklch(0.965 0.004 32)",
      border: "oklch(0.9 0.006 32)",
      ink: "oklch(0.22 0.02 32)",
      ink2: "oklch(0.47 0.02 32)",
      primary: "oklch(0.56 0.19 32)",
      onPrimary: "oklch(1 0 0)",
      ok: "oklch(0.5 0.12 155)",
      problem: "oklch(0.5 0.12 85)",
      glow: "oklch(0.55 0.15 52)",
      aura: "oklch(0.89 0.065 32)",
      aura2: "oklch(0.91 0.075 62)",
    },
    dark: {
      bg: "oklch(0.18 0.008 32)",
      raised: "oklch(0.24 0.01 32)",
      border: "oklch(0.32 0.012 32)",
      ink: "oklch(0.95 0.005 32)",
      ink2: "oklch(0.74 0.012 32)",
      primary: "oklch(0.74 0.17 32)",
      onPrimary: "oklch(0.18 0.008 32)",
      ok: "oklch(0.8 0.13 155)",
      problem: "oklch(0.86 0.15 90)",
      glow: "oklch(0.8 0.14 62)",
      aura: "oklch(0.29 0.08 32)",
      aura2: "oklch(0.26 0.05 62)",
    },
  },
};
