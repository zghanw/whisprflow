import { msg } from "../../i18n/index.mjs";
import { DEFAULT_TRANSCRIBER, downloadSize, findModel } from "../../models/catalog.mjs";
import { CHAT_VENDORS } from "../../server/chat/vendors.mjs";
import { keyVendorsOf, MODES, usesLocalModel } from "../../server/modes.mjs";
import { PROVIDERS } from "../../server/providers/index.mjs";
import { routeOf } from "../../storage/settings.mjs";
import { Cancelled } from "../ask-secret.mjs";
import { currentSettings, parse, renderOptions, UsageError } from "../common.mjs";
import { renderModes, routeTitle } from "../render/modes.mjs";
import { storeSetting } from "./config.mjs";
import { currentProvider, keySource } from "./key.mjs";
import { modelStatus, offerDownload } from "./local-models.mjs";
import { applyChange, checked, ensureKey, modeNow, routeWith } from "./route.mjs";

// whisprflow mode: the recognition mode layer. Shows what each of the three modes uses and switches to another.
// Each mode's models have their own commands: native uses whisprflow model, local's two steps use whisprflow transcriber and whisprflow polish,
// and private's on-device model also uses whisprflow transcriber (changing private's own setting when in private).
// They only work in their own mode. On first entering local, step two can't be changed yet, so switching can carry that mode's own settings along.

/** Settings that can come along when switching to a mode, as CLI flags: flag name to setting name (only that mode's own, MODE_SETTINGS in storage/settings.mjs) */
const MODE_FLAGS = {
  native: { model: "model" },
  local: { transcriber: "transcriber", polish: "polish", url: "customUrl" },
  private: { transcriber: "privateTranscriber" },
};
const FLAG_OPTIONS = {
  model: { type: "string" },
  transcriber: { type: "string" },
  polish: { type: "string" },
  url: { type: "string" },
};

/** The route each mode takes with the current settings */
const routesOf = (settings) => Object.fromEntries(MODES.map(({ id }) => [id, routeOf(settings, id)]));

export async function mode(args, io) {
  const { values, positionals } = parse(args, FLAG_OPTIONS);
  const [wanted, ...extra] = positionals;
  const flags = Object.keys(values);
  if (extra.length > 0 || (wanted === undefined && flags.length > 0)) throw new UsageError(msg("cli.syntax.mode"));

  const status = await io.daemon.status();
  if (wanted === undefined) {
    io.out(renderModes({ routes: routesOf(currentSettings(io)), current: modeNow(io, status) }, renderOptions(io)));
    return 0;
  }

  const target = checked(io, { mode: wanted }).mode;
  const foreign = flags.find((flag) => !Object.hasOwn(MODE_FLAGS[target], flag));
  if (foreign) {
    const allowed = Object.keys(MODE_FLAGS[target]).map((flag) => `--${flag}`);
    throw new UsageError(msg("cli.modes.flagsFor", { flag: `--${foreign}`, mode: target, flags: allowed.join(" / ") }));
  }
  const changes = checked(io, Object.fromEntries(flags.map((flag) => [MODE_FLAGS[target][flag], values[flag]])));
  const route = routeWith(io, target, changes);
  if (route.mode === "local") needUrl(route);

  if (modeNow(io, status) === target && flags.length === 0) {
    io.out(io.t("cli.modes.already", { mode: target, route: io.t.text(routeTitle(route)) }));
    return 0;
  }
  // The on-device model needed (local's step one, or private's model) isn't downloaded: ask whether to download it first (hundreds of MB needs the user's OK), then ask for keys, then switch
  if (usesLocalModel(route) && !modelStatus(io, status, route.transcriber).installed) {
    if (!(await offerDownload(io, route.transcriber))) return 1;
  }
  // Ask for as many keys as the route needs (two when step one goes to the cloud; none for private)
  for (const vendor of keyVendorsOf(route)) {
    if (!(await ensureKey(io, vendor, { mode: target, ...changes }))) return 1;
  }
  return applyChange(io, {
    command: "set-mode",
    params: { mode: target, changes },
    changes: { mode: target, ...changes },
    done: msg("cli.modes.switched", { mode: target, route: routeTitle(route) }),
  });
}

/** Polish goes to a custom service with no address: say --url is needed */
export function needUrl(route) {
  if (route.polish.vendor === "custom" && !route.customUrl) throw new UsageError(msg("cli.local.urlNeeded"));
}

const MAX_CHOICE_ATTEMPTS = 3;

/** How big the on-device model is, shown when choosing a mode (if step one is in the cloud, the default on-device model is used) */
const localSize = (id) => `${Math.round(downloadSize(findModel(id) ?? findModel(DEFAULT_TRANSCRIBER)) / 1_000_000)} MB`;

/**
 * On first start with no key yet, asks which mode and provider to use: which keys people have differs.
 * Lists them grouped by mode; a choice other than the configured provider is saved to the settings. Providers that already have a key are marked, so choosing one needs no new key.
 * The last option is private mode: on-device transcription only, no key.
 * A custom service needs an address and model name, which aren't asked here: it says how to switch to it later.
 * @returns {Promise<{ mode: string, vendor: object | null } | null>} the chosen mode and provider (private mode has none, so null);
 *   null after Ctrl-C or running out of attempts without a choice (no insisting)
 */
export async function chooseProvider(io) {
  const { t } = io;
  const current = currentProvider(io);
  const settings = currentSettings(io);
  const groups = [
    { mode: "native", vendors: PROVIDERS, title: t("cli.choose.native") },
    {
      mode: "local",
      vendors: CHAT_VENDORS.filter(({ defaultModel }) => defaultModel !== null),
      title: t("cli.choose.local", { size: localSize(settings.transcriber.value) }),
    },
  ];
  const options = [
    ...groups.flatMap(({ mode, vendors }) => vendors.map((vendor) => ({ mode, vendor }))),
    { mode: "private", vendor: null },
  ];
  const lines = ["", t("cli.choose.question")];
  for (const group of groups) {
    lines.push(`  ${group.title}`);
    for (const { vendor } of options.filter(({ mode }) => mode === group.mode)) {
      const number = options.findIndex((option) => option.vendor === vendor) + 1;
      // A vendor that runs on this computer (Ollama) needs no key
      const note = t(
        vendor.keyEnv === null
          ? "cli.model.optionLocal"
          : keySource(io, vendor)
            ? "cli.model.optionWithKey"
            : "cli.model.option",
        { model: vendor.defaultModel },
      );
      lines.push(`    ${number}  ${vendor.name.padEnd(9)}${note}`);
    }
  }
  lines.push(
    `  ${t("cli.choose.private", { size: localSize(settings.privateTranscriber.value) })}`,
    `    ${options.length}  ${t("cli.choose.privateOption")}`,
  );
  const fallback = options.findIndex(({ vendor }) => vendor !== null && vendor.id === current?.id) + 1 || 1;
  lines.push(t("cli.choose.custom"), t("cli.model.choosePrompt", { fallback }));
  const question = lines.join("\n");
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt++) {
    let answer;
    try {
      answer = (await io.ask(attempt === 0 ? question : t("cli.model.choosePromptAgain"))).trim();
    } catch (error) {
      if (error instanceof Cancelled) return null;
      throw error;
    }
    const chosen =
      answer === ""
        ? options[fallback - 1]
        : (options[Number(answer) - 1] ??
          options.find(({ mode, vendor }) => (vendor?.id ?? mode) === answer.toLowerCase()));
    if (chosen) {
      if (chosen.mode === "private") storeSetting(io, "mode", "private");
      else if (chosen.vendor.id !== current?.id) {
        if (chosen.mode === "native") storeSetting(io, "model", chosen.vendor.id);
        else storeSetting(io, "polish", chosen.vendor.id);
        storeSetting(io, "mode", chosen.mode);
      }
      return chosen;
    }
    const choices = options.map(({ vendor }, index) =>
      t("cli.model.choiceItem", { number: index + 1, name: vendor?.name ?? t("modes.private") }),
    );
    io.err(t("cli.model.noSuchChoice", { answer, choices: t.either(choices) }));
  }
  return null;
}
