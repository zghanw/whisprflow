// The registry of cloud transcription: besides on-device models, step one of the local path can go to a cloud speech model.
// It is a second strategy in the same slot as the on-device runtimes (../engines); callers only know transcribe(samples) returning { text }.
// Each vendor gets an adapter in this directory that handles how requests are built, how replies are read, and how errors are recognized;
// recordings are normalized to 16 kHz mono (transcriber.mjs encodes a wav for the adapter), so adapters ignore formats.
// For recordings longer than one request accepts, give the model maxSeconds (the most per piece) and transcriber.mjs splits like for on-device models (../segment.mjs);
// adapters handle one piece.
//
// Only synchronous APIs fit: one request with the whole recording, one reply with the whole transcript. Upload-then-poll APIs
// and WebSocket streaming don't: dictation needs text the moment speech ends, with no time to poll and no need to stream one recording.
//
// Descriptions only, no adapters loaded: the CLI reads this list when listing models. To add a vendor: write an adapter and register it below.
// Settings write it as vendor/model, which tells it apart from on-device model ids (no slash).

// Empty by design: transcription runs on this computer. Register a vendor here to add a cloud option.
export const CLOUD_TRANSCRIBERS = Object.freeze([]);

/** @returns {(typeof CLOUD_TRANSCRIBERS)[number] | null} case-insensitive; null when unknown */
export function findCloudTranscriber(id) {
  const wanted = String(id).toLowerCase();
  return CLOUD_TRANSCRIBERS.find((vendor) => vendor.id === wanted) ?? null;
}

/**
 * Step one as written in settings, to the cloud { vendor, model }; null for an on-device model (no slash).
 * A vendor alone uses its default model. An unknown vendor is null too, and the caller reports it by the on-device model rules
 * @param {string} value
 * @returns {{ vendor: string, model: string } | null}
 */
export function cloudTranscriberOf(value) {
  const text = String(value ?? "").trim();
  const slash = text.indexOf("/");
  const vendor = findCloudTranscriber(slash === -1 ? text : text.slice(0, slash));
  if (!vendor) return null;
  const model = slash === -1 ? vendor.defaultModel : text.slice(slash + 1);
  return model ? { vendor: vendor.id, model } : null;
}

/** A cloud model's catalog entry; null when unlisted (it can still be sent, with the vendor's default endpoint) */
export const cloudModelOf = (vendor, model) => vendor.models.find(({ id }) => id === model) ?? null;
