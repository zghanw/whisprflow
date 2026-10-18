import { usageReport } from "../../usage/report.mjs";
import { noPositionals, parse, renderOptions } from "../common.mjs";
import { renderUsage } from "../render/usage.mjs";

// whisprflow usage: how much was spent, how many tokens, and how long models took to reply. Opens the history database read-only, without the background app.

export async function usage(args, io) {
  const { values, positionals } = parse(args, { json: { type: "boolean", default: false } });
  noPositionals(positionals, "usage");

  let report = null;
  const db = io.openHistory(io.paths.historyDb, { readOnly: true });
  if (db !== null) {
    try {
      report = usageReport(db, { now: io.now() });
    } finally {
      db.close();
    }
  }
  io.out(values.json ? JSON.stringify(report) : renderUsage(report, renderOptions(io)));
  return 0;
}
