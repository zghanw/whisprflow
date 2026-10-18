import { msg } from "../../i18n/index.mjs";
import { downloadSize, findModel } from "../../models/catalog.mjs";
import { sizeText } from "../../models/describe.mjs";
import { createModelStore } from "../../models/store.mjs";
import { currentSettings } from "../common.mjs";

// On-device models from the CLI: whether they are downloaded, downloading and waiting for it to finish, and asking first when one is needed but missing.
// Downloads happen only when the user asks: whisprflow transcriber download, or answering "yes" when a missing model is needed.
// If the background app is running it does the download (the same one the settings window shows); otherwise this process downloads.

/** How often to check progress while waiting for the background download */
const POLL_MS = 500;

/**
 * A model's current state: if the background app is running and reports each model's state, go by that; otherwise check the files
 * @returns {{ installed: boolean, download: { received: number, total: number } | null, problem: string | null }}
 */
export function modelStatus(io, status, id) {
  const reported = status?.localModels?.find((model) => model.id === id);
  if (reported) return reported;
  const installed = createModelStore({ dir: io.paths.modelsDir }).isInstalled(findModel(id));
  return { installed, download: null, problem: null };
}

/** One line of progress for every 10% */
function progressPrinter(io) {
  let reported = -1;
  return ({ received, total }) => {
    const percent = Math.floor((received / total) * 10) * 10;
    if (percent === reported) return;
    reported = percent;
    io.out(io.t("cli.local.downloadProgress", { percent, received: sizeText(received), total: sizeText(total) }));
  };
}

/**
 * Downloads an on-device model and waits for it to finish. If the background app is running it does the download; Ctrl-C then only stops watching and the download continues
 * @returns {Promise<boolean>} whether it finished
 */
export async function downloadAndWait(io, id) {
  const model = findModel(id);
  const status = await io.daemon.status();
  if (modelStatus(io, status, id).installed) {
    io.out(io.t("cli.local.downloadAlready", { model: model.name }));
    return true;
  }
  const source = currentSettings(io).modelSource.value;
  io.out(
    io.t("cli.local.downloadStart", {
      model: model.name,
      size: sizeText(downloadSize(model)),
      source: io.t(`modelSources.${source}`),
    }),
  );
  const print = progressPrinter(io);
  // Older background apps don't report each model's state or know the download command: download in this process
  if (status?.localModels) return viaDaemon(io, model, print);
  return inProcess(io, model, source, print);
}

async function viaDaemon(io, model, print) {
  const started = await io.daemon.request("download-model", { id: model.id });
  if (!started.ok) {
    io.err(io.t("common.sentence", { text: started.problem }));
    return false;
  }
  io.out(io.t("cli.local.downloadBackground", { id: model.id }));
  for (;;) {
    const status = await io.daemon.status();
    const now = status?.localModels?.find(({ id }) => id === model.id);
    if (!now) {
      // The background app quit mid-download: finished files stay, and the next download resumes
      io.err(io.t("cli.local.downloadInterrupted", { id: model.id }));
      return false;
    }
    if (now.installed) break;
    if (now.download) print(now.download);
    else if (now.problem) {
      io.err(io.t("common.sentence", { text: now.problem }));
      return false;
    } else {
      io.err(io.t("cli.local.downloadStopped", { model: model.name }));
      return false;
    }
    await io.sleep(POLL_MS);
  }
  io.out(io.t("cli.local.downloadDone", { model: model.name }));
  return true;
}

async function inProcess(io, model, source, print) {
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const models = io.localModels({
    source,
    onChange: () => {
      const now = models.status(model.id);
      if (now.download) print(now.download);
      else settle(now);
    },
  });
  const started = await models.download(model.id);
  if (!started.ok) {
    io.err(io.t("common.sentence", { text: started.problem }));
    return false;
  }
  const now = await finished;
  if (!now.installed) {
    io.err(io.t("common.sentence", { text: now.problem ?? msg("cli.local.downloadStopped", { model: model.name }) }));
    return false;
  }
  io.out(io.t("cli.local.downloadDone", { model: model.name }));
  return true;
}

/**
 * When the needed on-device model isn't downloaded: if it can ask, it asks whether to download it now (default no), and on "yes" downloads it before going on;
 * if it can't ask, it says which command to run first
 * @returns {Promise<boolean>} whether it is downloaded now
 */
export async function offerDownload(io, id) {
  const model = findModel(id);
  if (!io.interactive) {
    io.err(io.t("cli.local.notDownloadedHint", { model: model.name, id }));
    return false;
  }
  const source = currentSettings(io).modelSource.value;
  const question = io.t("cli.local.notDownloadedAsk", {
    model: model.name,
    size: sizeText(downloadSize(model)),
    source: io.t(`modelSources.${source}`),
  });
  if (!(await io.confirm(question))) {
    io.out(io.t("cli.local.notDownloadedLater", { id }));
    return false;
  }
  return downloadAndWait(io, id);
}
