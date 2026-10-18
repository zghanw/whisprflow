import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ControlError, NotRunningError, requestControl, startControlServer, TimeoutError } from "../src/control.mjs";
import { createTranslator } from "../src/i18n/index.mjs";
import { resolvePaths } from "../src/storage/paths.mjs";

const en = createTranslator("en");

let dir;
let socketPath;
let server;
let logged;
const log = {
  info: (event, fields) => logged.push({ level: "info", event, ...fields }),
  warn: (event, fields) => logged.push({ level: "warn", event, ...fields }),
  error: (event, fields) => logged.push({ level: "error", event, ...fields }),
};

beforeEach(() => {
  // Socket paths have a length limit, so the temporary directory has a short name. The address follows the home convention: a socket file on macOS, a named pipe on Windows
  dir = mkdtempSync(join(tmpdir(), "wf-"));
  const paths = resolvePaths({ WHISPRFLOW_HOME: dir });
  mkdirSync(paths.runDir);
  socketPath = paths.controlSocket;
  server = null;
  logged = [];
});
afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("one question, one answer; parameters reach the handler as they are", async () => {
  server = await startControlServer({
    socketPath,
    log,
    handlers: { greet: async ({ name }) => ({ text: `Hello, ${name}` }), ping: () => "pong" },
  });
  assert.deepEqual(await requestControl(socketPath, "greet", { name: "world" }), { text: "Hello, world" });
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("when a handler throws, the other side receives its error message", async () => {
  server = await startControlServer({
    socketPath,
    log,
    handlers: {
      fail: () => {
        throw new Error("This key is invalid");
      },
    },
  });
  await assert.rejects(requestControl(socketPath, "fail"), /This key is invalid/);
});

test("unknown commands are refused", async () => {
  server = await startControlServer({ socketPath, log, handlers: {} });
  await assert.rejects(requestControl(socketPath, "dance"), /dance/);
});

test("errors log only the command name, never the parameters (they may contain a key)", async () => {
  server = await startControlServer({
    socketPath,
    log,
    handlers: {
      "set-key": () => {
        throw new Error("no");
      },
    },
  });
  await assert.rejects(requestControl(socketPath, "set-key", { key: "SECRET-VALUE" }));
  assert.ok(logged.some((entry) => entry.cmd === "set-key"));
  assert.ok(!JSON.stringify(logged).includes("SECRET-VALUE"));
});

/** Only socket files have this: a Windows named pipe isn't on disk, disappears with the process, and has the pipe's own default permissions */
const socketFileOnly = { skip: process.platform === "win32" && "Windows uses a named pipe, not a socket file" };

test("NotRunningError when not running: nobody listening", async () => {
  await assert.rejects(requestControl(socketPath, "ping"), NotRunningError);
});

test("NotRunningError when not running: only a socket file nobody listens on", socketFileOnly, async () => {
  writeFileSync(socketPath, "");
  await assert.rejects(requestControl(socketPath, "ping"), NotRunningError);
});

test("a stale socket file left from last time is cleared and recreated at start", socketFileOnly, async () => {
  // Start one, then close the listener roughly but leave the file, as if the process was killed
  const stale = createServer();
  await new Promise((resolve) => stale.listen(socketPath, resolve));
  stale.unref();
  await new Promise((resolve) => {
    // close deletes the file too, so put a plain file of the same name back after closing
    stale.close(() => resolve());
  });
  writeFileSync(socketPath, "");
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "pong" } });
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("refuses to start when one is already listening, and leaves its socket alone", async () => {
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "first" } });
  await assert.rejects(startControlServer({ socketPath, log, handlers: { ping: () => "second" } }), /already running/);
  assert.equal(await requestControl(socketPath, "ping"), "first");
});

test("the socket is owner read/write only; closing deletes the file", socketFileOnly, async () => {
  server = await startControlServer({ socketPath, log, handlers: {} });
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  await server.close();
  server = null;
  assert.equal(existsSync(socketPath), false);
});

test("gives up in time when the other side never answers", async () => {
  server = await startControlServer({ socketPath, log, handlers: { hang: () => new Promise(() => {}) } });
  await assert.rejects(
    requestControl(socketPath, "hang", {}, { timeoutMs: 100 }),
    (error) => error instanceof TimeoutError && /didn't reply within 0\.1 seconds/.test(en.text(error.problem)),
  );
});

test("not running and not answering are both ControlErrors, so callers can treat them as explained failures together", () => {
  assert.ok(new NotRunningError() instanceof ControlError);
  assert.ok(new TimeoutError("status", 5000) instanceof ControlError);
});

test("one connection handles one command: data arriving mid-way never runs the same command again", async () => {
  let calls = 0;
  let finish;
  server = await startControlServer({
    socketPath,
    log,
    handlers: {
      slow: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const { connect } = await import("node:net");
  const socket = connect(socketPath);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.on("data", () => {});
  socket.write('{"cmd":"slow"}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.write("\n");
  socket.write("\n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish("done");
  await closed;
  assert.equal(calls, 1);
});

test("anything other than one line of JSON gets an error reply and never takes the server down", async () => {
  server = await startControlServer({ socketPath, log, handlers: { ping: () => "pong" } });
  const { connect } = await import("node:net");
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write("this is not JSON\n");
  });
  assert.equal(JSON.parse(reply).ok, false);
  assert.equal(await requestControl(socketPath, "ping"), "pong");
});

test("a peer that accepts the connection and closes without a word (quitting) counts as not running", async () => {
  // Both ways of closing happen: a polite end, or cut off outright
  const ways = [(socket) => socket.resume().end(), (socket) => socket.destroy()];
  for (const hangUp of ways) {
    const quitting = createServer(hangUp);
    await new Promise((resolve) => quitting.listen(socketPath, resolve));
    try {
      await assert.rejects(requestControl(socketPath, "status"), NotRunningError);
    } finally {
      await new Promise((resolve) => quitting.close(resolve));
    }
  }
});
