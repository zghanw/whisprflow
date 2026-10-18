// Errors from the model side fall into three kinds, so callers decide what to do by kind without knowing each vendor's error format:
//   key          the key is wrong (invalid, out of credit, no permission): another key fixes it
//   unavailable  temporarily unreachable (offline, timeout, an outage or rate limit on their side): nothing to do with the key or settings, try again later
//   other        it rejected this request (usually a wrong model name or level), or the recording has a problem
// problem is one sentence for the user: a message not yet in a language (msg, translated by whoever shows it), or the shortened original for unrecognized errors;
// no trailing punctuation, since more text often follows. detail is the original with the key scrubbed, for the log, and is also the message.

import { msg } from "../../i18n/index.mjs";

const PROBLEM_MAX_LENGTH = 200;

export class ModelError extends Error {
  /**
   * @param {{ kind: "key" | "unavailable" | "other", problem: object | string, detail: string, origin?: string,
   *   provider?: string }} fields
   *   origin: the original error's stack (key scrubbed), log only. Traces bugs in adapters or decoding.
   *   provider: which vendor reported it (vendor id). When a route needs keys from two vendors, it says whose key failed
   */
  constructor({ kind, problem, detail, origin, provider }) {
    super(detail);
    this.name = "ModelError";
    this.kind = kind;
    this.problem = problem;
    this.detail = detail;
    this.origin = origin;
    this.provider = provider ?? null;
  }
}

/** The connection-level failures: never connected, connected then reset, or the reply cut off midway (undici reports "terminated") */
const DROPPED = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/;
const unreachable = (error, detail) =>
  error?.name === "AbortError" ||
  /fetch failed|^terminated$/.test(detail) ||
  DROPPED.test(error?.code ?? error?.cause?.code ?? "");

/**
 * Any error to a ModelError. Unreachable cases come first (the same for every vendor), then that vendor's adapter recognizes its own errors,
 * and anything still unrecognized shows its own message, shortened.
 * @param {unknown} error
 * @param {object} context
 * @param {{ name: string }} context.provider
 * @param {string} [context.apiKey] the key in use: scrubbed from the error text if it appears
 * @param {(error: unknown, detail: string) => { kind: string, problem: object | string } | null} [context.classify]
 */
export function toModelError(error, { provider, apiKey, classify }) {
  if (error instanceof ModelError) return error;
  const scrub = (text) => (apiKey ? text.replaceAll(apiKey, "(key)") : text);
  const detail = scrub(String(error?.message ?? error));
  const origin = error?.stack ? scrub(String(error.stack)) : undefined;
  const make = (fields) => new ModelError({ ...fields, detail, origin, provider: provider.id });
  // A timeout gets its own message: the network works, the vendor took too long (a long recording sent to OpenAI can take that long to upload and process)
  if (error?.name === "TimeoutError") {
    return make({ kind: "unavailable", problem: msg("model.timeout", { provider: provider.name }) });
  }
  if (unreachable(error, detail)) {
    return make({ kind: "unavailable", problem: msg("model.unreachable", { provider: provider.name }) });
  }
  const specific = classify?.(error, detail);
  if (specific) return make(specific);
  // Errors we explain ourselves (an undecodable recording and the like) are shown as they are
  if (error?.problem) return make({ kind: "other", problem: error.problem });
  return make({ kind: "other", problem: detail.slice(0, PROBLEM_MAX_LENGTH) });
}

/** Tidies a model's sentence so more text can follow: trailing periods and whitespace removed, shortened */
export const quote = (said) =>
  String(said ?? "")
    .replace(/[.\s]+$/, "")
    .slice(0, 160);
