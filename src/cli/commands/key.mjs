import { existsSync, rmSync } from "node:fs";
import { msg } from "../../i18n/index.mjs";
import { keyVendorOf } from "../../server/modes.mjs";
import { apiKeyProblem, findProvider } from "../../server/providers/index.mjs";
import { findVendor, VENDORS } from "../../server/vendors.mjs";
import { keyFile } from "../../storage/paths.mjs";
import { routeOf } from "../../storage/settings.mjs";
import { Cancelled } from "../ask-secret.mjs";
import { currentSettings, ensureRunning, parse, UsageError } from "../common.mjs";

// whisprflow key: asks for a key, hands it to the background app to verify and save, or deletes it. One key per provider; with no provider named it is the one in use
// (in native mode the one that receives audio, in local mode the one that polishes).
// Missing keys at startup (whisprflow start) or when switching modes and models (mode, model, polish) are asked for here too.

const MAX_KEY_ATTEMPTS = 3;

/** Saving a key makes the background app check it with the provider once; that check times out after 30 seconds */
const SAVE_KEY_TIMEOUT_MS = 45_000;

/**
 * The lines shown before asking for a key. They aren't printed separately but passed to askSecret with the prompt:
 * that step turns terminal echo off before showing any text. Otherwise a fast typist sees "key needed" and pastes
 * before echo is off, and the terminal shows the key as typed (seen in a pseudo-terminal).
 */
const keyPreamble = (t, provider, skippable) =>
  [
    "",
    // The audio provider gets the recording; the polish provider only gets the text transcribed on this computer
    t(findProvider(provider.id) ? "cli.key.need" : "cli.key.needText", { provider: provider.name }),
    // Custom services have no sign-up page
    ...(provider.keyPage ? [t("cli.key.getOne", { url: provider.keyPage })] : []),
    t("cli.key.storage"),
    ...(skippable ? [t("cli.key.skip")] : []),
    t("cli.key.prompt"),
  ].join("\n");

/**
 * Asks for a provider's key in the terminal one attempt at a time: each call returns one that looks valid; one that looks wrong is flagged and asked again on the spot.
 * At most MAX_KEY_ATTEMPTS attempts in total.
 * @returns {() => Promise<string | null>} null: nothing entered, Ctrl-C pressed, or out of attempts
 */
export function keyPrompter(io, provider) {
  let asked = 0;
  return async function nextKey() {
    while (asked < MAX_KEY_ATTEMPTS) {
      let value;
      try {
        value = await io.askSecret(asked++ === 0 ? keyPreamble(io.t, provider, true) : io.t("cli.key.prompt"));
      } catch (error) {
        if (error instanceof Cancelled) return null;
        throw error;
      }
      if (value === "") return null;
      const problem = apiKeyProblem(value);
      if (problem === null) return value;
      io.err(io.t("common.sentence", { text: problem }));
    }
    return null;
  };
}

/**
 * Hands one key for a provider to the background app to verify and save.
 * @param {Record<string, string>} [changes] settings to switch to at the same time (given when saving a key before changing mode or model), used for the check
 * @returns {Promise<boolean>} whether it passed
 */
export async function submitKey(io, value, provider, changes) {
  io.out(io.t("cli.key.verifying"));
  const result = await io.daemon.request(
    "set-key",
    changes ? { key: value, provider: provider.id, changes } : { key: value, provider: provider.id },
    { timeoutMs: SAVE_KEY_TIMEOUT_MS },
  );
  if (result.ok) io.out(io.t("cli.key.saved"));
  else io.err(io.t("cli.key.rejected", { problem: result.problem }));
  return result.ok;
}

/** Whose key the configured mode needs: in native the audio provider, in local the polish provider; private needs none and gives undefined */
export const currentProvider = (io) => keyVendorOf(routeOf(currentSettings(io)));

/**
 * Which layer to switch to use a provider: audio providers in native (whisprflow model), polish providers in local's second step (whisprflow polish).
 * Outside that layer's mode the switching command only works in that mode, so the mode must change too
 * @param {string} current the current mode
 */
function switchCommand(provider, current) {
  if (findProvider(provider.id)) {
    return current === "native" ? `whisprflow model ${provider.id}` : `whisprflow mode native --model ${provider.id}`;
  }
  const polish = provider.defaultModel ? provider.id : `${provider.id}/<model> --url <url>`;
  return current === "local" ? `whisprflow polish ${polish}` : `whisprflow mode local --polish ${polish}`;
}

/**
 * Where a provider's key is, found without starting the background app: stored (saved), env (from an environment variable), or null for neither.
 * This looks at the CLI's own copy: the installed app keeps its own, which isn't readable from here
 */
export function keySource(io, provider) {
  if (io.env[provider.keyEnv]?.trim()) return "env";
  if (existsSync(keyFile(io.paths, provider.id))) return "stored";
  return null;
}

/**
 * Whether a provider has a key, as the background app that would use it sees it: if it is running, go by what it reports (the CLI can't see the environment it started with);
 * otherwise check the CLI side (a background restart uses this side's environment variables and files).
 * @param {object | null} status the running background app's status; null when not running
 */
export function keySourceFor(io, provider, status) {
  if (status?.keys) return status.keys[provider.id] ?? null;
  return keySource(io, provider);
}

/** A key is known to be available before starting: saved, from an environment variable, or handled by a separately started server; modes that need no key count too */
export function hasKeyAlready(io) {
  const provider = currentProvider(io);
  return provider === undefined || keySource(io, provider) !== null || Boolean(io.env.WHISPRFLOW_SERVER_URL);
}

/**
 * Whether this state is fixed by entering a new key. Two cases aren't: Gemini refused the request (most likely a wrong model name or level),
 * and the key from the environment variable is wrong (saving a new one won't help; the next start still uses the environment variable).
 */
export const needsNewKey = (key) =>
  key.state === "missing" ||
  key.state === "unreadable" ||
  (key.state === "rejected" && key.cause !== "other" && key.source !== "env");

export async function key(args, io) {
  const { values, positionals } = parse(args, { forget: { type: "boolean", default: false } });
  // A provider name may follow. Anything else is most likely a key: don't use it, and don't print it back
  const named = positionals.length === 1 ? findVendor(positionals[0]) : null;
  if (positionals.length > 0 && named === null) {
    throw new UsageError(msg("cli.key.notInline", { providers: VENDORS.map(({ id }) => id).join(" / ") }));
  }
  const provider = named ?? currentProvider(io);
  // Private mode needs no key and has no "provider in use": the provider must be named
  if (provider === undefined) {
    throw new UsageError(msg("cli.key.whichVendor", { providers: VENDORS.map(({ id }) => id).join(" / ") }));
  }
  if (values.forget) {
    // If it is running, make it drop the key it holds; if not, there's no need to start it just to delete a file
    if ((await io.daemon.status()) !== null) await io.daemon.request("forget-key", { provider: provider.id });
    rmSync(keyFile(io.paths, provider.id), { force: true });
    io.out(io.t("cli.key.forgotten", { provider: provider.name }));
    return 0;
  }

  // A vendor that runs on this computer (Ollama) has no key to save
  if (provider.keyEnv === null) {
    io.out(io.t("cli.key.notNeeded", { provider: provider.name }));
    return 0;
  }
  // Custom services have no default model, so a key alone can't be verified: give it with the model name and address
  if (provider.id === "custom" && provider.id !== currentProvider(io)?.id) {
    io.err(io.t("cli.key.customWithModel"));
    return 1;
  }
  let value;
  try {
    value = await io.askSecret(keyPreamble(io.t, provider, false));
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.err(io.t("cli.key.cancelled"));
    return 1;
  }
  if (value === "") {
    io.err(io.t("cli.key.nothingRead"));
    return 1;
  }
  const problem = apiKeyProblem(value);
  if (problem !== null) {
    io.err(io.t("cli.key.badShapeUnchanged", { problem }));
    return 1;
  }
  await ensureRunning(io);
  if (!(await submitKey(io, value, provider))) return 1;
  if (provider.id !== currentProvider(io)?.id) {
    // If it is running, go by the mode it reports (very old versions don't report one; only native existed then)
    const status = await io.daemon.status();
    const current = status ? (status.mode ?? "native") : currentSettings(io).mode.value;
    io.out(io.t("cli.key.switchHint", { command: switchCommand(provider, current) }));
  }
  return 0;
}
