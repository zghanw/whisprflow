// Indigo: colors mark stages: green is listening, blue-violet is cleaning up, amber is a problem.
// The window gradient runs from indigo to teal (the listening green leaning a little blue), with a blue and a teal glow behind.

export default {
  id: "indigo",
  bar: {
    surface: "oklch(0.21 0.012 262)",
    edge: "oklch(0.36 0.014 262)",
    ink: "oklch(0.96 0.004 262)",
    muted: "oklch(0.76 0.012 262)",
    ghost: "oklch(0.34 0.016 262)",
    live: "oklch(0.8 0.15 152)",
    working: "oklch(0.8 0.11 262)",
    go: "oklch(0.8 0.15 152)",
    onGo: "oklch(0.21 0.012 262)",
    problem: "oklch(0.82 0.13 62)",
  },
  window: {
    light: {
      bg: "oklch(0.985 0.002 262)",
      raised: "oklch(0.95 0.005 262)",
      border: "oklch(0.9 0.006 262)",
      ink: "oklch(0.24 0.014 262)",
      ink2: "oklch(0.47 0.014 262)",
      primary: "oklch(0.47 0.15 262)",
      onPrimary: "oklch(0.985 0.002 262)",
      ok: "oklch(0.5 0.12 155)",
      problem: "oklch(0.5 0.15 40)",
      glow: "oklch(0.5 0.1 200)",
      aura: "oklch(0.89 0.055 262)",
      aura2: "oklch(0.91 0.065 185)",
    },
    dark: {
      bg: "oklch(0.2 0.012 262)",
      raised: "oklch(0.27 0.014 262)",
      border: "oklch(0.32 0.014 262)",
      ink: "oklch(0.94 0.005 262)",
      ink2: "oklch(0.72 0.012 262)",
      primary: "oklch(0.78 0.12 262)",
      onPrimary: "oklch(0.2 0.012 262)",
      ok: "oklch(0.8 0.13 155)",
      problem: "oklch(0.8 0.12 55)",
      glow: "oklch(0.82 0.1 195)",
      aura: "oklch(0.3 0.07 262)",
      aura2: "oklch(0.27 0.05 185)",
    },
  },
};
