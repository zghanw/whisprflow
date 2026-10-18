import { msg } from "../../i18n/index.mjs";
import { chipOf, downloadSize, findModel, MODELS, measuredOn, SOURCES, tagsOn } from "../../models/catalog.mjs";
import { sizeText } from "../../models/describe.mjs";
import { freeBytesAt } from "../../models/library.mjs";
import { createModelStore } from "../../models/store.mjs";
import { cloudTranscriberOf, findCloudTranscriber } from "../../server/asr/cloud/vendors.mjs";
import { CHAT_VENDORS, findChatVendor, parseChatChoice } from "../../server/chat/vendors.mjs";
import { formatSeconds } from "../../usage/format.mjs";
import { currentSettings, ensureRunning, parse, renderOptions, UsageError } from "../common.mjs";
import { polishTitle, renderPolish, renderTranscribers } from "../render/modes.mjs";
import { keySourceFor } from "./key.mjs";
import { downloadAndWait, modelStatus, offerDownload } from "./local-models.mjs";
import { needUrl } from "./mode.mjs";
import { applyChange, checked, ensureKey, inMode, modeNow, routeWith } from "./route.mjs";

// The two steps of local mode, one command each, changeable only in local mode (otherwise it says to run whisprflow mode local first):
//   whisprflow transcriber   step one: an on-device transcription model (no key; must be downloaded first), or a cloud provider/model (needs that provider's key).
//                           download / cancel / delete manage on-device model downloads and removal; check tests that it produces text
//   whisprflow polish        step two: the polish provider and model; a custom service (OpenAI-compatible API) with its address
// Private mode also uses whisprflow transcriber to change its on-device model (stored in its own privateTranscriber), and accepts on-device models only.
// Listing works in any mode, with a note up top when not in local or private. Downloading and deleting work in any mode.

/** A check waits for the background app to ask that provider once; that request times out after 30 seconds */
const CHECK_TIMEOUT_MS = 45_000;
/** Checking an on-device model: one not in use is loaded temporarily (a big one takes over ten seconds on a CPU), then transcribes one sentence */
const TRANSCRIBER_CHECK_TIMEOUT_MS = 90_000;

/** The download and delete actions: whisprflow transcriber <action> <model> */
const MODEL_ACTIONS = { download, cancel, delete: remove };

/** Which setting holds the current mode's transcription model: private has its own privateTranscriber, other modes use local's step one */
const firstHopSetting = (mode) => (mode === "private" ? "privateTranscriber" : "transcriber");

export async function transcriber(args, io) {
  const { values, positionals } = parse(args, { yes: { type: "boolean", short: "y", default: false } });
  const [first, second, ...extra] = positionals;
  if (first === "check") {
    if (extra.length > 0 || values.yes) throw new UsageError(msg("cli.syntax.transcriber"));
    const setting = firstHopSetting(modeNow(io, await io.daemon.status()));
    const id =
      second === undefined ? currentSettings(io)[setting].value : checked(io, { transcriber: second }).transcriber;
    return cloudTranscriberOf(id) ? checkCloudTranscriber(io, id) : checkTranscriber(io, id);
  }
  if (Object.hasOwn(MODEL_ACTIONS, first ?? "")) {
    if (second === undefined || extra.length > 0) throw new UsageError(msg("cli.syntax.transcriber"));
    const { transcriber: id } = checked(io, { transcriber: second });
    // Cloud models need no download and have nothing to delete
    if (cloudTranscriberOf(id)) throw new UsageError(msg("cli.local.cloudNoDownload", { model: id }));
    return MODEL_ACTIONS[first](io, id, values);
  }
  if (second !== undefined || values.yes) throw new UsageError(msg("cli.syntax.transcriber"));
  const status = await io.daemon.status();
  if (first === undefined) return listTranscribers(io, status);

  const { transcriber: id } = checked(io, { transcriber: first });
  const mode = modeNow(io, status);
  if (mode === "private") {
    if (cloudTranscriberOf(id)) {
      io.err(io.t("common.sentence", { text: msg("modes.privateOnlyLocal", { model: id }) }));
      return 1;
    }
  } else if (!inMode(io, status, "local", "transcriber")) return 1;
  const cloud = cloudTranscriberOf(id);
  if (cloud) {
    // Step one goes to the cloud: needs that provider's key, verified against the route with it switched in
    if (!(await ensureKey(io, findCloudTranscriber(cloud.vendor), { transcriber: id }))) return 1;
  } else if (!modelStatus(io, status, id).installed && !(await offerDownload(io, id))) {
    // The model to use isn't downloaded: ask whether to download it first, and switch once it is
    return 1;
  }
  return applyChange(io, {
    command: "set-transcriber",
    params: { transcriber: id },
    changes: { [firstHopSetting(mode)]: id },
    done: msg("cli.local.transcriberSwitched", { model: id }),
  });
}

function listTranscribers(io, status) {
  const chip = chipOf();
  const models = MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    bytes: downloadSize(model),
    ...modelStatus(io, status, model.id),
    tags: tagsOn(model, chip),
    measured: measuredOn(model, chip),
  }));
  let freeBytes = null;
  try {
    freeBytes = freeBytesAt(io.paths.modelsDir);
  } catch {
    // If the disk can't be checked, don't say how much is free
  }
  const settings = currentSettings(io);
  const view = {
    models,
    chip,
    freeBytes,
    setting: settings[firstHopSetting(modeNow(io, status))].value,
    source: settings.modelSource.value,
    sources: SOURCES.map(({ id }) => id),
    current: modeNow(io, status),
  };
  io.out(renderTranscribers(view, renderOptions(io)));
  return 0;
}

/** Checks an on-device model: the background app reads a sentence and transcribes it once (loading it temporarily if not in use, unloading after). Starts the background app if it isn't running */
async function checkTranscriber(io, id) {
  const model = findModel(id);
  await ensureRunning(io);
  // No need to ask the background app about a model that isn't downloaded: say how to get it
  if (!modelStatus(io, await io.daemon.status(), id).installed) {
    io.err(io.t("cli.local.notDownloadedHint", { model: model.name, id }));
    return 1;
  }
  io.out(io.t("cli.local.checking", { model: model.name }));
  let result;
  try {
    result = await io.daemon.request("check-transcriber", { id }, { timeoutMs: TRANSCRIBER_CHECK_TIMEOUT_MS });
  } catch (error) {
    // The running app was started before an upgrade and doesn't know this command yet
    if (!/^Unknown command/.test(error?.message ?? "")) throw error;
    io.err(io.t("cli.local.oldDaemonCheck"));
    return 1;
  }
  if (!result.ok) {
    io.err(io.t("common.sentence", { text: result.problem }));
    return 1;
  }
  io.out(
    io.t("cli.local.checkOk", {
      model: model.name,
      said: result.said,
      text: result.text,
      seconds: formatSeconds(result.transcribeMs, io.t),
    }),
  );
  if (result.loadMs !== null) io.out(io.t("cli.local.checkLoaded", { seconds: formatSeconds(result.loadMs, io.t) }));
  return 0;
}

/** Checks a cloud transcription model: asks once along the route local mode would take with it switched in (both steps are checked, so the polish provider's key is needed too) */
async function checkCloudTranscriber(io, id) {
  await ensureRunning(io);
  io.out(io.t("cli.local.checking", { model: id }));
  const result = await io.daemon.request(
    "check-mode",
    { mode: "local", changes: { transcriber: id } },
    { timeoutMs: CHECK_TIMEOUT_MS },
  );
  if (!result.ok) {
    io.err(io.t("common.sentence", { text: result.problem }));
    return 1;
  }
  io.out(io.t("cli.local.cloudCheckOk", { model: id, seconds: formatSeconds(result.ms, io.t) }));
  return 0;
}

async function download(io, id) {
  return (await downloadAndWait(io, id)) ? 0 : 1;
}

/** Stops a running download: only downloads handed to the background app can be stopped (one in this CLI process stops with Ctrl-C) */
async function cancel(io, id) {
  const status = await io.daemon.status();
  const model = findModel(id);
  if (!modelStatus(io, status, id).download) {
    io.out(io.t("cli.local.nothingToCancel", { model: model.name }));
    return 0;
  }
  await io.daemon.request("cancel-download", { id });
  io.out(io.t("cli.local.cancelled", { model: model.name }));
  return 0;
}

/**
 * Deletes an on-device model after confirming (--yes skips it). The one in use can't be deleted: if the background app is running it decides (the core's rule);
 * if not, check the settings: if local mode uses it, it won't be available at the next start
 */
async function remove(io, id, { yes }) {
  const model = findModel(id);
  const status = await io.daemon.status();
  const { installed } = modelStatus(io, status, id);
  const store = createModelStore({ dir: io.paths.modelsDir });
  const onDisk = installed ? downloadSize(model) : downloadSize(model) - store.missingBytes(model);
  if (onDisk === 0) {
    io.out(io.t("cli.local.notOnDisk", { model: model.name }));
    return 0;
  }
  const settings = currentSettings(io);
  const inUse =
    (settings.mode.value === "local" && settings.transcriber.value === id) ||
    (settings.mode.value === "private" && settings.privateTranscriber.value === id);
  if (status === null && inUse) {
    io.err(io.t("common.sentence", { text: msg("localModels.inUse", { model: model.name }) }));
    return 1;
  }
  if (!yes) {
    if (!io.interactive) throw new UsageError(msg("cli.local.deleteNeedsConfirm", { id }));
    if (!(await io.confirm(io.t("cli.local.deleteConfirm", { model: model.name, size: sizeText(onDisk) })))) {
      io.out(io.t("cli.local.deleteAborted"));
      return 1;
    }
  }
  if (status === null) {
    io.localModels({ source: settings.modelSource.value }).remove(id);
  } else {
    let result;
    try {
      result = await io.daemon.request("delete-model", { id });
    } catch (error) {
      // Older background apps don't know this command: they can't tell which models are in use, so don't delete on their behalf
      if (!/^Unknown command/.test(error?.message ?? "")) throw error;
      io.err(io.t("cli.local.oldDaemonDelete"));
      return 1;
    }
    if (!result.ok) {
      io.err(io.t("common.sentence", { text: result.problem }));
      return 1;
    }
  }
  io.out(io.t("cli.local.deleted", { model: model.name, size: sizeText(onDisk) }));
  return 0;
}

export async function polish(args, io) {
  const { values, positionals } = parse(args, { url: { type: "string" } });
  const [first, second, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(msg("cli.syntax.polish"));
  if (first === "check") return check(io, second, values.url);
  if (second !== undefined) throw new UsageError(msg("cli.syntax.polish"));
  const status = await io.daemon.status();
  if (first === undefined) {
    if (values.url !== undefined) throw new UsageError(msg("cli.syntax.polish"));
    return list(io, status);
  }

  // First check the input is well formed (exit 2), then whether local mode is active (exit 1)
  const changes = choiceFrom(io, first, values.url);
  const route = routeWith(io, "local", changes);
  needUrl(route);
  if (!inMode(io, status, "local", "polish")) return 1;
  const vendor = findChatVendor(route.polish.vendor);
  if (!(await ensureKey(io, vendor, changes))) return 1;
  return applyChange(io, {
    command: "set-polish",
    params: changes,
    changes,
    done: msg("cli.local.polishSwitched", { model: polishTitle(route.polish, route.customUrl) }),
  });
}

/**
 * The polish model (and address) the user wrote, turned into checked settings. An audio provider or a typo exits with 2 and lists what is accepted
 * @returns {{ polish: string, customUrl?: string }}
 */
function choiceFrom(io, value, url) {
  const changes = url === undefined ? { polish: value } : { polish: value, customUrl: url };
  return checked(io, changes);
}

function list(io, status) {
  const settings = currentSettings(io);
  const keys = Object.fromEntries(CHAT_VENDORS.map((vendor) => [vendor.id, keySourceFor(io, vendor, status)]));
  const view = {
    vendors: CHAT_VENDORS,
    polish: parseChatChoice(settings.polish.value),
    customUrl: settings.customUrl.value,
    keys,
    current: modeNow(io, status),
  };
  io.out(renderPolish(view, renderOptions(io)));
  return 0;
}

/** Whether a step-two model works now: the background app sends one minimal request with that provider's key. Works in any mode */
async function check(io, value, url) {
  const changes = value === undefined ? {} : choiceFrom(io, value, url);
  const route = routeWith(io, "local", changes);
  needUrl(route);
  await ensureRunning(io);
  const title = io.t.text(polishTitle(route.polish, route.customUrl));
  io.out(io.t("cli.model.checking", { model: title }));
  const params = { polish: `${route.polish.vendor}/${route.polish.model}` };
  if (changes.customUrl !== undefined) params.customUrl = changes.customUrl;
  let result;
  try {
    result = await io.daemon.request("check-polish", params, { timeoutMs: CHECK_TIMEOUT_MS });
  } catch (error) {
    // The running app was started before an upgrade and doesn't know this command yet
    if (!/^Unknown command/.test(error?.message ?? "")) throw error;
    io.err(io.t("cli.model.oldDaemonCheck"));
    return 1;
  }
  if (!result.ok) {
    io.err(io.t("cli.model.unusable", { problem: result.problem }));
    return 1;
  }
  const vendor = findChatVendor(route.polish.vendor);
  const from =
    result.source === "env" ? msg("cli.model.fromEnv", { variable: vendor.keyEnv }) : msg("cli.model.fromStored");
  io.out(io.t("cli.model.usable", { model: title, from, seconds: (result.ms / 1000).toFixed(1) }));
  return 0;
}
