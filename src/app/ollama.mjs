import { LocalizedError, msg } from "../i18n/index.mjs";

// Ollama on this computer, as the setup screens see it: is it running, does it have the cleanup model, and pulling that model with progress.
// Cleanup itself talks to Ollama through its OpenAI-compatible address (server/chat); these use Ollama's own API next to it (/api/...).

/** How long a status check waits: Ollama on this computer answers in milliseconds, or isn't running */
const STATUS_TIMEOUT_MS = 3_000;

/** The root of Ollama's own API from the OpenAI-compatible address in the vendor registry (http://localhost:11434/v1) */
export const apiRootOf = (baseUrl) => baseUrl.replace(/\/v1\/?$/, "");

/**
 * Whether Ollama is running and has the model. Never throws: anything unreachable counts as not running.
 * @param {{ baseUrl: string, model: string, fetch?: typeof fetch }} options
 * @returns {Promise<{ running: boolean, pulled: boolean }>}
 */
export async function ollamaStatus({ baseUrl, model, fetch = globalThis.fetch }) {
  try {
    const response = await fetch(`${apiRootOf(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!response.ok) return { running: true, pulled: false };
    const { models = [] } = await response.json();
    // A model pulled without a tag is listed as name:latest
    const pulled = models.some(({ name }) => name === model || name === `${model}:latest`);
    return { running: true, pulled };
  } catch {
    return { running: false, pulled: false };
  }
}

/**
 * Pulls a model into Ollama, reporting progress. Ollama streams one JSON object per line: a status, and for each layer its digest, total, and completed bytes.
 * Progress adds up every layer seen so far, so the total grows a little as small layers start; the big one dominates.
 * @param {{ baseUrl: string, model: string, onProgress: (progress: { received: number, total: number }) => void, signal?: AbortSignal, fetch?: typeof fetch }} options
 * @returns {Promise<void>} resolves once Ollama reports success; a failure throws a LocalizedError saying why
 */
export async function pullModel({ baseUrl, model, onProgress, signal, fetch = globalThis.fetch }) {
  let response;
  try {
    response = await fetch(`${apiRootOf(baseUrl)}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LocalizedError(msg("model.localNotRunning", { provider: "Ollama" }), { cause: error });
  }
  if (!response.ok) {
    throw new LocalizedError(msg("ollama.pullFailed", { model, reason: `HTTP ${response.status}` }));
  }
  const layers = new Map();
  let buffered = "";
  let succeeded = false;
  const decoder = new TextDecoder();
  const handle = (line) => {
    if (line.trim() === "") return;
    const update = JSON.parse(line);
    if (update.error) throw new LocalizedError(msg("ollama.pullFailed", { model, reason: update.error }));
    if (update.digest && update.total) {
      layers.set(update.digest, { total: update.total, completed: update.completed ?? 0 });
      let received = 0;
      let total = 0;
      for (const layer of layers.values()) {
        received += layer.completed;
        total += layer.total;
      }
      onProgress({ received, total });
    }
    if (update.status === "success") succeeded = true;
  };
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) handle(line);
  }
  handle(buffered);
  if (!succeeded) throw new LocalizedError(msg("ollama.pullFailed", { model, reason: "the download stopped early" }));
}
