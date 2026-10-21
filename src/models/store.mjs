import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { chipOf, DEFAULT_SOURCE, downloadSize, downloadUrls } from "./catalog.mjs";
import { installRuntime as installPythonRuntime, RUNTIME_STAMP } from "./runtime.mjs";

// Model store: downloads the catalog's (catalog.mjs) models to this computer, verifies, lists, and deletes them. The app and the CLI both use it.
// One directory per model, <store>/<model id>/, with files at their catalog paths. Each file is written as .part and renamed only once its sha256 matches;
// when all are in, a receipt .complete.json is written (the pinned commit and every file's sha256). Installed means a receipt that matches the catalog.
// A model with a runtime (runtime.mjs) has it installed after its files and before the receipt; the receipt then also names the runtime's pins.
// Download addresses are tried in turn: the user's chosen source first, the others after (downloadUrls in catalog.mjs).
// Only Node's built-in fetch and file APIs, so it behaves the same on every OS.

const RECEIPT = ".complete.json";

/** How long without a single byte counts as stalled, giving up on that address for the next */
const STALL_MS = 30_000;

/** What the receipt holds: the catalog fields that decide "is this the copy installed" */
const receiptOf = (model) => ({
  id: model.id,
  revision: model.origin.revision,
  files: Object.fromEntries(Object.values(model.files).map((file) => [file.path, file.sha256])),
  ...(model.runtime ? { runtime: RUNTIME_STAMP } : {}),
});

/**
 * @param {object} options
 * @param {string} options.dir where the store lives
 * @param {typeof globalThis.fetch} [options.fetch] replaced by a fake in tests
 * @param {string} [options.source] which download source to try first (SOURCES in catalog.mjs, modelSource in settings)
 * @param {number} [options.stallMs] how long without data counts as stalled; shortened in tests
 * @param {typeof installPythonRuntime} [options.installRuntime] replaced by a fake in tests
 */
export function createModelStore({
  dir,
  fetch = globalThis.fetch,
  source = DEFAULT_SOURCE,
  stallMs = STALL_MS,
  installRuntime = installPythonRuntime,
}) {
  const dirOf = (model) => join(dir, model.id);

  function isInstalled(model) {
    const path = join(dirOf(model), RECEIPT);
    if (!existsSync(path)) return false;
    return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === JSON.stringify(receiptOf(model));
  }

  /** Files already present with the right content aren't downloaded again: a resumed install only fills the gaps */
  async function alreadyThere(path, file) {
    if (!existsSync(path)) return false;
    return (await sha256Of(createReadStream(path))) === file.sha256;
  }

  async function download(model, file, { signal, onProgress }) {
    const target = join(dirOf(model), file.path);
    if (await alreadyThere(target, file)) {
      onProgress?.(file.size);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const failures = [];
    for (const url of downloadUrls(model, file, source)) {
      try {
        await fetchTo(url, target, file, { signal, onProgress });
        return;
      } catch (error) {
        // A cancel by the user doesn't move on to the next address
        if (signal?.aborted) throw error;
        failures.push(`${url}: ${error.message}`);
      }
    }
    throw new Error(`${file.path} failed from every address:\n${failures.join("\n")}`);
  }

  /** Downloads one file from one address: written as .part, renamed once size and sha256 match. Gives up after stalling for stallMs */
  async function fetchTo(url, target, file, { signal, onProgress }) {
    const stall = new AbortController();
    let timer;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error(`No data for ${stallMs / 1000} s`)), stallMs);
    };
    const aborted = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
    const partial = `${target}.part`;
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        kick();
        hash.update(chunk);
        received += chunk.length;
        onProgress?.(received);
        done(null, chunk);
      },
    });
    kick();
    try {
      const response = await fetch(url, { signal: aborted, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial), { signal: aborted });
      if (received !== file.size)
        throw new Error(`${file.path} downloaded ${received} bytes, the catalog says ${file.size}`);
      const digest = hash.digest("hex");
      if (digest !== file.sha256)
        throw new Error(`${file.path} sha256 mismatch: downloaded ${digest}, the catalog says ${file.sha256}`);
      renameSync(partial, target);
    } catch (error) {
      rmSync(partial, { force: true });
      // A stalled fetch reports "aborted"; report the stall instead
      throw stall.signal.aborted && !signal?.aborted ? stall.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    dirOf,
    isInstalled,

    /**
     * Downloads and verifies all of a model's files. Returns at once if already installed.
     * @param {{ signal?: AbortSignal, onProgress?: (p: { received: number, total: number }) => void }} [options]
     *   onProgress: progress counts the whole model, with finished files counted in full
     * @returns {Promise<string>} the model directory
     */
    async install(model, { signal, onProgress } = {}) {
      if (isInstalled(model)) return dirOf(model);
      // The receipt goes last: a failed or interrupted install has none, so the next one continues filling gaps
      rmSync(join(dirOf(model), RECEIPT), { force: true });
      const total = downloadSize(model);
      let done = 0;
      for (const file of Object.values(model.files)) {
        await download(model, file, {
          signal,
          onProgress: (received) => onProgress?.({ received: done + received, total }),
        });
        done += file.size;
      }
      if (model.runtime) {
        await installRuntime({
          model,
          dir: dirOf(model),
          chip: chipOf(),
          signal,
          onProgress: (fraction) =>
            onProgress?.({ received: done + Math.round(fraction * model.runtime.bytes), total }),
        });
      }
      writeFileSync(join(dirOf(model), RECEIPT), JSON.stringify(receiptOf(model), null, 2));
      return dirOf(model);
    },

    /**
     * Bytes still to download: files not yet in place, at their catalog sizes (content is not checked here; downloading checks it), plus the runtime
     * until the model is installed (each install starts it over). Used for the disk check
     */
    missingBytes(model) {
      return Object.values(model.files)
        .filter((file) => !existsSync(join(dirOf(model), file.path)))
        .reduce((sum, file) => sum + file.size, model.runtime && !isInstalled(model) ? model.runtime.bytes : 0);
    },

    /** Deletes a model's whole directory. Does nothing if it was never installed */
    remove(model) {
      rmSync(dirOf(model), { recursive: true, force: true });
    },

    /** Ids of installed models (directories with a receipt) */
    installed() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, RECEIPT)))
        .map((entry) => entry.name)
        .sort();
    },
  };
}

async function sha256Of(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
