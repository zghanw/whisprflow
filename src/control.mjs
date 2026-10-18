import { chmodSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { LocalizedError, msg } from "./i18n/index.mjs";

// The control channel between the CLI and the background app: a Unix socket in the data directory, reachable only by the same user on this machine.
// On Windows it is a named pipe (name in storage/paths.mjs): Node's net handles both, and only "clear the stale file, tighten permissions"
// apply to socket files. A pipe isn't on disk and disappears with the process; its default permissions give the creator, SYSTEM, and administrators full control,
// and other accounts can at most read, never send commands.
// One question and one answer per connection, each a line of JSON:
//   {"cmd": "status", "params": {...}}  ->  {"ok": true, "result": ...}  or  {"ok": false, "error": "...", "problem": ...}
// On errors, error is a sentence (English), and problem is the sentence for people (msg), translated by the CLI into its language.
// The CLI passes its language in params (locale), and the background translates the sentences for people in its answer into it

/** The longest a request may be, in bytes. Normal requests are tens of bytes; the one carrying a key is under two hundred */
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** A failure the control layer can explain. Callers tell the user its problem; no stack trace needed */
export class ControlError extends LocalizedError {}

/** The background app isn't running */
export class NotRunningError extends ControlError {
  constructor() {
    super(msg("control.notRunning"));
    this.name = "NotRunningError";
  }
}

/** Someone is listening but didn't answer in time: most likely stuck */
export class TimeoutError extends ControlError {
  constructor(cmd, timeoutMs) {
    super(msg("control.timeout", { seconds: timeoutMs / 1000, command: cmd }));
    this.name = "TimeoutError";
  }
}

/** The exit code a background app uses when it finds one already running, telling the command that started it: "I'm not broken, another one is here" */
export const ALREADY_RUNNING_EXIT_CODE = 3;

// The first three mean nobody is listening at all; the last two mean connected and then cut off, which only happens while it is quitting
const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ECONNRESET", "EPIPE"]);

/**
 * Sends a command and waits for the answer.
 * @returns {Promise<unknown>} what the other side's handler returned
 * @throws {NotRunningError} nobody is listening
 */
export function requestControl(socketPath, cmd, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TimeoutError(cmd, timeoutMs));
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      reject(NOT_RUNNING_CODES.has(error.code) ? new NotRunningError() : error);
    };

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ cmd, params })}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
    });
    socket.on("error", fail);
    socket.on("end", () => {
      clearTimeout(timer);
      // Accepted the connection, then closed without a word: it is quitting and didn't get to answer
      if (received === "") {
        reject(new NotRunningError());
        return;
      }
      let reply;
      try {
        reply = JSON.parse(received);
      } catch {
        reject(new ControlError(msg("control.unreadable", { command: cmd })));
        return;
      }
      if (reply.ok) resolve(reply.result);
      // Errors the background can explain (with a problem) are translated to the CLI's language; others are shown as they are
      else reject(reply.problem ? new LocalizedError(reply.problem) : new Error(reply.error));
    });
  });
}

/** A Windows named pipe rather than a socket file on disk */
const isNamedPipe = (socketPath) => socketPath.startsWith("\\\\.\\pipe\\");

/** Whether anyone is listening on this socket now */
async function isAlive(socketPath) {
  try {
    await requestControl(socketPath, "", {}, { timeoutMs: 1_000 });
  } catch (error) {
    if (error instanceof NotRunningError) return false;
  }
  // Anyone answering (even with "unknown command") or holding the line without answering counts as present
  return true;
}

/**
 * Starts listening for commands on the socket.
 * @param {object} options
 * @param {string} options.socketPath
 * @param {Record<string, (params: object) => unknown>} options.handlers command name to handler; the return value is the answer
 * @param {{ warn: Function }} options.log
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function startControlServer({ socketPath, handlers, log }) {
  if (await isAlive(socketPath)) throw new Error("Another instance is already running");
  // Getting here means even if the file exists nobody listens: left over from a process that didn't exit cleanly
  if (!isNamedPipe(socketPath)) rmSync(socketPath, { force: true });

  const server = createServer((socket) => {
    let received = "";
    let answered = false;
    /** A command was taken and is being handled. One connection does one thing; later data is ignored */
    let handling = false;
    const answer = (reply) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(reply)}\n`);
    };

    socket.setEncoding("utf8");
    // This errors when the other side disconnects midway; nothing to do, but unhandled it would crash the whole process
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (answered || handling) return;
      received += chunk;
      if (Buffer.byteLength(received) > MAX_REQUEST_BYTES) {
        answer({ ok: false, error: "Request too long" });
        return;
      }
      const end = received.indexOf("\n");
      if (end === -1) return;
      handling = true;

      let request;
      try {
        request = JSON.parse(received.slice(0, end));
      } catch {
        answer({ ok: false, error: "Request is not one line of JSON" });
        return;
      }
      const handler = Object.hasOwn(handlers, request?.cmd) ? handlers[request.cmd] : null;
      if (!handler) {
        answer({ ok: false, error: `Unknown command: ${JSON.stringify(request?.cmd)}` });
        return;
      }
      try {
        answer({ ok: true, result: (await handler(request.params ?? {})) ?? null });
      } catch (error) {
        // Log only the command name: the parameters may contain a key
        log.warn("control_failed", { cmd: request.cmd, error: String(error?.message ?? error).slice(0, 300) });
        answer({
          ok: false,
          error: String(error?.message ?? error),
          ...(error?.problem ? { problem: error.problem } : {}),
        });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!isNamedPipe(socketPath)) chmodSync(socketPath, 0o600);

  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          if (!isNamedPipe(socketPath)) rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
