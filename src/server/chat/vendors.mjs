import { LocalizedError, msg } from "../../i18n/index.mjs";

// Text models for the cleanup step (on-device transcript in, finished text out), one entry per vendor. Each says which API protocol it speaks, its default address,
// its default model, which extra parameters it needs for speed, and how it prices calls.
//
// Protocols are strategies (PROTOCOLS). There is one today, OpenAI Chat Completions, which Ollama, LM Studio, OpenRouter,
// and most hosted services support. To add a service that only speaks another protocol (such as Anthropic Messages), write a protocol adapter and register it in PROTOCOLS.
//
// Each vendor's models is a list to pick from, one model per entry: id is the name sent in requests, name is for people, maker is who made it (the UI picks the icon by it,
// since one platform can host models from several makers), request is any parameter this model needs beyond
// or instead of vendor.request. Model names outside the list are still sent, with only vendor.request.
// tested means it passed a batch of real dictations, issue is a known problem (wording in models.issues.<issue>): the model page tags by them.
// The same model on different platforms gets the same name, so the model page merges them into one row with each platform as a channel.
// Services not listed here need no registration: pick custom and enter the address, model, and key.
//
// Keys are stored per vendor, in the same place the native path uses (keyFile in storage/paths.mjs), so adding openai or gemini here later
// would reuse the key the user already saved.
// This file holds only descriptions and loads no protocol code: the CLI reads this list when listing models. To add a vendor, register it in CHAT_VENDORS.

export const PROTOCOLS = Object.freeze({
  "openai-chat": Object.freeze({ name: "OpenAI Chat Completions", load: () => import("./openai-chat.mjs") }),
});

/** The listed models are frozen one by one: nothing outside this module can change them */
const models = (entries) => Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));

export const CHAT_VENDORS = Object.freeze([
  Object.freeze({
    id: "ollama",
    name: "Ollama",
    // Runs on this computer: no key needed, and the text never leaves the machine
    keyEnv: null,
    keyPage: null,
    protocol: "openai-chat",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:4b-instruct",
    models: models([{ id: "qwen3:4b-instruct", name: "Qwen3 4B Instruct", maker: "qwen", tested: true }]),
    // Cleanup should be the same every time: no sampling randomness
    request: Object.freeze({ temperature: 0 }),
    // Free: the model runs locally
    prices: null,
  }),
  Object.freeze({
    id: "custom",
    // Errors name the host of the address the user entered (chatEndpoint); this name is only used in lists
    name: "Custom",
    keyEnv: "WHISPRFLOW_CUSTOM_API_KEY",
    keyPage: null,
    protocol: "openai-chat",
    /** Entered by the user (customUrl in settings) */
    baseUrl: null,
    /** Entered by the user; there is no default */
    defaultModel: null,
    models: models([]),
    // The other side is unknown, so no extra parameters: some services return 400 for parameters they don't know
    request: Object.freeze({}),
    // Price unknown, so the cost is recorded as empty
    prices: null,
  }),
]);

/** @returns {(typeof CHAT_VENDORS)[number] | null} case-insensitive; null when unknown */
export function findChatVendor(id) {
  const wanted = String(id).toLowerCase();
  return CHAT_VENDORS.find((vendor) => vendor.id === wanted) ?? null;
}

/** Extra parameters for this vendor's model: the vendor's own, plus the listed model's (the model wins on the same name) */
export function requestFor(vendor, model) {
  const entry = vendor.models.find(({ id }) => id === model);
  return { ...vendor.request, ...entry?.request };
}

/**
 * A model name. Looser than the native path's: other services' model names often contain slashes (OpenRouter's deepseek/deepseek-chat,
 * SiliconFlow's Qwen/Qwen3-8B), colons (Ollama's qwen3:8b), or @ (Workers AI's @cf/...)
 */
const MODEL_NAME = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * The user's cleanup model choice as { vendor, model }. Forms:
 *   ollama                    vendor only, with its default model
 *   ollama/llama3.2:3b        vendor/model. Split at the first slash only; the rest is the model name
 *   custom/Qwen/Qwen3-8B      custom always needs a model name
 * A wrong choice throws a LocalizedError that says what is wrong.
 */
export function parseChatChoice(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("models.empty"));
  const slash = text.indexOf("/");
  const name = slash === -1 ? text : text.slice(0, slash);
  const vendor = findChatVendor(name);
  if (!vendor) {
    throw new LocalizedError(
      msg("models.unknownProvider", { name, providers: CHAT_VENDORS.map(({ id }) => id).join(" / ") }),
    );
  }
  const model = slash === -1 ? vendor.defaultModel : text.slice(slash + 1);
  if (model === null) throw new LocalizedError(msg("chat.modelRequired", { vendor: vendor.id }));
  if (!MODEL_NAME.test(model)) throw new LocalizedError(msg("chat.badModelName", { model: JSON.stringify(model) }));
  return { vendor: vendor.id, model };
}

export const formatChatChoice = ({ vendor, model }) => `${vendor}/${model}`;

/**
 * The API address the user entered, normalized (no trailing slash). A pasted full .../chat/completions works too; that part is dropped.
 * No credentials in the address: it goes into logs and the settings file.
 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("chat.urlEmpty"));
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new LocalizedError(msg("chat.urlNotHttp", { url: JSON.stringify(text) }));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LocalizedError(msg("chat.urlNotHttp", { url: JSON.stringify(text) }));
  }
  if (url.username || url.password) throw new LocalizedError(msg("chat.urlCredentials"));
  if (url.search || url.hash) throw new LocalizedError(msg("chat.urlQuery"));
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * The address this vendor actually connects to, and what to call it in errors. Custom uses the user's address, named by its host:
 * "api.siliconflow.cn rejected the request" helps more than "Custom rejected the request"
 * @param {{ customUrl?: string | null }} settings
 * @returns {{ baseUrl: string, name: string }}
 */
export function chatEndpoint(vendor, { customUrl = null } = {}) {
  if (vendor.baseUrl !== null) return { baseUrl: vendor.baseUrl, name: vendor.name };
  if (!customUrl) throw new LocalizedError(msg("chat.urlMissing"));
  const baseUrl = normalizeBaseUrl(customUrl);
  return { baseUrl, name: new URL(baseUrl).host };
}
