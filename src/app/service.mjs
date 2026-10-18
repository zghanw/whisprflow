// The built-in dictation service: the server from ../server running inside the main process, so users don't need a separate terminal.
// The page still talks to it over WebSocket, and the server can still start on its own (debugging, replaying recordings, evaluating prompts).
// Which recognition path and models are used is set by the "route" (../server/modes.mjs), switched the moment settings change.
// The local path's model is loaded and unloaded here: a downloaded model goes into the transcriber process, and is unloaded on a model change or the native path.
// Downloads aren't handled here: the user decides (models/library.mjs); an undownloaded model stays missing, with a clear hint where to get it.
import { LocalizedError, msg, problemOf } from "../i18n/index.mjs";
import { findModel } from "../models/catalog.mjs";
import { startTranscriber } from "../server/asr/start.mjs";
import { createModeRefiner, describeRoute, keyVendorOf, usesLocalModel } from "../server/modes.mjs";
import { startServer, WS_PATH } from "../server/server.mjs";

/**
 * Starts the built-in service. The system assigns the port, so it never collides with other programs (or a separately started server).
 * Without a key the service still listens, and every cleanup fails with the reason; the page's address never changes, so an entered key works at once.
 *
 * @param {object} options
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {object} options.route the starting route (mode and settings, routeOf in storage/settings.mjs)
 * @param {string} [options.modelsDir] where on-device models live (modelsDir in storage/paths.mjs)
 * @param {{ isInstalled(id: string): boolean, status(id: string): { download: object | null } }} [options.models]
 *   the on-device model library (models/library.mjs): which are downloaded and how far downloads are. Call modelsChanged when it changes
 * @param {(record: object) => void} [options.onModelCall] billing: every model call that got a reply (dictations and key checks),
 *   see ../server/refine/meter.mjs
 * @param {() => void} [options.onLocalModel] the local model's state changed (missing, loading, ready, failed)
 * @param {"auto" | "cpu"} [options.acceleration] whether the local model uses the GPU (the acceleration setting); call setAcceleration on change
 * @param {{ terms(): string[], learn(terms: string[]): string[] } | null} [options.dictionary] the user's dictionary (storage/dictionary.mjs):
 *   preferred spellings for cleanup, learned into after on-device cleanup
 * @param {typeof createModeRefiner} [options.createRefiner] a fake in tests
 * @param {typeof startTranscriber} [options.startLocal] a fake in tests
 */
export async function startService({
  log,
  route: initialRoute,
  modelsDir,
  models,
  onModelCall,
  onLocalModel = () => {},
  acceleration: initialAcceleration = "auto",
  dictionary = null,
  createRefiner = createModeRefiner,
  startLocal = startTranscriber,
}) {
  /** The route in use. A new one switches at once (setRoute), and the key manager installs the key it needs later (useKey) */
  let route = initialRoute;
  /** The other vendor in the route (the cloud step one) when its key is missing (missing from forgetKey): dictation names it rather than the main vendor */
  let missing = null;
  const noKey = () =>
    new LocalizedError(
      missing
        ? msg("key.noKeyServiceFor", { provider: missing.name, id: missing.id })
        : msg("key.noKeyService", { provider: keyVendorOf(route).name }),
    );
  /** The verified refiner in use; null without a key */
  let refiner = null;
  /** How many times the route changed (setRoute): a key verified across a change was checked for the old route and isn't installed */
  let switches = 0;

  // ---------- Local model ----------

  /**
   * The state of the model the local path needs:
   *   off (not on the local path) / missing (not downloaded) / loading / ready / failed (problem is why)
   */
  let local = { state: "off" };
  let acceleration = initialAcceleration;
  /** The load in progress or done: transcriber unloads it on a model change; ready is the load's Promise, awaited by checks */
  let loading = null;

  function setLocal(next) {
    local = next;
    onLocalModel();
  }

  /** Keeps the local model in step with the route: another model is swapped in, no local path unloads it; undownloaded stays missing; a failed load is retried */
  function followRoute() {
    // A cloud step one has no local model to load
    const wanted = usesLocalModel(route) ? route.transcriber : null;
    if (wanted && !models.isInstalled(wanted)) {
      releaseLocal();
      if (local.state !== "missing" || local.model !== wanted) setLocal({ state: "missing", model: wanted });
      return;
    }
    if (loading?.model === wanted && local.state !== "failed") return;
    releaseLocal();
    if (wanted) loadLocal(wanted);
  }

  function loadLocal(model) {
    const job = { model, transcriber: null, ready: null };
    loading = job;
    setLocal({ state: "loading", model });
    job.ready = startLocal({ modelId: model, modelsDir, log, acceleration });
    job.ready.then(
      (transcriber) => {
        if (loading !== job) {
          // The user changed models while this one was loading
          transcriber.dispose();
          return;
        }
        job.transcriber = transcriber;
        setLocal({ state: "ready", model, backend: transcriber.backend });
      },
      (error) => {
        if (loading !== job) return;
        log.error("local_model_failed", { model, error: String(error?.stack ?? error) });
        setLocal({ state: "failed", model, problem: msg("local.modelFailed", { reason: problemOf(error) }) });
      },
    );
  }

  function releaseLocal() {
    if (!loading) return;
    loading.transcriber?.dispose();
    loading = null;
    setLocal({ state: "off" });
  }

  /** The local model state for outsiders: with progress when not downloaded but being downloaded */
  function localView() {
    if (local.state !== "missing") return local;
    const download = models.status(local.model).download;
    return download ? { ...local, received: download.received, total: download.total } : local;
  }

  /** The transcriber handed to the local path: if the model isn't loaded yet it says why, instead of leaving the dictation waiting */
  const transcriber = {
    transcribe(samples) {
      if (loading?.transcriber) return loading.transcriber.transcribe(samples);
      const view = localView();
      if (view.state === "missing" && view.total) {
        const percent = Math.floor((view.received / view.total) * 100);
        throw new LocalizedError(msg("local.modelDownloading", { percent }));
      }
      if (view.state === "missing") {
        throw new LocalizedError(msg("local.modelMissing", { model: findModel(view.model).name, id: view.model }));
      }
      if (view.state === "failed") throw new LocalizedError(view.problem);
      throw new LocalizedError(msg("local.modelLoading"));
    },
  };

  const build = (nextRoute, apiKey, keys) =>
    createRefiner({ route: nextRoute, apiKey, keys, transcriber, log, onCall: onModelCall, dictionary });

  followRoute();

  const server = await startServer({
    port: 0,
    log,
    refiner: {
      async refine(audio, options) {
        if (!refiner) throw noKey();
        return refiner.refine(audio, options);
      },
      /** Preparation when speech starts (Gemini builds a prompt cache). Nothing to prepare without a key */
      async prepare() {
        await refiner?.prepare?.();
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}${WS_PATH}`,

    get ready() {
      return refiner !== null;
    },

    /** The route in use */
    get route() {
      return route;
    },

    /** The local model state, see local above (with received and total while downloading) */
    get localModel() {
      return localView();
    },

    /** The model library changed (downloaded, deleted, download progress): load the needed model as soon as it's downloaded */
    modelsChanged() {
      followRoute();
      if (local.state === "missing") onLocalModel();
    },

    /** Changes acceleration: a loaded (or loading) local model is reloaded with the new setting */
    setAcceleration(value) {
      if (value === acceleration) return;
      acceleration = value;
      if (!loading) return;
      releaseLocal();
      followRoute();
    },

    /**
     * Gives the route in use a new key. A smallest request goes first: an invalid key, a wrong model name, or an unreachable vendor throws here (all classified
     * ModelErrors), and the working key stays in use. The request doubles as a warm-up, so the next dictation isn't slow.
     * The local path verifies the cleanup vendor: the local model is prepared in the background, not awaited.
     * If the route changed during verification (setRoute switches at once, unqueued), this refiner was built for the old route: it isn't installed, stale comes back, and the key manager discards it
     *
     * @param {string | null} apiKey the route's main vendor key (keyVendorOf in server/modes.mjs); null when the route needs no key (private mode)
     * @param {{ allowUnverified?: boolean, keys?: Record<string, string> }} [options]
     *   allowUnverified: enable it anyway when the vendor is only temporarily unreachable. Used at startup and after route changes with a stored key: it was verified when saved,
     *   and shouldn't be judged unusable because the network was down at boot or the vendor briefly answered 503.
     *   keys: the other vendor's key when the route needs two (cloud step one, cleanup by another vendor), by vendor id
     * @returns {Promise<{ verified: boolean, problem?: object | string, stale?: true }>} verified false means in use but not yet verified,
     *   and problem says why (the vendor was unreachable)
     */
    async useKey(apiKey, { allowUnverified = false, keys } = {}) {
      const at = switches;
      const candidate = await build(route, apiKey, keys);
      let verified = true;
      let problem;
      try {
        await candidate.warmUp();
      } catch (error) {
        if (!allowUnverified || error.kind !== "unavailable") throw error;
        verified = false;
        problem = error.problem;
      }
      if (switches !== at) return { verified, stale: true };
      refiner = candidate;
      missing = null;
      return verified ? { verified } : { verified, problem };
    },

    /**
     * Switches routes without verifying: mode and model changes come here first and take effect at once. The refiner in hand was built for the old route and is dropped;
     * the key manager finds and installs the new route's key (useKey), and until then dictation says what's missing, as at startup.
     * The local model follows the new route: undownloaded stays missing, and loads once downloaded
     * @param {object} nextRoute
     */
    setRoute(nextRoute) {
      switches += 1;
      refiner = null;
      missing = null;
      log.info("route_switched", { from: describeRoute(route), to: describeRoute(nextRoute) });
      route = nextRoute;
      followRoute();
    },

    /**
     * Changes only local mode's step-one model (choosing a failed one again retries). Cleanup and the key stay, with no re-verification:
     * the transcriber is looked up by name (transcriber above), the loaded refiner keeps working, and the new model loads in the background; undownloaded stays missing
     * @param {string} model the on-device model id (models/catalog.mjs), validated by the caller
     */
    switchTranscriber(model) {
      if (route.mode !== "local" && route.mode !== "private") {
        throw new Error(`In ${route.mode} mode; only local and private mode have an on-device model to change`);
      }
      // Switching to or from a cloud step one changes what comes before cleanup: the refiner is rebuilt and keys looked up again, so the whole route switches (setRoute)
      if (!usesLocalModel(route) || !usesLocalModel({ ...route, transcriber: model })) {
        throw new Error(
          `Step one ${route.transcriber} to ${model} involves a cloud model; switch the whole route (setRoute)`,
        );
      }
      // The same one and working: nothing to do. A failed one goes on and loads again
      if (model === route.transcriber && local.state !== "failed") return;
      log.info("transcriber_switched", { from: route.transcriber, to: model, retry: model === route.transcriber });
      route = { ...route, transcriber: model };
      followRoute();
    },

    /**
     * Checks an on-device model: transcribes a sample once to see whether it produces text. The one in use (loaded or loading) is used directly;
     * another is loaded temporarily and unloaded afterwards, leaving the one in use alone. It must be downloaded; the caller checks (modes.mjs)
     * @param {string} model the on-device model id
     * @param {Float32Array} samples 16 kHz mono (the sentence asr/probe.mjs speaks)
     * @returns {Promise<{ text: string, transcribeMs: number, loadMs: number | null, backend: string }>}
     *   loadMs: how long the temporary load took; null when the loaded one was used
     */
    async checkTranscriber(model, samples) {
      let transcriber;
      let loadMs = null;
      if (loading?.model === model) {
        transcriber = loading.transcriber ?? (await loading.ready);
      } else {
        const startedAt = performance.now();
        transcriber = await startLocal({ modelId: model, modelsDir, log });
        loadMs = Math.round(performance.now() - startedAt);
      }
      try {
        const startedAt = performance.now();
        const { text } = await transcriber.transcribe(samples);
        const transcribeMs = Math.round(performance.now() - startedAt);
        // Log only length and timing: the text is the spoken check sentence, not the user's speech, but it needn't be in the log
        log.info("transcriber_checked", {
          model,
          backend: transcriber.backend,
          load_ms: loadMs,
          transcribe_ms: transcribeMs,
          text_length: text.length,
        });
        return { text, transcribeMs, loadMs, backend: transcriber.backend };
      } finally {
        if (loadMs !== null) transcriber.dispose();
      }
    },

    /** Verifies the key in use again and throws if it fails. Fills in verification for a key enabled while offline at startup */
    async verify() {
      if (!refiner) throw noKey();
      await refiner.warmUp();
    },

    /**
     * Tries a key on a route without replacing the one in use: used to verify before saving another vendor's key, and by whisprflow model check.
     * @param {{ route: object, apiKey: string, keys?: Record<string, string> }} options keys as in useKey
     */
    async probe({ route: tried, apiKey, keys }) {
      await (await build(tried, apiKey, keys)).warmUp();
    },

    /**
     * Stops using the key in hand (deleted, failed). When the missing one is the route's other vendor, missing ({ id, name }) is given so dictation names it
     * @param {{ missing?: { id: string, name: string } }} [options]
     */
    forgetKey({ missing: vendor = null } = {}) {
      refiner = null;
      missing = vendor;
    },

    async close() {
      releaseLocal();
      await server.close();
    },
  };
}
