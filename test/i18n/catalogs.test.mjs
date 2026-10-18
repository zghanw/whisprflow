import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_LOCALE, findLocale, LOCALES } from "../../src/i18n/index.mjs";
import { PROVIDERS } from "../../src/server/providers/index.mjs";
import { HOTKEY_IDS, SETTINGS } from "../../src/storage/settings.mjs";
import { THEMES } from "../../src/themes/index.mjs";

// Every language's copy is complete with matching parameters, and every name the code uses exists. Adding a language, these point out what is missing.

const base = findLocale(DEFAULT_LOCALE).messages;
const isPlural = (node) => node !== null && typeof node === "object" && typeof node.other === "string";

/** Flattens to name -> template (plural ones are { one, other }). The windows section is handled separately (see the top of src/i18n/index.mjs), not here */
function flatten(node, prefix = "", out = new Map()) {
  for (const [name, value] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (key === "windows") continue;
    if (typeof value === "string" || isPlural(value)) out.set(key, value);
    else flatten(value, key, out);
  }
  return out;
}

/** The windows section flattened: names without the windows. prefix are the sentences they override */
const windowsVariants = (messages) => (messages.windows ? flatten(messages.windows) : new Map());

const placeholders = (template) =>
  new Set(
    (isPlural(template) ? Object.values(template) : [template]).flatMap((text) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
    ),
  );

const baseKeys = flatten(base);

for (const locale of LOCALES) {
  test(`${locale.id}: names match English one to one, with the same parameters per sentence`, () => {
    const keys = flatten(locale.messages);
    assert.deepEqual(
      [...keys.keys()].filter((key) => !baseKeys.has(key)),
      [],
      "extra",
    );
    assert.deepEqual(
      [...baseKeys.keys()].filter((key) => !keys.has(key)),
      [],
      "missing",
    );
    for (const [key, template] of keys) {
      assert.deepEqual(placeholders(template), placeholders(baseKeys.get(key)), key);
    }
  });

  test(`${locale.id}: Windows wordings override existing sentences with the same parameters; sentences that don't differ by system can be left out`, () => {
    for (const [key, template] of windowsVariants(locale.messages)) {
      assert.ok(baseKeys.has(key), `the sentence windows.${key} overrides doesn't exist`);
      assert.deepEqual(placeholders(template), placeholders(baseKeys.get(key)), `windows.${key}`);
    }
  });

  test(`${locale.id}: plurals only use this language's categories, and other is always there`, () => {
    const categories = new Intl.PluralRules(locale.id).resolvedOptions().pluralCategories;
    for (const [key, template] of flatten(locale.messages)) {
      if (!isPlural(template)) continue;
      for (const form of Object.keys(template)) assert.ok(categories.includes(form), `${form} of ${key}`);
    }
  });
}

test("names built dynamically exist too: every hotkey, theme, vendor, and setting", () => {
  const needed = [
    ...HOTKEY_IDS.flatMap((id) => [`hotkeys.${id}.name`, `hotkeys.${id}.keycap`]),
    ...THEMES.flatMap(({ id }) => [`themes.${id}.name`, `themes.${id}.describe`]),
    ...PROVIDERS.map(({ id }) => `providers.${id}.getKey`),
    ...Object.keys(SETTINGS).map((name) => `settings.describe.${name}`),
  ];
  assert.deepEqual(
    needed.filter((key) => !baseKeys.has(key)),
    [],
  );
});

/** Source files in the repository */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sourceFiles(path);
    return /\.(mjs|cjs|html)$/.test(name) ? [path] : [];
  });
}

test("names hard-coded in the code (t, msg, parts, data-i18n) all exist in English", () => {
  const root = resolve(import.meta.dirname, "../..");
  const used = new Map();
  const patterns = [/\bt(?:\.parts)?\(\s*"([\w.]+)"/g, /\bmsg\(\s*"([\w.]+)"/g, /data-i18n(?:-[\w-]+)?="([\w.]+)"/g];
  for (const file of [...sourceFiles(join(root, "src")), join(root, "bin/whisprflow.mjs")]) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) used.set(match[1], file.slice(root.length + 1));
    }
  }
  assert.ok(used.size > 100, `only found ${used.size}; the scan patterns may be wrong`);
  const missing = [...used].filter(([key]) => !baseKeys.has(key)).map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(missing, []);
});

test("the English written in HTML data-i18n spots matches en.mjs exactly (it is what shows before the page loads, and what screen readers see)", () => {
  const root = resolve(import.meta.dirname, "../..");
  const decode = (text) => text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  let checked = 0;
  for (const file of sourceFiles(join(root, "src")).filter((path) => path.endsWith(".html"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/data-i18n="([\w.]+)"[^<>]*>([^<]*)</g)) {
      const fallback = baseKeys.get(match[1]);
      assert.equal(decode(match[2]), isPlural(fallback) ? fallback.other : fallback, `${file}: ${match[1]}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `only checked ${checked}`);
});
