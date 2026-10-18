import { formatSeconds, formatTokens, formatUsd } from "../../usage/format.mjs";
import { keycapOf, t } from "../shared/i18n.mjs";

// History: grouped by day (Today, Yesterday, then dates), one entry per row, with copy and details appearing on hover.
// Each row has only the time and text; recording length, model time, and cost are in the details tooltip.

const $ = (id) => document.getElementById(id);

const clock = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat(t.locale, { month: "long", day: "numeric", weekday: "long" });
const longDayWithYear = new Intl.DateTimeFormat(t.locale, {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Group headings: Today, Yesterday, then month, day, and weekday (with the year if not this year) */
function dayTitle(day, now) {
  const today = startOfDay(now);
  const days = Math.round((today - day) / 86_400_000);
  if (days === 0) return t("history.today");
  if (days === 1) return t("history.yesterday");
  return (day.getFullYear() === now.getFullYear() ? longDay : longDayWithYear).format(day);
}

function formatDuration(seconds) {
  const whole = Math.round(seconds);
  return whole < 60
    ? t("units.seconds", { value: whole })
    : t("units.minutesSeconds", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}

/** Details: how long the recording was, how long the model took, what it cost, token details */
function detailsOf(row) {
  const lines = [t("history.recording", { duration: formatDuration(row.duration) })];
  if (row.usage) {
    const cost = row.usage.costUsd === null ? t("history.unpriced") : formatUsd(row.usage.costUsd);
    lines.push(t("history.model", { latency: formatSeconds(row.usage.latencyMs, t), cost }));
    const tokens = { input: formatTokens(row.usage.inputTokens), output: formatTokens(row.usage.outputTokens) };
    lines.push(
      row.usage.calls > 1
        ? t("history.tokensCalls", { ...tokens, calls: row.usage.calls })
        : t("history.tokens", tokens),
    );
  }
  return lines.join("\n");
}

export function createHistory() {
  const dayTemplate = $("history-day");
  const rowTemplate = $("history-row");

  function renderRow(row) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    const time = node.querySelector("time");
    time.dateTime = row.createdAt;
    time.textContent = clock.format(new Date(row.createdAt));

    const text = node.querySelector(".entry-text");
    const copy = node.querySelector(".copy");
    if (row.status === "failed") {
      node.dataset.kind = "failed";
      // The failure reason is the sentence on screen at the time, recorded in history, and doesn't change with the language
      text.dataset.prefix = t("history.failed");
      text.textContent = row.error;
      copy.hidden = true;
    } else if (row.refinedText === "") {
      // No speech in this recording
      node.dataset.kind = "silent";
      text.textContent = t("history.silent");
      copy.hidden = true;
    } else {
      text.textContent = row.refinedText;
      copy.addEventListener("click", async () => {
        try {
          await window.whisprflow.copyText(row.refinedText);
          copy.dataset.done = "";
          copy.title = t("history.copied");
        } catch (error) {
          console.error("Copy failed", error);
          copy.title = t("history.copyFailed");
        }
        setTimeout(() => {
          delete copy.dataset.done;
          copy.title = t("history.copy");
        }, 1500);
      });
    }

    const details = node.querySelector(".details");
    details.title = detailsOf(row);
    details.setAttribute("aria-label", details.title);
    return node;
  }

  return {
    /**
     * @param {{ rows: object[], app: { hotkey: string } }} data
     */
    render({ rows, app }) {
      $("history-error").hidden = true;
      $("history-empty").hidden = rows.length > 0;
      $("history-empty").textContent = t("history.empty", { keycap: keycapOf(app.hotkey) });

      const now = new Date();
      const groups = [];
      for (const row of rows) {
        const day = startOfDay(new Date(row.createdAt));
        const last = groups.at(-1);
        if (last && last.day.getTime() === day.getTime()) last.rows.push(row);
        else groups.push({ day, rows: [row] });
      }
      $("history-days").replaceChildren(
        ...groups.map(({ day, rows: dayRows }) => {
          const node = dayTemplate.content.firstElementChild.cloneNode(true);
          node.querySelector(".day-title").textContent = dayTitle(day, now);
          node.querySelector(".entries").replaceChildren(...dayRows.map(renderRow));
          return node;
        }),
      );
    },

    showError(message) {
      $("history-error").textContent = t("history.loadError", { reason: message });
      $("history-error").hidden = false;
    },
  };
}
