import { LocalizedError, msg } from "../../i18n/index.mjs";
import { downsample, encodeWav, mixDown, SPEECH_SAMPLE_RATE } from "./pcm.mjs";

// Converts recordings into the formats other vendors' models accept. Recordings are Opus: the bar records them in WebM, other recorders use Ogg.
// Gemini takes both directly and never comes through here; OpenAI only takes wav and mp3 (tested: other formats return 400).
// Ogg is not converted: splitting Ogg needs the LGPL codec-parser, which is deliberately not shipped with the app; WhisprFlow itself only records WebM.

const CONTAINERS = [
  { magic: Buffer.from("OggS"), mimeType: "audio/ogg" },
  { magic: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), mimeType: "audio/webm" },
];

/** Identifies the recording's container by its header: audio/ogg, audio/webm, otherwise null */
export function audioTypeOf(bytes) {
  return CONTAINERS.find(({ magic }) => bytes.subarray(0, magic.length).equals(magic))?.mimeType ?? null;
}

/**
 * Recording formats the app reads: format to the loader of its decoder. Loaded on first use: decoders carry WASM, and Gemini-only users needn't pay that startup cost.
 * Callers that need Ogg pass their own decoders; the app does not ship one.
 */
export const DECODERS = new Map([["audio/webm", () => import("@audio/decode-webm")]]);

/**
 * Recording to the common recognition format: 16 kHz mono samples (-1 to 1).
 * Measured on a 90 s recording sent to OpenAI: 48 kHz took 18 s, 16 kHz 7 to 9 s, with the same audio token count.
 * @param {Buffer} audio the whole recording
 * @param {string} mimeType the format the server identified from the header (see protocol/session.mjs)
 * @param {Map<string, () => Promise<{ default: (bytes: Uint8Array) => Promise<{ channelData: Float32Array[], sampleRate: number }> }>>} [decoders]
 * @returns {Promise<Float32Array>}
 */
export async function toSpeech(audio, mimeType, decoders = DECODERS) {
  const load = decoders.get(mimeType);
  if (!load)
    throw new Error(`Can't convert ${mimeType} for recognition: only ${[...decoders.keys()].join(", ")} is supported`);
  const { default: decode } = await load();
  let decoded;
  try {
    decoded = await decode(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
  } catch (error) {
    throw new LocalizedError(msg("audio.undecodable", { type: mimeType, reason: String(error?.message ?? error) }), {
      cause: error,
    });
  }
  if (!decoded?.channelData?.length || decoded.channelData[0].length === 0) {
    throw new LocalizedError(msg("audio.empty", { type: mimeType }));
  }
  return downsample(mixDown(decoded.channelData), decoded.sampleRate, SPEECH_SAMPLE_RATE);
}

/**
 * Recording to 16 kHz mono 16-bit WAV, for vendors that only take WAV.
 * @returns {Promise<{ audio: Buffer, mimeType: "audio/wav" }>}
 */
export async function toWav(audio, mimeType) {
  return { audio: encodeWav(await toSpeech(audio, mimeType), SPEECH_SAMPLE_RATE), mimeType: "audio/wav" };
}
