import { msg } from "../../../i18n/index.mjs";
import { quote } from "../../providers/errors.mjs";

// The shared part of transcription APIs that take the recording as multipart/form-data: sending the request and reading errors.
// OpenAI-style /audio/transcriptions endpoints work this way: one audio file and a few fields in, the whole transcript back in one reply.
// Errors follow the OpenAI shape {"error":{...}}; a business code may be in error.code (like "1113") or error.type
// (like insufficient_balance_error), and both go into code so each adapter can refine by its own codes.

/** The transcription API returned an error. status is the HTTP status, code its error code, said its own message (empty when unrecognized) */
export class UploadError extends Error {
  constructor(name, status, code, said) {
    super(`${name} returned ${status}${code ? ` ${code}` : ""}: ${said || "(no message)"}`);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
    this.said = said;
  }
}

/**
 * POSTs a wav with a few fields and reads the whole reply before parsing. Throws UploadError on anything but 2xx
 * @param {string} url
 * @param {{ name: string, apiKey: string, wav: Buffer, fields: Record<string, string>, signal?: AbortSignal,
 *   fetch?: typeof fetch }} options name is what to call the other side in errors
 */
export async function postAudio(url, { name, apiKey, wav, fields, signal, fetch = globalThis.fetch }) {
  const form = new FormData();
  for (const [field, value] of Object.entries(fields)) form.append(field, value);
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  // No Content-Type here: fetch writes the one with the boundary for FormData
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Gateways sometimes return an HTML page: report by status code and drop the body
  }
  if (!response.ok) {
    const error = payload?.error ?? payload ?? {};
    throw new UploadError(
      name,
      response.status,
      error.code ?? error.type ?? null,
      typeof error.message === "string" ? error.message : "",
    );
  }
  return payload;
}

/**
 * The transcript in the reply. A 2xx without it means the API doesn't match its docs: report that honestly rather than treating it as "no speech"
 * @param {object | null} payload
 * @param {string} name what to call the other side in errors
 */
export function textIn(payload, name) {
  if (typeof payload?.text !== "string") throw new Error(`${name} replied without a transcript (text)`);
  return payload.text;
}

/**
 * Recognizes errors this module throws by HTTP status, following OpenAI's conventions: 401 bad key, 402 no credit, 403 no permission, 429 and 5xx temporarily unavailable.
 * Returns null for anything but UploadError
 * @param {unknown} error
 * @param {{ name: string }} endpoint what to call the other side in errors
 */
export function classifyError(error, { name }) {
  if (!(error instanceof UploadError)) return null;
  // A non-JSON reply has no message of its own; at least include the status code
  const said = quote(error.said) || `HTTP ${error.status}`;
  if (error.status === 401) return { kind: "key", problem: msg("model.keyInvalid") };
  if (error.status === 402) return { kind: "key", problem: msg("model.noQuota") };
  if (error.status === 403) return { kind: "key", problem: msg("model.forbidden", { said }) };
  if (error.status === 429 || error.status >= 500) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: name, said }) };
  }
  if (error.status === 404) return { kind: "other", problem: msg("model.notFound", { provider: name, said }) };
  return { kind: "other", problem: msg("model.rejected", { provider: name, said }) };
}
