// What every theme must provide. The UI (bar and main window) only knows the tokens listed here, never which theme is active:
// switching themes swaps one set of values. This layer depends on neither Electron nor Node, so the CLI and the windows share it.
//
// To add a theme: write a file like ink.mjs and register it in index.mjs. themeProblems decides whether it passes.

import { contrast } from "./color.mjs";

/** Bar colors. The bar floats over any app and wallpaper, so it has one set, not light and dark */
export const BAR_TOKENS = {
  surface: "Bar background",
  edge: "Bar outline: separates it from a dark background",
  ink: "Text and icons on the bar",
  muted: "Secondary text: the hint line above",
  ghost: "Cancel button background",
  live: "Listening: the wave",
  working: "Cleaning up: the rolling wave",
  go: "Finish button background, and the check mark on completion",
  onGo: "Icon on the finish button",
  problem: "Icon shown on an error",
};

/** Main window colors. The window follows the system's light or dark appearance, so it needs both sets */
export const WINDOW_TOKENS = {
  bg: "Window background",
  raised: "One level above the background: inputs, hovered buttons",
  border: "Dividers and borders",
  ink: "Body text",
  ink2: "Secondary text",
  primary: "Primary button background, links, focus ring",
  onPrimary: "Text on the primary button",
  ok: "Success, permission granted",
  problem: "Errors, something missing",
  glow: "Other end of the gradient: spread with primary across the primary button, dictation card, and progress",
  aura: "Light glowing behind the window's top-left corner: the sidebar glass shows it through",
  aura2: "Light behind the opposite corner, a slightly different hue from aura",
};

/** What sits on what, and the minimum contrast. Text needs 4.5, icons and color blocks 3 (WCAG 2 AA) */
const BAR_LEGIBILITY = [
  ["ink", "surface", 4.5],
  ["muted", "surface", 4.5],
  ["ink", "ghost", 3],
  ["onGo", "go", 3],
  ["live", "surface", 3],
  ["working", "surface", 3],
  ["go", "surface", 3],
  ["problem", "surface", 3],
];
const WINDOW_LEGIBILITY = [
  ["ink", "bg", 4.5],
  ["ink", "raised", 4.5],
  ["ink2", "bg", 4.5],
  ["ink2", "raised", 4.5],
  ["primary", "bg", 4.5],
  ["primary", "raised", 4.5],
  ["onPrimary", "primary", 4.5],
  // The gradient runs from primary to glow, so text must read at either end
  ["onPrimary", "glow", 4.5],
  // The auras sit behind text: body and secondary text must read even over the densest part
  ["ink", "aura", 4.5],
  ["ink2", "aura", 4.5],
  ["ink", "aura2", 4.5],
  ["ink2", "aura2", 4.5],
  ["ok", "bg", 4.5],
  ["problem", "bg", 4.5],
];

const WINDOW_SCHEMES = { light: "light", dark: "dark" };

/** Token name to CSS variable name: onGo becomes --bar-on-go, ink2 becomes --ink-2 */
const cssName = (prefix, name) => `--${prefix}${name.replace(/[A-Z0-9]/g, (char) => `-${char.toLowerCase()}`)}`;

/** What is wrong with one group of tokens */
function groupProblems(where, values, tokens, legibility) {
  if (values === null || typeof values !== "object") return [`${where} group is missing`];
  const problems = [];
  const usable = new Set();
  for (const name of Object.keys(tokens)) {
    if (!Object.hasOwn(values, name)) {
      problems.push(`${where} is missing ${name}`);
      continue;
    }
    try {
      contrast(values[name], values[name]);
      usable.add(name);
    } catch {
      problems.push(`${where} ${name} must be oklch(lightness chroma hue), got ${JSON.stringify(values[name])}`);
    }
  }
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(tokens, name)) problems.push(`${where} has an unknown token ${name}`);
  }
  for (const [front, back, least] of legibility) {
    if (!usable.has(front) || !usable.has(back)) continue;
    const ratio = contrast(values[front], values[back]);
    if (ratio < least) {
      problems.push(
        `${where} ${front} on ${back} is hard to read: contrast ${ratio.toFixed(2)}, needs at least ${least}`,
      );
    }
  }
  return problems;
}

/**
 * What is wrong with a theme.
 * @returns {string[]} One problem per entry; empty when the theme passes
 */
export function themeProblems(theme) {
  if (theme === null || typeof theme !== "object") return ["A theme must be an object"];
  const problems = [];
  // The id appears in commands and the settings file
  if (typeof theme.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(theme.id)) {
    problems.push("id must start with a lowercase letter and contain only lowercase letters, digits, and hyphens");
  }
  problems.push(...groupProblems("Bar", theme.bar, BAR_TOKENS, BAR_LEGIBILITY));
  for (const [scheme, label] of Object.entries(WINDOW_SCHEMES)) {
    problems.push(
      ...groupProblems(`Window (${label})`, theme.window?.[scheme] ?? null, WINDOW_TOKENS, WINDOW_LEGIBILITY),
    );
  }
  return problems;
}

/**
 * Writes a theme as CSS: defines every token on :root. Page styles reference them only through var(--...).
 * @returns {string}
 */
export function themeCss(theme) {
  const declare = (prefix, values, tokens) =>
    Object.keys(tokens)
      .map((name) => `${cssName(prefix, name)}: ${values[name]};`)
      .join(" ");
  return [
    `:root { ${declare("bar-", theme.bar, BAR_TOKENS)} ${declare("", theme.window.light, WINDOW_TOKENS)} }`,
    `@media (prefers-color-scheme: dark) { :root { ${declare("", theme.window.dark, WINDOW_TOKENS)} } }`,
  ].join("\n");
}

/** Every CSS variable a theme defines. Any color variable a page style uses should be in here */
export const THEME_CSS_VARIABLES = [
  ...Object.keys(BAR_TOKENS).map((name) => cssName("bar-", name)),
  ...Object.keys(WINDOW_TOKENS).map((name) => cssName("", name)),
];
