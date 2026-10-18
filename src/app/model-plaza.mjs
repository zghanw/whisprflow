import { DEFAULT_TRANSCRIBER, downloadSize, findModel, MODELS, makerOf, measuredOn } from "../models/catalog.mjs";
import { nameParts } from "../models/describe.mjs";
import { CLOUD_TRANSCRIBERS, cloudTranscriberOf } from "../server/asr/cloud/vendors.mjs";
import { CHAT_VENDORS, formatChatChoice, parseChatChoice } from "../server/chat/vendors.mjs";
import { DEFAULT_POLISH, keyVendorsOf, usesLocalModel } from "../server/modes.mjs";
import { DEFAULT_MODEL_CHOICE, formatModelChoice, PROVIDERS } from "../server/providers/index.mjs";
import { VENDORS } from "../server/vendors.mjs";
import { DAILY_DICTATIONS, monthlyCost, TYPICAL } from "../usage/estimate.mjs";

// Data for the model page (the "Models" page in the main window sidebar): three shelves by role, plus a key table:
//   native      native recognition: audio models (server/providers)
//   transcribe  transcription: on-device models (models/catalog.mjs) and cloud models (server/asr/cloud)
//   polish      cleanup: text models (server/chat/vendors.mjs), with the custom service last
// Cloud shelves are grouped by maker, and a group's models may be sold on several platforms:
// the platforms are the group's channels, and each model's per-channel name and price live in offers. Users set one key per platform.
// It also gives the home page mode picker (renderer/hub/mode-picker.mjs) what each of the three modes looks like: the models it passes through and what's missing before switching;
// the presets at the top of the model page (models/presets.mjs) look the same, plus a monthly cost (usage/estimate.mjs).
// Model details come only from the registries, never written here; what changes (settings, where keys are, on-device download state, prices) comes from the caller.

/** Platform order in the key table: widest coverage first, the custom service always last, unlisted ones in between */
const PLATFORM_ORDER = ["ollama", "gemini", "openai"];
/** Group order on the shelves (by maker); unlisted ones follow */
const MAKER_ORDER = ["qwen", "gemini", "openai"];

const rank = (order, id) => {
  const at = order.indexOf(id);
  return at === -1 ? order.length : at;
};

/**
 * Each role's lists per platform: [{ vendor, models }]. The custom cleanup service is its own group (it has no list)
 * @type {Record<"native" | "transcribe" | "polish", ReadonlyArray<{ id: string, models: ReadonlyArray<object> }>>}
 */
const REGISTRIES = {
  native: PROVIDERS,
  transcribe: CLOUD_TRANSCRIBERS,
  polish: CHAT_VENDORS.filter(({ id }) => id !== "custom"),
};

/** Each role's factory default, written like settings (vendor/model; on-device models by id) */
export const DEFAULTS = Object.freeze({
  native: formatModelChoice(DEFAULT_MODEL_CHOICE),
  transcribe: DEFAULT_TRANSCRIBER,
  polish: formatChatChoice(parseChatChoice(DEFAULT_POLISH)),
});

/**
 * Loads the price modules of every vendor that needs pricing in the three roles (once at main process start) and returns two lookups:
 *   priceOf  the price shown on the shelf (each vendor's listPrice)
 *   costOf   what a given usage costs in US dollars (each vendor's costOf, the same as billing), for preset monthly costs
 * Anything not in a price list is null
 * @returns {Promise<{
 *   priceOf: (role: string, vendor: string, model: string) => object | null,
 *   costOf: (role: string, vendor: string, model: string, usage: object, at: Date) => number | null,
 * }>}
 */
export async function loadPriceBook() {
  const book = {};
  for (const [role, registry] of Object.entries(REGISTRIES)) {
    book[role] = {};
    for (const vendor of registry) {
      if (vendor.prices) book[role][vendor.id] = await vendor.prices();
    }
  }
  return {
    priceOf: (role, vendor, model) => book[role]?.[vendor]?.listPrice?.(model) ?? null,
    costOf: (role, vendor, model, usage, at) => book[role]?.[vendor]?.costOf?.(model, usage, at) ?? null,
  };
}

/** A cloud shelf: grouped by maker, models of the same name merged into one row, each platform a channel of that row */
function cloudShelf(role, { priceOf }) {
  const groups = new Map();
  for (const vendor of REGISTRIES[role]) {
    for (const model of vendor.models) {
      if (!groups.has(model.maker))
        groups.set(model.maker, { id: model.maker, kind: "cloud", channels: [], rows: new Map() });
      const group = groups.get(model.maker);
      if (!group.channels.includes(vendor.id)) group.channels.push(vendor.id);
      if (!group.rows.has(model.name))
        group.rows.set(model.name, { name: model.name, tested: false, issue: null, offers: {} });
      const row = group.rows.get(model.name);
      row.tested ||= Boolean(model.tested);
      row.issue ??= model.issue ?? null;
      // Unverified (integrated from docs, never called with a real key) follows the channel: the same model sold elsewhere may be verified
      row.offers[vendor.id] = {
        choice: `${vendor.id}/${model.id}`,
        price: priceOf(role, vendor.id, model.id),
        // Keyless vendors run on this computer (Ollama): nothing to pay
        free: vendor.keyEnv === null,
        unverified: Boolean(model.unverified),
      };
    }
  }
  return [...groups.values()]
    .sort((a, b) => rank(MAKER_ORDER, a.id) - rank(MAKER_ORDER, b.id))
    .map(({ rows, ...group }) => ({
      ...group,
      items: [...rows.values()].map(({ tested, issue, ...row }) => ({
        ...row,
        tags: tagsOf({
          isDefault: Object.values(row.offers).some(({ choice }) => choice === DEFAULTS[role]),
          tested,
          issue,
        }),
      })),
    }));
}

/** Only three tags: factory default, batch evaluated, known issue (wording in models.issues.<issue>) */
function tagsOf({ isDefault, tested, issue }) {
  return [
    ...(isDefault ? [{ kind: "default" }] : []),
    ...(tested ? [{ kind: "tested" }] : []),
    ...(issue ? [{ kind: "issue", issue }] : []),
  ];
}

/**
 * The on-device group: names split into model and quantization, specs from the fastest measurement on this kind of chip
 * @param {Record<string, object>} status status from models/library.mjs, by id
 */
function localGroup({ status, chip, freeBytes }) {
  return {
    id: "local",
    kind: "local",
    channels: ["local"],
    freeBytes,
    chip,
    items: MODELS.map((model) => {
      const [best] = measuredOn(model, chip);
      const { base, variant } = nameParts(model.name);
      return {
        name: base,
        variant,
        maker: makerOf(model),
        choice: model.id,
        backend: best?.backend ?? null,
        bytes: downloadSize(model),
        license: model.license.name,
        ...(status[model.id] ?? { installed: false, download: null, partial: 0, problem: null }),
        specs: best
          ? {
              zh: best.zh ?? null,
              mix: best.mix ?? null,
              minuteSeconds: 60 / best.realtime,
              memoryGB: best.peakMB / 1000,
              sizeMB: downloadSize(model) / 1_000_000,
            }
          : null,
        tags: tagsOf({ isDefault: model.id === DEFAULTS.transcribe, tested: false, issue: null }),
      };
    }),
  };
}

/** How many models a platform has on each shelf (the key table says "native 4 · transcribe 4 · polish 7") */
function coverageOf(id) {
  return Object.fromEntries(
    Object.entries(REGISTRIES).map(([role, registry]) => [
      role,
      registry.find((vendor) => vendor.id === id)?.models.length ?? 0,
    ]),
  );
}

/** A cloud model along the way: named from the list, or by the model id written in settings when unlisted */
function cloudHop(role, registry, vendor, model) {
  const listed = registry.find(({ id }) => id === vendor)?.models.find(({ id }) => id === model);
  return { role, platform: vendor, maker: listed?.maker ?? vendor, name: listed?.name ?? model };
}

/** Transcription along the way: cloud by vendor/model, otherwise the on-device model */
function transcribeHop(transcriber) {
  const cloud = cloudTranscriberOf(transcriber);
  if (cloud) return cloudHop("transcribe", CLOUD_TRANSCRIBERS, cloud.vendor, cloud.model);
  const model = findModel(transcriber);
  return {
    role: "transcribe",
    platform: "local",
    maker: model ? makerOf(model) : null,
    name: model?.name ?? transcriber,
  };
}

/** The models each mode passes through, in order */
const HOPS = {
  native: (route) => [cloudHop("native", PROVIDERS, route.model.provider, route.model.model)],
  local: (route) => [
    transcribeHop(route.transcriber),
    route.polish.vendor === "custom"
      ? { role: "polish", platform: "custom", maker: null, name: route.polish.model }
      : cloudHop("polish", CHAT_VENDORS, route.polish.vendor, route.polish.model),
  ],
  private: (route) => [transcribeHop(route.transcriber)],
};

/**
 * What one recognition mode looks like. Only visible gaps are listed: an undownloaded on-device model, a vendor without a key, a custom service without an address;
 * whether keys work and services are reachable is verified by the key manager after switching, with the result in the key state (app/modes.mjs)
 * @param {object | { problem: object }} route the route that mode takes with the settings; when it can't be built, why
 */
function wayOf(route, { keys, status }) {
  if (route.problem) return { problem: route.problem, hops: [], needs: [] };
  const needs = [];
  if (usesLocalModel(route) && !status[route.transcriber]?.installed) {
    needs.push({ kind: "download", model: route.transcriber });
  }
  if (route.mode === "local" && route.polish.vendor === "custom" && !route.customUrl) needs.push({ kind: "url" });
  for (const { id } of keyVendorsOf(route)) if (!keys[id]) needs.push({ kind: "key", platform: id });
  return { hops: HOPS[route.mode](route), needs };
}

/** Monthly cost at 100 dictations a day, in US dollars; null when it can't be computed */
function monthlyOf(route, { costOf }, at) {
  const usd = route.problem ? null : monthlyCost(route, costOf, at);
  return usd === null ? null : { usd };
}

/**
 * @param {object} options
 * @param {"native" | "local" | "private"} options.mode the recognition mode in use
 * @param {{ native: string, transcriber: string, privateTranscriber: string, polish: string, customUrl: string }} options.chosen
 *   what settings chose per role (transcription is chosen separately in local and private)
 * @param {Record<string, "env" | "stored" | null>} options.keys where each vendor's key is (sources in key-manager)
 * @param {Record<string, object>} options.status on-device model state by id (status in models/library.mjs)
 * @param {string | null} options.chip from chipOf in catalog.mjs
 * @param {number | null} options.freeBytes free space on the model directory's disk; null when it can't be checked
 * @param {Awaited<ReturnType<typeof loadPriceBook>>} options.prices price lookups (from loadPriceBook)
 * @param {Record<"native" | "local" | "private", object>} options.routes the route each mode takes with the settings
 *   (routeOf in storage/settings.mjs); { problem } when it can't be built
 * @param {Array<{ preset: object, route: object }>} options.presets presets that suit this machine (presetsFor in models/presets.mjs),
 *   each with the route after applying its settings; { problem } when it can't be built
 * @param {Date} options.at the moment whose prices the monthly cost uses (estimateTime in usage/estimate.mjs)
 */
export function describePlaza({ mode, chosen, keys, status, chip, freeBytes, prices, routes, presets, at }) {
  const platforms = VENDORS.map(({ id, name, keyEnv, keyPage }) => ({
    id,
    name,
    keyEnv,
    hasKeyPage: Boolean(keyPage),
    key: keys[id] ?? null,
    coverage: coverageOf(id),
  })).sort((a, b) => {
    if (a.id === "custom" || b.id === "custom") return a.id === "custom" ? 1 : -1;
    return rank(PLATFORM_ORDER, a.id) - rank(PLATFORM_ORDER, b.id);
  });
  return {
    mode,
    chosen,
    ways: Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, wayOf(route, { keys, status })])),
    presets: presets.map(({ preset, route }) => ({
      id: preset.id,
      mode: preset.mode,
      settings: preset.settings,
      ...wayOf(route, { keys, status }),
      // Active: this is the mode, and the route from settings matches it
      active: mode === preset.mode && JSON.stringify(route) === JSON.stringify(routes[preset.mode]),
      monthly: monthlyOf(route, prices, at),
    })),
    // The monthly cost basis, shown in the UI
    typical: { daily: DAILY_DICTATIONS, seconds: Math.round(TYPICAL.seconds) },
    defaults: DEFAULTS,
    platforms,
    shelves: {
      native: cloudShelf("native", prices),
      transcribe: [localGroup({ status, chip, freeBytes }), ...cloudShelf("transcribe", prices)],
      polish: [
        ...cloudShelf("polish", prices),
        { id: "custom", kind: "custom", channels: ["custom"], items: [{ name: null, tags: [], offers: {} }] },
      ],
    },
  };
}
