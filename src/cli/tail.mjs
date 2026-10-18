import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile } from "node:fs";

// Used by whisprflow logs on systems without tail (Windows): prints the last lines first, and with -f keeps printing what is written next until Ctrl-C.
// macOS still uses the system tail.

/** The last lines lines of the file (all of it if it has fewer) */
export function lastLines(text, lines) {
  const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return all.slice(-lines).join("\n");
}

/** Reads from position from to the end of the file */
function readFrom(file, from, size) {
  const length = size - from;
  if (length <= 0) return "";
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, from);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

/**
 * @param {string} file
 * @param {{ lines: number, follow: boolean, write: (text: string) => void, intervalMs?: number }} options
 * @returns {Promise<number>} exit code; with -f it only returns after Ctrl-C
 */
export function tailFile(file, { lines, follow, write, intervalMs = 500 }) {
  let size = statSync(file).size;
  const head = lastLines(readFrom(file, 0, size), lines);
  if (head) write(`${head}\n`);
  if (!follow) return Promise.resolve(0);
  return new Promise((resolve) => {
    watchFile(file, { interval: intervalMs }, (current) => {
      // When the log is rotated (shrinks), read the new one from the start
      if (current.size < size) size = 0;
      const added = readFrom(file, size, current.size);
      size = current.size;
      if (added) write(added);
    });
    process.once("SIGINT", () => {
      unwatchFile(file);
      resolve(0);
    });
  });
}
