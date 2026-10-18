import assert from "node:assert/strict";
import { test } from "node:test";
import { fixTarget } from "../../../src/renderer/hub/settings.mjs";

const setup = (key, permissions = {}, helper = "running") => ({
  key: { state: key },
  helper,
  permissions: { microphone: "granted", listen: true, trusted: true, ...permissions },
});

test("a missing key: go to the key table on the sidebar's model page", () => {
  const keys = { route: "models", tab: "keys" };
  assert.deepEqual(fixTarget(setup("missing")), keys);
  assert.deepEqual(fixTarget(setup("rejected", { listen: false })), keys);
  assert.deepEqual(fixTarget(setup("unreadable")), keys);
});

test("with the key fine or being verified, a missing permission goes to the permissions page", () => {
  assert.deepEqual(fixTarget(setup("ready", { microphone: "denied" })), { pane: "permissions" });
  assert.deepEqual(fixTarget(setup("checking", { listen: false })), { pane: "permissions" });
  // Only missing Accessibility counts too: it works but degraded, and the fix is on the permissions page as well
  assert.deepEqual(fixTarget(setup("ready", { trusted: false })), { pane: "permissions" });
});

test("nothing missing and permissions not reported yet: the first settings page", () => {
  assert.deepEqual(fixTarget(setup("ready")), { pane: "general" });
  assert.deepEqual(fixTarget(setup("ready", { listen: null, trusted: null })), { pane: "general" });
});

test("the key listener helper stopped: the permissions page, where rechecking is", () => {
  assert.deepEqual(fixTarget(setup("ready", { listen: null, trusted: null }, "stopped")), { pane: "permissions" });
});
