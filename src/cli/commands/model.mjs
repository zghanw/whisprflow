import { msg, problemOf } from "../../i18n/index.mjs";
import { findChatVendor } from "../../server/chat/vendors.mjs";
import { findProvider, formatModelChoice, PROVIDERS, parseModelChoice } from "../../server/providers/index.mjs";
import { ConfigError, currentSettings, ensureRunning, parse, renderOptions, UsageError } from "../common.mjs";
import { renderModels } from "../render/models.mjs";
import { keySourceFor } from "./key.mjs";
import { applyChange, ensureKey, inMode, modeNow } from "./route.mjs";

// whisprflow model: the native mode layer, where recordings go straight to an audio model (Gemini, OpenAI).
// Lists providers, switches to a provider's model, and checks whether a model works now. Switching only works in native mode:
// local mode uses two steps, on-device transcription then polish, changed with whisprflow transcriber and whisprflow polish.
// Before switching it makes sure that provider has a key (asking if not); if the app is running it switches live, without a restart.

/** A check waits for the background app to ask that provider once; that request times out after 30 seconds */
const CHECK_TIMEOUT_MS = 45_000;

/** The model the user wrote, as { provider, model }; a typo exits with 2 and lists what is accepted */
function choiceFrom(value) {
  // A polish provider (text only) was named: it belongs to local mode's step two, so point there
  const chat = findChatVendor(value.split("/")[0]);
  if (chat && findProvider(chat.id) === null) {
    throw new ConfigError(msg("cli.model.textOnly", { provider: chat.name, id: chat.id }));
  }
  // A single word must be a provider name. The old settings-file form of a bare Gemini model name isn't accepted here:
  // otherwise whisprflow model nope would be taken as a Gemini model called nope
  if (!value.includes("/") && findProvider(value) === null) {
    throw new ConfigError(
      msg("cli.model.unknownProvider", { name: value, providers: PROVIDERS.map(({ id }) => id).join(" / ") }),
    );
  }
  try {
    return parseModelChoice(value);
  } catch (error) {
    throw new ConfigError(msg("cli.model.invalid", { value: JSON.stringify(value), reason: problemOf(error) }), {
      cause: error,
    });
  }
}

/** "Gemini's gemini-3.6-flash": one msg */
const describe = ({ provider, model }) => msg("cli.model.describe", { provider: findProvider(provider).name, model });

async function list(io) {
  // The key for the provider in use may have come from an environment variable when the background app started, invisible to the CLI: ask the running one
  const running = await io.daemon.status();
  const fromDaemon = (provider) =>
    running?.provider === provider.id && running.key.state === "ready" && running.key.source === "env" ? "env" : null;
  const keys = Object.fromEntries(
    PROVIDERS.map((provider) => [provider.id, keySourceFor(io, provider, running) ?? fromDaemon(provider)]),
  );
  io.out(renderModels({ providers: PROVIDERS, setting: currentSettings(io).model, keys }, renderOptions(io)));
  // Not in native mode: these models aren't in use now
  if (modeNow(io, running) !== "native")
    io.out(`  ${io.t("cli.model.notInNative", { current: modeNow(io, running) })}\n`);
  return 0;
}

/**
 * Switches to a provider's model (native mode only). If that provider has no key yet, ask for one, verify it with this model, and save it before switching:
 * otherwise the switch would only then turn out unusable and the user would have to go back and enter one.
 */
async function switchTo(io, value) {
  const choice = choiceFrom(value);
  if (!inMode(io, await io.daemon.status(), "native", "model")) return 1;
  const model = formatModelChoice(choice);
  if (!(await ensureKey(io, findProvider(choice.provider), { model }))) return 1;
  return applyChange(io, {
    command: "set-model",
    params: { model },
    changes: { model },
    done: msg("cli.model.switched", { model: describe(choice) }),
  });
}

/** Whether a model works now: the background app sends one minimal request with that provider's key */
async function check(io, value) {
  const choice = value === undefined ? parseModelChoice(currentSettings(io).model.value) : choiceFrom(value);
  await ensureRunning(io);
  io.out(io.t("cli.model.checking", { model: describe(choice) }));
  let result;
  try {
    result = await io.daemon.request(
      "check-model",
      { model: formatModelChoice(choice) },
      { timeoutMs: CHECK_TIMEOUT_MS },
    );
  } catch (error) {
    // The running app was started before an upgrade and doesn't know this command yet
    if (!/^Unknown command/.test(error?.message ?? "")) throw error;
    io.err(io.t("cli.model.oldDaemonCheck"));
    return 1;
  }
  if (!result.ok) {
    io.err(io.t("cli.model.unusable", { problem: result.problem }));
    return 1;
  }
  const provider = findProvider(choice.provider);
  const from =
    result.source === "env" ? msg("cli.model.fromEnv", { variable: provider.keyEnv }) : msg("cli.model.fromStored");
  io.out(io.t("cli.model.usable", { model: describe(choice), from, seconds: (result.ms / 1000).toFixed(1) }));
  return 0;
}

export async function model(args, io) {
  const [first, second, ...extra] = parse(args).positionals;
  if (first === undefined) return list(io);
  if (first === "check" && extra.length === 0) return check(io, second);
  if (second === undefined) return switchTo(io, first);
  throw new UsageError(msg("cli.syntax.model"));
}
