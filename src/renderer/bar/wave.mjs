// The floating bar's wave: bars stay in place, each word raises a wave from the very middle that passes bar by bar to both sides, lower toward the edges,
// then settles back by itself. While speaking, words keep coming, so the middle bars keep jumping and it looks like a mountain, high in the middle and low at the sides, trembling.
// Sound only raises waves in the middle, which spread to the sides and decay on their own, with a little randomness;
// the parameters are calibrated to WhisprFlow's own volume levels.
// Pure computation, never touching the page: feed a volume every 50 ms (hear), take heights once per frame (frame); the caller supplies the time.

/** How many bars the wave has in all. Odd: there is one in the very middle, where the wave starts */
export const WAVE_BARS = 15;

/** The flat height (as a share of the wave area's height): a row of small dots when silent */
export const REST = 0.1;

/** The page gets an 8-bit waveform, and this is the smallest step it can resolve: pauses in real recordings sit at this step */
const QUIET = 1 / 128;
/** The loudest volume. Speech in real recordings is usually 8 to 20 steps (0.06 to 0.16) */
const LOUD = 0.19;
/** Waves only rise at this loudness: three steps (0.023) and up. Pauses are one or two steps and raise none */
const START = 0.3;
/** Once speech is heard, at least half the volume raises the wave; louder raises more, up to 80%: rising fully every time would pin the middle bar to the top, hiding the gaps between words */
const MIN_CHANCE = 0.5;
const MAX_CHANCE = 0.8;
/** How long it takes to reach the next bar. Reaching the very edge takes a hundred-odd milliseconds, so the spread from the middle is visible */
const STEP_MS = 14;
/** How fast bars settle: every this long, the distance above flat halves. In the gaps between words they drop a good way */
const HALF_LIFE_MS = 220;
/** Each frame jitters a little, up or down by this much (relative to the part above flat) */
const JITTER = 0.06;
/** The edge bar's lowest height as a share of the middle */
const EDGE = 0.15;
/** This close to flat counts as flat, so invisible changes aren't drawn forever */
const SETTLED = 0.01;

/** How loud a volume is: by how many times louder than the smallest step (logarithmic), 0 to 1. Speech volumes crowd into a very low band and would all be short if used directly */
function loudness(level) {
  if (level <= QUIET) return 0;
  return Math.min(1, Math.log(level / QUIET) / Math.log(LOUD / QUIET));
}

/** How high a bar has settled to after this many milliseconds */
function fade(height, ms) {
  return REST + (height - REST) * 0.5 ** (ms / HALF_LIFE_MS);
}

/**
 * @param {object} options
 * @param {number} options.bars how many bars
 * @param {() => number} [options.random] a random number from 0 to 1, replaced with a fixed one in tests
 */
export function createWave({ bars, random = Math.random }) {
  const middle = Math.floor(bars / 2);
  const between = (low, high) => low + random() * (high - low);
  /** How high each bar is now */
  let heights = Array(bars).fill(REST);
  /** Waves raised but not arrived yet: { bar, height, at } */
  let arrivals = [];
  /** The time of the last frame. null before the first */
  let last = null;

  return {
    /** Hears a volume (0 to 1), time in milliseconds */
    hear(level, now) {
      const loud = loudness(level);
      if (loud < START || random() >= Math.min(MAX_CHANCE, MIN_CHANCE + loud - START)) return;
      const peak = Math.min(1, (0.4 + 0.6 * loud) * between(0.9, 1.1));
      // The start occasionally shifts by one bar, so the left and right sides aren't always identical
      const center = middle + Math.round((random() - 0.5) * 2);
      for (let bar = 0; bar < bars; bar++) {
        const distance = Math.abs(bar - center);
        const side = Math.max(1, bar < center ? center : bars - 1 - center);
        const falloff = Math.max(EDGE, 1 - (distance / side) * between(0.65, 0.75));
        arrivals.push({
          bar,
          height: Math.min(1, Math.max(REST, peak * falloff * between(0.9, 1.1))),
          at: now + distance * STEP_MS * between(1, 1.3),
        });
      }
    },

    /** How high each bar should be at this moment (0 to 1), left to right */
    frame(now) {
      const since = last === null ? 0 : Math.max(0, now - last);
      last = now;
      heights = heights.map((height) => {
        const above = fade(height, since) - REST;
        if (above < SETTLED) return REST;
        return Math.min(1, REST + above * (1 + (random() - 0.5) * 2 * JITTER));
      });
      arrivals = arrivals.filter(({ bar, height, at }) => {
        if (at > now) return true;
        // Arrived: bars lower than it jump up to it; bars higher get pulled down a bit, so the new word shows.
        // Waves that arrived between two frames settle by how long they have been there, so fast and slow frames draw the same
        const arrived = fade(height, now - at);
        heights[bar] = Math.max(arrived, heights[bar] * 0.3 + arrived * 0.7);
        return false;
      });
      return [...heights];
    },

    /** Stop drawing: everything lies flat, and waves not yet arrived are dropped */
    reset() {
      heights = Array(bars).fill(REST);
      arrivals = [];
      last = null;
    },
  };
}
