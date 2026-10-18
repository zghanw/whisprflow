import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { APP_ENTRIES, findCopyleft, pruneUnused, UNUSED_PACKAGES } from "../../../scripts/build/stage-app.mjs";

const repoDir = resolve(import.meta.dirname, "../../..");

/** Lays out a fake node_modules in a temporary directory: name to license */
function fakeModules(t, packages) {
  const dir = mkdtempSync(join(tmpdir(), "wf-stage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, license] of Object.entries(packages)) {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    const own = name.split("/node_modules/").at(-1);
    const manifest = license === undefined ? { name: own } : { name: own, license };
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify(manifest));
  }
  return dir;
}

test("unused decoders are removed from release packages, keeping only WebM; codec-parser (LGPL) for splitting Ogg goes too", (t) => {
  const dir = fakeModules(t, {
    "@audio/decode-webm": "MIT",
    "@audio/decode-opus": "MIT",
    "@audio/decode-aac": "GPL-2.0",
    "@audio/decode-eac3": "LGPL-2.1-or-later",
    "codec-parser": "LGPL-3.0-or-later",
  });
  pruneUnused(dir);
  assert.ok(existsSync(join(dir, "node_modules", "@audio/decode-webm")));
  for (const name of ["@audio/decode-opus", "@audio/decode-aac", "@audio/decode-eac3", "codec-parser"]) {
    assert.ok(!existsSync(join(dir, "node_modules", name)), name);
  }
  assert.ok(!UNUSED_PACKAGES.includes("@audio/decode-webm"));
});

test("GPL-family packages in release packages are pointed out; MIT, Apache, ISC, and BSD don't count", (t) => {
  const dir = fakeModules(t, {
    ws: "MIT",
    "@google/genai": "Apache-2.0",
    "some-isc": "ISC",
    "bsd-thing": "BSD-3-Clause",
    "@audio/decode-aac": "GPL-2.0",
    "lgpl-thing": "LGPL-2.1-or-later",
    "agpl-thing": "AGPL-3.0-only",
    "either-way": "(MIT OR GPL-3.0)",
  });
  assert.deepEqual(
    findCopyleft(join(dir, "node_modules")).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "@audio/decode-aac", license: "GPL-2.0" },
      { name: "agpl-thing", license: "AGPL-3.0-only" },
      { name: "lgpl-thing", license: "LGPL-2.1-or-later" },
    ],
  );
});

test("nested node_modules are checked too; packages without a license aren't let through, flagged for a person to look at", (t) => {
  const dir = fakeModules(t, { outer: "MIT", "outer/node_modules/inner": "GPL-3.0", unlicensed: undefined });
  assert.deepEqual(
    findCopyleft(join(dir, "node_modules"))
      .map(({ name }) => name)
      .sort(),
    ["inner", "unlicensed"],
  );
});

test("repository files the program uses by relative path exist and sit in directories that packaging includes", () => {
  const srcDir = join(repoDir, "src");
  const outside = [];
  for (const file of readdirSync(srcDir, { recursive: true })) {
    if (!/\.(mjs|html|css)$/.test(file)) continue;
    const text = readFileSync(join(srcDir, file), "utf8");
    for (const [, path] of text.matchAll(/["'(]((?:\.\.\/)+[^"')\s]+)["')]/g)) {
      const target = resolve(dirname(join(srcDir, file)), path);
      assert.ok(existsSync(target), `${path} used by ${file} doesn't exist`);
      // Files inside src need no check; nor does the program root itself (the CLI finding where it is installed)
      if (target === repoDir || target.startsWith(srcDir + sep)) continue;
      outside.push({ file, top: relative(repoDir, target).split(sep)[0] });
    }
  }
  for (const { file, top } of outside)
    assert.ok(APP_ENTRIES.includes(top), `${file} uses ${top}/, which packaging leaves out`);
  assert.ok(
    outside.some(({ top }) => top === "assets"),
    "the menu bar and window icons are read from assets/",
  );
});
