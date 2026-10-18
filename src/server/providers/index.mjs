// The registry of model vendors. Which vendor cleans up a recording is a strategy: one adapter per vendor (gemini.mjs, openai.mjs in this directory),
// each handling how requests are built, which recording formats it takes, and how its errors read; the refining flow itself (prompt, finishing, retries) is shared in ../refine.
//
// Only descriptions live here, no SDKs: the CLI reads this list to show settings and list models and shouldn't load every vendor's code for that.
// load() runs only when a request is made. To add a vendor: write an adapter, register it below, and add where to get a key in the messages (providers.<id>.getKey).
// models is a list to pick from, one per entry: { id, name, maker }, written as in the cleanup registry (chat/vendors.mjs). Unlisted model names are still sent.
// prices is the price module: costOf for billing, listPrice for the model page.

import { LocalizedError, msg } from "../../i18n/index.mjs";

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "gemini",
    name: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    keyPage: "https://aistudio.google.com/apikey",
    // Originally measured with gemini-3.5-flash + MINIMAL: about 1.7 s per result, handling self-corrections; flash-lite is faster (about 1.2 s) but leaves corrections in.
    // 3.5 Flash was later retired and its requests go to 3.6 Flash automatically (per the deprecation page; replies measured on 2026-10-14 report 3.6), so 3.6 it is
    defaultModel: "gemini-3.6-flash",
    // Some models don't accept MINIMAL, so the level can change too
    thinkingLevels: Object.freeze(["MINIMAL", "LOW", "MEDIUM", "HIGH"]),
    // tested: passed a batch evaluation on real recordings (60 recordings, 12 runs)
    models: Object.freeze([
      Object.freeze({ id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", maker: "gemini", tested: true }),
    ]),
    load: () => import("./gemini.mjs"),
    prices: () => import("./prices/gemini.mjs"),
  }),
  Object.freeze({
    id: "openai",
    name: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    keyPage: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-audio-mini",
    // The gpt-audio series has no thinking levels
    thinkingLevels: null,
    models: Object.freeze(
      [
        { id: "gpt-audio-mini", name: "GPT Audio Mini" },
        // issue: a known problem, wording in models.issues.<issue>. On 2026-10-13, two of 6 recordings came back wrapped in JSON and one returned 500
        { id: "gpt-audio-1.5", name: "GPT Audio 1.5", issue: "jsonWrapped" },
      ].map((model) => Object.freeze({ ...model, maker: "openai" })),
    ),
    load: () => import("./openai.mjs"),
    prices: () => import("./prices/openai.mjs"),
  }),
]);

export const DEFAULT_MODEL_CHOICE = Object.freeze({ provider: "gemini", model: PROVIDERS[0].defaultModel });
export const DEFAULT_THINKING_LEVEL = "MINIMAL";

/** @returns {(typeof PROVIDERS)[number] | null} case-insensitive; null when unknown */
export function findProvider(id) {
  const wanted = String(id).toLowerCase();
  return PROVIDERS.find((provider) => provider.id === wanted) ?? null;
}

/** Model names contain only these characters (like gpt-audio-1.5, gemini-3.5-flash, gpt-audio-mini-2025-12-15) */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The Gemini SDK also accepts prefixed forms, which older settings files may contain */
const GEMINI_PREFIXED = /^(models|tunedModels)\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The user's model choice as { provider, model }. Forms:
 *   openai/gpt-audio-1.5   vendor/model
 *   openai                 vendor only, with its default model
 *   gemini-3.5-flash       a model name that isn't a vendor: taken as Gemini's. Older settings held only Gemini model names, which still work
 *   models/gemini-3.5-flash  the Gemini SDK also accepted models/ and tunedModels/ prefixes, still taken as Gemini's
 * A wrong choice throws a LocalizedError saying what is wrong (a phrase that follows "model is ...:").
 */
export function parseModelChoice(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("models.empty"));
  if (GEMINI_PREFIXED.test(text)) return { provider: "gemini", model: text };
  const slash = text.indexOf("/");
  if (slash === -1) {
    const provider = findProvider(text);
    if (provider) return { provider: provider.id, model: provider.defaultModel };
    return { provider: "gemini", model: checkedModelName("gemini", text) };
  }
  const provider = findProvider(text.slice(0, slash));
  if (!provider) {
    throw new LocalizedError(
      msg("models.unknownProvider", {
        name: text.slice(0, slash),
        providers: PROVIDERS.map(({ id }) => id).join(" / "),
      }),
    );
  }
  return { provider: provider.id, model: checkedModelName(provider.id, text.slice(slash + 1)) };
}

function checkedModelName(provider, model) {
  if (MODEL_NAME.test(model) || (provider === "gemini" && GEMINI_PREFIXED.test(model))) return model;
  throw new LocalizedError(msg("models.badName", { model: JSON.stringify(model) }));
}

export const formatModelChoice = ({ provider, model }) => `${provider}/${model}`;

const MAX_KEY_LENGTH = 512;

/**
 * Whether a key looks right (offline). If not, returns a message (msg) that never includes the key itself.
 * It must be caught before the SDK: a key with a line break makes the Gemini SDK report "Headers.append: "..." is an invalid header value"
 * with the whole input in quotes (measured), and that error then goes into logs and the terminal, leaking the key. Every vendor puts the key in a header, so the rule applies to all.
 * @returns {{ key: string, params?: object } | null} null when it looks fine
 */
export function apiKeyProblem(key) {
  if (key.length > MAX_KEY_LENGTH) return msg("key.tooLong", { length: key.length });
  if (/\s/.test(key)) return msg("key.whitespace");
  // Visible ASCII characters only: anything else can't go into a request header
  if (!/^[\x21-\x7e]+$/.test(key)) return msg("key.badCharacters");
  return null;
}
