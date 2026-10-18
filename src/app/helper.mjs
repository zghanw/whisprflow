import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PASTE_TIMEOUT_MS = 3_000;

/**
 * Starts the native helper (native/main.swift) and talks to it. Both sides speak "one JSON per line".
 * @param {string} command the executable
 * @param {object} options
 * @param {string[]} [options.args]
 * @param {(event: object) => void} options.onEvent receives ready / hotkey / other_key / escape / click,
 *   and exit once when the helper is gone (exited, or never started)
 * @param {{ warn: Function, error: Function }} options.log
 */
export function startHelper(command, { args = [], onEvent, log }) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  /** Paste requests sent without an answer yet: id to { resolve, reject, timer } */
  const pending = new Map();
  let nextId = 1;
  let exited = false;

  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      log.warn("helper_bad_line", { line: line.slice(0, 200) });
      return;
    }
    if (event.event === "pasted") {
      const request = pending.get(event.id);
      if (!request) return;
      pending.delete(event.id);
      clearTimeout(request.timer);
      request.resolve({ ok: event.ok, reason: event.reason ?? null });
    } else if (event.event === "error") {
      log.error("helper_error", { message: event.message });
    } else {
      onEvent(event);
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => log.warn("helper_stderr", { line }));

  /** It's gone: every waiting paste fails, reported up once. Failing to start and exiting midway both come here */
  const gone = (reason, code = null, signal = null) => {
    if (exited) return;
    exited = true;
    rejectAll(reason);
    onEvent({ event: "exit", code, signal });
  };

  child.on("error", (error) => {
    // A missing or non-executable file only raises this event, with no exit after it
    log.error("helper_spawn_failed", { command, error: String(error) });
    gone(error);
  });
  child.on("exit", (code, signal) => gone(new Error("The native helper exited"), code, signal));

  return {
    /**
     * Pastes text into the focused input.
     * @returns {Promise<{ ok: boolean, reason: string | null }>} when ok is false the text stays on the clipboard
     */
    paste(text) {
      if (exited) return Promise.reject(new Error("The native helper is not running"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Paste did not finish in time"));
        }, PASTE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ cmd: "paste", id, text })}\n`);
      });
    },
    /**
     * While dictating: captures esc and mouse clicks in these regions so other apps don't receive them. Captures are reported as escape / click.
     * Does nothing if the helper is gone: the hotkey itself doesn't work then, which was already reported.
     * @param {{ id: string, x: number, y: number, width: number, height: number }[]} regions screen coordinates
     */
    capture(regions) {
      if (!exited) child.stdin.write(`${JSON.stringify({ cmd: "capture", regions })}\n`);
    },
    /** Stop capturing */
    release() {
      if (!exited) child.stdin.write(`${JSON.stringify({ cmd: "release" })}\n`);
    },
    /** Closes stdin; the helper exits on its own */
    stop() {
      child.stdin.end();
    },
  };
}
