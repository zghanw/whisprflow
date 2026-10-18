import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { keyVendorOf, keyVendorsOf } from "../../server/modes.mjs";
import { toModelError } from "../../server/providers/errors.mjs";
import { apiKeyProblem, DEFAULT_THINKING_LEVEL, findProvider } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";

const MISSING = { state: "missing", source: null, problem: null };

/**
 * Every model vendor has its own key. Which vendor this run uses (provider) follows the route in use: the audio vendor in native mode,
 * the cleanup vendor in local mode (keyVendorOf in server/modes.mjs). That key's state,
 * where to find it at startup, how to replace it, and how to delete it all go through here; other vendors' keys are saved, deleted, and checked here too, without affecting the one in use.
 * Route changes (mode or model changes) also go through switchRoute here: the route switches at once without waiting for verification, the new route's key is found and installed as at startup,
 * and missing, unreadable, or failed keys are recorded honestly in the state. Which route to take is the user's call; whether it works is state, and the two stay apart.
 * Private mode and Ollama cleanup need no key: then provider is null, the state is ready with source none, and saving a key must name the vendor.
 * A route may need keys from two vendors (cloud step one, cleanup by another; keyVendorsOf in server/modes.mjs): provider is the main one,
 * and the other's key is found on every route change and verification ("environment first, then stored") and handed to the service with it; without it the whole route can't work,
 * and vendor in the state names the missing one.
 *
 * Fields of the state (current, about the vendor in use only):
 *   state     missing / unreadable (stored but can't be decrypted) / checking / rejected / ready
 *   source    env (an environment variable such as GEMINI_API_KEY) / stored (saved encrypted) / external (the key lives with a separately started server) /
 *             none (the route needs no key)
 *   problem   one sentence of reason for the user: a message not yet in a language (msg), or a model's own words as text; whoever displays it translates
 *   cause     only when rejected: key (this key is wrong) / other (the vendor rejected the request, usually a wrong model name or thinking level)
 *   verified  only when ready: false means the vendor was unreachable at startup (offline, or briefly unavailable), so the key is in use but not yet verified
 *   vendor    only when the missing, unreadable, or failed key belongs to the route's other vendor (not provider): { id, name }.
 *             Once that vendor's key is saved, the whole route is verified again (settle)
 *
 * @param {object} options
 * @param {{ useKey: Function, setRoute: Function, verify: Function, forgetKey: Function, probe: Function } | null} options.service
 *   the built-in dictation service; null when connected to a separately started server, which manages keys itself
 * @param {{ id: string, name: string, keyEnv: string } | null} options.provider the starting vendor (server/vendors.mjs);
 *   null when the starting route needs no key. It follows route changes (switchRoute); save, delete, and check without a vendor mean the one in use
 * @param {(id: string) => object} [options.routeFor] which route verifies a key being saved for a vendor not in use.
 *   Defaults to that (audio) vendor's default model in native mode
 * @param {Record<string, { load(): string | null, save(key: string): void, clear(): void }>} options.keyStores
 *   one per vendor, by id
 * @param {Record<string, string | undefined>} options.env
 * @param {{ info: Function, error: Function }} options.log
 * @param {() => void} options.onChange called on every state change
 */
export function createKeyManager({
  service,
  provider: initialProvider,
  keyStores,
  env,
  log,
  onChange,
  routeFor = nativeRouteFor,
}) {
  /** The vendor in use; null when the route needs no key */
  let provider = initialProvider ?? null;
  let current = MISSING;
  /** The key this run actually uses for the vendor in use (checks use the same one); null when none */
  let inUse = null;
  /** When the last queued task finishes. Only for queueing, carries no result or error */
  let queue = Promise.resolve();
  let reverifying = false;
  /**
   * How many times the route changed. Route changes happen at once, unqueued (switchRoute): a key queued before one, or being verified, was found for the old route,
   * so it is compared when its turn comes and when verification ends; if the route changed it is discarded, touching neither state nor service (stale)
   */
  let routeVersion = 0;
  const stale = () => ({ cause: "stale", problem: msg("key.routeChanged") });

  /**
   * Replacing and deleting keys go one at a time. Verifying a key waits on the vendor, and another task arriving meanwhile queues behind it:
   * otherwise an earlier task finishing later would override a later one (deleting during verification, then verification enabling it again).
   */
  function enqueue(task) {
    const result = queue.then(task);
    // A failing task is handled by its own caller and doesn't hold up the ones behind it
    queue = result.catch(() => {});
    return result;
  }

  function become(next) {
    current = next;
    onChange();
    return current;
  }

  /**
   * An error from the service. Ones the model layer didn't classify (usually bugs) are still described, with the key scrubbed first.
   * When the route needs two vendors' keys, the error may come from the other (the cloud step one): vendor names it, and the reason starts with it,
   * so the user doesn't think the key being verified is wrong and keep re-entering it
   * @returns {{ cause: string, problem: object | string, detail: string, vendor: { id: string, name: string } | null }}
   */
  const described = (error, apiKey, who = provider, route = service?.route) => {
    const modelError = toModelError(error, { provider: who, apiKey });
    const other =
      modelError.provider && modelError.provider !== who?.id && route
        ? keyVendorsOf(route).find(({ id }) => id === modelError.provider)
        : null;
    const vendor = other ? { id: other.id, name: other.name } : null;
    const problem = vendor
      ? msg("key.failedFor", { provider: vendor.name, reason: modelError.problem })
      : modelError.problem;
    return { cause: modelError.kind, problem, detail: modelError.detail, vendor };
  };

  function reject(source, cause, problem, detail, vendor = null) {
    // detail is the error text with the key scrubbed
    log.error("key_rejected", { provider: vendor?.id ?? provider?.id, source, cause, error: detail.slice(0, 300) });
    return become({ state: "rejected", source, problem, cause, ...(vendor ? { vendor } : {}) });
  }

  /** Finds the vendor and its key store by id. Throws when unknown */
  function lookup(id) {
    const found = findVendor(id);
    if (!found || !keyStores[found.id]) throw new LocalizedError(msg("key.unknownProvider", { id }));
    return { found, store: keyStores[found.id] };
  }

  /**
   * Keys of the route's vendors besides primary ({ vendor id: key }). When one is missing, unreadable, or malformed, failure says which and why.
   * Without a service (connected to a separately started server) there is no route and nothing is needed
   * @returns {{ keys: Record<string, string>, failure: null | { vendor: object, state: string, cause: string, problem: object } }}
   */
  function othersFor(route, primaryId) {
    const keys = {};
    for (const vendor of route ? keyVendorsOf(route) : []) {
      if (vendor.id === primaryId) continue;
      const { found, store } = lookup(vendor.id);
      const who = { id: found.id, name: found.name };
      let key;
      try {
        key = keyFor(found, store);
      } catch (error) {
        log.error("key_unreadable", { provider: found.id, error: String(error?.message ?? error) });
        const problem = msg("key.unreadableFor", { provider: found.name });
        return { keys, failure: { vendor: who, state: "unreadable", cause: "unreadable", problem } };
      }
      if (!key) {
        const problem = msg("key.noKeyFor", { provider: msg(`providers.${found.id}.name`) });
        return { keys, failure: { vendor: who, state: "missing", cause: "missing", problem } };
      }
      const shape = apiKeyProblem(key.apiKey);
      if (shape) return { keys, failure: { vendor: who, state: "rejected", cause: "key", problem: shape } };
      keys[found.id] = key.apiKey;
    }
    return { keys, failure: null };
  }

  /**
   * Verifies a key on the route in use and uses it only if it passes. Never throws.
   * @param {{ atStartup: boolean }} options atStartup: a key found at startup or after a route change (stored keys were verified when saved) is enabled anyway
   *   when the vendor is merely unreachable, and a failure means unusable; a newly entered key that fails leaves the previous key in use and the previous state
   * @returns {Promise<null | { cause: string, problem: object | string }>} null when it passes, otherwise why
   */
  function adopt(apiKey, source, { atStartup }) {
    const version = routeVersion;
    return enqueue(async () => {
      if (version !== routeVersion) return stale();
      // Record the "previous state" only once it's this task's turn: a key queued ahead may have just finished
      const previous = current;
      // Gather the route's other vendor keys first: if one is missing, there's no point verifying the main key
      const others = othersFor(service.route, provider.id);
      if (others.failure) {
        const { vendor, state, cause, problem } = others.failure;
        log.error("key_rejected", {
          provider: vendor.id,
          source: null,
          cause,
          error: "another vendor the route needs has no usable key",
        });
        if (atStartup) {
          // Dictation names the missing vendor
          service.forgetKey({ missing: vendor });
          become({ state, source: null, problem, vendor, ...(state === "rejected" ? { cause } : {}) });
        }
        return { cause, problem };
      }
      become({ state: "checking", source, problem: null });
      try {
        const { verified, stale: outdated } = await service.useKey(apiKey, {
          allowUnverified: atStartup,
          ...(Object.keys(others.keys).length > 0 ? { keys: others.keys } : {}),
        });
        if (outdated || version !== routeVersion) return stale();
        inUse = { apiKey, source };
        log.info("key_ready", { provider: provider.id, source, verified });
        become({ state: "ready", source, problem: null, verified });
        return null;
      } catch (error) {
        if (version !== routeVersion) return stale();
        const { cause, problem, detail, vendor } = described(error, apiKey);
        if (atStartup) reject(source, cause, problem, detail, vendor);
        else {
          log.error("key_rejected", {
            provider: vendor?.id ?? provider.id,
            source,
            cause,
            error: detail.slice(0, 300),
          });
          become(previous);
        }
        return { cause, problem };
      }
    });
  }

  /**
   * The route in use needs no key: ready once installed. An undownloaded on-device model is the service's state (localModel), not a key matter.
   * Cleanup on this computer (Ollama) that isn't running, or lacks its model, still installs: dictation pastes what was heard with a notice,
   * and the state carries verified false with the reason until a later check passes (reverify)
   */
  function adoptKeyless() {
    const version = routeVersion;
    return enqueue(async () => {
      if (version !== routeVersion) return;
      let installed;
      try {
        installed = await service.useKey(null, { allowUnverified: true });
        if (installed.stale || version !== routeVersion) return;
      } catch (error) {
        if (version !== routeVersion) return;
        // A keyless route that can't be installed is most likely a bug: say so honestly
        const { cause, problem, detail } = described(error, null, { id: null, name: "WhisprFlow" });
        log.error("route_failed", { route: service.route.mode, cause, error: detail.slice(0, 300) });
        become({ state: "rejected", source: "none", problem, cause });
        return;
      }
      inUse = null;
      const { verified, problem = null } = installed;
      log.info("key_ready", { provider: null, source: "none", verified });
      become({ state: "ready", source: "none", problem, ...(verified ? {} : { verified }) });
    });
  }

  /**
   * Finds and installs the key for the route in use, at startup and after route changes. A key already in hand this run for this vendor is used; otherwise the environment first, then stored;
   * none means missing (dictation names the vendor), and unreadable, malformed, or failed keys are recorded; merely unreachable keys are used anyway
   * @returns {Promise<object>} the state
   */
  async function resolveKey() {
    if (service.route && keyVendorsOf(service.route).length === 0) {
      await adoptKeyless();
      return current;
    }
    let found;
    try {
      found = inUse ?? keyFor(provider, keyStores[provider.id]);
    } catch (error) {
      // A changed signature or a lost keychain key both cause this; the only fix is entering it again
      log.error("key_unreadable", { provider: provider.id, error: String(error?.message ?? error) });
      return become({ state: "unreadable", source: "stored", problem: msg("key.unreadable") });
    }
    if (!found) return current.state === "missing" && !current.vendor ? current : become(MISSING);
    const { apiKey, source } = found;
    const shape = apiKeyProblem(apiKey);
    if (shape) return reject(source, "key", shape, "malformed, not sent for verification");
    await adopt(apiKey, source, { atStartup: true });
    return current;
  }

  /** Saves a key for a vendor not in use: verified once on the given route (routeFor's when none), saved if it passes. Leaves the one in use alone */
  function saveForOther(found, store, apiKey, route) {
    return enqueue(async () => {
      // routeFor can throw too (the custom service has no address yet, say): its reason is given as is
      let tried = null;
      try {
        tried = route ?? routeFor(found.id);
        await service.probe({ route: tried, apiKey });
      } catch (error) {
        const { cause, problem, detail } = described(error, apiKey, found, tried ?? undefined);
        log.error("key_rejected", { provider: found.id, source: "stored", cause, error: detail.slice(0, 300) });
        return { ok: false, problem };
      }
      return storeKey(store, apiKey);
    });
  }

  function storeKey(store, apiKey) {
    try {
      store.save(apiKey);
    } catch (error) {
      // Verified but not saveable: if in use it still works this run, but must be entered again next launch; tell the user honestly
      log.error("key_save_failed", { error: String(error?.message ?? error) });
      return { ok: false, problem: msg("key.notSaved", { reason: problemOf(error) }) };
    }
    return { ok: true };
  }

  /**
   * Verifies the route in use again and records the result: used right after the route's other vendor key is saved (it was missing, or failed before).
   * The vendor in use keeps the key in hand this run; without one, the environment and stored keys are searched
   */
  async function settle() {
    if (!provider) return current;
    let found;
    try {
      found = inUse ?? keyFor(provider, keyStores[provider.id]);
    } catch (error) {
      log.error("key_unreadable", { provider: provider.id, error: String(error?.message ?? error) });
      service.forgetKey();
      return become({ state: "unreadable", source: "stored", problem: msg("key.unreadable") });
    }
    if (!found) {
      service.forgetKey();
      return become(MISSING);
    }
    await adopt(found.apiKey, found.source, { atStartup: true });
    return current;
  }

  /** Which key a vendor should use this run: the environment first (for a key given temporarily from a terminal), then stored. Throws when unreadable */
  function keyFor(found, store) {
    const fromEnv = env[found.keyEnv]?.trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env" };
    const stored = store.load();
    return stored ? { apiKey: stored, source: "stored" } : null;
  }

  /** A newly entered key: trimmed; empty or malformed ones are refused with the reason (never sent to the service) */
  function typed(value) {
    if (typeof value !== "string" || value.trim() === "") return { problem: msg("key.empty") };
    const apiKey = value.trim();
    const shape = apiKeyProblem(apiKey);
    return shape ? { problem: shape } : { apiKey };
  }

  const manager = {
    get current() {
      return current;
    },

    /** The vendor in use */
    get provider() {
      return provider;
    },

    /**
     * Finds a key for the vendor in use at startup.
     * Merely unreachable vendors still get the key enabled: a stored key was verified when saved, so being offline at boot shouldn't make the user re-enter it.
     */
    async loadAtStartup() {
      if (!service) return become({ state: "ready", source: "external", problem: null });
      return resolveKey();
    },

    /**
     * Verifies and saves a new key. On failure the reason is in the return value and the previous state stays.
     * @param {unknown} value
     * @param {{ provider?: string, route?: object }} [options] provider: which vendor it's for, the one in use by default.
     *   route: which route verifies another vendor's key, routeFor's by default (for saving a vendor's key before switching to one of its models)
     * @returns {Promise<{ ok: true } | { ok: false, problem: object | string }>}
     */
    async save(value, { provider: id = provider?.id, route } = {}) {
      if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: msg("key.empty") };
      if (!service) return { ok: false, problem: msg("key.external") };
      // The route needs no key: there's no "vendor in use" to default to
      if (id === undefined) return { ok: false, problem: msg("key.whichVendor") };
      let target;
      try {
        target = lookup(id);
      } catch (error) {
        return { ok: false, problem: problemOf(error) };
      }
      const { apiKey, problem } = typed(value);
      if (problem) return { ok: false, problem };

      if (target.found.id !== provider?.id) {
        const saved = await saveForOther(target.found, target.store, apiKey, route);
        // The route in use is stuck on this vendor (step one goes to it, and its key was missing or failed): once saved, verify the whole route again
        if (saved.ok && current.vendor?.id === target.found.id) await settle();
        return saved;
      }
      const failure = await adopt(apiKey, "stored", { atStartup: false });
      if (failure) return { ok: false, problem: failure.problem };
      return storeKey(target.store, apiKey);
    },

    /**
     * Switches routes (mode and model changes both come here): at once, without verifying or blocking, and not queued behind keys being verified.
     * The new route's vendor becomes the one in use, and its key is found and installed as at startup (resolveKey), with presence and verification recorded in the state
     * and reported honestly while dictating; keys queued or being verified for the old route are discarded (routeVersion).
     * Callers build the route for their own layer (app/modes.mjs) and update settings themselves: this only decides which route and key this run uses
     * @param {object} route
     * @returns {{ ok: true, settled: Promise<object> } | { ok: false, problem: object }}
     *   already switched on return; settled is when the key lookup and check reach a verdict (state). Only a separately started server can't switch
     */
    switchRoute(route) {
      if (!service) return { ok: false, problem: msg("key.externalModel") };
      const next = keyVendorOf(route) ?? null;
      if (next?.id !== provider?.id) {
        log.info("provider_switched", { from: provider?.id ?? null, to: next?.id ?? null });
        // Still the same vendor (only its model changed): keep the key in hand this run, a newly saved one if any, never reverting to the environment's
        inUse = null;
      }
      routeVersion += 1;
      service.setRoute(route);
      provider = next;
      // No notification yet: every path below for finding the key lands on a state and notifies then, so the UI doesn't flash "missing key" first
      current = { state: "checking", source: null, problem: null };
      return { ok: true, settled: resolveKey() };
    },

    /** @param {{ provider?: string }} [options] whose key to delete, the one in use by default (required when the route needs no key) */
    forget({ provider: id = provider?.id } = {}) {
      return enqueue(() => {
        if (id === undefined) throw new LocalizedError(msg("key.whichVendor"));
        const { found, store } = lookup(id);
        store.clear();
        log.info("key_forgotten", { provider: found.id });
        if (!service) return;
        if (found.id === provider?.id) {
          service.forgetKey();
          inUse = null;
          become(MISSING);
          return;
        }
        // Deleting the key of the route's other vendor: that step has no key, so the whole route can't work
        const inRoute = service.route && keyVendorsOf(service.route).some(({ id }) => id === found.id);
        if (!inRoute || keyFor(found, store)) return;
        service.forgetKey({ missing: { id: found.id, name: found.name } });
        become({
          state: "missing",
          source: null,
          problem: msg("key.noKeyFor", { provider: msg(`providers.${found.id}.name`) }),
          vendor: { id: found.id, name: found.name },
        });
      });
    },

    /**
     * Whether a route works now: sends the smallest request with the key its vendor needs. Never throws, and doesn't change the one in use.
     * @param {object} route a route as server/modes.mjs describes it
     * @returns {Promise<{ ok: true, source: string, ms: number } | { ok: false, cause: string, problem: object | string }>}
     *   cause: missing (no key for this vendor) / unreadable / key / unavailable / other
     */
    async check(route) {
      if (!service) return { ok: false, cause: "other", problem: msg("key.externalModel") };
      if (keyVendorsOf(route).length === 0) {
        const startedAt = performance.now();
        try {
          await service.probe({ route, apiKey: null });
        } catch (error) {
          const { cause, problem } = described(error, null, { id: null, name: "WhisprFlow" });
          return { ok: false, cause, problem };
        }
        return { ok: true, source: "none", ms: Math.round(performance.now() - startedAt) };
      }
      let target;
      try {
        target = lookup(keyVendorOf(route).id);
      } catch (error) {
        return { ok: false, cause: "other", problem: problemOf(error) };
      }
      const { found, store } = target;
      let key;
      try {
        // The vendor in use: check the key actually in use this run (if a new one was saved, it isn't the environment's anymore)
        key = found.id === provider?.id && inUse ? inUse : keyFor(found, store);
      } catch (error) {
        log.error("key_unreadable", { provider: found.id, error: String(error?.message ?? error) });
        return { ok: false, cause: "unreadable", problem: msg("key.unreadableFor", { provider: found.name }) };
      }
      if (!key) {
        return { ok: false, cause: "missing", problem: msg("key.noKeyForCli", { provider: found.name, id: found.id }) };
      }
      const shape = apiKeyProblem(key.apiKey);
      if (shape) return { ok: false, cause: "key", problem: shape };
      const others = othersFor(route, found.id);
      if (others.failure) {
        const { vendor, cause } = others.failure;
        const problem =
          cause === "missing"
            ? msg("key.noKeyForCli", { provider: vendor.name, id: vendor.id })
            : others.failure.problem;
        return { ok: false, cause, problem };
      }
      const startedAt = performance.now();
      try {
        await service.probe({
          route,
          apiKey: key.apiKey,
          ...(Object.keys(others.keys).length > 0 ? { keys: others.keys } : {}),
        });
      } catch (error) {
        const { cause, problem, detail } = described(error, key.apiKey);
        log.warn("model_check_failed", { provider: found.id, cause, error: detail.slice(0, 300) });
        return { ok: false, cause, problem };
      }
      const ms = Math.round(performance.now() - startedAt);
      log.info("model_checked", { provider: found.id, source: key.source, ms });
      return { ok: true, source: key.source, ms };
    },

    /**
     * Where each vendor's key is: env (environment variable) / stored / null (none). Doesn't decrypt; used by the CLI to list models:
     * the CLI can see the stored files but never decrypts them
     * @returns {Record<string, "env" | "stored" | null>}
     */
    sources() {
      return Object.fromEntries(
        Object.entries(keyStores).map(([id, store]) => {
          const { keyEnv } = findVendor(id);
          return [id, env[keyEnv]?.trim() ? "env" : store.exists() ? "stored" : null];
        }),
      );
    },

    /** Verifies again a key enabled while its vendor was unreachable at startup. Does nothing otherwise */
    async reverify() {
      const checked = current;
      if (reverifying || checked.state !== "ready" || checked.verified !== false) return;
      reverifying = true;
      try {
        await service.verify();
        if (current !== checked) return;
        log.info("key_ready", { provider: provider?.id ?? null, source: checked.source, verified: true });
        become({ ...checked, verified: true, problem: null });
      } catch (error) {
        const keyless = checked.source === "none";
        const { cause, problem, detail, vendor } = keyless
          ? described(error, null, { id: null, name: "WhisprFlow" })
          : described(error);
        // Still unreachable: keep using it, with the latest reason; if the state was changed elsewhere meanwhile (a new key saved, say), stay out of it
        if (current !== checked) return;
        if (cause === "unavailable") {
          if (keyless) become({ ...checked, problem });
          return;
        }
        service.forgetKey(vendor ? { missing: vendor } : {});
        // When the other vendor's key is the wrong one, the key in use is fine and stays: once that vendor's key is saved, settle carries on
        if (!vendor) inUse = null;
        reject(checked.source, cause, problem, detail, vendor);
      } finally {
        reverifying = false;
      }
    },
  };
  return manager;
}

/** When no route is given: that (audio) vendor's default model on the native path */
function nativeRouteFor(id) {
  const provider = findProvider(id);
  if (!provider) throw new LocalizedError(msg("key.unknownProvider", { id }));
  return {
    mode: "native",
    model: { provider: provider.id, model: provider.defaultModel },
    thinkingLevel: provider.thinkingLevels ? DEFAULT_THINKING_LEVEL : null,
  };
}
