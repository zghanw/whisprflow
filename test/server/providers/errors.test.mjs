import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { ModelError, toModelError } from "../../../src/server/providers/errors.mjs";

const en = createTranslator("en");

const OpenAI = { name: "OpenAI" };

test("an unreachable vendor (offline, cancelled) is temporarily unavailable, and the message names it", () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("This operation was aborted", "AbortError")]) {
    const described = toModelError(error, { provider: OpenAI });
    assert.ok(described instanceof ModelError);
    assert.equal(described.kind, "unavailable");
    assert.equal(en.text(described.problem), "Can't reach OpenAI. Check your network");
  }
});

test("errors a vendor recognizes are classified by it; the rest show their own message, shortened", () => {
  const classify = (error) => (error.status === 401 ? { kind: "key", problem: "This key is invalid" } : null);
  const rejected = toModelError(Object.assign(new Error("401 nope"), { status: 401 }), { provider: OpenAI, classify });
  assert.deepEqual(
    [rejected.kind, en.text(rejected.problem), rejected.detail],
    ["key", "This key is invalid", "401 nope"],
  );

  const unknown = toModelError(new Error("x".repeat(500)), { provider: OpenAI, classify });
  assert.equal(unknown.kind, "other");
  assert.ok(en.text(unknown.problem).length <= 200);
  assert.equal(unknown.detail.length, 500);
});

test("a key inside the error is scrubbed first: neither the user-facing text nor the log copy contains it", () => {
  // Measured: a key with a line break given to the Gemini SDK produces exactly this, with the whole input in quotes
  const key = "line-one-SECRET\nline-two-SECRET";
  const leaked = new TypeError(`Headers.append: "${key}" is an invalid header value.`);
  const described = toModelError(leaked, { provider: OpenAI, apiKey: key });
  assert.doesNotMatch(en.text(described.problem) + described.message + described.detail, /SECRET/);
  assert.match(described.detail, /invalid header value/);
});

test("an already classified error comes back as is, not wrapped again", () => {
  const error = new ModelError({ kind: "key", problem: "This key is invalid", detail: "401" });
  assert.equal(toModelError(error, { provider: OpenAI }), error);
});

test("a timeout is its own message: the vendor took too long, the network is fine", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const described = toModelError(timeout, { provider: OpenAI });
  assert.equal(described.kind, "unavailable");
  assert.equal(en.text(described.problem), "OpenAI took too long to reply. Try again later");
});

test("a connection reset midway (the reply cut off, the peer reset) is temporarily unreachable too, not a rejected request", () => {
  for (const error of [
    new TypeError("terminated"),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    Object.assign(new Error("other side closed"), { cause: { code: "UND_ERR_SOCKET" } }),
  ]) {
    const described = toModelError(error, { provider: OpenAI });
    assert.equal(described.kind, "unavailable", error.message);
  }
});

test("the original stack (key scrubbed) is kept for the log: an adapter bug can still be traced", () => {
  const key = "sk-SECRET";
  let original;
  try {
    null.content;
  } catch (error) {
    original = Object.assign(error, { message: `${error.message} ${key}` });
  }
  const described = toModelError(original, { provider: OpenAI, apiKey: key });
  assert.match(described.origin, /TypeError/);
  assert.match(described.origin, /errors\.test\.mjs/);
  assert.doesNotMatch(described.origin, /SECRET/);
});
