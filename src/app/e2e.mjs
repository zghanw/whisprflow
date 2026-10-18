import { writeFileSync } from "node:fs";

// Loaded by the main process during end-to-end tests (only when WHISPRFLOW_E2E_OUT is set). It does two things in place of a person:
// simulates "press the hotkey, speak a few seconds, press again", and records the text instead of really pasting it.
// Chromium's fake device provides the microphone (launch flags from scripts/dev/e2e.mjs); the rest of the pipeline is real.
// In local mode it waits for the local model to download and load before pressing the hotkey (the data directory is new, so the model really downloads), recording how long each took.

const OUT_PATH = process.env.WHISPRFLOW_E2E_OUT;
const RECORD_MS = Number(process.env.WHISPRFLOW_E2E_RECORD_MS ?? 7_500);
const GIVE_UP_MS = RECORD_MS + 40_000;

const pasted = [];
let finish = null;

export const fakeHelper = {
  async paste(text) {
    pasted.push(text);
    return { ok: true, reason: null };
  },
  // Real esc presses and mouse clicks aren't captured
  capture() {},
  release() {},
  stop() {},
};

/** Called by the main process when a dictation reaches an outcome (success or failure) */
export function onFinished(outcome) {
  finish?.(outcome);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the local model is loaded. Starts the download for an undownloaded model on the user's behalf (the app never downloads on its own), reporting every 10%. Returns at once outside local mode
 * @param {() => object | null} localModel the local model state the service reports (localModel in app/service.mjs)
 * @param {(id: string) => Promise<{ ok: boolean, problem?: object }>} downloadModel the library's download (models/library.mjs)
 * @returns {Promise<{ downloadMs: number, loadMs: number, backend: string } | { failed: string } | null>}
 */
async function waitForLocalModel(localModel, downloadModel) {
  if (!localModel() || localModel().state === "off") return null;
  const startedAt = performance.now();
  let downloadedAt = null;
  let reported = -1;
  let asked = false;
  for (;;) {
    const local = localModel();
    if (local.state === "failed") return { failed: JSON.stringify(local.problem) };
    if (local.state === "missing" && !local.total && !asked) {
      asked = true;
      const started = await downloadModel(local.model);
      if (!started.ok) return { failed: JSON.stringify(started.problem) };
    } else if (local.state === "missing" && local.total) {
      const percent = Math.floor((local.received / local.total) * 10) * 10;
      if (percent !== reported) console.log(`Local model downloading ${percent}%`);
      reported = percent;
    } else if (local.state !== "missing" && downloadedAt === null) downloadedAt = performance.now();
    if (local.state === "ready") {
      return {
        downloadMs: Math.round(downloadedAt - startedAt),
        loadMs: Math.round(performance.now() - downloadedAt),
        backend: local.backend,
      };
    }
    await sleep(200);
  }
}

export async function run({ bar, history, localModel, downloadModel, quit }) {
  const done = (result, code) => {
    writeFileSync(OUT_PATH, JSON.stringify({ ...result, pasted, history: history.list() }, null, 2));
    quit(code);
  };
  const local = await waitForLocalModel(localModel, downloadModel);
  if (local?.failed) return done({ failed: `The local model failed to load: ${local.failed}` }, 1);
  const giveUp = setTimeout(() => done({ failed: `No outcome after ${GIVE_UP_MS / 1000} s` }, 1), GIVE_UP_MS);
  const outcome = new Promise((resolve) => {
    finish = resolve;
  });

  // The page may already be loaded by now, in which case did-finish-load never fires
  if (bar.webContents.isLoading()) {
    await new Promise((resolve) => bar.webContents.once("did-finish-load", resolve));
  }
  const press = async () => {
    bar.webContents.send("input", { event: "hotkey", down: true });
    await sleep(120);
    bar.webContents.send("input", { event: "hotkey", down: false });
  };
  await sleep(500);
  await press();
  await sleep(RECORD_MS);
  await press();

  const result = await outcome;
  clearTimeout(giveUp);
  done({ ...result, ...(local ? { localModel: local } : {}) }, result.failed ? 1 : 0);
}
