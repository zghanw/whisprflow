import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyStore } from "../../../src/app/keys/key-store.mjs";
import { createTranslator } from "../../../src/i18n/index.mjs";

// Checked with the macOS wording; the Windows wording is checked in the i18n test
const en = createTranslator("en", "darwin");
/** The user-facing sentence in the error, as translated */
const said = (pattern) => (error) => pattern.test(en.text(error.problem ?? error.message));

// Fake keychain: XORs each byte, enough to tell ciphertext from plain text
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a)).toString("utf8"),
});

function tempStore(safeStorage = fakeSafeStorage()) {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-key-"));
  const file = join(dir, "gemini-key.bin");
  return { file, store: createKeyStore({ file, safeStorage }), cleanup: () => rmSync(dir, { recursive: true }) };
}

test("nothing saved reads as null", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(store.load(), null);
});

test("a saved key reads back as it was; it isn't plain text on disk, and only the owner can read or write the file", (t) => {
  const { file, store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-not-a-real-key");
  assert.equal(store.load(), "AIza-not-a-real-key");
  assert.ok(!readFileSync(file).includes("AIza-not-a-real-key"));
  // Permission bits mean nothing on Windows; owner-only access comes from the home directory's ACL (storage/owner-only.mjs, checked in the paths test)
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("after clearing it reads as null, and clearing twice is fine", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-not-a-real-key");
  store.clear();
  store.clear();
  assert.equal(store.load(), null);
});

test("without the system keychain, saving is refused rather than falling back to plain text", (t) => {
  const { file, store, cleanup } = tempStore(fakeSafeStorage(false));
  t.after(cleanup);
  assert.throws(() => store.save("AIza-not-a-real-key"), said(/keychain/));
  assert.throws(() => statSync(file), { code: "ENOENT" });
});

test("exists only checks whether the file is there, without decrypting", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createKeyStore({
    file: join(dir, "openai-key.bin"),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: () => assert.fail("should not decrypt"),
    },
  });
  assert.equal(store.exists(), false);
  store.save("k");
  assert.equal(store.exists(), true);
});
