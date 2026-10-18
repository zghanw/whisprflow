import { CLOUD_TRANSCRIBERS } from "./asr/cloud/vendors.mjs";
import { CHAT_VENDORS } from "./chat/vendors.mjs";
import { PROVIDERS } from "./providers/index.mjs";

// Every vendor in every role: the audio models of the native path (providers/), the text models of the cleanup step (chat/vendors.mjs),
// and cloud transcription for step one of the local path (asr/cloud/vendors.mjs). Keys are stored per vendor (keyFile in storage/paths.mjs),
// and a vendor used in several roles shares one key. Vendors that run on this computer (Ollama) have keyEnv null.
// Only what storing and finding keys needs: id, name, environment variable, and where to get a key.

export const VENDORS = Object.freeze(
  [...PROVIDERS, ...CHAT_VENDORS, ...CLOUD_TRANSCRIBERS]
    .filter((vendor, index, all) => all.findIndex(({ id }) => id === vendor.id) === index)
    .map(({ id, name, keyEnv, keyPage }) => Object.freeze({ id, name, keyEnv, keyPage })),
);

/** @returns {(typeof VENDORS)[number] | null} case-insensitive; null when unknown */
export function findVendor(id) {
  const wanted = String(id).toLowerCase();
  return VENDORS.find((vendor) => vendor.id === wanted) ?? null;
}
