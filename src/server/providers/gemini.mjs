import { GoogleGenAI } from "@google/genai";
import { msg } from "../../i18n/index.mjs";
import { quote } from "./errors.mjs";
import { cacheMissing, createPromptCache } from "./gemini-cache.mjs";
import { costOf } from "./prices/gemini.mjs";

// The Gemini adapter: one request does recognition and cleanup together, with the recording sent as is.
// One step, because it needs only one service and one request.

/**
 * The bar's WebM and Ogg are both taken directly. Measured: a chained Ogg of 7 back-to-back parts is recognized start to finish.
 * WAV is taken too: the common 16 kHz WAV format, the same input cloud and on-device models get
 */
export const AUDIO_TYPES = ["audio/ogg", "audio/webm", "audio/wav"];

const QUIET = { info() {}, warn() {}, error() {} };

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} options.thinkingLevel
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {() => Date} [options.now] fixed in tests
 * @param {GoogleGenAI} [options.sdk] replaced by a fake in tests
 */
export function createClient({
  apiKey,
  model,
  thinkingLevel,
  log = QUIET,
  now = () => new Date(),
  sdk: client = new GoogleGenAI({ apiKey }),
}) {
  const promptCache = createPromptCache({ caches: client.caches, model, now, log });

  return {
    /** Called when speech starts: builds or extends the prompt cache (gemini-cache.mjs). Returns what it cost, null when nothing was done */
    prepare({ systemPrompt }) {
      return promptCache.prepare(systemPrompt);
    },

    /**
     * The smallest request: 1 token. An invalid key or a wrong model name or level shows up here.
     * With 1 token it says "didn't finish normally" (MAX_TOKENS), which is not a failure
     */
    async ping({ signal }) {
      const response = await client.models.generateContent({
        model,
        contents: "1",
        config: { maxOutputTokens: 1, thinkingConfig: { thinkingLevel }, abortSignal: signal },
      });
      return { usage: replyOf(response, { model, at: now() }).usage };
    },

    /**
     * Uses the prompt cache when one is usable (systemInstruction must then be left out, measured 400), otherwise sends as usual.
     * If the cache is already gone on their side, this request is sent again without it
     * @returns {Promise<{ text: string | null | undefined, problem: object | null, usage: object }>} see replyOf
     */
    async generate({ audio, mimeType, systemPrompt, reminder, signal }) {
      // No temperature. At 0, 10 of 60 real recordings came back broken (a stray word at the start,
      // only the first few words, a long run of underscores); without it the same batch dropped to 5, with no truncation or underscores.
      const send = (prompt) =>
        client.models.generateContent({
          model,
          contents: [
            { role: "user", parts: [{ inlineData: { mimeType, data: audio.toString("base64") } }, { text: reminder }] },
          ],
          config: { ...prompt, thinkingConfig: { thinkingLevel }, abortSignal: signal },
        });
      const cached = promptCache.nameFor(systemPrompt);
      let response;
      if (cached === null) {
        response = await send({ systemInstruction: systemPrompt });
      } else {
        try {
          response = await send({ cachedContent: cached });
        } catch (error) {
          if (!cacheMissing(error)) throw error;
          promptCache.forget(cached);
          response = await send({ systemInstruction: systemPrompt });
        }
      }
      return replyOf(response, { model, at: now() });
    },
  };
}

/** How many tokens one kind of input (AUDIO, TEXT, ...) used */
const tokensOf = (details, modality) => details?.find((detail) => detail.modality === modality)?.tokenCount ?? 0;

/**
 * A Gemini reply to the model's text, why it can't be used, and this call's usage.
 * Unusable replies (blocked, truncated) were still charged, so nothing is thrown here: usage goes back for billing and the caller reports the error.
 * Usage fields follow measured replies: promptTokenCount includes audio and cache hits, candidatesTokenCount excludes thinking,
 * and missing fields (no thoughtsTokenCount without thinking) are 0.
 * @param {{ model: string, at: Date }} request the requested model and when it was called. Priced by the model the reply reports (modelVersion):
 *   retired models get redirected (measured: gemini-3.5-flash requested, gemini-3.6-flash answered). When the reported model has no price
 *   (a suffixed variant name, say), the requested model is priced instead, which beats saying it's unknown
 * @returns {{ text: string | null | undefined, problem: object | null, usage: object }} problem is a msg
 */
export function replyOf(response, { model, at }) {
  const meta = response.usageMetadata ?? {};
  const audio = tokensOf(meta.promptTokensDetails, "AUDIO");
  const cachedAudio = tokensOf(meta.cacheTokensDetails, "AUDIO");
  const input = meta.promptTokenCount ?? 0;
  const cached = meta.cachedContentTokenCount ?? 0;
  const thinking = meta.thoughtsTokenCount ?? 0;
  const output = (meta.candidatesTokenCount ?? 0) + thinking;
  const billed = response.modelVersion ?? model;
  const tokens = { text: input - audio, audio, cachedText: cached - cachedAudio, cachedAudio, output };
  const usage = {
    model: billed,
    inputTokens: input,
    audioTokens: audio,
    cachedTokens: cached,
    outputTokens: output,
    thinkingTokens: thinking,
    costUsd: costOf(billed, tokens, at) ?? costOf(model, tokens, at),
  };

  const blockReason = response.promptFeedback?.blockReason;
  // Truncated or blocked partial text must not be pasted as the result
  const finishReason = response.candidates?.[0]?.finishReason;
  const problem = blockReason
    ? msg("model.blocked", { provider: "Gemini", reason: blockReason })
    : finishReason && finishReason !== "STOP"
      ? msg("model.unfinished", { provider: "Gemini", reason: finishReason })
      : null;
  return { text: problem ? null : response.text, problem, usage };
}

/** Gemini errors are a whole JSON body: {"error":{"code":503,"message":"...","status":"UNAVAILABLE"}}. null when not that shape */
function geminiError(detail) {
  try {
    const { error } = JSON.parse(detail);
    return typeof error?.message === "string" ? error : null;
  } catch {
    return null;
  }
}

/**
 * Recognizes Gemini's own errors (all measured: a fake key, a misspelled model name, its occasional 503). Returns null for anything else.
 * @param {unknown} _error
 * @param {string} detail the error text with the key scrubbed
 */
export function classifyError(_error, detail) {
  if (/API key not valid|API_KEY_INVALID/.test(detail)) {
    return { kind: "key", problem: msg("model.keyInvalid") };
  }
  const gemini = geminiError(detail);
  if (gemini === null) return null;
  const said = quote(gemini.message);
  if (gemini.code >= 500 || gemini.code === 429) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: "Gemini", said }) };
  }
  return { kind: "other", problem: msg("model.rejected", { provider: "Gemini", said }) };
}
