import { findModel } from "../../models/catalog.mjs";
import { createModelStore } from "../../models/store.mjs";
import { findEngine } from "./engines/index.mjs";
import { spawnTranscriber } from "./host.mjs";

// Loads a downloaded on-device model into the transcriber process. Downloading is not done here: the user decides whether and when (models/library.mjs);
// switching to local mode must never quietly download hundreds of megabytes.
//
// The GPU follows the acceleration setting: auto uses a GPU when there is one, and if loading on it fails (a runtime error, or the driver crashes the transcriber process)
// it loads again on the CPU, since GPUs and drivers vary too much to count on every one; cpu uses only the CPU from the start.

/**
 * @param {object} options
 * @param {string} options.modelId the catalog id (models/catalog.mjs)
 * @param {string} options.modelsDir where models live (modelsDir in storage/paths.mjs)
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {object} [options.options] other runtime parameters (threads, ...); GPU use is decided by acceleration
 * @param {"auto" | "cpu"} [options.acceleration] the acceleration setting
 * @returns {Promise<Awaited<ReturnType<typeof spawnTranscriber>>>}
 */
export async function startTranscriber({
  modelId,
  modelsDir,
  log,
  options = {},
  acceleration = "auto",
  store = createModelStore({ dir: modelsDir }),
  spawn = spawnTranscriber,
}) {
  const model = findModel(modelId);
  if (!model) throw new Error(`No model ${modelId} in the catalog`);
  if (!store.isInstalled(model)) throw new Error(`${model.id} is not downloaded yet`);
  const dir = store.dirOf(model);
  const on = (backend) => spawn({ model, dir, options: { ...options, backend }, log });
  if (acceleration === "cpu" || !findEngine(model.engine)?.gpu) return on(acceleration === "cpu" ? "cpu" : "auto");
  try {
    return await on("auto");
  } catch (error) {
    log.warn("transcriber_gpu_failed", { model: model.id, error: String(error?.message ?? error) });
    return on("cpu");
  }
}
