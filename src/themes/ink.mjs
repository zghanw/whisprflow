// Ink: black and white. State shows through shape and motion (bars jumping while listening, a steady roll while cleaning up); color appears only for errors.
// The window gradient and glows are gray too: an ink-to-graphite gradient, with a light gray and a dark gray glow.

export default {
  id: "ink",
  bar: {
    surface: "oklch(0.16 0 0)",
    edge: "oklch(0.34 0 0)",
    ink: "oklch(0.98 0 0)",
    muted: "oklch(0.74 0 0)",
    ghost: "oklch(0.33 0 0)",
    live: "oklch(0.98 0 0)",
    working: "oklch(0.98 0 0)",
    go: "oklch(0.98 0 0)",
    onGo: "oklch(0.16 0 0)",
    problem: "oklch(0.84 0.15 82)",
  },
  window: {
    light: {
      bg: "oklch(1 0 0)",
      raised: "oklch(0.965 0 0)",
      border: "oklch(0.9 0 0)",
      ink: "oklch(0.2 0 0)",
      ink2: "oklch(0.46 0 0)",
      primary: "oklch(0.2 0 0)",
      onPrimary: "oklch(1 0 0)",
      ok: "oklch(0.5 0.12 155)",
      problem: "oklch(0.52 0.14 62)",
      glow: "oklch(0.4 0 0)",
      aura: "oklch(0.9 0 0)",
      aura2: "oklch(0.935 0 0)",
    },
    dark: {
      bg: "oklch(0.17 0 0)",
      raised: "oklch(0.23 0 0)",
      border: "oklch(0.31 0 0)",
      ink: "oklch(0.96 0 0)",
      ink2: "oklch(0.73 0 0)",
      primary: "oklch(0.96 0 0)",
      onPrimary: "oklch(0.17 0 0)",
      ok: "oklch(0.8 0.13 155)",
      problem: "oklch(0.84 0.15 82)",
      glow: "oklch(0.76 0 0)",
      aura: "oklch(0.27 0 0)",
      aura2: "oklch(0.23 0 0)",
    },
  },
};
