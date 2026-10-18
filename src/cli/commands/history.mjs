import { noPositionals, parse, positiveInteger, renderOptions } from "../common.mjs";
import { renderHistory } from "../render/history.mjs";

// whisprflow history: what was said, grouped by day. Opens the history database read-only, without the background app.

export const DEFAULT_HISTORY_LIMIT = 20;

export async function history(args, io) {
  const { values, positionals } = parse(args, {
    limit: { type: "string", short: "n" },
    json: { type: "boolean", default: false },
  });
  noPositionals(positionals, "history");
  const limit = values.limit === undefined ? DEFAULT_HISTORY_LIMIT : positiveInteger(values.limit, "-n");

  let rows = [];
  let total = 0;
  const db = io.openHistory(io.paths.historyDb, { readOnly: true });
  if (db !== null) {
    try {
      rows = db.list({ limit });
      const { dictations, failed } = db.stats();
      total = dictations + failed;
    } finally {
      db.close();
    }
  }
  io.out(values.json ? JSON.stringify(rows) : renderHistory({ rows, total }, renderOptions(io)));
  return 0;
}
