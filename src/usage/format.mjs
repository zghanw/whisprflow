// How usage is written: money, tokens, counts, durations, wait times. Shared by the CLI (src/cli/render/usage.mjs) and the main window.
// Pure functions with no Node or DOM: the window imports this file directly. Unit words follow the UI language; the caller passes the translator (src/i18n).

/** Count abbreviations from small to large: thousand, million, billion */
const COUNT_UNITS = ["K", "M", "B"];

/** Counts: abbreviated as K, M, B with three significant digits (1.39K, 21.3K, 6.02M). The home page word count uses this too (194K) */
export function formatCount(count) {
  let value = count;
  let unit = "";
  for (const next of COUNT_UNITS) {
    // Judge by the abbreviated form, so 999,600 becomes 1M rather than 1000K
    if (Number(value.toPrecision(3)) < 1000) break;
    value /= 1000;
    unit = next;
  }
  return `${Number(value.toPrecision(3))}${unit}`;
}

/** Token counts, written like formatCount */
export const formatTokens = formatCount;

/**
 * A duration split into number and unit (the page draws the unit smaller): minutes under an hour, hours above, one decimal under ten hours.
 * The home page "time saved" and "total dictation time" use only these two units
 * @returns {{ value: string, unit: "min" | "hr" }} unit is the message name: units.min, units.hr
 */
export function formatSpan(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: seconds > 0 && minutes === 0 ? "<1" : String(minutes), unit: "min" };
  const hours = seconds / 3600;
  return { value: String(hours < 10 ? Number(hours.toFixed(1)) : Math.round(hours)), unit: "hr" };
}

/**
 * US dollars. A dictation costs fractions of a cent, so two significant digits ($0.0011); a dollar or more to the cent ($12.35); below a hundredth of a cent, no detail.
 * Prices are estimates; more digits would not make them more accurate
 */
export function formatUsd(usd) {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  // From 0.995 up, two significant digits would read 1.0, so round to the cent instead
  if (usd < 0.995) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * How long the wait was: seconds, one decimal
 * @param {(key: string, params: object) => string} t translator for the UI language
 */
export const formatSeconds = (ms, t) => t("units.seconds", { value: (ms / 1000).toFixed(1) });
