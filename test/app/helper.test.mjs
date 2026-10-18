import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { startHelper } from "../../src/app/helper.mjs";

// A small Node script stands in for the native helper: it reports ready and one hotkey press at start, and answers paste by the text's content;
// capture acts as if the user clicked the first marked region, and release reports the received command back as is
const FAKE_HELPER = `
const emit = (o) => console.log(JSON.stringify(o));
emit({ event: "ready", listen: true, trusted: true });
emit({ event: "hotkey", down: true });
console.log("this line is not JSON");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.cmd === "capture") return emit({ event: "click", id: command.regions[0]?.id ?? null, regions: command.regions });
  if (command.cmd === "release") return emit({ event: "escape", got: command });
  const { id, text } = command;
  if (text === "no reply") return;
  if (text === "exit") process.exit(3);
  emit({ event: "pasted", id, ok: text !== "no access", ...(text === "no access" ? { reason: "not_trusted" } : {}) });
}).on("close", () => process.exit(0));
`;

function start() {
  const events = new EventEmitter();
  const seen = [];
  const warnings = [];
  const helper = startHelper(process.execPath, {
    args: ["-e", FAKE_HELPER],
    onEvent: (event) => {
      seen.push(event);
      events.emit(event.event, event);
    },
    log: { warn: (name) => warnings.push(name), error: (name) => warnings.push(name) },
  });
  return { helper, events, seen, warnings };
}

test("key events are forwarded; a non-JSON line logs a warning and does not affect what follows", async () => {
  const { helper, events, seen, warnings } = start();
  await once(events, "hotkey");
  assert.deepEqual(seen, [
    { event: "ready", listen: true, trusted: true },
    { event: "hotkey", down: true },
  ]);
  assert.deepEqual(await helper.paste("hello"), { ok: true, reason: null });
  assert.deepEqual(warnings, ["helper_bad_line"]);
  helper.stop();
  const [exit] = await once(events, "exit");
  assert.equal(exit.code, 0);
});

test("without Accessibility access, paste returns ok false with the reason", async () => {
  const { helper } = start();
  assert.deepEqual(await helper.paste("no access"), { ok: false, reason: "not_trusted" });
  helper.stop();
});

test("two pastes each get their own answer", async () => {
  const { helper } = start();
  const results = await Promise.all([helper.paste("first"), helper.paste("no access")]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false],
  );
  helper.stop();
});

test("start and stop capturing: commands go through as is, and captured clicks and esc come back up", async () => {
  const { helper, events } = start();
  const regions = [
    { id: "cancel", x: 700, y: 900, width: 28, height: 28 },
    { id: "confirm", x: 812, y: 900, width: 28, height: 28 },
  ];
  const clicked = once(events, "click");
  helper.capture(regions);
  assert.deepEqual((await clicked)[0], { event: "click", id: "cancel", regions });
  const escaped = once(events, "escape");
  helper.release();
  assert.deepEqual((await escaped)[0], { event: "escape", got: { cmd: "release" } });
  helper.stop();
});

test("start or stop capturing after the helper is gone does nothing and throws nothing", async () => {
  const { helper, events } = start();
  const exited = once(events, "exit");
  helper.stop();
  await exited;
  helper.capture([]);
  helper.release();
});

test("the helper exiting midway: the waiting paste fails, and later pastes fail at once", async () => {
  const { helper, events } = start();
  const exited = once(events, "exit");
  await assert.rejects(helper.paste("exit"), /exited/);
  const [exit] = await exited;
  assert.equal(exit.code, 3);
  await assert.rejects(helper.paste("again"), /not running/);
});

test("a missing executable makes paste fail instead of waiting forever, and still reports one exit so callers know it is gone", async () => {
  const errors = [];
  const seen = [];
  const helper = startHelper("/no/such/program", {
    onEvent: (event) => seen.push(event),
    log: { warn() {}, error: (name) => errors.push(name) },
  });
  await assert.rejects(helper.paste("x"));
  assert.ok(errors.includes("helper_spawn_failed"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    seen.map((event) => event.event),
    ["exit"],
  );
  await assert.rejects(helper.paste("again"), /not running/);
});
