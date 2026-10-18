import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { downloadSize, findModel } from "../../src/models/catalog.mjs";
import { createLocalModels } from "../../src/models/library.mjs";

const en = createTranslator("en");
const quiet = { info() {}, warn() {}, error() {} };
const QWEN = findModel("qwen3-asr-0.6b-q8");
const CPU = findModel("qwen3-asr-0.6b-int8");
const GB = 1_000_000_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Fake model store: installed lists the installed ids; install doesn't download, control reports progress, completion, and errors by hand.
 * Every createStore call records which source it used
 */
function setUp({ installed = [], free = 100 * GB, partial = {} } = {}) {
  const control = { installed: new Set(installed), sources: [], jobs: new Map(), removed: [] };
  const createStore = ({ source }) => {
    control.sources.push(source);
    return {
      isInstalled: (model) => control.installed.has(model.id),
      missingBytes: (model) => (control.installed.has(model.id) ? 0 : downloadSize(model) - (partial[model.id] ?? 0)),
      remove: (model) => {
        control.removed.push(model.id);
        control.installed.delete(model.id);
      },
      install: (model, { signal, onProgress }) =>
        new Promise((resolve, reject) => {
          const job = {
            progress: (received) => onProgress({ received, total: downloadSize(model) }),
            finish: () => {
              control.installed.add(model.id);
              resolve();
            },
            fail: (error) => reject(error),
          };
          control.jobs.set(model.id, job);
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
        }),
    };
  };
  const changed = [];
  const models = createLocalModels({
    dir: "/models",
    source: "original",
    log: quiet,
    onChange: (id) => changed.push(id),
    createStore,
    freeBytes: () => free,
  });
  return { control, models, changed };
}

test("list: whether each model is downloaded, how far a download is, why the last one failed; listing never downloads", () => {
  const { models, control } = setUp({ installed: [CPU.id] });
  const list = models.list();
  assert.equal(list.length >= 2, true);
  assert.deepEqual(
    list.find(({ id }) => id === CPU.id),
    {
      id: CPU.id,
      installed: true,
      download: null,
      partial: 0,
      problem: null,
    },
  );
  assert.equal(list.find(({ id }) => id === QWEN.id).installed, false);
  assert.equal(control.jobs.size, 0);
});

test("download: only when the user asks; progress goes to the page; done counts as installed and notifies", async () => {
  const { models, control, changed } = setUp();
  assert.deepEqual(await models.download(QWEN.id), { ok: true });
  assert.deepEqual(models.status(QWEN.id).download, { received: 0, total: downloadSize(QWEN) });
  control.jobs.get(QWEN.id).progress(downloadSize(QWEN));
  control.jobs.get(QWEN.id).finish();
  await tick();
  assert.equal(models.isInstalled(QWEN.id), true);
  assert.equal(models.status(QWEN.id).download, null);
  assert.ok(changed.filter((id) => id === QWEN.id).length >= 2);
});

test("disk check before downloading: if free space can not hold what is missing (plus headroom), it does not start and says how much is needed and free", async () => {
  const { models, control } = setUp({ free: 500_000_000 });
  const result = await models.download(QWEN.id);
  assert.equal(result.ok, false);
  assert.match(en.text(result.problem), /Not enough disk space.*Qwen3-ASR.*850 MB.*500 MB/);
  assert.equal(control.jobs.size, 0);
});

test("a half-finished download only counts what is left; the list reports how much is already there", async () => {
  const half = Math.round(downloadSize(QWEN) / 2);
  const { models } = setUp({ free: downloadSize(QWEN) - half + 300_000_000, partial: { [QWEN.id]: half } });
  assert.equal(models.status(QWEN.id).partial, half);
  assert.deepEqual(await models.download(QWEN.id), { ok: true });
});

test("asking again for an installed or downloading model does nothing; an unknown model says so", async () => {
  const { models, control } = setUp({ installed: [CPU.id] });
  assert.deepEqual(await models.download(CPU.id), { ok: true });
  await models.download(QWEN.id);
  await models.download(QWEN.id);
  assert.equal(control.sources.length, 1);
  const unknown = await models.download("nope");
  assert.equal(unknown.ok, false);
  assert.match(en.text(unknown.problem), /nope/);
});

test("cancel: stops without counting as failed; finished files stay for next time", async () => {
  const { models, control } = setUp();
  await models.download(QWEN.id);
  models.cancel(QWEN.id);
  await tick();
  assert.equal(models.status(QWEN.id).download, null);
  assert.equal(models.status(QWEN.id).problem, null);
  assert.deepEqual(control.removed, []);
  // Cancelling something that isn't downloading is fine too
  models.cancel(CPU.id);
});

test("a failed download records why, visible in the list; downloading again clears it and retries", async () => {
  const { models, control } = setUp();
  await models.download(QWEN.id);
  control.jobs.get(QWEN.id).fail(new Error("Every address failed"));
  await tick();
  assert.match(en.text(models.status(QWEN.id).problem), /didn't download.*Every address failed/);
  await models.download(QWEN.id);
  assert.equal(models.status(QWEN.id).problem, null);
});

test("delete removes it entirely; a download in progress is stopped first", async () => {
  const { models, control } = setUp({ installed: [CPU.id] });
  assert.deepEqual(models.remove(CPU.id), { ok: true });
  assert.equal(models.isInstalled(CPU.id), false);
  await models.download(QWEN.id);
  models.remove(QWEN.id);
  await tick();
  assert.deepEqual(control.removed, [CPU.id, QWEN.id]);
  assert.equal(models.status(QWEN.id).download, null);
  assert.equal(models.status(QWEN.id).problem, null);
});

test("changing the download source: a download in progress continues from the new source without failing; later downloads use it too", async () => {
  const { models, control } = setUp();
  await models.download(QWEN.id);
  models.setSource("mirror");
  await tick();
  assert.deepEqual(control.sources, ["original", "mirror"]);
  assert.equal(models.status(QWEN.id).problem, null);
  assert.notEqual(models.status(QWEN.id).download, null);
  await models.download(CPU.id);
  assert.equal(control.sources.at(-1), "mirror");
});

test("closing stops every download", async () => {
  const { models } = setUp();
  await models.download(QWEN.id);
  await models.download(CPU.id);
  models.close();
  await tick();
  assert.equal(models.status(QWEN.id).download, null);
  assert.equal(models.status(CPU.id).download, null);
});
