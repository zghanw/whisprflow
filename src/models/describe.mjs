import { msg } from "../i18n/index.mjs";

// Turns the catalog's (catalog.mjs) tags and measured numbers into messages (msg); the CLI and the app's model list share it, translated per UI language.

/**
 * How a transcriber backend name reads: the runtime reports a device name (transcribe.cpp's MTL0 is the first GPU on Metal, Vulkan0 is Vulkan);
 * known ones are translated via localModels.backends, unknown ones stay as they are
 */
export function backendText(reported) {
  if (/^MTL/i.test(reported)) return msg("localModels.backends.metal");
  if (/^vulkan/i.test(reported)) return msg("localModels.backends.vulkan");
  if (/^cpu/i.test(reported)) return msg("localModels.backends.cpu");
  return reported;
}

/** Size for people: MB below 1 GB, GB above (decimal, like download tools and Finder) */
export function sizeText(bytes) {
  return bytes < 1_000_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** A model's tags, one message per tag */
export const tagTexts = (tags) => tags.map((tag) => msg(`localModels.tags.${tag}`));

/**
 * How it measured on this machine's kind of chip: the fastest entry (measuredOn in catalog.mjs sorts them). Says so honestly when unmeasured
 * @param {ReadonlyArray<{ backend: string, score: number, realtime: number, peakMB: number }>} measured
 * @param {string | null} chip from chipOf in catalog.mjs
 */
export function measuredText(measured, chip) {
  if (chip === null) return msg("localModels.unknownChip");
  const name = msg(`localModels.chips.${chip}`);
  if (measured.length === 0) return msg("localModels.notMeasured", { chip: name });
  const [best] = measured;
  return msg("localModels.measured", {
    chip: name,
    backend: msg(`localModels.backends.${best.backend}`),
    score: best.score.toFixed(2),
    realtime: String(Math.round(best.realtime)),
    memory: `${(best.peakMB / 1000).toFixed(1)} GB`,
  });
}

/**
 * The same measurement split up for the app's model list: three figures (value, unit, label) plus a line on the machine and backend.
 * When unmeasured or the chip is unknown there are no figures, and that line reads like measuredText
 * @param {ReadonlyArray<{ backend: string, score: number, realtime: number, peakMB: number }>} measured
 * @param {string | null} chip
 * @returns {{ figures: Array<{ value: string, unit: string, label: object }>, where: object }}
 */
export function measuredFacts(measured, chip) {
  if (chip === null || measured.length === 0) return { figures: [], where: measuredText(measured, chip) };
  const [best] = measured;
  return {
    figures: [
      { value: best.score.toFixed(2), unit: "/5", label: msg("localModels.figures.score") },
      { value: String(Math.round(best.realtime)), unit: "×", label: msg("localModels.figures.speed") },
      { value: (best.peakMB / 1000).toFixed(1), unit: "GB", label: msg("localModels.figures.memory") },
    ],
    where: msg("localModels.measuredOn", {
      chip: msg(`localModels.chips.${chip}`),
      backend: msg(`localModels.backends.${best.backend}`),
    }),
  };
}

/** A model name split into name and the quantization in parentheses ("Qwen3-ASR 0.6B (Q8_0)" gives Qwen3-ASR 0.6B and Q8_0); the app puts the quantization in a small tag */
export function nameParts(name) {
  const match = /^(.+?)\s*\(([^()]+)\)$/.exec(name);
  return match ? { base: match[1], variant: match[2] } : { base: name, variant: null };
}
