import { msg, problemOf } from "../../i18n/index.mjs";
import { patchSettings, routeOf } from "../../storage/settings.mjs";
import { ConfigError, currentSettings, ensureRunning } from "../common.mjs";
import { applySettings, storeSetting, warnIfEnvOverrides } from "./config.mjs";
import { keyPrompter, keySourceFor, submitKey } from "./key.mjs";

// The steps shared by the commands that switch modes and models (mode, model, transcriber, polish):
// which mode is active, stopping when not in the right mode, asking for a missing key first, and handing the switch to the running app.
// The switching rules (what can change in which mode) live in the core (src/app/modes.mjs); this checks the same rules first
// so nobody is asked for a key only to be refused; when not running there is no core to ask, so the mode in the settings file is used.
// Whatever the core accepts is switched in without verifying first: if that provider's key then fails (wrong model name, expired key), it says so and exits with 1.

/** Switching modes or models waits for the background app to ask that provider once; that request times out after 30 seconds */
const SWITCH_TIMEOUT_MS = 45_000;

/** Which mode is active: if running, go by what it reports (very old versions don't report one; only native existed then); otherwise the settings */
export function modeNow(io, status) {
  if (status) return status.mode ?? "native";
  return currentSettings(io).mode.value;
}

/**
 * Things in a mode can only be changed in that mode: otherwise it says to switch first
 * @param {string} what what is being changed (modes.what.*)
 * @returns {boolean} whether it is
 */
export function inMode(io, status, mode, what) {
  const current = modeNow(io, status);
  if (current === mode) return true;
  io.err(io.t("cli.modes.notIn", { current, mode, what: msg(`modes.what.${what}`) }));
  return false;
}

/**
 * Checks a few settings by the rules used when storing settings and returns the normalized values. A mistake exits with 2 and lists what is accepted
 * @param {Record<string, string>} changes
 */
export function checked(io, changes) {
  let patched;
  try {
    patched = patchSettings(currentSettings(io), changes);
  } catch (error) {
    throw new ConfigError(problemOf(error), { cause: error });
  }
  return Object.fromEntries(Object.keys(changes).map((name) => [name, patched[name].value]));
}

/** The route a mode takes with the current settings plus changes (changes already checked with checked) */
export const routeWith = (io, mode, changes = {}) => routeOf(patchSettings(currentSettings(io), changes), mode);

/**
 * When the provider to use has no key yet, asks for one, verifies it against the settings being switched to (changes), and saves it
 * @returns {Promise<boolean>} whether there is a key now
 */
export async function ensureKey(io, vendor, changes) {
  // A vendor that runs on this computer (Ollama) needs no key
  if (vendor.keyEnv === null || keySourceFor(io, vendor, await io.daemon.status()) !== null) return true;
  if (!io.interactive) {
    io.err(io.t("cli.model.noKeyNonInteractive", { provider: vendor.name, id: vendor.id }));
    return false;
  }
  // Ask before starting: the terminal echoes as usual while starting, so a key pasted early would show (same as whisprflow start)
  const nextKey = keyPrompter(io, vendor);
  for (let key = await nextKey(); key !== null; key = await nextKey()) {
    await ensureRunning(io);
    if (await submitKey(io, key, vendor, changes)) return true;
  }
  io.err(io.t("cli.model.notSwitched", { provider: vendor.name }));
  return false;
}

/**
 * Switches: if running, the core switches live (no restart, installed app included); if not, it is saved to the settings for the next start.
 * If the running app is an older version that doesn't know the command: save to the settings and restart it to apply (the old way of changing settings).
 * @param {object} change
 * @param {string} change.command which core command (set-mode, set-model, set-transcriber, set-polish)
 * @param {object} change.params
 * @param {Record<string, string>} change.changes the settings to write (used when not running, or for an older version)
 * @param {object} change.done what to say once switched (msg)
 * @returns {Promise<number>} exit code
 */
export async function applyChange(io, { command, params, changes, done }) {
  const store = () => {
    for (const [name, value] of Object.entries(changes)) {
      storeSetting(io, name, value);
      warnIfEnvOverrides(io, name);
    }
  };
  if ((await io.daemon.status()) === null) {
    store();
    io.out(io.t.text(done));
    io.out(io.t("cli.config.nextLaunch"));
    return 0;
  }
  let result;
  try {
    result = await io.daemon.request(command, params, { timeoutMs: SWITCH_TIMEOUT_MS });
  } catch (error) {
    // The app started before an upgrade doesn't know this command yet
    if (!/^Unknown command/.test(error?.message ?? "")) throw error;
    store();
    io.out(io.t.text(done));
    return applySettings(io, null);
  }
  if (!result.ok) {
    io.err(io.t("cli.modes.notSwitched", { problem: result.problem }));
    return 1;
  }
  io.out(io.t.text(done));
  io.out(io.t("cli.modes.applied"));
  if (result.note) io.out(io.t("common.sentence", { text: result.note }));
  const status = await io.daemon.status();
  reportLocalModel(io, status?.localModel);
  // The core replies only once finding and verifying the key has a result: not passing means it can't be used yet
  if (status?.key?.state === "rejected" || status?.key?.state === "unreadable") {
    io.err(io.t("cli.modes.notUsable", { problem: status.key.problem }));
    return 1;
  }
  return 0;
}

/** After switching to local or changing the on-device model: say so if the model is still downloading, loading, or failed to load */
function reportLocalModel(io, localModel) {
  if (localModel?.state === "downloading") {
    const percent = Math.floor((localModel.received / localModel.total) * 100);
    io.out(io.t("cli.modes.downloading", { percent }));
  } else if (localModel?.state === "loading") io.out(io.t("cli.modes.loading"));
  else if (localModel?.state === "failed") io.err(io.t("common.sentence", { text: localModel.problem }));
}
