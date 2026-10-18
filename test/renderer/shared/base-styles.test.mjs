import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The shared window base (shared/window.css). Once, Home's "Today / This month / All time" styles were deleted while reworking the model page,
// the buttons fell back to the browser's gray system buttons, and nobody noticed; "Get a key" was the same kind. So buttons first drop the built-in look:
// a button whose style is missing falls back to plain text, never a gray raised system button again. This test guards that rule.

const css = readFileSync(join(import.meta.dirname, "../../../src/renderer/shared/window.css"), "utf8");

test("buttons drop the browser's built-in look first, with no specificity (the standard buttons still override it)", () => {
  const rule = css.match(/:where\(button\)\s*\{([^}]*)\}/);
  assert.ok(rule, "window.css needs a :where(button) { ... } rule");
  for (const declaration of ["background: none", "border: none", "font: inherit", "color: inherit"]) {
    assert.ok(rule[1].includes(declaration), `missing ${declaration}`);
  }
});
