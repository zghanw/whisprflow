import { msg } from "../../i18n/index.mjs";
import { measuredText, sizeText, tagTexts } from "../../models/describe.mjs";
import { findChatVendor } from "../../server/chat/vendors.mjs";
import { findProvider } from "../../server/providers/index.mjs";
import { displayWidth, INDENT, padEnd, paint } from "./text.mjs";

// Recognition modes (whisprflow mode) and local mode's two steps (whisprflow transcriber, whisprflow polish).
// native's models are still in models.mjs (whisprflow model).

/** "Ollama qwen3:4b-instruct"; a custom service shows its host: "127.0.0.1:8080 qwen3:8b". One msg */
export function polishTitle({ vendor, model }, customUrl) {
  const name = vendor === "custom" && customUrl ? new URL(customUrl).host : findChatVendor(vendor).name;
  return msg("cli.model.describe", { provider: name, model });
}

/** The models a route uses, as one sentence (msg): native is that provider's model, local is step one then step two, private is its on-device model */
export function routeTitle(route) {
  if (route.mode === "native") {
    return msg("cli.model.describe", { provider: findProvider(route.model.provider).name, model: route.model.model });
  }
  if (route.mode === "private") return msg("cli.modes.privateRoute", { transcriber: route.transcriber });
  return msg("cli.modes.localRoute", {
    transcriber: route.transcriber,
    polish: polishTitle(route.polish, route.customUrl),
  });
}

/**
 * @param {object} view
 * @param {Record<string, object>} view.routes the route each mode takes with the current settings
 * @param {string} view.current the current mode
 * @param {{ color: boolean, t: Function }} options
 */
export function renderModes({ routes, current }, { color, t }) {
  const c = paint(color);
  const ids = Object.keys(routes);
  const idWidth = Math.max(...ids.map((id) => id.length)) + 3;
  const labelWidth = Math.max(...ids.map((id) => displayWidth(t(`modes.${id}`)))) + 3;
  const lines = [t("cli.modes.title"), ""];
  for (const id of ids) {
    const mark = id === current ? c.green("●") : " ";
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(id, idWidth))}${padEnd(t(`modes.${id}`), labelWidth)}${t.text(routeTitle(routes[id]))}`,
    );
  }
  const others = ids.filter((id) => id !== current);
  lines.push(
    "",
    `${INDENT}${t("cli.modes.switch", { mode: others.join(" / ") })}`,
    `${INDENT}${t("cli.modes.nativeModels")}`,
    `${INDENT}${t("cli.modes.localHops")}`,
    `${INDENT}${t("cli.modes.privateModel")}`,
    `${INDENT}${t("cli.modes.withSettings")}`,
    "",
  );
  return lines.join("\n");
}

/** When in a mode without on-device models (local and private use them): listing is fine, with a note up top that they aren't in use now */
const notInLocal = (t, current) =>
  current === "local" || current === "private" ? [] : [`${INDENT}${t("cli.local.notInLocal", { current })}`, ""];

/**
 * Step one: on-device transcription models. For each, whether it is downloaded, how far along a download is, partly downloaded, or failed last time; then how many are downloaded and how much disk is free,
 * and how to download, delete, switch, and change the download source
 * @param {object} view
 * @param {ReadonlyArray<{ id: string, name: string, bytes: number, installed: boolean,
 *   download?: { received: number, total: number } | null, partial?: number, problem?: string | null,
 *   tags: readonly string[], measured: readonly object[] }>} view.models
 * @param {string | null} view.chip which kind of chip this machine has (chipOf in catalog.mjs)
 * @param {number | null} view.freeBytes free space on the model directory's disk; null if it can't be checked
 * @param {string} view.setting the one chosen in the settings
 * @param {string} view.source the download source in the settings
 * @param {readonly string[]} view.sources the download sources to choose from
 * @param {string} view.current the current mode
 * @param {{ color: boolean, t: Function }} options
 */
export function renderTranscribers({ models, chip, freeBytes, setting, source, sources, current }, { color, t }) {
  const c = paint(color);
  const idWidth = Math.max(...models.map(({ id }) => id.length)) + 3;
  const nameWidth = Math.max(...models.map(({ name }) => displayWidth(name))) + 3;
  const sizeWidth = Math.max(...models.map(({ bytes }) => sizeText(bytes).length)) + 3;
  const lines = [t("cli.local.transcribersTitle"), "", ...notInLocal(t, current)];
  for (const model of models) {
    const mark = model.id === setting ? c.green("●") : " ";
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(model.id, idWidth))}${padEnd(model.name, nameWidth)}${padEnd(sizeText(model.bytes), sizeWidth)}${stateText(model, t, c)}`,
    );
    const under = `${INDENT}  ${" ".repeat(idWidth)}`;
    lines.push(c.dim(`${under}${tagTexts(model.tags).map(t.text).join(" · ")}`));
    lines.push(c.dim(`${under}${t.text(measuredText(model.measured, chip))}`));
    if (model.problem && !model.download) lines.push(`${under}${c.red(t.text(model.problem))}`);
  }
  const installed = models.filter((model) => model.installed);
  const summary = [
    t("cli.local.summary", {
      count: String(installed.length),
      all: String(models.length),
      size: sizeText(installed.reduce((sum, model) => sum + model.bytes, 0)),
    }),
  ];
  if (freeBytes !== null) summary.push(t("cli.local.freeSpace", { size: sizeText(freeBytes) }));
  const missing = models.find((model) => !model.installed) ?? models[0];
  const other = models.find(({ id, installed: done }) => id !== setting && done);
  const otherSource = sources.find((id) => id !== source);
  lines.push(
    "",
    `${INDENT}${summary.join(" · ")}`,
    `${INDENT}${t("cli.local.transcriberCurrent", { model: setting })}`,
    ...(other ? [`${INDENT}${t("cli.local.transcriberSwitch", { id: other.id })}`] : []),
    `${INDENT}${t("cli.local.transcriberManage", { id: missing.id })}`,
    `${INDENT}${t("cli.local.sourceCurrent", { source: t(`modelSources.${source}`) })}`,
    `${INDENT}${t("cli.local.sourceSwitch", { other: otherSource })}`,
    "",
  );
  return lines.join("\n");
}

/** An on-device model's state: downloaded / downloading x% / x% downloaded / download failed / not downloaded */
function stateText(model, t, c) {
  if (model.download) {
    const { received, total } = model.download;
    return c.yellow(t("cli.local.downloading", { percent: Math.floor((received / total) * 100) }));
  }
  if (model.installed) return t("cli.local.installed");
  if (model.problem) return c.red(t("cli.local.downloadFailed"));
  if (model.partial > 0)
    return c.dim(t("cli.local.partial", { percent: Math.floor((model.partial / model.bytes) * 100) }));
  return c.dim(t("cli.local.notInstalled"));
}

/** Where a provider's key is, and how to say it */
const keyText = (t, vendor, where) => {
  if (where === "stored") return t("cli.models.keyStored");
  if (where === "env") return t("cli.models.keyEnv", { variable: vendor.keyEnv });
  return t("cli.models.noKey");
};

/**
 * Step two: the polish providers
 * @param {object} view
 * @param {ReadonlyArray<{ id: string, name: string, keyEnv: string, defaultModel: string | null, models: ReadonlyArray<{ id: string }> }>} view.vendors
 * @param {{ vendor: string, model: string }} view.polish the one chosen in the settings
 * @param {string} view.customUrl the custom address in the settings (empty if not set)
 * @param {Record<string, "stored" | "env" | null>} view.keys
 * @param {string} view.current the current mode
 * @param {{ color: boolean, t: Function }} options
 */
export function renderPolish({ vendors, polish, customUrl, keys, current }, { color, t }) {
  const c = paint(color);
  const nameOf = (vendor) => (vendor.id === "custom" ? t("cli.local.customName") : vendor.name);
  const modelOf = (vendor) => {
    if (vendor.id === polish.vendor) return polish.model;
    return vendor.defaultModel ? t("cli.models.default", { model: vendor.defaultModel }) : t("cli.local.customModel");
  };
  const idWidth = Math.max(...vendors.map(({ id }) => id.length)) + 3;
  const nameWidth = Math.max(...vendors.map((vendor) => displayWidth(nameOf(vendor)))) + 3;
  const modelWidth = Math.max(...vendors.map((vendor) => displayWidth(modelOf(vendor)))) + 3;
  const lines = [t("cli.local.polishTitle"), "", ...notInLocal(t, current)];
  for (const vendor of vendors) {
    const mark = vendor.id === polish.vendor ? c.green("●") : " ";
    const key = keyText(t, vendor, keys[vendor.id]);
    lines.push(
      `${INDENT}${mark} ${c.bold(padEnd(vendor.id, idWidth))}${padEnd(nameOf(vendor), nameWidth)}${padEnd(modelOf(vendor), modelWidth)}${keys[vendor.id] ? key : c.dim(key)}`,
    );
    // Other models to pick from go on the next line
    const ids = vendor.models.map(({ id }) => id);
    const others = ids.filter((model) => model !== modelOf(vendor) && model !== vendor.defaultModel);
    const listed = vendor.id === polish.vendor ? ids.filter((model) => model !== polish.model) : others;
    if (listed.length > 0) {
      lines.push(
        c.dim(
          `${INDENT}  ${" ".repeat(idWidth + nameWidth)}${t("cli.local.alsoModels", { models: listed.join(" / ") })}`,
        ),
      );
    }
  }
  const url = polish.vendor === "custom" && customUrl ? customUrl : null;
  lines.push(
    "",
    `${INDENT}${t("cli.local.polishCurrent", { model: t.text(polishTitle(polish, url)) })}`,
    `${INDENT}${t("cli.local.polishSwitch")}`,
    `${INDENT}${t("cli.local.polishCustom")}`,
    `${INDENT}${t("cli.local.polishCheck")}`,
    "",
  );
  return lines.join("\n");
}
