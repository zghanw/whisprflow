// Splitting long recordings. Each model accepts a limited length of audio at once, maxSeconds in the catalog. Longer recordings are split, transcribed piece by piece,
// and the texts joined in order (loadTranscriber in engines/index.mjs does this for every model; adapters handle one piece).
// Split points go in the quietest place between sentences: within the "half the limit to the limit" stretch, the quietest short window, cut in its middle.
// Only loudness is used, no voice detection model, so it works the same with any model or runtime.
// Fully silent pieces are not given to the model: Qwen3-ASR returns "None" for 7.9 s of silence, and some models invent words.

/** Loudness is computed every 20 ms */
const FRAME_SECONDS = 0.02;
/** Pauses are found by 300 ms average loudness: shorter silences are just gaps between words */
const QUIET_SECONDS = 0.3;
/** Split points are searched from half the limit onward, so pieces aren't too short */
const SEARCH_FROM = 0.5;
/** If even the loudest moment is below this, it is silence: about 160 in a 16-bit recording, far below the quietest speech */
const SILENT_PEAK = 0.005;

/** Whether this stretch is silent (empty counts too) */
export function isSilent(samples) {
  for (const value of samples) if (Math.abs(value) >= SILENT_PEAK) return false;
  return true;
}

/**
 * The pieces actually given to the model: split if there is a limit (splitPoints), then fully silent pieces dropped. A fully silent recording gives none.
 * @param {number | null | undefined} maxSeconds with no limit the whole recording is one piece
 * @returns {[number, number][]}
 */
export function planWindows(samples, sampleRate, maxSeconds) {
  const windows = maxSeconds ? splitPoints(samples, sampleRate, maxSeconds) : [[0, samples.length]];
  return windows.filter(([start, end]) => !isSilent(samples.subarray(start, end)));
}

/**
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} maxSeconds the longest a piece may be, in seconds
 * @returns {[number, number][]} each piece's [start, end) sample indexes, back to back, covering the whole recording
 */
export function splitPoints(samples, sampleRate, maxSeconds) {
  const limit = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= limit) return [[0, samples.length]];

  const frame = Math.round(FRAME_SECONDS * sampleRate);
  const frames = Math.ceil(samples.length / frame);
  // Prefix sums of loudness: any stretch's average loudness in one step
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += samples[i] * samples[i];
    prefix[f + 1] = prefix[f] + sum;
  }
  const window = Math.round(QUIET_SECONDS / FRAME_SECONDS);

  const segments = [];
  let start = 0;
  while (samples.length - start > limit) {
    const from = start + Math.floor(limit * SEARCH_FROM);
    const to = start + limit;
    let quietest = null;
    let lowest = Number.POSITIVE_INFINITY;
    for (let f = Math.ceil(from / frame); (f + window) * frame <= to; f++) {
      const energy = prefix[f + window] - prefix[f];
      if (energy < lowest) {
        lowest = energy;
        quietest = f;
      }
    }
    const cut = quietest === null ? to : Math.min(to, (quietest + Math.floor(window / 2)) * frame);
    segments.push([start, cut]);
    start = cut;
  }
  segments.push([start, samples.length]);
  return segments;
}

/** Joins the pieces' texts in order: CJK text joins directly; a space goes between pieces only when both sides are Latin letters or digits, so words don't stick together */
export function joinTexts(parts) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((joined, part) => {
      if (joined === "") return part;
      const spaced = /[A-Za-z0-9]$/.test(joined) && /^[A-Za-z0-9]/.test(part);
      return `${joined}${spaced ? " " : ""}${part}`;
    }, "");
}
