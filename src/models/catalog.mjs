import { UV_BUILDS } from "./runtime.mjs";

// The on-device model table: the only place model details live. Which models exist, where each file downloads from,
// sizes and checksums, licenses and original authors, and what machines they suit (tags and measured numbers) all come from here:
//   downloads and verification (store.mjs), the transcriber process (server/asr/), settings and the CLI, and the app.
//
// An entry is "one model's files for one runtime": the same Qwen3-ASR is ONNX for sherpa-onnx and GGUF for transcribe.cpp, so two entries.
// Model files are not in the repository: they download to the user's machine on first use. Each origin is pinned to one
// Hugging Face commit, so the content never changes, and every file is checked against its sha256 after download.
// files are named by role (encoder, tokens, ...); each runtime adapter maps those names into its config (FAMILIES in server/asr/engines/*.mjs).
// A file with its own url downloads from there instead of the origin (a tool the model needs, not part of the model).
// maxSeconds is how much audio one pass accepts, only where there is a limit: longer recordings are split by server/asr/segment.mjs.
// A model that runs in Python has a runtime (models/runtime.mjs), installed into its directory once its files are in; its bytes count toward the model's size.
// chips limits a model to the chips its runtime runs on; MODELS holds only the models this machine can run, so nothing else is offered anywhere.
//
// To add a model: add an entry to MODELS (its runtime must be registered in server/asr/engines/index.mjs, and family must be one
// that runtime knows). Add tags and measured numbers once it has been benchmarked.

// ---------- Download sources ----------

/** Hugging Face, pinned to that commit */
const huggingFace = (model, file) =>
  `https://huggingface.co/${model.origin.repo}/resolve/${model.origin.revision}/${file.path}`;

/** A public Hugging Face mirror with the same path layout, for networks where Hugging Face is slow or blocked */
const hfMirror = (model, file) =>
  `https://hf-mirror.com/${model.origin.repo}/resolve/${model.origin.revision}/${file.path}`;

/**
 * Download sources; the user picks one in settings (modelSource). The chosen one is tried first, and if it can't connect,
 * stalls, or hits a limit the next source is used, so the choice only affects speed, never whether the download works.
 * Display names are in the messages (modelSources.<id>). urls are the addresses tried in order within a source
 */
export const SOURCES = Object.freeze([
  Object.freeze({ id: "original", urls: Object.freeze([huggingFace]) }),
  Object.freeze({ id: "mirror", urls: Object.freeze([hfMirror]) }),
]);

export const DEFAULT_SOURCE = "original";

/** @returns {(typeof SOURCES)[number] | null} */
export function findSource(id) {
  return SOURCES.find((source) => source.id === id) ?? null;
}

/** The addresses a file is tried from, in order: the chosen source first, then the others in SOURCES order. A file with its own url has only that */
export function downloadUrls(model, file, preferred = DEFAULT_SOURCE) {
  if (file.url) return [file.url];
  const first = findSource(preferred);
  if (!first)
    throw new Error(`No download source named ${preferred}; available: ${SOURCES.map(({ id }) => id).join(" / ")}`);
  return [first, ...SOURCES.filter((source) => source !== first)].flatMap((source) =>
    source.urls.map((urlOf) => urlOf(model, file)),
  );
}

// ---------- Machines and tags ----------

/** Chips, identified by OS and architecture (chipOf). Tags and measured numbers are per chip */
export const CHIPS = Object.freeze([
  Object.freeze({ id: "apple-silicon", platform: "darwin", arch: "arm64" }),
  Object.freeze({ id: "intel-mac", platform: "darwin", arch: "x64" }),
  Object.freeze({ id: "windows-x64", platform: "win32", arch: "x64" }),
  Object.freeze({ id: "windows-arm64", platform: "win32", arch: "arm64" }),
]);

/** This machine's chip; null when it is not in CHIPS */
export function chipOf(platform = process.platform, arch = process.arch) {
  return CHIPS.find((chip) => chip.platform === platform && chip.arch === arch)?.id ?? null;
}

/**
 * Tags and their kind; wording is in models.tags.<id>. Only measured facts get a tag:
 *   chip      which chip it suits: measured on that chip (in measured) and the right pick there
 *   backend   what it can run on: measured has numbers on that backend
 *   strength  where it beats the others in the list, per the benchmark comparison
 *   language  the only language it transcribes, from its model card
 */
export const TAGS = Object.freeze({
  "apple-silicon": "chip",
  "windows-x64": "chip",
  metal: "backend",
  vulkan: "backend",
  cpu: "backend",
  "zh-en": "strength",
  en: "language",
});

/**
 * Round one of the benchmark: 97 real dictations on an Apple silicon Mac.
 * In measured, score is the overall average; zh and mix are per-language averages (47 Mandarin, 45 mixed Mandarin and English), out of 5
 */
const ROUND1 = "asr-round1-2026-10-16";
/** The Windows round: the same recordings, an RTX 4060 Ti on Vulkan and an i5-13400F on CPU alone */
const WINDOWS = "asr-windows-2026-10-17";

// ---------- Models ----------

const APACHE_LICENSE = Object.freeze({
  name: "Apache-2.0",
  url: "https://www.apache.org/licenses/LICENSE-2.0.txt",
});

const CC_BY_LICENSE = Object.freeze({
  name: "CC-BY-4.0",
  url: "https://creativecommons.org/licenses/by/4.0/legalcode.txt",
});

const THIS_CHIP = chipOf();

const freeze = (model) =>
  Object.freeze({
    ...model,
    origin: Object.freeze(model.origin),
    files: Object.freeze(model.files),
    tags: Object.freeze(model.tags),
    measured: Object.freeze(model.measured.map((entry) => Object.freeze({ run: ROUND1, ...entry }))),
    ...(model.runtime ? { runtime: Object.freeze(model.runtime) } : {}),
    ...(model.chips ? { chips: Object.freeze(model.chips) } : {}),
  });

/**
 * Each entry:
 *   id, name, engine (runtime), family (which family within the runtime), maxSeconds (optional)
 *   runtime   for models that run in Python: bytes, what the runtime and the unpacked model take on disk (optional)
 *   chips     the only chips it runs on (optional; absent means every chip)
 *   license   the license name and the address of its text
 *   author    the original author's repository for this model (Hugging Face), credited in the UI
 *   origin    where this copy downloads from: repository and pinned commit; notice is a notice file shipped in that repository (optional)
 *   files     files to download: relative path, bytes, sha256
 *   tags      tags (TAGS)
 *   measured  measurements: chip, backend, judge average (0 to 5), median transcription time per recording,
 *             realtime factor (recording length / transcription time), peak memory, and which benchmark round (run)
 *
 * The order is the order shown to users: the default first (the first this machine can run), then GPU-accelerated before CPU-only.
 */
export const MODELS = Object.freeze(
  [
    {
      id: "phonon-2",
      name: "Phonon-2 0.6B (int6)",
      engine: "phonon",
      family: "phonon-2",
      // Measured on Windows: the environment 761 MB, CPython 63 MB, the unpacked model 178 MB
      runtime: { bytes: 1_002_000_000 },
      chips: ["windows-x64", "apple-silicon"],
      license: CC_BY_LICENSE,
      author: "nvidia/parakeet-tdt-0.6b-v3",
      origin: {
        repo: "FermionResearch/Phonon-2",
        revision: "7e153e4054c0a10db6d47d6fff5c062d4c77c154",
        notice: "NOTICE",
      },
      files: {
        archive: {
          path: "phonon-2.bps.tar.zst",
          size: 163_515_201,
          sha256: "98125795b6dda72f5c6eee9ba33d19815df65dcb18b50a357bf9f73c9935309e",
        },
        // uv installs the runtime; the build for this chip
        ...(UV_BUILDS[THIS_CHIP] ? { uv: UV_BUILDS[THIS_CHIP] } : {}),
      },
      // English only. Not in the benchmark rounds (mostly Mandarin recordings): on Windows (i5-13500HX, CPU) 10.4 s of speech took 0.42 s
      tags: ["en"],
      measured: [],
    },
    {
      id: "qwen3-asr-0.6b-q8",
      name: "Qwen3-ASR 0.6B (Q8_0)",
      engine: "transcribe-cpp",
      family: "qwen3-asr",
      license: APACHE_LICENSE,
      author: "Qwen/Qwen3-ASR-0.6B",
      origin: {
        repo: "handy-computer/Qwen3-ASR-0.6B-gguf",
        revision: "7e7c69a577fa2725dfedbe34b5e999336e30a19b",
        notice: "NOTICE",
      },
      files: {
        gguf: {
          path: "Qwen3-ASR-0.6B-Q8_0.gguf",
          size: 850_423_456,
          sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
        },
      },
      // The most accurate in round one, with the biggest lead on mixed-language speech; the same on Windows
      tags: ["apple-silicon", "windows-x64", "metal", "vulkan", "cpu", "zh-en"],
      measured: [
        {
          chip: "apple-silicon",
          backend: "metal",
          score: 4.14,
          zh: 4.32,
          mix: 4.02,
          p50Ms: 231,
          realtime: 67.5,
          peakMB: 1964,
        },
        {
          chip: "apple-silicon",
          backend: "cpu",
          score: 4.14,
          zh: 4.34,
          mix: 4.0,
          p50Ms: 1061,
          realtime: 16,
          peakMB: 4499,
        },
        // On the GPU the model sits in video memory, so peak memory excludes it
        {
          chip: "windows-x64",
          backend: "vulkan",
          run: WINDOWS,
          score: 4.16,
          zh: 4.34,
          mix: 4.04,
          p50Ms: 240,
          realtime: 72.9,
          peakMB: 509,
        },
        {
          chip: "windows-x64",
          backend: "cpu",
          run: WINDOWS,
          score: 4.18,
          zh: 4.38,
          mix: 4.04,
          p50Ms: 2653,
          realtime: 6.1,
          peakMB: 3997,
        },
      ],
    },
    {
      id: "qwen3-asr-0.6b-int8",
      name: "Qwen3-ASR 0.6B (int8)",
      engine: "sherpa-onnx",
      family: "qwen3-asr",
      // This ONNX export fixes the decoder KV cache at 512 positions (prompt + audio + output all count), about 13 per second of audio.
      // Measured: recordings over 38 s come back as just "language" or empty, and 33 to 35 s silently lose the second half. Split at 20 s to leave headroom
      maxSeconds: 20,
      license: APACHE_LICENSE,
      author: "Qwen/Qwen3-ASR-0.6B",
      origin: {
        repo: "csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        revision: "68818b2313fe77bd06f6a7c5068ff3ef59d02b8a",
      },
      files: {
        convFrontend: {
          path: "conv_frontend.onnx",
          size: 44_148_281,
          sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
        },
        encoder: {
          path: "encoder.int8.onnx",
          size: 182_491_662,
          sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
        },
        decoder: {
          path: "decoder.int8.onnx",
          size: 755_914_231,
          sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
        },
        tokenizerMerges: {
          path: "tokenizer/merges.txt",
          size: 1_671_853,
          sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
        },
        tokenizerConfig: {
          path: "tokenizer/tokenizer_config.json",
          size: 12_487,
          sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
        },
        tokenizerVocab: {
          path: "tokenizer/vocab.json",
          size: 2_776_833,
          sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        },
      },
      tags: ["cpu"],
      measured: [
        {
          chip: "apple-silicon",
          backend: "cpu",
          score: 4.02,
          zh: 4.32,
          mix: 3.8,
          p50Ms: 1081,
          realtime: 15.2,
          peakMB: 3526,
        },
        {
          chip: "windows-x64",
          backend: "cpu",
          run: WINDOWS,
          score: 4.06,
          zh: 4.36,
          mix: 3.8,
          p50Ms: 3388,
          realtime: 5.2,
          peakMB: 2475,
        },
      ],
    },
  ]
    .map(freeze)
    .filter((model) => !model.chips || model.chips.includes(THIS_CHIP)),
);

/** Used when settings name none: the first model this machine can run (Phonon-2 where it runs, else Qwen3-ASR). Users can switch */
export const DEFAULT_TRANSCRIBER = MODELS[0].id;

/** @returns {(typeof MODELS)[number] | null} */
export function findModel(id) {
  return MODELS.find((model) => model.id === id) ?? null;
}

/** Who made it: the organization of the author's repository, lowercased (qwen). The UI picks the icon by it */
export const makerOf = (model) => model.author.split("/")[0].toLowerCase();

/** Total bytes a model takes: its files, plus its runtime when it has one */
export function downloadSize(model) {
  return Object.values(model.files).reduce((sum, file) => sum + file.size, model.runtime?.bytes ?? 0);
}

/** Measurements on a chip, fastest first; empty when never measured */
export function measuredOn(model, chip) {
  return model.measured.filter((entry) => entry.chip === chip).sort((a, b) => b.realtime - a.realtime);
}

/**
 * Tags shown on a chip. Which chip it suits and what it runs on only count measurements on that chip: what was measured on a Mac
 * ("suits Apple silicon", "Metal-accelerated") is not claimed on Windows. Strengths are chip-independent
 * @param {string | null} chip from chipOf; when unknown only strengths remain
 */
export function tagsOn(model, chip) {
  return model.tags.filter((tag) => {
    if (TAGS[tag] === "chip") return tag === chip;
    if (TAGS[tag] === "backend") return model.measured.some((entry) => entry.chip === chip && entry.backend === tag);
    return true;
  });
}
