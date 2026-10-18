import { TimeoutError } from "../../control.mjs";
import {
  currentSettings,
  noPositionals,
  PACKAGED_RELAUNCH,
  parse,
  permissionMissing,
  progressOf,
  readStats,
  showStatus,
} from "../common.mjs";
import { INDENT } from "../render/text.mjs";
import { currentProvider, hasKeyAlready, keyPrompter, keySource, needsNewKey, submitKey } from "./key.mjs";
import { offerDownload } from "./local-models.mjs";
import { chooseProvider } from "./mode.mjs";
import { newerVersion } from "./update.mjs";

// Starting, stopping, and status: whisprflow (start), stop, restart, status.

export async function start(args, io) {
  noPositionals(parse(args).positionals, "start");
  // Read once first: if the settings file is broken, say so before asking anything
  currentSettings(io);
  let provider = currentProvider(io);

  let started = await io.daemon.status();
  /** Ctrl-C while choosing a provider: skip the key questions too */
  let declined = false;
  // Nothing chosen yet (no mode or model in settings or the environment): ask how to dictate before starting. The answer is saved, so it's asked once
  const settings = currentSettings(io);
  const choosing =
    started === null && io.interactive && settings.mode.source === "default" && settings.model.source === "default";
  if (choosing) {
    const chosen = await chooseProvider(io);
    if (chosen === null) declined = true;
    // A keyless choice (private mode, Ollama) asks for no key below
    else provider = chosen.vendor?.keyEnv ? chosen.vendor : null;
  }
  // First use: the key is asked for before starting. Starting takes a while (the first time also downloads and shows permission prompts), and the terminal echoes as usual meanwhile;
  // asking only then would show the key on screen for anyone who pasted it early
  const firstRun = choosing || (started === null && io.interactive && !hasKeyAlready(io));
  // Private mode needs no key (provider is undefined or null): ask for none below
  const nextKey = provider ? keyPrompter(io, provider) : async () => null;
  /** The first key asked for. undefined: not asked yet; null: asked, nothing entered */
  let firstKey;
  if (started === null) {
    if (firstRun && !declined && provider && keySource(io, provider) === null) firstKey = await nextKey();
    io.out(io.t("cli.starting"));
    started = await io.daemon.start({ onProgress: progressOf(io) });
  }
  if (firstKey === undefined && !declined && io.interactive && needsNewKey(started.key)) firstKey = await nextKey();
  // Don't insist if it is skipped or cancelled; the window will say it is still missing
  for (let value = firstKey ?? null; value !== null; value = await nextKey()) {
    if (await submitKey(io, value, provider)) break;
  }
  // The on-device model local or private mode needs isn't downloaded (chosen on first use, or deleted): ask whether to download it now; start as usual either way
  const local = (await io.daemon.status())?.localModel;
  if (io.interactive && !declined && local?.state === "missing" && !local.total) await offerDownload(io, local.model);
  // Recheck system permissions: the user may have just changed them in system settings
  const status = (await io.daemon.status({ recheck: true })) ?? started;

  const openSettings = io.interactive && !status.starting && permissionMissing(status);
  // First-time users go through onboarding (permissions, testing the microphone and hotkey, saying one real sentence); returning users who only lack a permission just get the settings.
  // The request keeps the name show-settings: older background apps don't know the onboarding parameter and still open the settings
  if (openSettings) await io.daemon.request("show-settings", firstRun ? { onboarding: true } : {});
  io.out("");
  // Another provider may have just been chosen, so the settings changed
  showStatus(io, status, currentSettings(io));
  if (openSettings) io.out(io.t(firstRun ? "cli.lifecycle.openedOnboarding" : "cli.lifecycle.openedSettings"));
  return 0;
}

/** What to say for each stop result (the names in the copy) */
const STOPPED = {
  "not-running": "cli.lifecycle.notRunning",
  quit: "cli.lifecycle.stopped",
  killed: "cli.lifecycle.killed",
};

export async function stop(args, io) {
  noPositionals(parse(args).positionals, "stop");
  io.out(io.t(STOPPED[await io.daemon.stop()]));
  return 0;
}

export async function restart(args, io) {
  noPositionals(parse(args).positionals, "restart");
  currentSettings(io);
  let current = null;
  try {
    current = await io.daemon.status();
  } catch (error) {
    // Hung and not answering: exactly when a restart is needed; the stop below ends it by force
    if (!(error instanceof TimeoutError)) throw error;
  }
  if (current?.packaged) {
    io.err(io.t("cli.lifecycle.packagedRestart"));
    io.err(io.t("cli.lifecycle.howToRestart", { relaunch: PACKAGED_RELAUNCH }));
    return 1;
  }
  await io.daemon.stop();
  return start([], io);
}

export async function status(args, io) {
  const { values, positionals } = parse(args, { json: { type: "boolean", default: false } });
  noPositionals(positionals, "status");
  const settings = currentSettings(io);
  const current = await io.daemon.status({ recheck: true });
  const newVersion = await newerVersion(io);
  if (values.json) {
    io.out(JSON.stringify({ running: current !== null, status: current, settings, stats: readStats(io), newVersion }));
  } else {
    showStatus(io, current, settings);
    if (newVersion) io.out(`\n${INDENT}${io.t("cli.update.available", { latest: newVersion, current: io.version })}`);
  }
  return current?.summary.ready ? 0 : 1;
}
