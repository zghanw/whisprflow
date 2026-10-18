import { msg } from "../../i18n/index.mjs";
import { quote } from "../providers/errors.mjs";

// The adapter for the OpenAI Chat Completions protocol: POST {address}/chat/completions, GET {address}/models.
// Ollama and most other services support it; the differences (address, models, extra parameters, prices) come from the vendor registry (vendors.mjs).
// No official SDK, for the same reason as providers/openai.mjs: only two endpoints are used.
// Request and reply fields follow the OpenAI-compatible format that Ollama and hosted services share.

/** The other side returned an error. status is the HTTP status, said is its own message (empty when unrecognized), json says whether the reply was JSON */
class ChatError extends Error {
  constructor(name, status, said, json) {
    super(`${name} returned ${status}: ${said || "(no message)"}`);
    this.name = "ChatError";
    this.status = status;
    this.said = said;
    this.json = json;
    this.code = null;
  }
}

/**
 * The error's own message. OpenAI writes {"error":{"message":"...","code":"..."}},
 * some services write {"error":"..."} (Ollama), {"message":"..."}, or {"detail":"..."}
 */
function saidIn(payload) {
  const error = payload?.error;
  if (typeof error?.message === "string") return error.message;
  if (typeof error === "string") return error;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.detail === "string") return payload.detail;
  return "";
}

/**
 * @param {object} options
 * @param {string} options.baseUrl the normalized address (chatEndpoint in vendors.mjs), without a trailing slash
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} [options.name] what to call the other side in errors
 * @param {object} [options.request] extra parameters this vendor needs
 * @param {((model: string, tokens: { input: number, cached: number, output: number }, at: Date) => number | null) | null} [options.costOf]
 *   how this vendor prices calls; null when the price is unknown, and the cost is recorded as empty
 * @param {() => Date} [options.now]
 * @param {typeof fetch} [options.fetch] replaced by a fake in tests
 */
export function createClient({
  baseUrl,
  apiKey,
  model,
  name = baseUrl,
  request = {},
  costOf = null,
  now = () => new Date(),
  fetch = globalThis.fetch,
}) {
  // Local services such as Ollama need no key: send no Authorization header rather than "Bearer undefined"
  const headers = { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" };

  async function call(path, init) {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    // Read the whole reply before parsing: some services send headers first and the body a while later
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // Gateways and wrong addresses often return an HTML page: report by status code and drop the body
    }
    if (!response.ok) {
      const error = new ChatError(name, response.status, saidIn(payload), payload !== null);
      error.code = payload?.error?.code ?? null;
      throw error;
    }
    return payload;
  }

  const complete = (body, signal) =>
    call("/chat/completions", { method: "POST", body: JSON.stringify({ model, ...request, ...body }), signal });

  const usageOf = (payload) => {
    const usage = payload?.usage ?? {};
    const input = usage.prompt_tokens ?? 0;
    // Some services list cache hits separately (prompt_cache_hit_tokens), others in prompt_tokens_details
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const billed = payload?.model ?? model;
    return {
      model: billed,
      inputTokens: input,
      audioTokens: 0,
      cachedTokens: cached,
      outputTokens: output,
      thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      costUsd: costOf?.(billed, { input: input - cached, cached, output }, now()) ?? null,
    };
  };

  return {
    /** The smallest request: 1 token (the reply then has finish_reason length, which is not a failure). A wrong key, address, or model name shows up here */
    async ping({ signal }) {
      const payload = await complete({ max_tokens: 1, messages: [{ role: "user", content: "1" }] }, signal);
      return { usage: usageOf(payload) };
    },

    /**
     * @returns {Promise<{ text: string | null, problem: object | null, usage: object }>} the model's text (finishing is the caller's job),
     *   why it can't be used, and this call's usage. Unusable replies (truncated, blocked) were still charged, so nothing is thrown here; the caller bills, then reports
     */
    async complete({ system, user, signal }) {
      const payload = await complete(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        signal,
      );
      const choice = payload?.choices?.[0];
      const finish = choice?.finish_reason;
      // Truncated or blocked partial text must not be pasted as the result
      const problem = choice?.message?.refusal
        ? msg("model.blocked", { provider: name, reason: quote(choice.message.refusal) })
        : finish === "content_filter"
          ? msg("model.blocked", { provider: name, reason: finish })
          : finish !== "stop"
            ? msg("model.unfinished", { provider: name, reason: String(finish) })
            : null;
      return { text: problem ? null : (choice.message.content ?? ""), problem, usage: usageOf(payload) };
    },

    /** The models at this address (GET /models), for picking a model: most services have this endpoint; those without it throw */
    async listModels({ signal }) {
      const payload = await call("/models", { method: "GET", signal });
      return (payload?.data ?? []).map((entry) => entry.id).filter((id) => typeof id === "string");
    },
  };
}

/**
 * Error codes services use for no credit: OpenAI's insufficient_quota, Alibaba Cloud's Arrearage, Zhipu's 1113
 * (Zhipu returns status 429, which by status alone would read as temporarily unavailable)
 */
const NO_QUOTA_CODES = new Set(["insufficient_quota", "Arrearage", "1113"]);

/**
 * Recognizes errors this adapter throws. Status codes follow common OpenAI-compatible practice (401, 402, 422, 429, 500, 503);
 * returns null for anything else.
 * @param {unknown} error
 * @param {{ name: string }} endpoint what to call the other side in errors
 */
export function classifyError(error, { name }) {
  if (!(error instanceof ChatError)) return null;
  // A non-JSON reply has no message of its own; at least include the status code
  const said = quote(error.said) || `HTTP ${error.status}`;
  if (error.status === 401) return { kind: "key", problem: msg("model.keyInvalid") };
  // Some services return 402 for no credit; others put it in the error code with varying status codes
  if (error.status === 402 || NO_QUOTA_CODES.has(String(error.code)))
    return { kind: "key", problem: msg("model.noQuota") };
  if (error.status === 403) return { kind: "key", problem: msg("model.forbidden", { said }) };
  if (error.status === 429 || error.status >= 500) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: name, said }) };
  }
  if (error.status === 404) {
    // A JSON reply means the service itself says not found (usually the model); an HTML page means the address doesn't reach the API at all
    return error.json
      ? { kind: "other", problem: msg("model.notFound", { provider: name, said }) }
      : { kind: "other", problem: msg("chat.endpointNotFound", { provider: name }) };
  }
  return { kind: "other", problem: msg("model.rejected", { provider: name, said }) };
}
