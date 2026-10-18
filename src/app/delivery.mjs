import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { msg } from "../i18n/index.mjs";

// What the main process does after a dictation: save the recording, record history, paste the text.
// Recordings are saved under Recordings/<audio_id>, failed ones too.

/** audio_id goes into a file name, so only the format the page makes with crypto.randomUUID() is accepted */
const AUDIO_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function checkRecording({ audioId, durationSeconds, audio }) {
  if (typeof audioId !== "string" || !AUDIO_ID.test(audioId)) throw new TypeError("audioId is not a UUID");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0)
    throw new TypeError("durationSeconds is not a valid duration");
  if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) throw new TypeError("audio is not binary data");
}

/**
 * @param {object} deps
 * @param {string} deps.recordingsDir
 * @param {{ add: Function }} deps.history
 * @param {(text: string) => Promise<{ ok: boolean }>} deps.paste
 * @param {(text: string) => void} deps.writeClipboard
 * @param {{ warn: Function, error: Function }} deps.log
 */
export function createDelivery({ recordingsDir, history, paste, writeClipboard, log, now = () => new Date() }) {
  const record = (payload, fields) => {
    checkRecording(payload);
    mkdirSync(recordingsDir, { recursive: true });
    const audioLocalPath = join(recordingsDir, `${payload.audioId}.webm`);
    const { audio } = payload;
    // A view may be part of a larger buffer; write only its own part
    const bytes = ArrayBuffer.isView(audio)
      ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
      : new Uint8Array(audio);
    writeFileSync(audioLocalPath, bytes);
    history.add({
      id: payload.audioId,
      duration: payload.durationSeconds,
      audioLocalPath,
      createdAt: now().toISOString(),
      ...fields,
    });
  };

  return {
    /**
     * The text is back: save first, then paste. If pasting fails the text goes to the clipboard, so nothing is lost.
     * @returns {Promise<{ notice: object | null }>} notice is what to tell the user on the bar (a msg the bar translates)
     */
    async completed(payload) {
      if (typeof payload.text !== "string") throw new TypeError("text is not a string");
      record(payload, { status: "completed", refinedText: payload.text, error: null });
      if (payload.text === "") return { notice: msg("delivery.silent") };
      try {
        const result = await paste(payload.text);
        if (result.ok) return { notice: null };
        log.warn("paste_not_permitted", { audio_id: payload.audioId, reason: result.reason });
        // Why the helper couldn't paste (native/main.swift, native/windows/main_windows.go):
        //   not_trusted  no Accessibility access on macOS; the text is already on the clipboard
        //   elevated     the target window runs as administrator on Windows, which blocks simulated keys; the text is already on the clipboard
        //   clipboard    the text didn't reach the clipboard on Windows (another program held it): put it there again so there's something to paste
        //   send_input   simulating the keys failed on Windows; the text is already on the clipboard
        if (result.reason === "not_trusted") return { notice: msg("delivery.noAccessibility") };
        if (result.reason === "elevated") return { notice: msg("delivery.elevated") };
        if (result.reason === "clipboard") writeClipboard(payload.text);
        return { notice: msg("delivery.pasteFailed") };
      } catch (error) {
        log.error("paste_failed", { audio_id: payload.audioId, error: String(error?.message ?? error) });
        writeClipboard(payload.text);
        return { notice: msg("delivery.pasteFailed") };
      }
    },

    /** This dictation failed: the recording and the reason go into history */
    failed(payload) {
      if (typeof payload.error !== "string") throw new TypeError("error is not a string");
      record(payload, { status: "failed", refinedText: "", error: payload.error });
    },
  };
}
