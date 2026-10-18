import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyManager } from "../../../src/app/keys/key-manager.mjs";
import { createTranslator, LocalizedError, msg } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { findProvider } from "../../../src/server/providers/index.mjs";
import { findVendor } from "../../../src/server/vendors.mjs";

const en = createTranslator("en");

/** Switches routes, waits until the key lookup and check settle, and returns whether it switched */
async function switched(keys, route) {
  const result = keys.switchRoute(route);
  await result.settled;
  return result.ok;
}

const nativeRoute = (provider, model) => ({ mode: "native", model: { provider, model }, thinkingLevel: null });
const LOCAL_CUSTOM = {
  mode: "local",
  transcriber: "qwen3-asr-0.6b-q8",
  polish: { vendor: "custom", model: "qwen3:8b" },
  customUrl: "http://127.0.0.1:8080/v1",
};

/** The route used for OpenAI when none is given: its default model, native path */
const OPENAI_DEFAULT = {
  mode: "native",
  model: { provider: "openai", model: findProvider("openai").defaultModel },
  thinkingLevel: null,
};

// Errors from the service are ModelErrors classified by the model layer (see src/server/providers/errors.mjs); the originals below were all measured
const OFFLINE = () =>
  new ModelError({ kind: "unavailable", problem: "Can't reach Gemini. Check your network", detail: "fetch failed" });
const BUSY = () =>
  new ModelError({
    kind: "unavailable",
    problem: "Gemini is unavailable right now (The service is currently unavailable). Try again later",
    detail: '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}',
  });
const INVALID = () =>
  new ModelError({
    kind: "key",
    problem: "This key is invalid. Check it was copied in full",
    detail: "API key not valid.",
  });
const NO_SUCH_MODEL = () =>
  new ModelError({
    kind: "other",
    problem: "Gemini rejected the request: models/gemini-nope is not found",
    detail: '{"error":{"code":404,"message":"models/gemini-nope is not found.","status":"NOT_FOUND"}}',
  });

/**
 * Fake dictation service. verdicts: key to the error thrown when verifying with it (none means it passes).
 * Like the real one: when "use before verification" is allowed, unreachable doesn't count as failure.
 */
function fakeService(verdicts = {}) {
  const service = {
    calls: [],
    /** The key in use; null when none */
    using: null,
    /** The route in use; null until changed (the route from settings at startup) */
    route: null,
    /** When set, verification waits here until released (simulating a slow vendor) */
    gate: null,
    async useKey(apiKey, { allowUnverified = false, keys } = {}) {
      service.calls.push({ useKey: apiKey, allowUnverified, ...(keys ? { keys } : {}) });
      if (service.gate) await service.gate;
      const error = verdicts[apiKey]?.();
      if (error && !(allowUnverified && error.kind === "unavailable")) throw error;
      service.using = apiKey;
      return error ? { verified: false, problem: error.problem } : { verified: true };
    },
    /** Switches routes at once, dropping the key in hand (without verifying, like the real one) */
    setRoute(route) {
      service.calls.push({ setRoute: route });
      service.route = route;
      service.using = null;
    },
    /** Tries a key on another route without replacing the one in use */
    async probe({ route, apiKey, keys }) {
      service.calls.push({ probe: apiKey, route, ...(keys ? { keys } : {}) });
      const error = verdicts[apiKey]?.();
      if (error) throw error;
    },
    async verify() {
      service.calls.push({ verify: service.using });
      const error = verdicts[service.using]?.();
      if (error) throw error;
    },
    forgetKey() {
      service.using = null;
    },
  };
  return service;
}

function fakeStore(initial = null) {
  const store = {
    value: initial,
    load() {
      if (store.value instanceof Error) throw store.value;
      return store.value;
    },
    save(key) {
      if (store.failOnSave) throw new Error("keychain unavailable");
      store.value = key;
    },
    clear() {
      store.value = null;
    },
    exists() {
      return store.value !== null;
    },
  };
  return store;
}

/**
 * @param {object} [options]
 * @param {string} [options.provider] which vendor is in use, Gemini by default
 * @param {string | Error | null} [options.stored] the stored key of the vendor in use
 * @param {string | Error | null} [options.storedOther] the other one's stored key (OpenAI when Gemini, and the reverse)
 * @param {string | Error | null} [options.storedCustom] the custom cleanup service's stored key
 * @param {(id: string) => object} [options.routeFor] defaults to key-manager's own (native path, default model)
 */
function setup({
  verdicts,
  provider = "gemini",
  stored = null,
  storedOther = null,
  storedCustom = null,
  env = {},
  external = false,
  routeFor,
} = {}) {
  const service = external ? null : fakeService(verdicts);
  const other = provider === "gemini" ? "openai" : "gemini";
  const keyStores = { [provider]: fakeStore(stored), [other]: fakeStore(storedOther) };
  if (provider !== "custom") keyStores.custom = fakeStore(storedCustom);
  const logged = [];
  const record = (level) => (event, fields) => logged.push({ level, event, ...fields });
  let changes = 0;
  const keys = createKeyManager({
    service,
    provider: findVendor(provider),
    keyStores,
    ...(routeFor ? { routeFor } : {}),
    env,
    log: { info: record("info"), warn: record("warn"), error: record("error") },
    onChange: () => changes++,
  });
  return {
    keys,
    service,
    keyStore: keyStores[provider],
    otherStore: keyStores[other],
    customStore: keyStores.custom,
    logged,
    changes: () => changes,
  };
}

// ---------- Finding the key at startup ----------

test("no environment variable and nothing stored: no key yet, and the service is left alone", async () => {
  const { keys, service } = setup();
  assert.deepEqual(await keys.loadAtStartup(), { state: "missing", source: null, problem: null });
  assert.deepEqual(service.calls, []);
});

test("a stored key that passes verification is ready; every step along the way notifies", async () => {
  const { keys, service, changes } = setup({ stored: "stored-key" });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "stored", problem: null, verified: true });
  assert.equal(keys.current.state, "ready");
  assert.equal(service.using, "stored-key");
  // Checking, then ready
  assert.equal(changes(), 2);
});

test("a key in the environment is used without reading the stored one", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key", env: { GEMINI_API_KEY: " env-key " } });
  keyStore.load = () => assert.fail("should not read the stored key");
  assert.equal((await keys.loadAtStartup()).source, "env");
  assert.equal(service.using, "env-key");
});

test("Gemini unreachable at startup: the stored key is enabled anyway and honestly marked not yet verified", async () => {
  const { keys, service, logged } = setup({ stored: "stored-key", verdicts: { "stored-key": OFFLINE } });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "stored", problem: null, verified: false });
  assert.equal(service.using, "stored-key");
  assert.deepEqual(service.calls, [{ useKey: "stored-key", allowUnverified: true }]);
  assert.deepEqual(logged.at(-1), {
    level: "info",
    event: "key_ready",
    provider: "gemini",
    source: "stored",
    verified: false,
  });
});

test("Gemini briefly unavailable at startup (503): used anyway like being offline, not reported as a model settings problem", async () => {
  const { keys, service } = setup({ stored: "stored-key", verdicts: { "stored-key": BUSY } });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "stored", problem: null, verified: false });
  assert.equal(service.using, "stored-key");
});

test("an invalid key or Gemini rejecting the request at startup: not ready, and the two are told apart", async () => {
  const invalid = setup({ stored: "revoked", verdicts: { revoked: INVALID } });
  const rejected = await invalid.keys.loadAtStartup();
  assert.deepEqual(
    { state: rejected.state, source: rejected.source, cause: rejected.cause },
    { state: "rejected", source: "stored", cause: "key" },
  );
  assert.match(en.text(rejected.problem), /invalid/);
  assert.equal(invalid.service.using, null);

  const wrongModel = setup({ stored: "good", verdicts: { good: NO_SUCH_MODEL } });
  const other = await wrongModel.keys.loadAtStartup();
  assert.equal(other.cause, "other");
  assert.match(en.text(other.problem), /gemini-nope is not found/);
});

test("a stored key that can not be decrypted says it can not be read anymore and asks to enter it again", async () => {
  const { keys, service } = setup({ stored: new Error("the keychain key is gone") });
  const state = await keys.loadAtStartup();
  assert.deepEqual({ state: state.state, source: state.source }, { state: "unreadable", source: "stored" });
  assert.match(en.text(state.problem), /can't be read anymore/);
  assert.deepEqual(service.calls, []);
});

test("a key in the environment with a line break is judged unusable at once, never reaches the service, and its content appears nowhere", async () => {
  const { keys, service, logged } = setup({ env: { GEMINI_API_KEY: "line-one-SECRET\nline-two-SECRET" } });
  const state = await keys.loadAtStartup();
  assert.deepEqual(
    { state: state.state, source: state.source, cause: state.cause },
    { state: "rejected", source: "env", cause: "key" },
  );
  assert.match(en.text(state.problem), /spaces or line breaks/);
  assert.deepEqual(service.calls, []);
  assert.doesNotMatch(JSON.stringify([state, logged]), /SECRET/);
});

test("connected to a separately started server: the key lives there, nothing to manage here", async () => {
  const { keys } = setup({ external: true, stored: "stored-key" });
  assert.deepEqual(await keys.loadAtStartup(), { state: "ready", source: "external", problem: null });
  assert.match(en.text((await keys.save("new-key")).problem), /WHISPRFLOW_SERVER_URL/);
  await keys.forget();
  assert.equal(keys.current.source, "external");
});

// ---------- Replacing the key ----------

test("saving a new key: stored and used only after it passes verification", async () => {
  const { keys, service, keyStore } = setup();
  assert.deepEqual(await keys.save("  new-key \n"), { ok: true });
  assert.equal(keyStore.value, "new-key");
  assert.equal(service.using, "new-key");
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });
});

test("nothing entered: no verification, nothing saved", async () => {
  const { keys, service } = setup();
  for (const empty of ["", "   ", undefined, 42]) {
    assert.match(en.text((await keys.save(empty)).problem), /No key entered/);
  }
  assert.deepEqual(service.calls, []);
});

test("a newly entered key with a line break is refused at once, never reaches the service, and appears in neither the answer nor the log", async () => {
  const { keys, service, keyStore, logged } = setup({ stored: "old-key" });
  await keys.loadAtStartup();
  const result = await keys.save("line-one-SECRET\nline-two-SECRET");
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /This key has spaces or line breaks/);
  assert.equal(service.using, "old-key");
  assert.equal(keyStore.value, "old-key");
  assert.equal(keys.current.state, "ready");
  assert.doesNotMatch(JSON.stringify([result, logged, keys.current]), /SECRET/);
});

test("a new key that can not be verified while offline does not pass (it was never verified), and the previous state stays", async () => {
  const withOld = setup({ stored: "old-key", verdicts: { "new-key": OFFLINE } });
  await withOld.keys.loadAtStartup();
  const result = await withOld.keys.save("new-key");
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /Can't reach/);
  assert.deepEqual(withOld.service.calls.at(-1), { useKey: "new-key", allowUnverified: false });
  assert.equal(withOld.service.using, "old-key");
  assert.equal(withOld.keyStore.value, "old-key");
  assert.deepEqual(withOld.keys.current, { state: "ready", source: "stored", problem: null, verified: true });

  // Without a key before, a failure still means "no key yet", not "the stored key doesn't work"
  const empty = setup({ verdicts: { "new-key": INVALID } });
  assert.match(en.text((await empty.keys.save("new-key")).problem), /invalid/);
  assert.deepEqual(empty.keys.current, { state: "missing", source: null, problem: null });
  assert.equal(empty.keyStore.value, null);
});

test("verified but not saveable: works this time, and honestly says it must be entered again next time", async () => {
  const { keys, service, keyStore } = setup();
  keyStore.failOnSave = true;
  const result = await keys.save("new-key");
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /wasn't saved.*keychain unavailable/);
  assert.equal(service.using, "new-key");
  assert.equal(keys.current.state, "ready");
});

test("a key inside a verification error is scrubbed from both the answer and the log", async () => {
  const leaky = () => new TypeError('Headers.append: "SECRET-key" is an invalid header value.');
  const { keys, logged } = setup({ verdicts: { "SECRET-key": leaky } });
  const result = await keys.save("SECRET-key");
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify([result, logged]), /SECRET/);
  assert.equal(logged.at(-1).event, "key_rejected");
});

/** Holds the stored key's verification until the test releases it */
function holdStartup(service) {
  let release;
  const useKey = service.useKey;
  service.useKey = async (apiKey, options) => {
    if (apiKey === "stored-key") await new Promise((resolve) => (release = resolve));
    return useKey(apiKey, options);
  };
  return async () => {
    await new Promise((resolve) => setImmediate(resolve));
    release();
  };
}

test("a new key saved while startup verification is pending: one at a time, and the later key ends up in use", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  const release = holdStartup(service);
  const pending = [keys.loadAtStartup(), keys.save("new-key")];
  await release();
  await Promise.all(pending);
  assert.equal(service.using, "new-key");
  assert.equal(keyStore.value, "new-key");
  assert.equal(keys.current.state, "ready");
});

test("an unusable key saved while startup verification is pending: it returns to the state startup verification reached, never stuck on 'checking'", async () => {
  const { keys, service } = setup({ stored: "stored-key", verdicts: { "bad-key": INVALID } });
  const release = holdStartup(service);
  const pending = [keys.loadAtStartup(), keys.save("bad-key")];
  await release();
  const [, saved] = await Promise.all(pending);
  assert.equal(saved.ok, false);
  assert.equal(service.using, "stored-key");
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });
});

// ---------- Deleting ----------

test("deleting: the stored key is gone and the service stops using it", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  await keys.loadAtStartup();
  await keys.forget();
  assert.equal(keyStore.value, null);
  assert.equal(service.using, null);
  assert.deepEqual(keys.current, { state: "missing", source: null, problem: null });
});

test("deleting before startup verification returns: once it returns the key is still deleted, never enabled again", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  const release = holdStartup(service);
  const pending = [keys.loadAtStartup(), keys.forget()];
  await release();
  await Promise.all(pending);
  assert.equal(service.using, null);
  assert.equal(keyStore.value, null);
  assert.equal(keys.current.state, "missing");
});

test("an error while deleting (the file won't go) is reported honestly, and saving a key later is unaffected", async () => {
  const { keys, service, keyStore } = setup({ stored: "stored-key" });
  await keys.loadAtStartup();
  keyStore.clear = () => {
    throw new Error("cannot delete");
  };
  await assert.rejects(keys.forget(), /cannot delete/);
  assert.deepEqual(await keys.save("new-key"), { ok: true });
  assert.equal(service.using, "new-key");
});

// ---------- Verification missed at startup, filled in later ----------

test("reverify: becomes verified once the network is back", async () => {
  const verdicts = { "stored-key": OFFLINE };
  const { keys, service } = setup({ stored: "stored-key", verdicts });
  await keys.loadAtStartup();

  await keys.reverify();
  assert.equal(keys.current.verified, false, "still unreachable: in use, state unchanged");
  assert.equal(service.using, "stored-key");

  delete verdicts["stored-key"];
  await keys.reverify();
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });
});

test("reverify: finding the key invalid once connected makes it unusable, and the service stops using it", async () => {
  const verdicts = { "env-key": OFFLINE };
  const { keys, service } = setup({ env: { GEMINI_API_KEY: "env-key" }, verdicts });
  await keys.loadAtStartup();
  verdicts["env-key"] = INVALID;
  await keys.reverify();
  assert.deepEqual(
    { state: keys.current.state, source: keys.current.source, cause: keys.current.cause },
    { state: "rejected", source: "env", cause: "key" },
  );
  assert.equal(service.using, null);
});

test("reverify: a verified key or no key sends nothing; two at once verify once", async () => {
  const verified = setup({ stored: "stored-key" });
  await verified.keys.loadAtStartup();
  await verified.keys.reverify();
  const missing = setup();
  await missing.keys.reverify();
  assert.ok(![...verified.service.calls, ...missing.service.calls].some((call) => "verify" in call));

  const pending = setup({ stored: "stored-key", verdicts: { "stored-key": OFFLINE } });
  await pending.keys.loadAtStartup();
  await Promise.all([pending.keys.reverify(), pending.keys.reverify()]);
  assert.equal(pending.service.calls.filter((call) => "verify" in call).length, 1);
});

// ---------- More than one vendor ----------

test("using OpenAI: looks in OPENAI_API_KEY and its own stored key, never Gemini's", async () => {
  const fromEnv = setup({ provider: "openai", env: { GEMINI_API_KEY: "gemini-key", OPENAI_API_KEY: "openai-key" } });
  assert.equal((await fromEnv.keys.loadAtStartup()).source, "env");
  assert.equal(fromEnv.service.using, "openai-key");

  const stored = setup({ provider: "openai", stored: "openai-stored", storedOther: "gemini-stored" });
  await stored.keys.loadAtStartup();
  assert.equal(stored.service.using, "openai-stored");
});

test("saving another vendor's key: stored only after verifying with that vendor's default model; the key in use and the state are untouched", async () => {
  const { keys, service, keyStore, otherStore } = setup({ stored: "gemini-key" });
  await keys.loadAtStartup();
  assert.deepEqual(await keys.save(" openai-key ", { provider: "openai" }), { ok: true });
  assert.equal(otherStore.value, "openai-key");
  assert.equal(keyStore.value, "gemini-key");
  assert.equal(service.using, "gemini-key");
  assert.deepEqual(service.calls.at(-1), { probe: "openai-key", route: OPENAI_DEFAULT });
  assert.equal(keys.current.state, "ready");
});

test("another vendor's key that fails is not saved, with the reason", async () => {
  const { keys, otherStore } = setup({ verdicts: { "bad-key": INVALID } });
  const result = await keys.save("bad-key", { provider: "openai" });
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /invalid/);
  assert.equal(otherStore.value, null);
});

test("deleting another vendor's key deletes only that one; the key in use is unaffected", async () => {
  const { keys, service, keyStore, otherStore } = setup({ stored: "gemini-key", storedOther: "openai-key" });
  await keys.loadAtStartup();
  await keys.forget({ provider: "openai" });
  assert.equal(otherStore.value, null);
  assert.equal(keyStore.value, "gemini-key");
  assert.equal(service.using, "gemini-key");
  assert.equal(keys.current.state, "ready");
});

test("an unknown vendor: no verification, no save, no delete", async () => {
  const { keys, service } = setup();
  assert.match(en.text((await keys.save("k", { provider: "nope" })).problem), /Unknown model provider: nope/);
  await assert.rejects(keys.forget({ provider: "nope" }), (error) =>
    /Unknown model provider: nope/.test(en.text(error.problem)),
  );
  assert.deepEqual(service.calls, []);
});

// ---------- Changing routes (another vendor, another model) ----------

test("changing routes: switched at once, the new vendor's stored key installed as at startup; later save, delete, and check without a vendor mean the new one", async () => {
  const { keys, service, keyStore, otherStore } = setup({ stored: "gemini-key", storedOther: "openai-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.equal(keys.provider.id, "openai");
  assert.deepEqual(service.calls.slice(-2), [
    { setRoute: OPENAI_DEFAULT },
    { useKey: "openai-key", allowUnverified: true },
  ]);
  assert.equal(service.using, "openai-key");
  assert.deepEqual(keys.current, { state: "ready", source: "stored", problem: null, verified: true });

  await keys.forget();
  assert.equal(otherStore.value, null);
  assert.equal(keyStore.value, "gemini-key");
  assert.equal(keys.current.state, "missing");
});

test("switching to a vendor without a key: it still switches, the state is missing for the new vendor; entering one makes it work", async () => {
  const { keys, service } = setup({ stored: "gemini-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.equal(keys.provider.id, "openai");
  assert.equal(service.using, null, "the Gemini key in hand can't be used on the OpenAI route");
  assert.deepEqual(keys.current, { state: "missing", source: null, problem: null });
  assert.deepEqual(await keys.save("openai-new"), { ok: true });
  assert.equal(keys.current.state, "ready");
  assert.equal(service.using, "openai-new");
});

test("a wrong key for the vendor switched to: it still switches, with the state rejected", async () => {
  const { keys } = setup({ stored: "gemini-key", storedOther: "openai-bad", verdicts: { "openai-bad": INVALID } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.deepEqual([keys.current.state, keys.current.cause], ["rejected", "key"]);
  assert.match(en.text(keys.current.problem), /invalid/);
});

test("the vendor switched to is temporarily unreachable: its stored key was verified when saved, so it is used and honestly marked not yet verified", async () => {
  const { keys } = setup({ stored: "gemini-key", storedOther: "openai-key", verdicts: { "openai-key": OFFLINE } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.deepEqual([keys.current.state, keys.current.verified], ["ready", false]);
});

test("the vendor switched to has a key in the environment: it is used and marked as from the environment", async () => {
  const { keys, service } = setup({ stored: "gemini-key", env: { OPENAI_API_KEY: "openai-env" } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, OPENAI_DEFAULT), true);
  assert.equal(service.using, "openai-env");
  assert.equal(keys.current.source, "env");
});

test("changing routes while connected to a separately started server is refused with the reason", async () => {
  const external = setup({ external: true });
  assert.match(en.text(external.keys.switchRoute(OPENAI_DEFAULT).problem), /separately started server/);
});

test("another route for the same vendor (another model) keeps the key in hand this run (a newly saved one if any), never reverting to the environment", async () => {
  const { keys, service } = setup({ env: { GEMINI_API_KEY: "env-key" } });
  await keys.loadAtStartup();
  await keys.save("new-key");
  const route = nativeRoute("gemini", "gemini-3.8-flash");
  assert.equal(await switched(keys, route), true);
  assert.deepEqual(service.calls.slice(-2), [{ setRoute: route }, { useKey: "new-key", allowUnverified: true }]);
  assert.equal(keys.provider.id, "gemini");
  assert.equal(keys.current.source, "stored");
});

// ---------- Checking whether a route works ----------

test("check: sends the smallest request with that vendor's key (environment first, then stored) and says whether it works and how long it took", async () => {
  const { keys, service } = setup({ storedOther: "openai-stored" });
  const result = await keys.check(nativeRoute("openai", "gpt-audio-1.5"));
  assert.equal(result.ok, true);
  assert.equal(result.source, "stored");
  assert.equal(typeof result.ms, "number");
  assert.deepEqual(service.calls, [{ probe: "openai-stored", route: nativeRoute("openai", "gpt-audio-1.5") }]);

  const fromEnv = setup({ storedOther: "openai-stored", env: { OPENAI_API_KEY: "openai-env" } });
  assert.equal((await fromEnv.keys.check(nativeRoute("openai", "gpt-audio-mini"))).source, "env");
  assert.equal(fromEnv.service.calls[0].probe, "openai-env");
});

test("check: no key for that vendor, an unreadable key, and a failed verification each say their own thing", async () => {
  const none = await setup().keys.check(nativeRoute("openai", "gpt-audio-mini"));
  assert.equal(none.ok, false);
  assert.equal(none.cause, "missing");
  assert.match(en.text(none.problem), /No OpenAI key yet.*whisprflow key openai/);

  const unreadable = await setup({ storedOther: new Error("cannot decrypt") }).keys.check(
    nativeRoute("openai", "gpt-audio-mini"),
  );
  assert.equal(unreadable.ok, false);
  assert.match(en.text(unreadable.problem), /can't be read anymore/);

  const rejected = await setup({ storedOther: "openai-key", verdicts: { "openai-key": NO_SUCH_MODEL } }).keys.check(
    nativeRoute("openai", "gpt-audio-9"),
  );
  assert.deepEqual([rejected.ok, rejected.cause], [false, "other"]);
  assert.match(en.text(rejected.problem), /gemini-nope is not found/);
});

test("check is impossible while connected to a separately started server, and it says why", async () => {
  const result = await setup({ external: true }).keys.check(nativeRoute("gemini", "gemini-3.5-flash"));
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /WHISPRFLOW_SERVER_URL/);
});

test("checking the vendor in use uses the key actually in use this run (a newly saved one if any), not the environment's", async () => {
  const { keys, service } = setup({ env: { GEMINI_API_KEY: "env-key" } });
  await keys.loadAtStartup();
  await keys.save("new-key");
  await keys.check(nativeRoute("gemini", "gemini-3.5-flash"));
  assert.equal(service.calls.at(-1).probe, "new-key");
  assert.equal((await keys.check(nativeRoute("gemini", "gemini-3.5-flash"))).source, "stored");
});

test("sources: where each vendor's key is (environment, stored, none), without decrypting", () => {
  const { keys, keyStore } = setup({ storedOther: "openai-key", env: { GEMINI_API_KEY: "env-key" } });
  keyStore.load = () => assert.fail("should not decrypt");
  assert.deepEqual(keys.sources(), { gemini: "env", openai: "stored", custom: null });
  assert.deepEqual(setup({ storedCustom: "custom-key" }).keys.sources(), {
    gemini: null,
    openai: null,
    custom: "stored",
  });
});

// ---------- The cleanup vendor (text only, on the local path) ----------

test("switching to local mode makes the cleanup vendor (a custom service) the one in use, with its key", async () => {
  const { keys, service } = setup({ stored: "gemini-key", storedCustom: "custom-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, LOCAL_CUSTOM), true);
  assert.equal(keys.provider.id, "custom");
  assert.equal(service.using, "custom-key");
  assert.deepEqual(service.route, LOCAL_CUSTOM);
});

test("saving the custom service's key: tried on the route routeFor gives, without replacing the one in use", async () => {
  const { keys, service, customStore } = setup({ stored: "gemini-key", routeFor: () => LOCAL_CUSTOM });
  await keys.loadAtStartup();
  assert.deepEqual(await keys.save("custom-key", { provider: "custom" }), { ok: true });
  assert.equal(customStore.value, "custom-key");
  assert.equal(service.using, "gemini-key");
  assert.deepEqual(service.calls.at(-1), { probe: "custom-key", route: LOCAL_CUSTOM });
});

test("saving another vendor's key can name the route to verify on (saving the key before switching to a custom model)", async () => {
  const custom = { ...LOCAL_CUSTOM, polish: { vendor: "custom", model: "llama3.2:3b" } };
  const { keys, service } = setup({
    stored: "gemini-key",
    routeFor: () => assert.fail("routeFor should not be asked when a route is given"),
  });
  await keys.loadAtStartup();
  assert.deepEqual(await keys.save("custom-key", { provider: "custom", route: custom }), { ok: true });
  assert.deepEqual(service.calls.at(-1), { probe: "custom-key", route: custom });
});

test("when routeFor says the vendor can't be verified (the custom service has no address yet), nothing is saved and its reason is given", async () => {
  const { keys, customStore, service } = setup({
    routeFor: () => {
      throw new LocalizedError(msg("chat.urlMissing"));
    },
  });
  const result = await keys.save("custom-key", { provider: "custom" });
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /No address set for the custom service/i);
  assert.equal(customStore.value, null);
  assert.deepEqual(service.calls, []);
});

test("checking the local path uses the cleanup vendor's key", async () => {
  const { keys, service } = setup({ stored: "gemini-key", storedCustom: "custom-key" });
  const result = await keys.check(LOCAL_CUSTOM);
  assert.equal(result.ok, true);
  assert.deepEqual(service.calls, [{ probe: "custom-key", route: LOCAL_CUSTOM }]);
});

test("cleanup by Ollama needs no key: switching makes no vendor the one in use, ready with no key, and nothing is verified", async () => {
  const LOCAL_OLLAMA = { ...LOCAL_CUSTOM, polish: { vendor: "ollama", model: "qwen3:4b-instruct" }, customUrl: null };
  const { keys, service } = setup({ stored: "gemini-key" });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, LOCAL_OLLAMA), true);
  assert.equal(keys.provider, null);
  assert.deepEqual([keys.current.state, keys.current.source], ["ready", "none"]);
  assert.ok(!service.calls.some((call) => call.route === LOCAL_OLLAMA), JSON.stringify(service.calls));
});

test("cleanup by Ollama while it isn't running: installed anyway, ready but unverified with the reason; a later check that passes clears it", async () => {
  let down = true;
  const ollamaDown = () =>
    down ? new ModelError({ kind: "unavailable", problem: "Ollama isn't running", detail: "fetch failed" }) : null;
  const LOCAL_OLLAMA = { ...LOCAL_CUSTOM, polish: { vendor: "ollama", model: "qwen3:4b-instruct" }, customUrl: null };
  const { keys, service } = setup({ stored: "gemini-key", verdicts: { null: ollamaDown } });
  await keys.loadAtStartup();
  assert.equal(await switched(keys, LOCAL_OLLAMA), true);
  assert.deepEqual(service.calls.at(-1), { useKey: null, allowUnverified: true });
  assert.deepEqual(
    [keys.current.state, keys.current.verified, keys.current.problem],
    ["ready", false, "Ollama isn't running"],
  );
  await keys.reverify();
  assert.equal(keys.current.verified, false, "still down: stays unverified");
  down = false;
  await keys.reverify();
  assert.deepEqual([keys.current.state, keys.current.verified, keys.current.problem], ["ready", true, null]);
});
