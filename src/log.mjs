// One line of JSON per log entry: time, level, event name, plus the context at the time (which recording, how many chunks, how many bytes, how long).
// Errors and warnings go to standard error, the rest to standard output. Shared by the background app and a separately started server.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
let logFile = null;

/**
 * Logs also go to a file. Installed as an app there is no terminal to watch, so troubleshooting relies on it.
 * At start, a file over 5 MB is renamed to .old as the previous one, and writing starts fresh.
 */
export function alsoLogTo(file) {
  rotateIfLarge(file);
  logFile = file;
}

/** Gets this file ready for appending logs: creates the directory if missing, and renames the file aside as the previous one if too big */
export function rotateIfLarge(file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function write(stream, level, event, fields) {
  const line = `${JSON.stringify({ t: new Date().toISOString(), level, event, ...fields })}\n`;
  stream.write(line);
  if (logFile === null) return;
  try {
    appendFileSync(logFile, line);
  } catch (error) {
    // A file that can't be written (disk full, directory deleted) mustn't break normal function: stop the file output and leave one line on standard error
    const failedFile = logFile;
    logFile = null;
    process.stderr.write(
      `${JSON.stringify({ t: new Date().toISOString(), level: "error", event: "log_file_failed", file: failedFile, error: String(error) })}\n`,
    );
  }
}

export const log = {
  info: (event, fields = {}) => write(process.stdout, "info", event, fields),
  warn: (event, fields = {}) => write(process.stderr, "warn", event, fields),
  error: (event, fields = {}) => write(process.stderr, "error", event, fields),
};
