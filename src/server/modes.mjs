import { LocalizedError, msg } from "../i18n/index.mjs";
import { createCloudTranscriber } from "./asr/cloud/transcriber.mjs";
import { cloudTranscriberOf, findCloudTranscriber } from "./asr/cloud/vendors.mjs";
import { findChatVendor, formatChatChoice } from "./chat/vendors.mjs";
import { findProvider, formatModelChoice } from "./providers/index.mjs";
import { createLocalRefiner } from "./refine/local.mjs";
import { createChatPolisher } from "./refine/polisher.mjs";
import { createModelRefiner } from "./refine/refiner.mjs";

// The three recognition modes; the user picks one in settings (mode). They are peers, none is a fallback for another:
//   native   one step: the recording goes straight to an audio model, one request returns the finished text (refine/refiner.mjs)
//   local    transcription plus cleanup, two steps: the recording becomes a transcript (a small on-device model, or a cloud speech model), then any text model cleans it up
//            (refine/local.mjs)
//   private  one step: on-device transcription only, the transcript is used as is, no cleanup, nothing uploaded, no key needed
//            (refine/local.mjs with no polisher)
// Each mode picks different things: native picks an audio model; local picks a transcription model for step one and a cleanup vendor and model for step two;
// private picks an on-device model (saved separately from local's step one).
// Pick the mode first, then the models within it, each on its own (app/modes.mjs).
// Every mode builds the same interface (warmUp, prepare, refine), the only one the server knows.
//
// A "route" spells out what one setup uses, assembled from settings or environment variables:
//   { mode: "native", model: { provider, model }, thinkingLevel }
//   { mode: "local", transcriber: on-device model id or cloud vendor/model, polish: { vendor, model }, customUrl }
//   { mode: "private", transcriber: on-device model id }
// When step one is an on-device model, the caller loads the transcriber (the child process holding the model, asr/host.mjs) and passes it in: it lives with the model,
// so changing a key or the cleanup vendor never reloads the model. When step one is a cloud model, it is built here from the route (asr/cloud/transcriber.mjs).
//
// A route may need keys from two vendors: step one in the cloud and cleanup by another vendor.
// keyVendorsOf lists every vendor the route needs, the main one (keyVendorOf: the audio model for native, the cleanup vendor for local) last;
// when building a refiner, keys holds one per vendor ({ vendor id: key }) and apiKey is the main vendor's, enough on its own when there is only one.

/** Who cleans up when settings name nobody */
export const DEFAULT_POLISH = "ollama";

export const MODES = Object.freeze([
  Object.freeze({
    id: "native",
    /** Whose keys it needs, the main vendor last */
    keyVendors: (route) => [findProvider(route.model.provider)],
    describe: (route) => formatModelChoice(route.model),
    create: ({ route, keys, log, onCall, dictionary }) =>
      createModelRefiner({
        choice: route.model,
        apiKey: keys[route.model.provider],
        thinkingLevel: route.thinkingLevel,
        log,
        onCall,
        dictionary,
      }),
  }),
  Object.freeze({
    id: "local",
    keyVendors(route) {
      const cloud = cloudTranscriberOf(route.transcriber);
      const polish = findChatVendor(route.polish.vendor);
      const vendors = cloud && cloud.vendor !== polish.id ? [findCloudTranscriber(cloud.vendor), polish] : [polish];
      // A vendor with no keyEnv (Ollama) runs on this computer and needs no key
      return vendors.filter((vendor) => vendor.keyEnv !== null);
    },
    describe: (route) => `${route.transcriber} → ${formatChatChoice(route.polish)}`,
    async create({ route, keys, transcriber, log, onCall, decode, fetch, dictionary }) {
      const cloud = cloudTranscriberOf(route.transcriber);
      if (!cloud && !transcriber)
        throw new Error(`The local path needs its transcriber loaded first (${route.transcriber})`);
      const firstHop = cloud
        ? await createCloudTranscriber({ choice: cloud, apiKey: keys[cloud.vendor], log, onCall, fetch })
        : transcriber;
      const polisher = await createChatPolisher({
        choice: route.polish,
        customUrl: route.customUrl,
        apiKey: keys[route.polish.vendor],
        log,
        onCall,
        fetch,
        dictionary,
      });
      const refiner = createLocalRefiner({
        transcriber: firstHop,
        polisher,
        log,
        // Cloud transcription bills itself; local.mjs records the on-device step
        model: cloud ? null : route.transcriber,
        onCall,
        ...(decode ? { decode } : {}),
      });
      if (!cloud) return refiner;
      // Checking verifies both steps: step one's key or model may be wrong too
      return { ...refiner, warmUp: () => Promise.all([firstHop.warmUp(), refiner.warmUp()]).then(() => {}) };
    },
  }),
  Object.freeze({
    id: "private",
    // Needs no key from anyone
    keyVendors: () => [],
    describe: (route) => route.transcriber,
    async create({ route, transcriber, log, onCall, decode }) {
      // The settings layer already only accepts on-device models (storage/settings.mjs); guard again here: private mode never sends the recording out
      if (cloudTranscriberOf(route.transcriber)) {
        throw new Error(`Private mode only uses on-device models and can't send to the cloud (${route.transcriber})`);
      }
      if (!transcriber) throw new Error(`Private mode needs its transcriber loaded first (${route.transcriber})`);
      return createLocalRefiner({
        transcriber,
        polisher: null,
        log,
        model: route.transcriber,
        onCall,
        ...(decode ? { decode } : {}),
      });
    },
  }),
]);

export const DEFAULT_MODE = "local";

/** @returns {(typeof MODES)[number] | null} case-insensitive */
export function findMode(id) {
  const wanted = String(id ?? "").toLowerCase();
  return MODES.find((mode) => mode.id === wanted) ?? null;
}

/** The mode the user wrote, as its id. A wrong one throws a LocalizedError listing the choices */
export function parseMode(value) {
  const mode = findMode(String(value ?? "").trim());
  if (!mode) {
    throw new LocalizedError(msg("settings.oneOf", { choices: MODES.map(({ id }) => id).join(" / ") }));
  }
  return mode.id;
}

/** Every vendor this route uses: [{ id, name, keyEnv, keyPage }], the main one last, each once; empty for private mode */
export const keyVendorsOf = (route) => findMode(route.mode).keyVendors(route);

/** Whose key this route mainly uses (the audio model for native, the cleanup vendor for local); undefined when no key is needed */
export const keyVendorOf = (route) => keyVendorsOf(route).at(-1);

/** Whether an on-device model is needed: private mode always; local mode when step one is not a cloud vendor/model */
export const usesLocalModel = (route) =>
  route.mode === "private" || (route.mode === "local" && cloudTranscriberOf(route.transcriber) === null);

/** The route in one line, for logs and status */
export const describeRoute = (route) => `${route.mode}: ${findMode(route.mode).describe(route)}`;

/**
 * Builds a refiner for a route.
 * @param {object} options
 * @param {object} options.route
 * @param {string} [options.apiKey] the main vendor's key (keyVendorOf); enough when the route needs only one
 * @param {Record<string, string>} [options.keys] keys for every vendor the route needs (keyVendorsOf), by vendor id
 * @param {object} [options.transcriber] the transcriber needed when step one is on-device (spawnTranscriber in asr/host.mjs)
 */
export function createModeRefiner({ apiKey, keys, ...options }) {
  const primary = keyVendorOf(options.route);
  const all = { ...keys, ...(apiKey === undefined || primary === undefined ? {} : { [primary.id]: apiKey }) };
  return findMode(options.route.mode).create({ ...options, keys: all });
}
