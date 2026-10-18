import { cloudTranscriberOf } from "../server/asr/cloud/vendors.mjs";
import { findChatVendor } from "../server/chat/vendors.mjs";

// Roughly what a setup costs per month (the figure on the model page's recommended setups). One basis for all: 100 dictations a day, 30 days a month,
// each one using the usage of a "typical dictation". Usage is a measured average; prices are not here: they come from each vendor price module costOf (the same one billing uses),
// so a price change shows up here automatically.

export const DAILY_DICTATIONS = 100;
export const MONTHLY_DICTATIONS = DAILY_DICTATIONS * 30;

/**
 * What a typical dictation uses, averaged over 97 real recordings (2026-10-17):
 * cleanup was given the text transcribed on-device by Qwen3-ASR 0.6B Q8 (96 recordings with a transcript), native used the app's default thinking level
 * (96 recordings; 1 more was blocked by Gemini's safety filter and left out).
 * Only measured vendors have a cost: if a recommended setup uses an unmeasured one, test/models/presets.test.mjs says so; measure it and add it here.
 */
export const TYPICAL = Object.freeze({
  /** Length of one dictation, seconds */
  seconds: 26.3,
  /** Cloud transcription billed per token (per-second billing only reads seconds): 740 input and 94 output tokens measured on a 55 s dictation, scaled by length */
  transcribe: Object.freeze({ inputTokens: Math.round((26.3 * 740) / 55), outputTokens: Math.round((26.3 * 94) / 55) }),
  /** One cleanup, per vendor (cache hits differ by vendor). input is the uncached part, written as the vendor's costOf expects */
  polish: Object.freeze({}),
  /** One native request, per vendor, written as that vendor's price module costOf expects (providers/prices) */
  native: Object.freeze({
    gemini: Object.freeze({ text: 1415, audio: 666, cachedText: 0, cachedAudio: 0, output: 54 }),
  }),
});

/**
 * The moment estimates are priced at: 02:30 UTC that day, a weekday morning when most dictation happens (some vendors price by time of day).
 * Weekends move to the next Monday. The figure does not change with the hour within a day
 * @param {Date} now
 */
export function estimateTime(now) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30));
  const day = at.getUTCDay();
  if (day === 6) at.setUTCDate(at.getUTCDate() + 2);
  if (day === 0) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/**
 * US dollars per dictation. On-device steps are free; when it can't be computed (vendor not measured, not in the price list, custom service) it is null, never made up
 * @param {object} route a route (routeOf in storage/settings.mjs)
 * @param {(role: string, vendor: string, model: string, usage: object, at: Date) => number | null} costOf
 *   price lookup: role, vendor, model, usage (from loadPriceBook in app/model-plaza.mjs)
 * @param {Date} at
 * @returns {number | null}
 */
export function costPerDictation(route, costOf, at) {
  if (route.mode === "private") return 0;
  if (route.mode === "native") {
    const usage = TYPICAL.native[route.model.provider];
    return usage ? costOf("native", route.model.provider, route.model.model, usage, at) : null;
  }
  const cloud = cloudTranscriberOf(route.transcriber);
  const transcribe = cloud
    ? costOf("transcribe", cloud.vendor, cloud.model, { seconds: TYPICAL.seconds, ...TYPICAL.transcribe }, at)
    : 0;
  // A polisher that runs on this computer (Ollama) costs nothing
  if (findChatVendor(route.polish.vendor)?.keyEnv === null) return transcribe;
  const usage = TYPICAL.polish[route.polish.vendor];
  const polish = usage ? costOf("polish", route.polish.vendor, route.polish.model, usage, at) : null;
  return transcribe === null || polish === null ? null : transcribe + polish;
}

/** US dollars for 100 dictations a day over 30 days; null when it can't be computed */
export function monthlyCost(route, costOf, at) {
  const once = costPerDictation(route, costOf, at);
  return once === null ? null : once * MONTHLY_DICTATIONS;
}
