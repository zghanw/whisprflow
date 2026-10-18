import { formatCount, formatSeconds, formatSpan, formatTokens, formatUsd } from "../../usage/format.mjs";
import { activityGrid } from "../../usage/insights.mjs";
import { platformName } from "../shared/dom.mjs";
import { keycapOf, t } from "../shared/i18n.mjs";
import { providerIcon } from "../shared/provider-icons.mjs";
import { slidingIndicators } from "./indicators.mjs";

// Home: the insights column (four numbers, active days, and a heatmap) plus cost; the right column has the dictation card and version.
// The numbers are computed by the main process from all history (src/usage/insights.mjs, src/usage/report.mjs); this only draws.
// Cost is listed per model: which provider, which model, and the on-device step, with how much each cost and how many calls, for today, this month, or all time.

const $ = (id) => document.getElementById(id);

/** How wide each heatmap cell is (with the gap), matching --cell and --gap in hub.css: 0.875rem + 0.375rem */
const CELL_PITCH = 20;
/** The five heatmap levels, named in the copy (home.levels.*); months likewise (months.*) */
const LEVELS = ["none", "light", "moderate", "high", "power"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const dayLabel = new Intl.DateTimeFormat(t.locale, { month: "long", day: "numeric", weekday: "short" });

// The weekday column left of the heatmap (from Sunday): the shortest form in the interface language (S, M...)
const weekday = new Intl.DateTimeFormat(t.locale, { weekday: "narrow" });
document
  .getElementById("heatmap-weekdays")
  .replaceChildren(
    ...Array.from({ length: 7 }, (_, index) =>
      Object.assign(document.createElement("span"), { textContent: weekday.format(new Date(2026, 0, 4 + index)) }),
    ),
  );

/** A number plus a unit a size smaller; two dashes before there is a number */
function setValue(element, value, unit) {
  if (value === null) {
    element.textContent = "--";
    element.dataset.empty = "";
    return;
  }
  delete element.dataset.empty;
  const unitNode = document.createElement("span");
  unitNode.className = "unit";
  unitNode.textContent = unit;
  element.replaceChildren(value, unitNode);
}

function setSpan(element, seconds) {
  const { value, unit } = formatSpan(seconds);
  setValue(element, value, t(`units.${unit}`));
}

/**
 * @param {{ onOpenSettings: () => void }} options
 */
export function createHome() {
  /** The latest stats; the heatmap is redrawn from them when the window gets wider or narrower */
  let latest = null;
  /** How many pages back the heatmap is (a page is as many weeks as fit now); 0 is the latest */
  let pagesBack = 0;
  let weeks = 0;

  function renderStats(insights) {
    const empty = insights.activeDays === 0;
    setValue($("stat-words"), empty ? null : formatCount(insights.words), t("units.words", { count: insights.words }));
    if (empty) {
      for (const id of ["stat-saved", "stat-time", "stat-speed"]) setValue($(id), null);
    } else {
      setSpan($("stat-saved"), insights.savedSeconds);
      setSpan($("stat-time"), insights.seconds);
      setValue($("stat-speed"), String(insights.wordsPerMinute), t("units.wpm"));
    }
    const days = (count) => t("units.days", { count });
    setValue($("stat-active"), String(insights.activeDays), days(insights.activeDays));
    setValue($("stat-current"), String(insights.currentStreak), days(insights.currentStreak));
    setValue($("stat-longest"), String(insights.longestStreak), days(insights.longestStreak));
  }

  function renderHeatmap() {
    if (latest === null) return;
    const container = $("heatmap-cells");
    // Draw as many weeks as fit, at least one
    weeks = Math.max(1, Math.floor((container.clientWidth + 6) / CELL_PITCH));
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - pagesBack * weeks * 7);
    const grid = activityGrid({ perDay: latest.perDay, firstDay: latest.firstDay, end, today, weeks });

    container.replaceChildren(
      ...grid.columns.flat().map((cell) => {
        const node = document.createElement("span");
        node.className = "cell";
        node.dataset.level = String(cell.level);
        node.dataset.state = cell.state;
        if (cell.state !== "future") {
          const [year, month, date] = cell.day.split("-").map(Number);
          const day = dayLabel.format(new Date(year, month - 1, date));
          const level = t(`home.levels.${LEVELS[cell.level]}`);
          node.title =
            cell.state === "before"
              ? t("home.notStarted", { day })
              : cell.count > 0
                ? t("home.dayCount", { day, count: cell.count, level })
                : t("home.dayLevel", { day, level });
        }
        return node;
      }),
    );
    // Months go under the column containing the 1st; columns are spread evenly, so place proportionally
    const pitch = weeks > 1 ? (container.clientWidth - 14) / (weeks - 1) : 0;
    $("heatmap-months").replaceChildren(
      ...grid.months.map(({ column, month }) => {
        const label = document.createElement("span");
        label.textContent = t(`months.${MONTHS[month]}`);
        label.style.left = `${column * pitch}px`;
        return label;
      }),
    );
    $("heatmap-next").disabled = pagesBack === 0;
    // Nothing to see before the first day: stop paging back once the earliest column predates first use
    const first = grid.columns[0][0].day;
    $("heatmap-back").disabled = latest.firstDay === null || first <= latest.firstDay;
  }

  /** The segmented control choosing the cost card's period; the thumb slides to the selected segment */
  const indicators = slidingIndicators(document.querySelector('.page[data-route="home"]'));
  /** Which period the cost card shows: today / month / total. Month by default */
  let spendPeriod = "month";
  /** The latest usage report, for redrawing when the period changes */
  let usage = null;

  /** One table row: the first cell is the name (or "Total"), then cost, tokens, calls, typical time */
  function spendRow(head, { cost, tokens, count, latency }, { tag = "tr" } = {}) {
    const tr = document.createElement(tag === "tr" ? "tr" : tag);
    const th = document.createElement("th");
    th.scope = "row";
    th.append(head);
    const cells = [cost, tokens, count, latency].map((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      return td;
    });
    tr.append(th, ...cells);
    return tr;
  }

  /** What a model is called: icon and name; cloud ones follow the model, on-device ones are tagged "On device" */
  function modelLabel(row) {
    const label = document.createElement("span");
    label.className = "spend-model";
    const icon = row.icon ? providerIcon(row.icon) : null;
    const name = document.createElement("span");
    // A cloud row's icon is the provider id: the name is written in the interface language
    name.textContent = row.local ? row.name : platformName({ id: row.icon, name: row.name });
    const detail = document.createElement("span");
    detail.className = row.local ? "tag" : "spend-model-id";
    detail.textContent = row.local ? t("home.local") : row.model;
    // Name and model share one run of text: in a narrow window the model wraps under the name, left aligned, without stretching the table past the card
    const text = document.createElement("span");
    text.className = "spend-model-text";
    text.append(name, " ", detail);
    label.append(...(icon ? [icon] : []), text);
    return label;
  }

  const waited = (latency) => (latency ? formatSeconds(latency.medianMs, t) : "-");
  /** When some models have no price, the cost only adds up the calls with known prices */
  const costText = (row) => (row.calls > 0 && row.unpricedCalls === row.calls ? "-" : formatUsd(row.costUsd));

  function renderSpend() {
    const card = $("spend");
    card.hidden = usage === null || usage.total.calls === 0;
    if (card.hidden) return;
    const period = usage[spendPeriod];
    for (const segment of $("spend-periods").querySelectorAll(".segment")) {
      segment.setAttribute("aria-checked", String(segment.dataset.period === spendPeriod));
    }
    indicators.place();
    $("spend-total").textContent = formatUsd(period.costUsd);
    $("spend-label").textContent = t(`home.spend.${spendPeriod}`);
    const rows = period.models.map((row) =>
      spendRow(modelLabel(row), {
        cost: row.local ? t("home.free") : costText(row),
        tokens: row.local ? "-" : formatTokens(row.tokens),
        count: String(row.dictations),
        latency: waited(row.latency),
      }),
    );
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "spend-empty";
      td.textContent = t("home.emptyPeriod");
      tr.append(td);
      rows.push(tr);
    }
    $("spend-rows").replaceChildren(...rows);
    // Total: calls are dictations (on-device transcription plus the polish step count as one), and time is the whole dictation's wait for models
    $("spend-sum").replaceChildren(
      spendRow(t("home.sum"), {
        cost: formatUsd(period.costUsd),
        tokens: formatTokens(period.tokens),
        count: String(period.dictations),
        latency: waited(period.latency),
      }),
    );
    // A small line below: how many checks are included, how much was prompt cache, and that cost is estimated when some models have no price
    const notes = [];
    if (period.checks > 0) notes.push(t("home.checks", { count: period.checks }));
    if (period.cacheCostUsd > 0) notes.push(t("home.cache", { cost: formatUsd(period.cacheCostUsd) }));
    const unpriced = period.models.filter(({ unpricedCalls }) => unpricedCalls > 0);
    if (unpriced.length > 0) {
      notes.push(
        t("home.unpriced", { models: t.list(unpriced.map(({ model }) => model)), count: period.unpricedCalls }),
      );
    }
    notes.push(t("home.estimate"));
    $("spend-note").hidden = false;
    $("spend-note").textContent = notes.join(" · ");
  }

  for (const segment of $("spend-periods").querySelectorAll(".segment")) {
    segment.addEventListener("click", () => {
      spendPeriod = segment.dataset.period;
      renderSpend();
    });
  }

  $("heatmap-back").addEventListener("click", () => {
    pagesBack++;
    renderHeatmap();
  });
  $("heatmap-next").addEventListener("click", () => {
    pagesBack = Math.max(0, pagesBack - 1);
    renderHeatmap();
  });
  // When the window gets wider or narrower, the number of weeks that fit changes
  new ResizeObserver(() => renderHeatmap()).observe($("heatmap-cells"));

  return {
    /**
     * @param {{ insights: object, usage: object, app: { version: string, hotkey: string } }} data
     */
    render({ insights, usage: report, app }) {
      latest = insights;
      renderStats(insights);
      renderHeatmap();
      usage = report;
      renderSpend();
      $("home-keycap").textContent = keycapOf(app.hotkey);
      $("home-version").textContent = `v${app.version}`;
    },

    /** When the page comes to the front, the segmented control's thumb is placed again by real widths (they can't be measured while hidden) */
    shown() {
      indicators.reset();
      indicators.place();
    },
  };
}
