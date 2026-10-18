import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { msg, problemOf } from "../i18n/index.mjs";
import { downloadSize, findModel, MODELS } from "./catalog.mjs";
import { sizeText } from "./describe.mjs";
import { createModelStore } from "./store.mjs";

// The on-device model library: for each model in the catalog (models/catalog.mjs), whether it is downloaded, downloading and how far, and why the last try failed;
// downloads, cancels, and deletes are all started by the user (the "Models" page in settings, whisprflow transcriber); nothing downloads on its own.
// Disk space is checked before a download. Several models can download at once, each on its own.
// Independent of the recognition mode: any mode can download and delete. The rule that the model in use can't be deleted lives in the mode layer (removeModel in app/modes.mjs).
// Both the app and the CLI (when the background service isn't running) use it.

/** Download progress is reported at most this often, so it doesn't flood */
const PROGRESS_EVERY_MS = 500;
/** Disk space to leave free after a download: a full disk breaks the system and other programs */
const DISK_HEADROOM = 200_000_000;

/** Free bytes on the disk holding the model directory. If the directory doesn't exist yet, its nearest parent is checked */
export function freeBytesAt(dir) {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const { bavail, bsize } = statfsSync(at);
  return bavail * bsize;
}

/**
 * @param {object} options
 * @param {string} options.dir where models live (modelsDir in storage/paths.mjs)
 * @param {string} options.source which download source to try first (modelSource in settings, SOURCES in models/catalog.mjs)
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {(id: string) => void} [options.onChange] a model's state changed (started, progress, done, failed, cancelled, deleted)
 * @param {typeof createModelStore} [options.createStore] replaced by a fake in tests
 * @param {(dir: string) => number} [options.freeBytes] replaced by a fake in tests
 */
export function createLocalModels({
  dir,
  source: initialSource,
  log,
  onChange = () => {},
  createStore = (options) => createModelStore(options),
  freeBytes = freeBytesAt,
}) {
  let source = initialSource;
  let store = createStore({ dir, source });
  /** Downloads in progress: id to { abort, received, total } */
  const downloads = new Map();
  /** Why the last download failed (msg): id to problem. Cleared on retry or delete */
  const problems = new Map();

  const modelOf = (id) => {
    const model = findModel(id);
    if (!model) throw new Error(`No model ${id} in the catalog`);
    return model;
  };

  /** A model's current state. partial: bytes already on disk when not fully downloaded (a half-finished download) */
  function status(id) {
    const model = modelOf(id);
    const installed = store.isInstalled(model);
    const job = downloads.get(id);
    return {
      id,
      installed,
      download: job ? { received: job.received, total: job.total } : null,
      partial: installed ? 0 : downloadSize(model) - store.missingBytes(model),
      problem: problems.get(id) ?? null,
    };
  }

  function start(model) {
    const job = { abort: new AbortController(), received: 0, total: downloadSize(model) };
    downloads.set(model.id, job);
    problems.delete(model.id);
    let reportedAt = Number.NEGATIVE_INFINITY;
    const startedAt = performance.now();
    log.info("model_downloading", { model: model.id, bytes: job.total, source });
    onChange(model.id);
    store
      .install(model, {
        signal: job.abort.signal,
        onProgress: ({ received }) => {
          job.received = received;
          const now = performance.now();
          if (now - reportedAt < PROGRESS_EVERY_MS) return;
          reportedAt = now;
          onChange(model.id);
        },
      })
      .then(
        () => {
          if (downloads.get(model.id) !== job) return;
          downloads.delete(model.id);
          log.info("model_downloaded", { model: model.id, ms: Math.round(performance.now() - startedAt), source });
          onChange(model.id);
        },
        (error) => {
          // Stopped downloads (cancel, delete, source change) were already handled by stop
          if (downloads.get(model.id) !== job) return;
          downloads.delete(model.id);
          log.error("model_download_failed", { model: model.id, source, error: String(error?.stack ?? error) });
          problems.set(model.id, msg("localModels.downloadFailed", { model: model.name, reason: problemOf(error) }));
          onChange(model.id);
        },
      );
  }

  /** Stops a download without counting it as failed; reason is why (cancelled: user cancel, delete, quit; restart: source changed, continue from the new one) */
  function stop(id, reason) {
    const job = downloads.get(id);
    if (!job) return false;
    downloads.delete(id);
    job.abort.abort(new Error(reason));
    log.info("model_download_stopped", { model: id, reason, received: job.received, total: job.total });
    return true;
  }

  return {
    dir,

    /** Every catalog model's current state, in catalog order */
    list: () => MODELS.map(({ id }) => status(id)),

    status,

    isInstalled: (id) => store.isInstalled(modelOf(id)),

    /**
     * Starts downloading a model (in the background, without waiting). Does nothing if it is already downloaded or downloading.
     * Checks the disk first: if the free space can't hold what is missing (plus headroom), it doesn't start
     * @returns {Promise<{ ok: true } | { ok: false, problem: object }>}
     */
    async download(id) {
      const model = findModel(id);
      if (!model) return { ok: false, problem: msg("localModels.unknown", { id }) };
      if (store.isInstalled(model) || downloads.has(id)) return { ok: true };
      const need = store.missingBytes(model);
      let free;
      try {
        free = freeBytes(dir);
      } catch (error) {
        // If the check itself fails, don't block: a failed write during download is reported anyway
        log.warn("disk_space_unknown", { dir, error: String(error) });
        free = Number.POSITIVE_INFINITY;
      }
      if (free < need + DISK_HEADROOM) {
        log.warn("model_download_no_space", { model: id, need, free });
        return {
          ok: false,
          problem: msg("localModels.noSpace", { model: model.name, need: sizeText(need), free: sizeText(free) }),
        };
      }
      start(model);
      return { ok: true };
    },

    /** Cancels a download without counting it as failed. Finished, verified files are kept; the half-done one is not (store.mjs doesn't resume), so it restarts next time */
    cancel(id) {
      if (stop(id, "cancelled")) onChange(id);
    },

    /**
     * Deletes a model (including a half-finished one). A download in progress is stopped first. Whether the model in use may be deleted is the mode layer's call
     * @returns {{ ok: true }}
     */
    remove(id) {
      const model = modelOf(id);
      stop(id, "cancelled");
      store.remove(model);
      problems.delete(id);
      log.info("model_removed", { model: id });
      onChange(id);
      return { ok: true };
    },

    /** Changes the download source: future downloads use it; current ones stop and continue from the new source (finished files aren't downloaded again) */
    setSource(next) {
      if (next === source) return;
      log.info("model_source_changed", { from: source, to: next, downloading: [...downloads.keys()] });
      source = next;
      store = createStore({ dir, source });
      for (const id of [...downloads.keys()]) {
        stop(id, "restart");
        start(modelOf(id));
      }
    },

    /** Stops every download on quit */
    close() {
      for (const id of [...downloads.keys()]) stop(id, "cancelled");
    },
  };
}
