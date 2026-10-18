import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENTITLEMENTS, osxSignOptions, signingConfig } from "../../../scripts/build/signing.mjs";

/** A temporary repository root, with .machine.env written as content (null means no such file) */
function repo(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "wf-signing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (content !== null) writeFileSync(join(dir, ".machine.env"), content);
  return dir;
}

const IDENTITY = "Developer ID Application: Someone (TEAM123456)";

test("nothing configured: no identity, a local signature", (t) => {
  assert.equal(signingConfig(repo(t, null), {}), null);
  assert.equal(signingConfig(repo(t, "MAC_SIGNING_IDENTITY=\nMAC_NOTARY_PROFILE=\n"), {}), null);
});

test("reads the certificate and notary profile names from .machine.env, quotes and spaces included", (t) => {
  const dir = repo(t, `# local settings\nMAC_SIGNING_IDENTITY="${IDENTITY}"\nMAC_NOTARY_PROFILE=whisprflow-notary\n`);
  assert.deepEqual(signingConfig(dir, {}), { identity: IDENTITY, notaryProfile: "whisprflow-notary" });
});

test("environment variables take precedence over .machine.env", (t) => {
  const dir = repo(t, `MAC_SIGNING_IDENTITY="${IDENTITY}"\nMAC_NOTARY_PROFILE=whisprflow-notary\n`);
  assert.deepEqual(signingConfig(dir, { MAC_NOTARY_PROFILE: "other" }), { identity: IDENTITY, notaryProfile: "other" });
});

test("signing without notarizing works too: for use on this machine", (t) => {
  assert.deepEqual(signingConfig(repo(t, `MAC_SIGNING_IDENTITY="${IDENTITY}"\n`), {}), {
    identity: IDENTITY,
    notaryProfile: null,
  });
});

test("a notary profile without a certificate: says so instead of quietly building an unsigned app", (t) => {
  assert.throws(() => signingConfig(repo(t, "MAC_NOTARY_PROFILE=whisprflow-notary\n"), {}), /MAC_SIGNING_IDENTITY/);
});

test("Chromium's helpers get the signing library's defaults; the rest only get JIT and the microphone", () => {
  const { identity, optionsForFile } = osxSignOptions(IDENTITY);
  assert.equal(identity, IDENTITY);
  for (const helper of ["Renderer", "GPU", "Plugin"]) {
    assert.deepEqual(optionsForFile(`/x/WhisprFlow.app/Contents/Frameworks/WhisprFlow Helper (${helper}).app`), {});
  }
  for (const file of [
    "/x/WhisprFlow.app",
    "/x/WhisprFlow.app/Contents/Frameworks/WhisprFlow Helper.app",
    "/x/WhisprFlow.app/Contents/Resources/app/build/key-helper",
  ]) {
    assert.deepEqual(optionsForFile(file), { entitlements: ENTITLEMENTS });
  }
  const keys = [...readFileSync(ENTITLEMENTS, "utf8").matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"]);
});
