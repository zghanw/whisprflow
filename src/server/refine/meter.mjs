// Billing: every model call that got a reply is recorded (which dictation, which model, how many tokens, the cost, the wait).
// Shared by both paths: the native path records the call that heard the recording, the local path records the cleanup call.
// A reply that can't be used (truncated, blocked) was still charged, so it is recorded. A call with no reply has no usage and can't be recorded: an unreachable vendor charges nothing,
// but a request sent and then cut off (timeout, disconnect) may still be charged, so only a warning is logged.

/**
 * @param {object} options
 * @param {{ id: string }} options.provider which vendor
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {(record: object) => void} options.onCall billing: { purpose: "dictation" | "check" | "cache", audioId, provider,
 *   ...the usage the adapter returned, latencyMs, createdAt }. Its failures don't affect the dictation
 * @returns {(purpose: string, audioId: string | null, call: () => Promise<object | null>) => Promise<object | null>}
 *   calls the adapter once, records the call if it got a reply, and returns the reply unchanged
 */
export function createMeter({ provider, log, onCall }) {
  return async function metered(purpose, audioId, call) {
    const startedAt = performance.now();
    let reply;
    try {
      reply = await call();
    } catch (error) {
      // The request went out and we gave up first (timeout, the user disconnected): the vendor may have finished and charged, and the ledger misses it.
      // There is no way to know, so log a warning for reconciliation
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        log.warn("model_call_unmetered", {
          purpose,
          audio_id: audioId,
          provider: provider.id,
          reason: error.name,
          latency_ms: Math.round(performance.now() - startedAt),
        });
      }
      throw error;
    }
    const latencyMs = Math.round(performance.now() - startedAt);
    // null: nothing was spent this time (for example, the cache is still building), nothing to record
    if (reply === null) return null;
    if (!reply?.usage) {
      log.warn("usage_missing", { purpose, audio_id: audioId, provider: provider.id });
      return reply;
    }
    const { usage } = reply;
    // Record only counts, never the text: it is what the user said
    log.info("model_call", {
      purpose,
      audio_id: audioId,
      model: usage.model,
      input_tokens: usage.inputTokens,
      audio_tokens: usage.audioTokens,
      cached_tokens: usage.cachedTokens,
      output_tokens: usage.outputTokens,
      thinking_tokens: usage.thinkingTokens,
      cost_usd: usage.costUsd,
      latency_ms: latencyMs,
    });
    try {
      onCall({ purpose, audioId, provider: provider.id, ...usage, latencyMs, createdAt: new Date().toISOString() });
    } catch (error) {
      // A missed record only loses one statistic; never drop the user's sentence because of it
      log.error("model_call_not_recorded", { audio_id: audioId, error: String(error?.stack ?? error) });
    }
    return reply;
  };
}
