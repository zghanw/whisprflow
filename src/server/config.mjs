import { LocalizedError } from "../i18n/index.mjs";
import { DEFAULT_SOURCE, DEFAULT_TRANSCRIBER, findModel, findSource, MODELS, SOURCES } from "../models/catalog.mjs";
import { cloudTranscriberOf } from "./asr/cloud/vendors.mjs";
import { normalizeBaseUrl, parseChatChoice } from "./chat/vendors.mjs";
import { DEFAULT_MODE, DEFAULT_POLISH, keyVendorOf, keyVendorsOf, parseMode } from "./modes.mjs";
import {
  apiKeyProblem,
  DEFAULT_MODEL_CHOICE,
  DEFAULT_THINKING_LEVEL,
  findProvider,
  parseModelChoice,
} from "./providers/index.mjs";

// Config from environment variables when the server is started on its own (node src/server/main.mjs). Normally the service runs inside the app and settings come from src/storage/settings.mjs.

const THINKING_LEVELS = findProvider("gemini").thinkingLevels;

/** This environment variable: empty counts as unset */
const given = (env, name) => (env[name]?.trim() ? env[name].trim() : null);

/** Reads one variable with parse; a wrong value names the variable in the error */
function read(env, name, parse) {
  try {
    return parse(env[name]);
  } catch (error) {
    throw new Error(`${name} is ${JSON.stringify(env[name])}: ${error.message}`, { cause: error });
  }
}

/** Which vendor and model the native path uses. WHISPRFLOW_MODEL wins; GEMINI_MODEL is the older form, a Gemini model name only, and still works */
function modelFrom(env) {
  for (const name of ["WHISPRFLOW_MODEL", "GEMINI_MODEL"]) {
    if (given(env, name)) return read(env, name, parseModelChoice);
  }
  return DEFAULT_MODEL_CHOICE;
}

function thinkingFrom(env) {
  const thinkingLevel = (env.GEMINI_THINKING_LEVEL ?? DEFAULT_THINKING_LEVEL).toUpperCase();
  if (!THINKING_LEVELS.includes(thinkingLevel)) {
    throw new Error(
      `GEMINI_THINKING_LEVEL must be one of ${THINKING_LEVELS.join(" / ")}, got ${JSON.stringify(env.GEMINI_THINKING_LEVEL)}`,
    );
  }
  return thinkingLevel;
}

/** The local path: which on-device model (or cloud vendor/model) does step one, who cleans up, and the custom service address */
function localRouteFrom(env) {
  const written = given(env, "WHISPRFLOW_TRANSCRIBER") ?? DEFAULT_TRANSCRIBER;
  const cloud = cloudTranscriberOf(written);
  const transcriber = cloud ? `${cloud.vendor}/${cloud.model}` : written;
  if (!cloud && !findModel(transcriber)) {
    throw new Error(
      `WHISPRFLOW_TRANSCRIBER is ${JSON.stringify(transcriber)}; available: ${MODELS.map(({ id }) => id).join(" / ")}`,
    );
  }
  const polish = given(env, "WHISPRFLOW_POLISH")
    ? read(env, "WHISPRFLOW_POLISH", parseChatChoice)
    : parseChatChoice(DEFAULT_POLISH);
  const customUrl = given(env, "WHISPRFLOW_CUSTOM_URL") ? read(env, "WHISPRFLOW_CUSTOM_URL", normalizeBaseUrl) : null;
  if (polish.vendor === "custom" && customUrl === null) {
    throw new Error("Cleanup by a custom service needs its address: WHISPRFLOW_CUSTOM_URL");
  }
  return { mode: "local", transcriber, polish, customUrl };
}

/** Which source to download a missing on-device model from first (SOURCES in models/catalog.mjs) */
function modelSourceFrom(env) {
  const source = given(env, "WHISPRFLOW_MODEL_SOURCE") ?? DEFAULT_SOURCE;
  if (!findSource(source)) {
    throw new Error(
      `WHISPRFLOW_MODEL_SOURCE is ${JSON.stringify(source)}; available: ${SOURCES.map(({ id }) => id).join(" / ")}`,
    );
  }
  return source;
}

/** Reads config from environment variables. A wrong value is an error, never quietly replaced by a default. */
export function loadConfig(env) {
  const mode = given(env, "WHISPRFLOW_MODE") ? read(env, "WHISPRFLOW_MODE", parseMode) : DEFAULT_MODE;
  const thinkingLevel = thinkingFrom(env);
  const route = mode === "local" ? localRouteFrom(env) : { mode: "native", model: modelFrom(env), thinkingLevel };
  const modelSource = modelSourceFrom(env);

  // Every vendor the route uses needs a key; keyless ones (Ollama) are not listed
  const keys = {};
  for (const { id, keyEnv } of keyVendorsOf(route)) {
    const key = env[keyEnv]?.trim();
    if (!key) throw new Error(`Missing environment variable ${keyEnv}`);
    const keyProblem = apiKeyProblem(key);
    // Starting the server on its own is for debugging, so errors read like log lines
    if (keyProblem) throw new Error(`${keyEnv}: ${new LocalizedError(keyProblem).message}`);
    keys[id] = key;
  }
  // null when no vendor needs a key (cleanup by Ollama)
  const apiKey = keys[keyVendorOf(route)?.id] ?? null;

  const port = env.PORT === undefined ? 8790 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got ${JSON.stringify(env.PORT)}`);
  }

  // Listen on this computer only: the service has no login and must not be reachable from the local network
  return { host: "127.0.0.1", port, route, apiKey, keys, modelSource };
}
