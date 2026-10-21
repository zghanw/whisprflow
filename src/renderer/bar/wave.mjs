// The floating bar's wave, drawn the way Siri's is: one bright main curve and fainter echoes in mirrored pairs, all inside a bell-shaped envelope,
// so the middle swells and the ends stay pinned. The voice sets the height: it rises at once and falls within about a tenth of a second between
// syllables. Silence keeps a small, slow breathing motion, so the bar looks alive while it waits. Ported from WhisprFlow v1's pill.
// Pure computation, never touching the page: feed a volume every 50 ms (hear), take the curves once per frame (frame); the caller supplies the time.

/** The curves, back to front: echoes in mirrored pairs (smallest first), the main curve last, on top */
export const CURVES = Object.freeze([0.22, -0.22, 0.45, -0.45, 0.72, -0.72, 1]);
/** Points per curve, evenly spaced across the width */
export const POINTS = 37;
/** The height when silent, as a share of full: the breathing floor */
export const IDLE = 0.15;

/** Between syllables the height falls by a factor of e every this long */
const FALL_MS = 110;
/** How fast each motion turns at full voice, in radians per second: sway (the carrier sliding), ripple (rings inside the envelope), lag (echoes drifting) */
const SPEEDS = [2.8, 4.5, 1.7];
/** Silence turns the motions at this share of full speed; half volume and up turns them at full speed */
const RESTING_SPEED = 0.25;
/** The envelope: a bell across the width with this spread (standard deviation, the width being 1) */
const BELL = 0.22;
/** Carrier waves across the width */
const CYCLES = 2.6;
/** The tallest a curve reaches before the ripple, as a share of the half-height: room for the ripple's crests */
const REACH = 0.8;

/** The page gets an 8-bit waveform, and this is the smallest step it can resolve: pauses in real recordings sit at this step */
const QUIET = 1 / 128;
/** The loudest volume. Speech in real recordings is usually 8 to 20 steps (0.06 to 0.16) */
const LOUD = 0.19;

/** How loud a volume is, 0 to 1, by how many times louder than the smallest step (logarithmic): speech crowds into a low band and would all look short if used directly */
export function loudness(level) {
  if (level <= QUIET) return 0;
  return Math.min(1, Math.log(level / QUIET) / Math.log(LOUD / QUIET));
}

export function createWave() {
  /** The envelope's height now, IDLE to 1 */
  let height = IDLE;
  /** sway, ripple, lag */
  let phases = [0, 0, 0];
  /** The time of the last frame. null before the first */
  let last = null;

  return {
    /** Hears a volume (0 to 1): a louder one lifts the wave at once */
    hear(level) {
      height = Math.max(height, loudness(level));
    },

    /**
     * The curves at this moment, back to front. Each point is [x, y]: x from 0 to 1 across, y from -1 to 1 (up is positive, 1 the half-height)
     * @param {number} now milliseconds
     * @param {{ still?: boolean }} [options] still: the motions stop (reduce motion); the height still follows the voice
     * @returns {Array<{ scale: number, main: boolean, points: number[][] }>}
     */
    frame(now, { still = false } = {}) {
      const since = last === null ? 0 : Math.max(0, now - last);
      last = now;
      height = Math.max(IDLE, height * Math.exp(-since / FALL_MS));
      if (!still) {
        const speed = RESTING_SPEED + (1 - RESTING_SPEED) * Math.min(1, (height - IDLE) / 0.5);
        phases = phases.map((phase, i) => phase + ((SPEEDS[i] * since) / 1000) * speed);
      }
      const [sway, ripple, lag] = phases;
      const slide = 0.5 * Math.sin(sway);
      return CURVES.map((scale, j) => {
        const main = scale === 1;
        // Echoes drift against the main curve and flex in height, each on its own beat, so the pairs never move as one block
        const drift = 0.9 * (1 - Math.abs(scale)) * Math.sin(lag + j);
        const flex = main ? 1 : 0.65 + 0.45 * Math.abs(Math.sin(lag * 0.7 + j * 1.3));
        const points = Array.from({ length: POINTS }, (_, k) => {
          const x = k / (POINTS - 1);
          const off = Math.abs(x - 0.5);
          const bell = Math.exp(-(off * off) / (2 * BELL * BELL));
          const rings = 1 - 0.22 * Math.cos(2 * Math.PI * 2.2 * off - ripple);
          const carrier = Math.cos(2 * Math.PI * CYCLES * (x - 0.5) + slide + drift);
          return [x, scale * flex * height * REACH * bell * rings * carrier];
        });
        return { scale, main, points };
      });
    },

    /** Starts over: silent, motions at their start */
    reset() {
      height = IDLE;
      phases = [0, 0, 0];
      last = null;
    },
  };
}
