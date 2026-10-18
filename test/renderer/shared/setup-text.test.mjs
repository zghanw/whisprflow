import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { describeError, permissionGranted, permissionText } from "../../../src/renderer/shared/setup-text.mjs";

// Checked with the macOS wording; the Windows wording is checked in the i18n test
const en = createTranslator("en", "darwin");

test("main-process errors drop the prefix Electron adds and keep only the sentence", () => {
  const wrapped = new Error(
    "Error invoking remote method 'setup:set-theme': Error: theme must be one of ink / cinnabar",
  );
  assert.equal(describeError(wrapped), "theme must be one of ink / cinnabar");
  assert.equal(
    describeError(new Error("Error invoking remote method 'a': TypeError: Unknown hotkey")),
    "Unknown hotkey",
  );
  assert.equal(describeError(new Error("Network is down")), "Network is down");
  assert.equal(describeError("Plain strings work too"), "Plain strings work too");
});

test("permission granted or not: the microphone uses the system status, the other two are what the helper reports, null until it reports", () => {
  assert.equal(permissionGranted("microphone", "granted"), true);
  assert.equal(permissionGranted("microphone", "not-determined"), false);
  assert.equal(permissionGranted("listen", true), true);
  assert.equal(permissionGranted("trusted", null), null);
});

test('the microphone button says "Allow" when it was never asked: the system must prompt first before the app appears in System Settings', () => {
  assert.deepEqual(permissionText("microphone", "not-determined", en), ["Not granted", "problem", "Allow"]);
  assert.deepEqual(permissionText("microphone", "denied", en), ["Not granted", "problem", "System Settings"]);
  assert.deepEqual(permissionText("listen", null, en), ["Checking…", "pending", "System Settings"]);
  assert.deepEqual(permissionText("trusted", true, en), ["Granted", "ok", "System Settings"]);
  assert.deepEqual(permissionText("microphone", "not-determined", en), ["Not granted", "problem", "Allow"]);
  assert.deepEqual(permissionText("trusted", true, en), ["Granted", "ok", "System Settings"]);
});
