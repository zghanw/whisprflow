import { log } from "../log.mjs";
import { findModel } from "../models/catalog.mjs";
import { createModelStore } from "../models/store.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { startTranscriber } from "./asr/start.mjs";
import { loadConfig } from "./config.mjs";
import { createModeRefiner, describeRoute, usesLocalModel } from "./modes.mjs";
import { findProvider } from "./providers/index.mjs";
import { startServer, WS_PATH } from "./server.mjs";

let config;
/** Where on-device models live: only the local path uses them */
let modelsDir = null;
try {
  config = loadConfig(process.env);
  if (usesLocalModel(config.route)) modelsDir = resolvePaths(process.env).modelsDir;
} catch (error) {
  // A config mistake is a usage problem: one plain sentence is enough, no stack trace
  console.error(error.message);
  process.exit(2);
}
const { route, keys } = config;

/** Download progress is logged every 10%, so it doesn't flood */
function progressLogger(modelId) {
  let reported = -1;
  return ({ received, total }) => {
    const percent = Math.floor((received / total) * 10) * 10;
    if (percent === reported) return;
    reported = percent;
    log.info("model_download_progress", { model: modelId, percent });
  };
}

// The local path prepares the model first and loads it into the transcriber process. Starting the server on its own is for development: the user asked for local, so a missing model is downloaded
// (the app doesn't do this; the user decides on downloads)
if (usesLocalModel(route)) {
  const store = createModelStore({ dir: modelsDir, source: config.modelSource });
  const model = findModel(route.transcriber);
  if (!store.isInstalled(model)) {
    log.info("model_downloading", { model: model.id, source: config.modelSource });
    await store.install(model, { onProgress: progressLogger(model.id) });
  }
}
const transcriber = usesLocalModel(route)
  ? await startTranscriber({ modelId: route.transcriber, modelsDir, log })
  : null;
const refiner = await createModeRefiner({ route, keys, transcriber, log });

let server;
try {
  server = await startServer({ host: config.host, port: config.port, refiner, log });
} catch (error) {
  if (error.code !== "EADDRINUSE") throw error;
  // The usual cause is one already running: one plain sentence, no stack trace
  console.error(
    `Port ${config.port} is already in use: the server may already be running. Use PORT to pick another port.`,
  );
  transcriber?.dispose();
  process.exit(1);
}
log.info("listening", {
  url: `ws://${config.host}:${server.port}${WS_PATH}`,
  route: describeRoute(route),
  // Only Gemini uses the thinking level; leave it out for others so nobody reading the log thinks it took effect
  ...(route.mode === "native" && findProvider(route.model.provider).thinkingLevels
    ? { thinking_level: route.thinkingLevel }
    : {}),
  ...(transcriber ? { transcriber_backend: transcriber.backend } : {}),
});

// Not awaited: a failed warm-up shouldn't block startup, but it should be visible
const warmUpStartedAt = performance.now();
refiner.warmUp().then(
  () => log.info("warmed_up", { ms: Math.round(performance.now() - warmUpStartedAt) }),
  (error) => log.error("warm_up_failed", { route: describeRoute(route), error: error.message, detail: error.detail }),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    log.info("shutting_down", { signal });
    transcriber?.dispose();
    await server.close();
    process.exit(0);
  });
}
