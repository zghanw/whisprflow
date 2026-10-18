// The steps after decoding: mixing to mono, downsampling, wrapping in WAV. Each is a few lines, so no library:
// the downsampling libraries found had only a few hundred weekly downloads, and a WAV is just a 44-byte header.

/**
 * The common recognition format: 16 kHz, mono. Cloud models and on-device transcription both take it, and 16 kHz is plenty for speech;
 * every incoming recording is converted to it first (toSpeech in transcode.mjs).
 */
export const SPEECH_SAMPLE_RATE = 16_000;

/** Low-pass filter length. Longer is steeper and slower: 97 taps take about 60 ms per minute of audio (measured) */
const TAPS = 97;
/** Cutoff as a share of the target rate: 7.2 kHz when going to 16 kHz, leaving room for the transition band; speech is mostly under 4 kHz */
const CUTOFF_RATIO = 0.45;

/** Averages multiple channels into one. A mono recording comes back as is */
export function mixDown(channels) {
  if (channels.length === 1) return channels[0];
  const mixed = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < mixed.length; i++) mixed[i] += channel[i] / channels.length;
  }
  return mixed;
}

/** A Blackman-windowed sinc low-pass whose taps sum to 1 (unchanged gain at low frequencies). cutoff is relative to the input rate */
function lowPass(cutoff) {
  const middle = (TAPS - 1) / 2;
  const kernel = new Float64Array(TAPS);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  return kernel.map((value) => value / sum);
}

/**
 * Downsamples to `to`. Integer factors only (Opus always decodes at 48 kHz, and 48 to 16 kHz is 3):
 * first a low-pass removes frequencies the new rate can't represent, which would otherwise fold back as noise in the speech band, then every nth sample is kept.
 * @param {Float32Array} samples
 */
export function downsample(samples, from, to) {
  if (from === to) return samples;
  const factor = from / to;
  if (!Number.isInteger(factor))
    throw new Error(`Can only downsample to ${to} Hz from an integer multiple; this recording is ${from} Hz`);
  const kernel = lowPass((CUTOFF_RATIO * to) / from);
  const middle = (TAPS - 1) / 2;
  const output = new Float32Array(Math.ceil(samples.length / factor));
  for (let o = 0; o < output.length; o++) {
    const start = o * factor - middle;
    let sum = 0;
    for (let k = Math.max(0, -start); k < TAPS && start + k < samples.length; k++) {
      sum += kernel[k] * samples[start + k];
    }
    output[o] = sum;
  }
  return output;
}

/** A mono 16-bit little-endian PCM WAV file */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16); // fmt chunk length
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  wav.writeUInt16LE(2, 32); // bytes per sample
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    // Values beyond +-1 are clipped: converting them directly would overflow into a pop of the opposite sign
    const value = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), 44 + i * 2);
  }
  return wav;
}

/**
 * The kind of WAV encodeWav writes (mono, 16-bit PCM, 44-byte header), to samples.
 * Other layouts (stereo, float, extra chunks) aren't guessed at, they are errors, so recordings from different sources never quietly take different paths.
 * @param {Buffer} wav
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function decodeWav(wav) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 16) !== "WAVEfmt ") {
    throw new Error("Not a WAV file");
  }
  if (wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(34) !== 16) throw new Error("Only 16-bit PCM WAV is supported");
  if (wav.readUInt16LE(22) !== 1)
    throw new Error(`Only mono WAV is supported; this one has ${wav.readUInt16LE(22)} channels`);
  const dataBytes = wav.readUInt32LE(40);
  if (wav.toString("ascii", 36, 40) !== "data" || wav.length !== 44 + dataBytes) {
    throw new Error(
      `WAV length mismatch: the header says ${dataBytes} bytes of audio, the file has ${wav.length - 44}`,
    );
  }
  const samples = new Float32Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i++) {
    const value = wav.readInt16LE(44 + i * 2);
    samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return { samples, sampleRate: wav.readUInt32LE(24) };
}
