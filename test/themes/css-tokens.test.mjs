import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { THEME_CSS_VARIABLES } from "../../src/themes/contract.mjs";

// The contract between page styles and themes, checked wherever a machine can: colors come only from the theme, and every variable used is defined somewhere.

const rendererDir = resolve(import.meta.dirname, "../../src/renderer");
const read = (name) => readFileSync(join(rendererDir, name), "utf8");
// One subdirectory per window, shared styles in shared/: subdirectories must be searched too, or a missed one makes these checks meaningless
const files = readdirSync(rendererDir, { recursive: true });
const sheets = files.filter((name) => name.endsWith(".css")).map((name) => ({ name, css: read(name) }));
const pages = files.filter((name) => name.endsWith(".html")).map((name) => ({ name, html: read(name) }));

const definedIn = (css) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
const usedIn = (css) => new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]));
const themed = new Set(THEME_CSS_VARIABLES);

test("no variable a theme provides is defined in a stylesheet: the theme is the only source of colors", () => {
  for (const { name, css } of sheets) {
    const redefined = [...definedIn(css)].filter((variable) => themed.has(variable));
    assert.deepEqual(redefined, [], name);
  }
});

test("every variable a stylesheet uses is defined: by the theme or by the stylesheet itself", () => {
  const local = new Set(sheets.flatMap(({ css }) => [...definedIn(css)]));
  for (const { name, css } of sheets) {
    const unknown = [...usedIn(css)].filter((variable) => !themed.has(variable) && !local.has(variable));
    assert.deepEqual(unknown, [], name);
  }
});

test("every variable a theme provides is used somewhere: none defined for nothing", () => {
  const used = new Set(sheets.flatMap(({ css }) => [...usedIn(css)]));
  assert.deepEqual(
    THEME_CSS_VARIABLES.filter((variable) => !used.has(variable)),
    [],
  );
});

test("stylesheets hardcode no colors, except the translucent black used for shadows", () => {
  for (const { name, css } of sheets) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const literals =
      withoutComments.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)/gi) ?? [];
    assert.deepEqual(
      literals.filter((literal) => !/^oklch\(0 0 0 \/ [\d.]+\)$/.test(literal)),
      [],
      name,
    );
  }
});

test("every page imports the shared tokens before any other stylesheet", () => {
  // The bar, the main window, and onboarding; fewer means the directory wasn't fully scanned
  assert.ok(pages.length >= 3);
  for (const { name, html } of pages) {
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(links[0], "../shared/tokens.css", name);
  }
});
