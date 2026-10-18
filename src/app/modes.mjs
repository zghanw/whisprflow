import { msg, problemOf } from "../i18n/index.mjs";
import { DEFAULT_TRANSCRIBER, downloadSize, findModel } from "../models/catalog.mjs";
import { sizeText } from "../models/describe.mjs";
import { cloudTranscriberOf } from "../server/asr/cloud/vendors.mjs";
import { speechSample } from "../server/asr/probe.mjs";
import { findChatVendor } from "../server/chat/vendors.mjs";
import { describeRoute, usesLocalModel } from "../server/modes.mjs";
import { findProvider } from "../server/providers/index.mjs";
import {
  MODE_SETTINGS,
  overridingEnv,
  patchSettings,
  resolveSettings,
  routeOf,
  saveSetting,
} from "../storage/settings.mjs";

// The recognition mode state machine. The state is "which mode is in use" (service.route.mode) plus the models chosen within that mode:
//
//   native <--switchMode--> local <--switchMode--> private <--switchMode--> native (any two can switch, optionally carrying that mode's settings)
//     + setModel        changes the audio model
//   local
//     + setTranscriber  step one: an on-device model (no key, must be downloaded) or a cloud model (checks that vendor's key)
//     + setPolish       step two: the cleanup vendor and model (a custom service with its address)
//   private
//     + setTranscriber  the only step: on-device models only (no key, must be downloaded), saved in its own privateTranscriber
//
// The modes change different things and each takes its own path: a model can only change in its own mode; changing it from another mode is an error (it isn't selectable),
// said plainly rather than quietly saved. On first entering local, step two can't be changed yet, so switching modes can carry that mode's own settings
// (MODE_SETTINGS in storage/settings.mjs), for someone going straight to a custom service, say.
//
// What to pick is the user's call, whether it works is state, and the two stay apart: each step builds the route from the changed settings (routeOf), and if it builds, it switches at once and
// saves (switchRoute in keys/key-manager.mjs), without checking keys first or waiting for downloads. Whatever is still missing (a vendor's key, a key that failed,
// an undownloaded on-device model) lives in the key manager's and service's state, reported honestly in the UI and while dictating, and works once filled in (downloads are the user's call, models/library.mjs,
// and the service loads the model once it's downloaded). Requiring verification and downloads before switching would trap a fresh install in the default mode.
// Only mistakes are refused (unknown modes, models, vendors, settings of another mode). The on-device model in use can't be deleted.

/**
 * @param {object} options
 * @param {{ route: object, switchTranscriber(model: string): void, checkTranscriber: Function }} options.service
 *   the built-in dictation service (service.mjs)
 * @param {{ switchRoute: Function, check: Function }} options.keys the key manager (keys/key-manager.mjs)
 * @param {{ isInstalled(id: string): boolean, remove(id: string): object }} options.models the on-device model library (models/library.mjs)
 * @param {string} options.settingsFile
 * @param {Record<string, string | undefined>} options.env
 * @param {{ info: Function, warn: Function }} options.log
 * @param {typeof speechSample} [options.speech] the sentence spoken when checking an on-device model (asr/probe.mjs); a fake in tests
 */
export function createModeSwitch({ service, keys, models, settingsFile, env, log, speech = speechSample }) {
  /** One at a time: a change arriving while the previous one verifies must see the mode it switched to and the settings it saved */
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  const read = () => resolveSettings({ file: settingsFile, env });

  /**
   * Writes the settings file. If writing fails this run still switched, and it says honestly that the next launch won't remember;
   * when an environment variable overrides it, it says the next launch will be overridden
   * @returns {{ note?: object }}
   */
  function save(changes) {
    for (const [name, value] of Object.entries(changes)) {
      try {
        saveSetting(settingsFile, name, value);
      } catch (error) {
        return { note: msg("notes.settingNotSaved", { name, reason: problemOf(error) }) };
      }
    }
    const variable = Object.keys(changes)
      .map((name) => overridingEnv(name, env))
      .find((found) => found !== null);
    return variable ? { note: msg("notes.envNextLaunch", { variable }) } : {};
  }

  /**
   * Changes a model within a mode: outside that mode nothing changes and it says to switch first; inside, the route switches to the changed settings (apply does it) and is saved once switched.
   * @param {string} mode
   * @param {string} what what is being changed (modes.what.*), named in errors
   * @param {Record<string, string>} changes
   * @param {(route: object) => { ok: boolean, problem?: object, settled?: Promise<unknown> }} apply
   *   switched at once; settled is what remains to wait for (key lookup and check)
   */
  function within(mode, what, changes, apply) {
    return serial(async () => {
      const current = service.route.mode;
      if (current !== mode) {
        return { ok: false, problem: msg("modes.notIn", { current, mode, what: msg(`modes.what.${what}`) }) };
      }
      let route;
      try {
        route = routeOf(patchSettings(read(), changes), mode);
      } catch (error) {
        return { ok: false, problem: problemOf(error) };
      }
      const result = apply(route);
      if (!result.ok) return result;
      log.info("route_changed", { route: describeRoute(route), settings: Object.keys(changes) });
      // Save as soon as it switched: if the UI asks for state while the key verdict is pending, route and settings agree
      const note = save(changes);
      await result.settled;
      return { ok: true, ...note };
    });
  }

  /** Switches to this route at once; the key manager finds the keys it needs (settled is when lookup and check finish) */
  const useRoute = (route) => keys.switchRoute(route);

  /**
   * The step one used when checking only a cleanup vendor: the on-device model in settings, or the default on-device model when settings hold a cloud model.
   * Otherwise a cloud step one from another vendor would be pulled in, and its missing or wrong key would be blamed on the vendor being checked
   */
  const localFirstHop = (settings) =>
    usesLocalModel(routeOf(settings, "local")) ? settings.transcriber.value : DEFAULT_TRANSCRIBER;

  return {
    /**
     * Switches modes. That mode's own settings (only those in MODE_SETTINGS[mode]) can come along, switched and saved together
     * @param {string} mode
     * @param {Record<string, string>} [changes]
     */
    switchMode(mode, changes = {}) {
      return serial(async () => {
        let wanted;
        let route;
        try {
          wanted = patchSettings(read(), { mode }).mode.value;
          const foreign = Object.keys(changes).find((name) => !MODE_SETTINGS[wanted].includes(name));
          if (foreign) {
            return {
              ok: false,
              problem: msg("modes.notOfMode", {
                name: foreign,
                mode: wanted,
                names: MODE_SETTINGS[wanted].join(" / "),
              }),
            };
          }
          route = routeOf(patchSettings(read(), { mode: wanted, ...changes }), wanted);
        } catch (error) {
          return { ok: false, problem: problemOf(error) };
        }
        const from = service.route.mode;
        let settled = null;
        // Already this route (switching to the mode in use with nothing else): nothing to switch
        if (JSON.stringify(route) !== JSON.stringify(service.route)) {
          const result = useRoute(route);
          if (!result.ok) return result;
          settled = result.settled;
        }
        if (from !== wanted) log.info("mode_switched", { from, to: wanted, route: describeRoute(route) });
        // Save as soon as it switched: if the UI asks for state while the key verdict is pending, mode and settings agree
        const note = save({ mode: wanted, ...changes });
        await settled;
        return { ok: true, ...note };
      });
    },

    /** Changes the audio vendor and model within native, written like the model setting (vendor, or vendor/model) */
    setModel(model) {
      return within("native", "model", { model }, useRoute);
    },

    /**
     * Changes the transcription model, in local or private, whichever is in use.
     * local step one: on-device models need no key; cleanup stays as it is and the service only changes models (an undownloaded one waits, and loads once downloaded).
     * Switching to a cloud model, or from cloud back to on-device, changes the kind of transcriber: the whole route switches again and keys are looked up again (the cloud vendor's too).
     * private: on-device models only; a cloud one is refused outright
     */
    setTranscriber(transcriber) {
      const apply = (route) => {
        if (!usesLocalModel(route) || !usesLocalModel(service.route)) return useRoute(route);
        service.switchTranscriber(route.transcriber);
        return { ok: true };
      };
      if (service.route.mode !== "private") return within("local", "transcriber", { transcriber }, apply);
      if (cloudTranscriberOf(transcriber)) {
        return Promise.resolve({ ok: false, problem: msg("modes.privateOnlyLocal", { model: transcriber }) });
      }
      return within("private", "privateTranscriber", { privateTranscriber: transcriber }, apply);
    },

    /** Deletes an on-device model; the one in use (local's step one, private's model) is refused with a hint to switch models or modes first */
    removeModel(id) {
      return serial(async () => {
        const model = findModel(id);
        if (!model) return { ok: false, problem: msg("localModels.unknown", { id }) };
        if (usesLocalModel(service.route) && service.route.transcriber === id) {
          return { ok: false, problem: msg("localModels.inUse", { model: model.name }) };
        }
        return models.remove(id);
      });
    },

    /**
     * local step two: the cleanup vendor and model, written like the polish setting (vendor, vendor/model, custom/model name)
     * @param {string} polish
     * @param {{ customUrl?: string }} [options] the custom service address, verified and saved with the model
     */
    setPolish(polish, { customUrl } = {}) {
      const changes = customUrl === undefined ? { polish } : { polish, customUrl };
      return within("local", "polish", changes, useRoute);
    },

    /**
     * Checks whether an on-device model transcribes properly: the system voice speaks a sentence for it. Works in any mode and doesn't replace the model in use.
     * Not queued: it changes neither settings nor the route
     * @param {string} id
     * @param {{ locale: string }} options speak in the UI language
     * @returns {Promise<{ ok: true, said: string, text: string, transcribeMs: number, loadMs: number | null, backend: string }
     *   | { ok: false, problem: object }>}
     */
    async checkTranscriber(id, { locale }) {
      const model = findModel(id);
      if (!model) return { ok: false, problem: msg("localModels.unknown", { id }) };
      if (!models.isInstalled(id)) {
        return {
          ok: false,
          problem: msg("modes.notDownloaded", { model: model.name, size: sizeText(downloadSize(model)) }),
        };
      }
      let sample;
      try {
        sample = await speech(locale);
      } catch (error) {
        log.warn("probe_speech_failed", { error: String(error?.message ?? error) });
        return { ok: false, problem: msg("localModels.checkNoSpeech", { reason: problemOf(error) }) };
      }
      let result;
      try {
        result = await service.checkTranscriber(id, sample.samples);
      } catch (error) {
        log.warn("transcriber_check_failed", { model: id, error: String(error?.message ?? error) });
        return { ok: false, problem: msg("localModels.checkFailed", { model: model.name, reason: problemOf(error) }) };
      }
      if (result.text.trim() === "") {
        return { ok: false, problem: msg("localModels.checkEmpty", { model: model.name }) };
      }
      return { ok: true, said: sample.said, ...result };
    },

    /**
     * Whether a mode works with changed settings: builds the route and hands it to the key manager to try, without replacing the route in use.
     * Only a trial, so it works from any mode (to look before switching)
     * @returns {Promise<object>} like check in key-manager
     */
    async check(mode, changes) {
      let route;
      try {
        const settings = read();
        // Checking a cleanup model (or a cleanup vendor's key): only that one, without pulling another vendor in for step one
        const isolated =
          mode === "local" && "polish" in changes && !("transcriber" in changes)
            ? { transcriber: localFirstHop(settings) }
            : {};
        route = routeOf(patchSettings(settings, { ...changes, ...isolated }), mode);
      } catch (error) {
        return { ok: false, cause: "other", problem: problemOf(error) };
      }
      return keys.check(route);
    },

    /**
     * Which route verifies a vendor's key before saving: audio vendors use native, cleanup vendors use local (routeFor in key-manager).
     * If settings already chose this vendor its model is used, otherwise its default model; changes are settings to switch to along with it (not saved yet).
     * A cleanup vendor is checked on its own: step one uses the on-device model (see localFirstHop).
     * The custom service has no default model: without it in settings or in changes, this throws and says to write custom/model name
     */
    routeForVendor(id, changes = {}) {
      const settings = read();
      if (findProvider(id)) {
        const chosen = routeOf(settings, "native").model.provider === id;
        return routeOf(patchSettings(settings, { model: chosen ? settings.model.value : id, ...changes }), "native");
      }
      if (!findChatVendor(id)) throw new Error(`Unknown vendor: ${id}`);
      const chosen = routeOf(settings, "local").polish.vendor === id;
      const polish = chosen ? settings.polish.value : id;
      return routeOf(patchSettings(settings, { polish, transcriber: localFirstHop(settings), ...changes }), "local");
    },
  };
}
