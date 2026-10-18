// Usage report: for today, this month, and all time, how many model calls, how many tokens, the cost, and how fast the model usually answers, each split by model.
// The CLI (whisprflow usage) and the main window home page share it. The data is the ledger in the history store (usage in src/storage/history.mjs);
// cost is US dollars estimated from list prices (src/server/providers/prices). On-device transcription has its own row too (provider local), at no cost.

import { findModel, makerOf } from "../models/catalog.mjs";
import { findVendor } from "../server/vendors.mjs";

/** The p-th percentile of numbers sorted fast to slow (nearest rank: at least p of the numbers are not above it). null when empty */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * One period's totals as a report item: adds the token total, and turns each dictation's wait into the usual wait (median) and the slow wait
 * (90% are faster). null when there were no dictations, not 0 seconds
 */
function summarize({ latenciesMs, models: _models, ...totals }) {
  return {
    ...totals,
    tokens: totals.inputTokens + totals.outputTokens,
    latency:
      latenciesMs.length === 0 ? null : { medianMs: percentile(latenciesMs, 0.5), p90Ms: percentile(latenciesMs, 0.9) },
  };
}

/**
 * Who a model row is: name is for people (for cloud rows the vendor's name, with the model in model; for on-device rows the model's name),
 * icon picks the icon by vendor (renderer/shared/provider-icons.mjs), local says whether this is the on-device transcription step.
 * On-device models no longer in the catalog and unknown vendors are named by their id
 */
function whoIs({ provider, model }) {
  if (provider === "local") {
    const found = findModel(model);
    return { name: found?.name ?? model, icon: found ? makerOf(found) : null, local: true };
  }
  return { name: findVendor(provider)?.name ?? provider, icon: provider, local: false };
}

/** One period as a report item, with its per-model rows (biggest spend first) */
function period(usage) {
  return {
    ...summarize(usage),
    models: usage.models.map((row) => ({ ...summarize(row), ...whoIs(row) })),
  };
}

/**
 * @param {{ usage(range?: { since?: string }): object }} history the open history store
 * @param {{ now: Date }} options today and this month use the local time zone
 * @returns {{ today: object, month: object, total: object, models: object[] }} models is the all-time per-model split (same as total.models)
 */
export function usageReport(history, { now }) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const firstOfMonth = new Date(midnight);
  firstOfMonth.setDate(1);
  const total = period(history.usage());
  return {
    today: period(history.usage({ since: midnight.toISOString() })),
    month: period(history.usage({ since: firstOfMonth.toISOString() })),
    total,
    models: total.models,
  };
}
