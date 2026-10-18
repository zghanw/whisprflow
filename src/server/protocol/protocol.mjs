// The dictation protocol between the bar and this server.
// Messages arrive as JSON text frames, audio as binary frames announced by set_audio_chunk_info.
// Only messages that have a sender are implemented.

/** A 3-second chunk measured 14 to 15 KB; plenty of headroom here, also the WebSocket frame limit */
export const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_AUDIO_ID_LENGTH = 128;
/** An app name longer than this isn't a name: dropped rather than put in a prompt */
const MAX_APP_LENGTH = 80;

export const ClientType = Object.freeze({
  START: "start_audio",
  CHUNK_INFO: "set_audio_chunk_info",
  END: "end_audio",
});

export const ServerType = Object.freeze({
  STARTED: "audio_session_started",
  CHUNK_RECEIVED: "received_audio_chunk_count",
  ENDING: "audio_session_ending",
  COMPLETED: "audio_processing_completed",
  PROCESSING_ERROR: "audio_processing_error",
  ERROR: "error",
});

/** The client sent something outside the protocol. code is for programs, detail for people */
export class ProtocolError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

/** The envelope of server messages. T/M/S only take this one set of values */
export function envelope(kind, value) {
  return { K: kind, V: value, T: "json", M: false, S: "done" };
}

function audioIdOf(message) {
  const id = message.audio_id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_AUDIO_ID_LENGTH) {
    throw new ProtocolError("invalid_field", `audio_id must be a string of 1 to ${MAX_AUDIO_ID_LENGTH} characters`);
  }
  return id;
}

/** The app the text goes into (an executable or app name from the key helper), for cleanup's tone. Optional: anything odd is dropped, never an error */
function appOf(message) {
  const app = typeof message.app === "string" ? message.app.replace(/[\r\n\t]/g, " ").trim() : "";
  return app.length > 0 && app.length <= MAX_APP_LENGTH ? app : null;
}

function positiveInteger(message, field, max) {
  const value = message[field];
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ProtocolError("invalid_field", `${field} must be an integer from 1 to ${max}`);
  }
  return value;
}

// A Map rather than an object literal: message types come from outside, and names like "constructor" must not find a prototype property
const PARSERS = new Map([
  [ClientType.START, (message) => ({ type: ClientType.START, audioId: audioIdOf(message) })],
  [
    ClientType.CHUNK_INFO,
    (message) => ({
      type: ClientType.CHUNK_INFO,
      audioId: audioIdOf(message),
      index: positiveInteger(message, "index", Number.MAX_SAFE_INTEGER),
      size: positiveInteger(message, "size", MAX_CHUNK_BYTES),
    }),
  ],
  [ClientType.END, (message) => ({ type: ClientType.END, audioId: audioIdOf(message), app: appOf(message) })],
]);

/** Parses and validates a text message, keeping only the fields the server uses */
export function parseClientMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", "The text frame is not valid JSON");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProtocolError("invalid_message", "The message must be a JSON object");
  }
  const parse = PARSERS.get(message.type);
  if (!parse) {
    throw new ProtocolError("unknown_type", `Unknown message type: ${String(message.type).slice(0, 64)}`);
  }
  return parse(message);
}
