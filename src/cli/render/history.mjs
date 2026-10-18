import { INDENT, paint } from "./text.mjs";

// History (whisprflow history): grouped by day, newest first.

/** Splits out the year, month, day, and "hour:minute" in the given time zone (dayHeading writes the date and weekday in the interface language) */
function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    time: `${parts.hour}:${parts.minute}`,
  };
}

function dayHeading(date, parts, { now, timeZone, t }) {
  const format = (options) => new Intl.DateTimeFormat(t.locale, { timeZone, ...options }).format(date);
  const day = format({ month: "long", day: "numeric" });
  const today = localParts(now, timeZone);
  if (parts.dayKey === today.dayKey) return t("cli.history.today", { date: day });
  if (parts.dayKey === localParts(new Date(now.getTime() - 86_400_000), timeZone).dayKey) {
    return t("cli.history.yesterday", { date: day });
  }
  // Dates outside this year need the year, or there's no telling which year's October 8 it was
  const year = parts.year === today.year ? {} : { year: "numeric" };
  return format({ ...year, month: "long", day: "numeric", weekday: "short" });
}

/**
 * @param {object} view
 * @param {Array<object>} view.rows newest first (the order list() in the history database gives)
 * @param {number} view.total how many entries the database has in all
 * @param {{ color: boolean, now: Date, timeZone?: string, t: Function }} options timeZone defaults to the system's; t translates into the interface language
 */
export function renderHistory({ rows, total }, { color, now, timeZone, t }) {
  const c = paint(color);
  if (rows.length === 0) return `${t("cli.history.empty", { command: c.bold("whisprflow") })}\n`;

  // The text starts after "  14:32  ", and continuation lines indent to the same column
  const continuation = " ".repeat(INDENT.length + 5 + 2);
  const lines = [];
  let currentDay = null;
  for (const entry of rows) {
    const date = new Date(entry.createdAt);
    const parts = localParts(date, timeZone);
    if (parts.dayKey !== currentDay) {
      if (currentDay !== null) lines.push("");
      lines.push(c.bold(dayHeading(date, parts, { now, timeZone, t })));
      currentDay = parts.dayKey;
    }
    const body =
      entry.status === "completed"
        ? entry.refinedText.split("\n")
        : [
            c.red(t("cli.history.failed", { reason: entry.error ?? t("common.unknownReason") })),
            c.dim(
              t("cli.history.recording", {
                seconds: entry.duration.toFixed(1),
                path: entry.audioLocalPath ?? t("cli.history.notSaved"),
              }),
            ),
          ];
    body.forEach((line, index) => {
      if (index === 0) lines.push(`${INDENT}${c.dim(parts.time)}  ${line}`);
      // Blank lines between paragraphs carry no indent, so no trailing spaces are left
      else lines.push(line === "" ? "" : `${continuation}${line}`);
    });
  }

  if (rows.length < total) {
    lines.push("", c.dim(t("cli.history.more", { shown: rows.length, total })));
  }
  lines.push("");
  return lines.join("\n");
}
