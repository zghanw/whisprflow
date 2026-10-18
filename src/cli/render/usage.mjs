import { formatSeconds, formatTokens, formatUsd } from "../../usage/format.mjs";
import { displayWidth, INDENT, paint } from "./text.mjs";

// Usage (whisprflow usage): today, this month, and all-time spend, tokens, and model reply times, then all-time totals per model.
// The on-device transcription step gets its own row (no cost, no tokens), so it is clear at a glance which step dictation time goes to and who the money goes to.

const GAP = "   ";

/**
 * Lines up rows and columns: each column is padded to its widest cell; columns marked "right" in align are right-aligned (numbers), the rest left.
 * No trailing spaces
 */
function columns(rows, align) {
  const widths = align.map((_, i) => Math.max(...rows.map((cells) => displayWidth(cells[i]))));
  return rows.map((cells) =>
    cells
      .map((cell, i) => {
        const pad = " ".repeat(widths[i] - displayWidth(cell));
        return align[i] === "right" ? pad + cell : cell + pad;
      })
      .join(GAP)
      .trimEnd(),
  );
}

const waiting = (latency, t) =>
  latency
    ? t("cli.usage.waiting", { median: formatSeconds(latency.medianMs, t), slow: formatSeconds(latency.p90Ms, t) })
    : "-";

/** A model's cost: unknown when none of it is in the price list */
const costOf = ({ costUsd, calls, unpricedCalls }, t) =>
  unpricedCalls === calls ? t("cli.usage.unpriced") : formatUsd(costUsd);

/**
 * @param {{ today: object, month: object, total: object, models: object[] } | null} report from src/usage/report.mjs;
 *   null when there is no history database yet
 * @param {{ color: boolean, t: Function }} options
 */
export function renderUsage(report, { color, t }) {
  const c = paint(color);
  if (report === null || report.total.calls === 0) return `${t("cli.usage.empty")}\n`;
  const { total } = report;

  const periods = columns(
    [
      ["", t("cli.usage.cost"), t("cli.usage.tokens"), t("cli.usage.dictations"), t("cli.usage.latency")],
      ...[
        [t("periods.today"), report.today],
        [t("periods.month"), report.month],
        [t("periods.total"), total],
      ].map(([label, it]) => [
        label,
        formatUsd(it.costUsd),
        formatTokens(it.tokens),
        String(it.dictations),
        waiting(it.latency, t),
      ]),
    ],
    ["left", "right", "right", "right", "left"],
  );
  const models = columns(
    report.models.map((it) => [
      it.local ? t("cli.usage.localModel", { name: it.name }) : `${it.name} ${it.model}`,
      it.local ? t("cli.usage.free") : costOf(it, t),
      it.local ? "-" : formatTokens(it.tokens),
      t("cli.usage.times", { count: it.dictations }),
      it.latency ? t("cli.usage.usually", { median: formatSeconds(it.latency.medianMs, t) }) : "",
    ]),
    ["left", "right", "right", "right", "left"],
  );

  const notes = [
    t("cli.usage.tokensNote", {
      input: formatTokens(total.inputTokens),
      audio: formatTokens(total.audioTokens),
      cached: formatTokens(total.cachedTokens),
      output: formatTokens(total.outputTokens),
      thinking: formatTokens(total.thinkingTokens),
    }),
  ];
  if (total.checks > 0) notes.push(t("cli.usage.checksNote", { count: total.checks }));
  if (total.cacheCostUsd > 0) notes.push(t("cli.usage.cacheNote", { cost: formatUsd(total.cacheCostUsd) }));
  const unpriced = report.models.filter(({ unpricedCalls }) => unpricedCalls > 0);
  if (unpriced.length > 0) {
    notes.push(
      t("cli.usage.unpricedNote", { models: t.list(unpriced.map(({ model }) => model)), count: total.unpricedCalls }),
    );
  }
  notes.push(t("cli.usage.estimateNote"));

  return [
    c.bold(t("cli.usage.title")),
    "",
    `${INDENT}${c.dim(periods[0])}`,
    ...periods.slice(1).map((line) => `${INDENT}${line}`),
    "",
    `${INDENT}${c.bold(t("cli.usage.byModel"))}`,
    ...models.map((line) => `${INDENT}${line}`),
    "",
    ...notes.map((note) => c.dim(`${INDENT}${note}`)),
    "",
  ].join("\n");
}
