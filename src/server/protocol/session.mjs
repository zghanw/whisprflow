import { audioTypeOf } from "../audio/transcode.mjs";
import { ProtocolError } from "./protocol.mjs";

/**
 * One recording's state on the server: audio chunks are taken in order and joined at the end.
 * Each chunk is two frames: an announcement (index, byte count), then one binary frame.
 */
export class RecordingSession {
  #chunks = [];
  #announced = null;
  #totalBytes = 0;
  #maxTotalBytes;
  #mimeType = null;

  constructor(audioId, { maxTotalBytes }) {
    this.audioId = audioId;
    this.#maxTotalBytes = maxTotalBytes;
  }

  get chunkCount() {
    return this.#chunks.length;
  }

  get totalBytes() {
    return this.#totalBytes;
  }

  /** Known once the first chunk arrives; null before */
  get mimeType() {
    return this.#mimeType;
  }

  /** Records "the next binary frame is chunk n of this size". Indexes start at 1 */
  announceChunk({ index, size }) {
    if (this.#announced) {
      throw new ProtocolError(
        "chunk_missing",
        `No audio frame arrived after chunk ${this.#announced.index} was announced`,
      );
    }
    const expected = this.#chunks.length + 1;
    if (index !== expected) {
      throw new ProtocolError("chunk_out_of_order", `Expected chunk ${expected}, but chunk ${index} was announced`);
    }
    this.#announced = { index, size };
  }

  /** Takes one binary frame. A bad frame is dropped, and the client must announce the chunk again before resending */
  addChunk(data) {
    const announced = this.#announced;
    if (!announced) {
      throw new ProtocolError("chunk_without_info", "Audio frame without a preceding set_audio_chunk_info");
    }
    this.#announced = null;
    if (data.length !== announced.size) {
      throw new ProtocolError(
        "chunk_size_mismatch",
        `Chunk ${announced.index} was announced as ${announced.size} bytes but has ${data.length}`,
      );
    }
    // The container is identified by its header, not by the format the client claims in start_audio.
    // Only the first chunk's header counts: in browser-recorded WebM the later chunks continue the data with no header
    const mimeType = this.#mimeType ?? audioTypeOf(data);
    if (!mimeType) {
      throw new ProtocolError("unsupported_audio", "The recording starts as neither Ogg nor WebM");
    }
    if (this.#totalBytes + data.length > this.#maxTotalBytes) {
      throw new ProtocolError("audio_too_large", `The recording is over the ${this.#maxTotalBytes}-byte limit`);
    }
    this.#mimeType = mimeType;
    this.#chunks.push(data);
    this.#totalBytes += data.length;
    return announced;
  }

  /**
   * The chunks back to back are the whole recording, with no re-encoding:
   * - WebM (sliced output of the browser MediaRecorder) is one file cut into pieces.
   * - Ogg chunks that are independent streams join into a "chained Ogg"; Gemini recognizes a 7-chunk chain start to finish (measured).
   */
  merge() {
    return Buffer.concat(this.#chunks, this.#totalBytes);
  }
}
