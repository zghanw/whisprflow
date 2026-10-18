import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES } from "../../src/i18n/index.mjs";
import { contrast, toHex } from "../../src/themes/color.mjs";
import { BAR_TOKENS, themeCss, themeProblems, WINDOW_TOKENS } from "../../src/themes/contract.mjs";
import { DEFAULT_THEME, findTheme, THEMES } from "../../src/themes/index.mjs";

const clone = (theme) => structuredClone(theme);

test("color conversion: black, white, and pure red convert correctly; black on white has contrast 21", () => {
  assert.equal(toHex("oklch(0 0 0)"), "#000000");
  assert.equal(toHex("oklch(1 0 0)"), "#ffffff");
  // sRGB pure red in oklch coordinates
  assert.equal(toHex("oklch(0.62796 0.25768 29.234)"), "#ff0000");
  assert.equal(Math.round(contrast("oklch(0 0 0)", "oklch(1 0 0)")), 21);
  assert.equal(contrast("oklch(0.5 0.1 200)", "oklch(0.5 0.1 200)"), 1);
});

test("anything other than oklch(lightness chroma hue) is rejected: a color without a computable contrast can't be in a theme", () => {
  for (const value of ["#fff", "white", "oklch(0.5 0.1)", "oklch(1 0 0 / 0.16)", "oklch(1.2 0 0)", "", 3]) {
    assert.throws(() => toHex(value), /oklch/, String(value));
  }
});

test("every registered theme passes: no token missing, everything that must be legible is", () => {
  assert.ok(THEMES.length >= 3);
  for (const theme of THEMES) assert.deepEqual(themeProblems(theme), [], theme.id);
});

test("ids and display names are unique; the default theme is registered; themes are found by id or name", () => {
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
  for (const { id, messages } of LOCALES) {
    assert.equal(new Set(THEMES.map((theme) => messages.themes[theme.id].name)).size, THEMES.length, id);
  }
  assert.deepEqual(
    THEMES.map((theme) => theme.id),
    ["ink", "cinnabar", "indigo"],
  );
  assert.equal(findTheme(DEFAULT_THEME).id, DEFAULT_THEME);
  assert.equal(findTheme("cinnabar").id, "cinnabar");
  assert.equal(findTheme("Cinnabar").id, "cinnabar");
  assert.equal(findTheme("neon"), null);
  // Built-in object property names are not themes
  assert.equal(findTheme("constructor"), null);
});

test("cinnabar: listening and cleaning up use the same red. Cleaning up must not turn white, or the theme looks unapplied", () => {
  const { bar } = findTheme("cinnabar");
  assert.equal(bar.working, bar.live);
  assert.equal(bar.go, bar.live);
});

test("a failing theme says what is wrong: missing token, unknown token, malformed color, illegible pair", () => {
  const missing = clone(THEMES[0]);
  delete missing.bar.live;
  delete missing.window.dark.ink2;
  assert.deepEqual(themeProblems(missing), ["Bar is missing live", "Window (dark) is missing ink2"]);

  const extra = clone(THEMES[0]);
  extra.bar.glow = "oklch(0.9 0.1 100)";
  assert.deepEqual(themeProblems(extra), ["Bar has an unknown token glow"]);

  const malformed = clone(THEMES[0]);
  malformed.window.light.bg = "#ffffff";
  assert.match(themeProblems(malformed).join("\n"), /Window \(light\) bg must be oklch/);

  const faint = clone(THEMES[0]);
  faint.bar.muted = "oklch(0.3 0 0)";
  faint.window.light.ink2 = "oklch(0.8 0 0)";
  const problems = themeProblems(faint).join("\n");
  assert.match(problems, /Bar muted on surface is hard to read: contrast [\d.]+, needs at least 4\.5/);
  assert.match(problems, /Window \(light\) ink2 on bg is hard to read/);

  assert.match(themeProblems({ ...clone(THEMES[0]), id: "Ink 2" }).join("\n"), /id/);
  assert.deepEqual(themeProblems(null), ["A theme must be an object"]);
});

test("the window gradient and auras must be legible too: primary button text on both gradient ends, body text on both auras", () => {
  for (const theme of THEMES) {
    for (const name of ["glow", "aura", "aura2"]) {
      assert.ok(Object.hasOwn(theme.window.light, name), `${theme.id} light is missing ${name}`);
      assert.ok(Object.hasOwn(theme.window.dark, name), `${theme.id} dark is missing ${name}`);
    }
  }
  const dim = clone(THEMES[0]);
  dim.window.light.glow = "oklch(0.9 0 0)";
  dim.window.light.aura2 = "oklch(0.4 0 0)";
  const problems = themeProblems(dim).join("\n");
  assert.match(problems, /Window \(light\) onPrimary on glow is hard to read/);
  assert.match(problems, /Window \(light\) ink on aura2 is hard to read/);
  assert.match(problems, /Window \(light\) ink2 on aura2 is hard to read/);
});

test("themeCss: one bar group, one light window group, the dark group inside the follow-the-system query; token names map to CSS variable names", () => {
  const theme = findTheme("ink");
  const css = themeCss(theme);
  const [base, dark] = css.split("@media (prefers-color-scheme: dark)");
  for (const name of Object.keys(BAR_TOKENS)) assert.ok(base.includes(`: ${theme.bar[name]};`), name);
  assert.match(base, new RegExp(`--bar-surface: ${theme.bar.surface.replace(/[()]/g, "\\$&")};`));
  assert.match(base, /--bar-on-go: /);
  assert.match(base, new RegExp(`--bg: ${theme.window.light.bg.replace(/[()]/g, "\\$&")};`));
  assert.match(base, /--ink-2: /);
  assert.match(base, /--on-primary: /);
  assert.doesNotMatch(dark, /--bar-/);
  for (const name of Object.keys(WINDOW_TOKENS)) assert.ok(dark.includes(`: ${theme.window.dark[name]};`), name);
  // Exactly this many declarations, no more, no fewer
  const declarations = css.match(/--[a-z0-9-]+: /g);
  assert.equal(declarations.length, Object.keys(BAR_TOKENS).length + 2 * Object.keys(WINDOW_TOKENS).length);
});
