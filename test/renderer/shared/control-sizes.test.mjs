import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// The standard sizes: three control heights (--control-sm/md/lg) and four radii (--radius-*).
// Buttons and badges of uneven height in one row usually mean someone wrote 30px in passing, so a test guards it, the same way as the type size test (type-scale.test.mjs).

const RENDERER = join(import.meta.dirname, "../../../src/renderer");

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** The rules in a stylesheet: selector, declarations, starting line. Only flat rules are split out, including those inside @media / @container */
function rules(path) {
  const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found = [];
  for (const match of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const line = css.slice(0, match.index).split("\n").length;
    found.push({
      selector: match[1].trim(),
      body: match[2],
      at: `${relative(RENDERER, path).replaceAll("\\", "/")}:${line}`,
    });
  }
  return found;
}

/** The standard controls: their height may only be one of the three. Only the selector's last part counts (.button .icon is an icon inside a button, not a button) */
const CONTROL = /\.(button|input|select|badge|check|pill|tab|segmented|state-box|toggle|icon-button)(?![\w-])/;
const isControl = (selector) =>
  selector.split(",").some((part) =>
    CONTROL.test(
      part
        .trim()
        .split(/\s*[\s>+~]\s*/)
        .pop(),
    ),
  );

test("control heights only use --control-sm / md / lg", () => {
  const offenders = cssFiles(RENDERER)
    .flatMap(rules)
    .filter(({ selector }) => isControl(selector))
    .flatMap(({ selector, body, at }) =>
      [...body.matchAll(/(?:^|;)\s*height:\s*([^;]+)/g)]
        .map(([, value]) => value.trim())
        .filter((value) => !/^var\(--control-(sm|md|lg)\)$/.test(value))
        .map((value) => `${at}  ${selector} { height: ${value} }`),
    );
  assert.deepEqual(offenders, []);
});

/**
 * Exceptions to the four radii, each with a reason: decorative thin lines, small cells, or the floating bar's own shape (it isn't a normal window and doesn't follow the window rules)
 */
/** One corner's radius: a token, fully round, square, or computed from a token */
const RADIUS_VALUE = /^(50%|0|var\(--radius-[a-z]+\)|calc\(var\(--radius-[a-z]+\)[^)]*\))$/;

const RADIUS_EXCEPTIONS = [
  ["bar/", "the floating bar's own shape and level bars"],
  ["shared/window.css:.tabs > .indicator", "the 2px underline under the category tabs"],
  ["hub/hub.css:.cell", "the small cells of Home's activity heatmap"],
  ["hub/hub.css:.page-arrow", "the small paging arrows of the heatmap"],
];

test("radii only use --radius-* (or a fully round 50%), with every exception's reason written down", () => {
  const offenders = cssFiles(RENDERER)
    .flatMap(rules)
    .flatMap(({ selector, body, at }) =>
      [...body.matchAll(/(?:^|;)\s*border-radius:\s*([^;]+)/g)]
        .map(([, value]) => value.trim())
        .filter((value) => !value.split(/\s+(?![^(]*\))/).every((part) => RADIUS_VALUE.test(part)))
        .map((value) => ({ at, selector, value })),
    )
    .filter(
      ({ at, selector }) =>
        !RADIUS_EXCEPTIONS.some(([where]) =>
          where.endsWith("/") ? at.startsWith(where) : `${at.split(":")[0]}:${selector}` === where,
        ),
    )
    .map(({ at, selector, value }) => `${at}  ${selector} { border-radius: ${value} }`);
  assert.deepEqual(offenders, []);
});

test("violations are found: controls are recognized and hard-coded radii are caught", () => {
  assert.ok(isControl(".row .button.block"));
  assert.ok(isControl(".search .input"));
  assert.ok(!isControl(".button .icon"));
  assert.ok(!isControl(".buttons-row"));
  assert.ok(!isControl(".tabs"));
  assert.ok(RADIUS_VALUE.test("var(--radius-card)"));
  assert.ok(!RADIUS_VALUE.test("6px"));
});
