import { msg } from "../../i18n/index.mjs";
import { encodeWav } from "../audio/pcm.mjs";
import { quote } from "./errors.mjs";
import { costOf } from "./prices/openai.mjs";

// The OpenAI adapter: the gpt-audio series takes audio in Chat Completions, so one request does recognition and cleanup, like Gemini.
// No official SDK: only this one endpoint is used, and the SDK adds 21 MB to the one-line install. The request format and errors below
// follow the official docs and were measured with a real key.

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** Only wav and mp3 (measured: webm and ogg return 400 "Supported values are: 'wav' and 'mp3'"). We can only produce wav */
export const AUDIO_TYPES = ["audio/wav"];
const FORMATS = { "audio/wav": "wav" };

/** 0.1 s of silence for the key check. These models refuse text-only requests (measured 400: "either input content or output modality contain audio") */
const SILENCE = encodeWav(new Float32Array(1_600), 16_000).toString("base64");

/** OpenAI returned an error. status is the HTTP status, code is its error code (invalid_api_key, model_not_found, ...) */
class OpenAIError extends Error {
  constructor(status, error) {
    super(`OpenAI returned ${status}${error?.code ? ` ${error.code}` : ""}: ${error?.message ?? "(no message)"}`);
    this.name = "OpenAIError";
    this.status = status;
    this.code = error?.code ?? null;
    this.said = error?.message ?? "";
  }
}

/**
 * @param {{ apiKey: string, model: string, fetch?: typeof fetch }} options fetch is replaced by a fake in tests
 */
export function createClient({ apiKey, model, fetch = globalThis.fetch }) {
  async function complete(body, signal) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, modalities: ["text"], ...body }),
      signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // A gateway in between sometimes returns an HTML page: report by status code and drop the body
    }
    if (!response.ok) throw new OpenAIError(response.status, payload?.error);
    return payload;
  }

  return {
    /** The smallest request: 0.1 s of silence, 1 token (finish_reason is then length, not a failure). Takes about 0.7 s, measured */
    async ping({ signal }) {
      const payload = await complete(
        {
          max_completion_tokens: 1,
          messages: [
            { role: "user", content: [{ type: "input_audio", input_audio: { data: SILENCE, format: "wav" } }] },
          ],
        },
        signal,
      );
      return { usage: usageOf(payload, model) };
    },

    /**
     * @returns {Promise<{ text: string | null, problem: object | null, usage: object }>} the model's text (finishing is the caller's job),
     *   why it can't be used, and this call's usage. Unusable replies (truncated, refused) were still charged, so nothing is thrown here; the caller bills, then reports
     */
    async generate({ audio, mimeType, systemPrompt, reminder, signal }) {
      const payload = await complete(
        {
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: audio.toString("base64"), format: FORMATS[mimeType] } },
                { type: "text", text: reminder },
              ],
            },
          ],
        },
        signal,
      );
      const choice = payload?.choices?.[0];
      // Truncated or blocked partial text must not be pasted as the result
      const problem = choice?.message?.refusal
        ? msg("model.blocked", { provider: "OpenAI", reason: quote(choice.message.refusal) })
        : choice?.finish_reason !== "stop"
          ? msg("model.unfinished", { provider: "OpenAI", reason: String(choice?.finish_reason) })
          : null;
      return { text: problem ? null : choice.message.content, problem, usage: usageOf(payload, model) };
    },
  };
}

/**
 * Usage in the reply, shaped for billing. Fields follow measured replies: prompt_tokens includes audio and cache hits,
 * completion_tokens includes thinking and audio; missing fields are 0. Priced by the model in the reply, else the requested one.
 */
function usageOf(payload, model) {
  const usage = payload?.usage ?? {};
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const audio = usage.prompt_tokens_details?.audio_tokens ?? 0;
  const audioOutput = usage.completion_tokens_details?.audio_tokens ?? 0;
  const billed = payload?.model ?? model;
  return {
    model: billed,
    inputTokens: input,
    audioTokens: audio,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: output,
    thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    costUsd: costOf(billed, { text: input - audio, audio, textOutput: output - audioOutput, audioOutput }),
  };
}

/**
 * Recognizes OpenAI errors (a fake key's 401 and a misspelled model's 404 were measured; the out-of-credit 429 code follows the official docs).
 * Returns null for anything else.
 */
export function classifyError(error) {
  if (!(error instanceof OpenAIError)) return null;
  // A non-JSON reply (an HTML page from a gateway in front) has no message; at least include the status code
  const said = quote(error.said) || `HTTP ${error.status}`;
  if (error.status === 401) return { kind: "key", problem: msg("model.keyInvalid") };
  // Rejected by the network exit's region (an error code from the official docs): the key is fine; a proxy or another network helps, so never ask for another key
  if (error.code === "unsupported_country_region_territory") {
    return { kind: "unavailable", problem: msg("model.regionBlocked", { provider: "OpenAI", said }) };
  }
  if (error.code === "insufficient_quota") return { kind: "key", problem: msg("model.noQuota") };
  if (error.status === 403) return { kind: "key", problem: msg("model.forbidden", { said }) };
  if (error.status === 429 || error.status >= 500) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: "OpenAI", said }) };
  }
  if (error.status === 404 || error.code === "model_not_found") {
    return { kind: "other", problem: msg("model.notFound", { provider: "OpenAI", said }) };
  }
  return { kind: "other", problem: msg("model.rejected", { provider: "OpenAI", said }) };
}
