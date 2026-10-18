import { existsSync } from "node:fs";
import { noPositionals, parse, positiveInteger } from "../common.mjs";

// whisprflow logs: the background app's log.

const DEFAULT_LOG_LINES = 40;

export async function logs(args, io) {
  const { values, positionals } = parse(args, {
    lines: { type: "string", short: "n", default: String(DEFAULT_LOG_LINES) },
    follow: { type: "boolean", short: "f", default: false },
  });
  noPositionals(positionals, "logs");
  const lines = positiveInteger(values.lines, "-n");
  if (!existsSync(io.paths.logFile)) {
    io.out(io.t("cli.logs.none", { file: io.paths.logFile }));
    return 0;
  }
  return io.tail({ file: io.paths.logFile, lines, follow: values.follow });
}
