// The WebSocket to the server. Message names and fields follow the server's voice protocol (src/server).
// It only depends on the standard WebSocket, so it runs in browsers and Node, and tests connect to the real server module.
// Errors are thrown as LocalizedError: the sentence for people (problem) is translated by the floating bar into the interface language.

import { LocalizedError, msg } from "../../i18n/index.mjs";

/** How long dictation waits for the result: VOICE_TRANSCRIPT_REFINE_TIMEOUT_MS */
export const REFINE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CHUNK_SECONDS = 3;

export class VoiceSocket {
  #url;
  #socket = null;
  /** The current recording: { audioId, nextIndex, sending, failure, settle } */
  #current = null;

  constructor(url) {
    this.#url = url;
  }

  /** Connects only when used and reuses the connection. If dropped while idle, the next key press connects again */
  async #connected() {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    const socket = new WebSocket(this.#url);
    socket.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new LocalizedError(msg("voice.connectTimeout")));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new LocalizedError(msg("voice.unreachable", { url: this.#url })));
      });
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#socket = null;
      this.#fail(new LocalizedError(msg("voice.disconnected")));
    });
    this.#socket = socket;
    return socket;
  }

  /** Starts a recording. Throws here if it can't connect */
  async begin(audioId) {
    const socket = await this.#connected();
    this.#current = { audioId, nextIndex: 1, sending: Promise.resolve(), failure: null, settle: null };
    socket.send(
      JSON.stringify({
        type: "start_audio",
        audio_id: audioId,
        audio_chunk_time: CHUNK_SECONDS,
        audio_metadata: { audio_format: "webm", audio_codec: "opus", audio_channels: 1, need_merge: true },
        mode: "voice_transcript",
      }),
    );
  }

  /**
   * Sends an audio chunk. The recorder emits one every 3 seconds, queued here and sent in order:
   * reading the bytes is asynchronous, so without a queue a later chunk could jump ahead of an earlier one.
   * @param {Blob} blob
   */
  sendChunk(blob) {
    const current = this.#current;
    if (!current) throw new Error("Audio chunk sent before recording started");
    current.sending = current.sending.then(async () => {
      const bytes = await blob.arrayBuffer();
      if (this.#current !== current || current.failure) return;
      const index = current.nextIndex++;
      this.#socket.send(
        JSON.stringify({ type: "set_audio_chunk_info", audio_id: current.audioId, index, size: bytes.byteLength }),
      );
      this.#socket.send(bytes);
    });
    // A failed send is recorded on this recording and reported at finish, so it never becomes an unhandled rejection
    current.sending = current.sending.catch((error) => this.#fail(error));
  }

  /**
   * Ends recording and waits for the finished text. app: the app the text goes into (from the key helper), so cleanup can follow its tone
   * @returns {Promise<{ text: string, notice: object | null }>} text is empty when there was no speech;
   *   notice is something the user should know about this result (cleanup skipped), a msg
   */
  async finish({ durationSeconds, timeoutMs = REFINE_TIMEOUT_MS, app = null }) {
    const current = this.#current;
    if (!current) throw new Error("Finished before recording started");
    await current.sending;
    if (current.failure) {
      this.#current = null;
      throw current.failure;
    }
    const result = new Promise((resolve, reject) => {
      current.settle = { resolve, reject };
    });
    this.#socket.send(
      JSON.stringify({
        type: "end_audio",
        audio_id: current.audioId,
        total_duration: durationSeconds,
        mode: "voice_transcript",
        ...(app ? { app } : {}),
      }),
    );
    const timer = setTimeout(
      () => this.#fail(new LocalizedError(msg("voice.timeout", { seconds: timeoutMs / 1000 }))),
      timeoutMs,
    );
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      if (this.#current === current) this.#current = null;
    }
  }

  /** Discards the current recording. The server clears its side on the next start_audio or on disconnect */
  abandon() {
    this.#current = null;
  }

  close() {
    this.#current = null;
    this.#socket?.close();
    this.#socket = null;
  }

  #fail(error) {
    const current = this.#current;
    if (!current || current.failure) return;
    current.failure = error;
    current.settle?.reject(error);
  }

  #onMessage(data) {
    const { K: kind, V: value } = JSON.parse(data);
    const current = this.#current;
    // Late messages from the previous recording must not count toward this one
    if (!current || (value.audio_id && value.audio_id !== current.audioId)) return;
    switch (kind) {
      case "audio_processing_completed":
        current.settle?.resolve({ text: value.refined_text, notice: value.notice ?? null });
        break;
      case "audio_processing_error":
      case "error":
        // Errors the server can explain (reasons from the model) carry a problem; protocol-level faults only have code and detail
        this.#fail(
          new LocalizedError(value.problem ?? msg("voice.serverError", { code: value.code, detail: value.detail })),
        );
        break;
      // audio_session_started, received_audio_chunk_count, and audio_session_ending are only progress, not needed
    }
  }
}
