import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDelivery } from "../../src/app/delivery.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

// Checked with the macOS wording (Cmd+V); the Windows wording is checked in the i18n test
const en = createTranslator("en", "darwin");

const AUDIO_ID = "0b6f1c1e-5a44-4f0e-9d0b-2f9f3a1c7e55";
const audio = () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 7]).buffer;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whisprflow-delivery-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(paste = async () => ({ ok: true, reason: null })) {
  const rows = [];
  const pasted = [];
  const clipboard = [];
  const delivery = createDelivery({
    recordingsDir: join(dir, "Recordings"),
    history: { add: (row) => rows.push(row) },
    paste: (text) => {
      pasted.push(text);
      return paste(text);
    },
    writeClipboard: (text) => clipboard.push(text),
    log: { warn() {}, error() {} },
    now: () => new Date("2026-10-13T08:00:00.000Z"),
  });
  return { delivery, rows, pasted, clipboard };
}

const payload = (overrides = {}) => ({
  audioId: AUDIO_ID,
  text: "We meet on Friday.",
  durationSeconds: 4.2,
  audio: audio(),
  ...overrides,
});

test("a result: save the recording, record history, paste", async () => {
  const { delivery, rows, pasted } = setup();
  assert.deepEqual(await delivery.completed(payload()), { notice: null });

  const audioLocalPath = join(dir, "Recordings", `${AUDIO_ID}.webm`);
  assert.deepEqual([...readFileSync(audioLocalPath)], [0x1a, 0x45, 0xdf, 0xa3, 7]);
  assert.deepEqual(rows, [
    {
      id: AUDIO_ID,
      status: "completed",
      refinedText: "We meet on Friday.",
      error: null,
      duration: 4.2,
      audioLocalPath,
      createdAt: "2026-10-13T08:00:00.000Z",
    },
  ]);
  assert.deepEqual(pasted, ["We meet on Friday."]);
});

test("nothing heard: recorded in history but not pasted", async () => {
  const { delivery, rows, pasted } = setup();
  const { notice: silent } = await delivery.completed(payload({ text: "" }));
  assert.equal(en.text(silent), "Didn't hear anything");
  assert.equal(rows.length, 1);
  assert.deepEqual(pasted, []);
});

test("no Accessibility access: the user is told to paste", async () => {
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "not_trusted" }));
  const { notice } = await delivery.completed(payload());
  assert.match(en.text(notice), /No Accessibility access.*⌘V/);
  // The helper already wrote the clipboard in this case, so it isn't written again here
  assert.deepEqual(clipboard, []);
});

test("a target window running as administrator on Windows: the helper did not press Ctrl+V, the text stays on the clipboard, and the user is told to paste", async () => {
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "elevated" }));
  const { notice } = await delivery.completed(payload());
  assert.match(en.text(notice), /administrator.*Ctrl\+V/);
  assert.deepEqual(clipboard, []);
});

test("the helper could not write the clipboard on Windows (clipboard): it is written again here and the user told to paste, without mentioning Accessibility", async () => {
  const win = createTranslator("en", "win32");
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "clipboard" }));
  const { notice } = await delivery.completed(payload());
  assert.equal(win.text(notice), "Couldn't paste: text copied, press Ctrl+V to paste");
  assert.deepEqual(clipboard, ["We meet on Friday."]);
});

test("simulated keys failed on Windows (send_input): the text is already on the clipboard; the user is told to paste, without mentioning Accessibility", async () => {
  const win = createTranslator("en", "win32");
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "send_input" }));
  const { notice } = await delivery.completed(payload());
  assert.equal(win.text(notice), "Couldn't paste: text copied, press Ctrl+V to paste");
  assert.deepEqual(clipboard, []);
});

test("a paste error: the text goes to the clipboard and history is still recorded", async () => {
  const { delivery, rows, clipboard } = setup(async () => {
    throw new Error("the native helper exited");
  });
  const { notice } = await delivery.completed(payload());
  assert.match(en.text(notice), /Couldn't paste.*⌘V/);
  assert.deepEqual(clipboard, ["We meet on Friday."]);
  assert.equal(rows.length, 1);
});

test("a failed dictation keeps the recording and the reason", () => {
  const { delivery, rows, pasted } = setup();
  delivery.failed({ audioId: AUDIO_ID, error: "No result after 20 s", durationSeconds: 9, audio: audio() });
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].refinedText, "");
  assert.equal(rows[0].error, "No result after 20 s");
  assert.ok(existsSync(rows[0].audioLocalPath));
  assert.deepEqual(pasted, []);
});

test("a recording that is part of a buffer saves only that part", async () => {
  const { delivery, rows } = setup();
  const whole = Uint8Array.from([9, 9, 0x1a, 0x45, 9]);
  await delivery.completed(payload({ audio: whole.subarray(2, 4) }));
  assert.deepEqual([...readFileSync(rows[0].audioLocalPath)], [0x1a, 0x45]);
});

test("invalid parameters from the page are refused, with no files written", async () => {
  const { delivery, rows } = setup();
  const bad = [
    payload({ audioId: "../../etc/passwd" }),
    payload({ audioId: `${AUDIO_ID}/x` }),
    payload({ durationSeconds: Number.NaN }),
    payload({ audio: "not binary" }),
    payload({ text: 42 }),
  ];
  for (const item of bad) await assert.rejects(delivery.completed(item), TypeError);
  assert.throws(() => delivery.failed(payload({ error: undefined })), TypeError);
  assert.deepEqual(rows, []);
  assert.equal(existsSync(join(dir, "Recordings")) ? readdirSync(join(dir, "Recordings")).length : 0, 0);
});
