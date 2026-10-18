import { WebSocket, WebSocketServer } from "ws";
import { msg } from "../i18n/index.mjs";
import {
  ClientType,
  envelope,
  MAX_CHUNK_BYTES,
  ProtocolError,
  parseClientMessage,
  ServerType,
} from "./protocol/protocol.mjs";
import { RecordingSession } from "./protocol/session.mjs";

export const WS_PATH = "/ws/rt_voice_flow";

/** About 25 minutes of recording; Gemini's inline audio request limit is 20 MB, which leaves room even after base64 */
const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ERROR_DETAIL_MAX_LENGTH = 300;

/**
 * Starts the dictation service. refiner is the "audio in, text out" step (refine), optionally with a prepare run when speech starts,
 * passed in by the caller and replaced by a fake in tests.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startServer({ host = "127.0.0.1", port, refiner, log, maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host,
      port,
      path: WS_PATH,
      maxPayload: MAX_CHUNK_BYTES,
      verifyClient: ({ origin }) => isLocalOrigin(origin),
    });
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      wss.on("error", (error) => log.error("server_error", { error: String(error) }));
      resolve({ port: wss.address().port, close: () => closeServer(wss) });
    });
    wss.on("connection", (socket) => handleConnection(socket, { refiner, log, maxAudioBytes }));
  });
}

/**
 * The service listens only on this computer, but any web page in a browser can connect to local ports and spend the user's model credit.
 * Browser connections always carry an Origin, so only connections without one (local programs) and file:// (Electron's local pages) are allowed.
 */
function isLocalOrigin(origin) {
  return origin === undefined || origin === "file://";
}

function closeServer(wss) {
  for (const socket of wss.clients) socket.terminate();
  return new Promise((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
}

function handleConnection(socket, { refiner, log, maxAudioBytes }) {
  /** The recording currently taking audio; cleared after end_audio while refining continues in the background */
  let session = null;
  /** Refining in progress, cancelled if the connection drops */
  const refining = new Set();

  const send = (kind, value) => {
    if (socket.readyState !== WebSocket.OPEN) {
      log.warn("send_skipped", { kind, audio_id: value.audio_id, reason: "connection closed" });
      return;
    }
    socket.send(JSON.stringify(envelope(kind, value)));
  };

  const requireSession = (audioId) => {
    if (!session) throw new ProtocolError("no_session", "No start_audio yet");
    if (audioId !== undefined && audioId !== session.audioId) {
      throw new ProtocolError(
        "audio_id_mismatch",
        `The current recording is ${session.audioId}, the message says ${audioId}`,
      );
    }
    return session;
  };

  const onText = (text) => {
    const message = parseClientMessage(text);
    switch (message.type) {
      case ClientType.START:
        if (session) {
          // A client that cancels a recording sends no end_audio and starts the next one directly
          log.info("session_abandoned", { audio_id: session.audioId, chunks: session.chunkCount });
        }
        session = new RecordingSession(message.audioId, { maxTotalBytes: maxAudioBytes });
        // The user started speaking: let the model side prepare (Gemini builds a prompt cache) so cleanup can use it.
        // Not awaited; a failed prepare only makes this one call pricier, so it's just logged
        Promise.resolve()
          .then(() => refiner.prepare?.())
          .catch((error) => log.warn("prepare_failed", { audio_id: message.audioId, error: String(error?.message) }));
        send(ServerType.STARTED, { audio_id: message.audioId, start_time: Date.now() });
        break;
      case ClientType.CHUNK_INFO:
        requireSession(message.audioId).announceChunk(message);
        break;
      case ClientType.END: {
        const finished = requireSession(message.audioId);
        session = null;
        // Refining waits a second or two on the model; it must not block later messages on this connection
        finish(finished, message.app).catch((error) => failConnection(error));
        break;
      }
    }
  };

  const onChunk = (data) => {
    const { index, size } = requireSession().addChunk(data);
    send(ServerType.CHUNK_RECEIVED, { index, server_t: Date.now(), size });
  };

  const finish = async (finished, app = null) => {
    const context = { audio_id: finished.audioId, chunks: finished.chunkCount, bytes: finished.totalBytes };
    if (finished.chunkCount === 0) {
      log.warn("no_audio", context);
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "no_audio",
        detail: "no audio received",
        problem: msg("voice.noAudio"),
      });
      return;
    }
    send(ServerType.ENDING, {
      audio_id: finished.audioId,
      total_chunks: finished.chunkCount,
      completed_chunks: finished.chunkCount,
      failed_chunks: 0,
    });

    const abort = new AbortController();
    refining.add(abort);
    const startedAt = performance.now();
    try {
      const result = await refiner.refine(finished.merge(), {
        mimeType: finished.mimeType,
        signal: abort.signal,
        audioId: finished.audioId,
        app,
      });
      // The local path also returns { text, notice } when cleanup was skipped
      const { text: refinedText, notice = null } = typeof result === "string" ? { text: result } : result;
      // Log only the length: the result is what the user said and doesn't belong in logs
      log.info("refined", {
        ...context,
        refine_ms: Math.round(performance.now() - startedAt),
        text_length: refinedText.length,
      });
      // The last five fields are always null in plain dictation; kept so clients parse one set of fields
      send(ServerType.COMPLETED, {
        audio_id: finished.audioId,
        refined_text: refinedText,
        status: true,
        run_index: 1,
        web_metadata: null,
        delivery: null,
        action: null,
        user_prompt: null,
        external_action: null,
        // Something the user should know about this result (cleanup skipped): a msg, translated by the bar
        notice,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        log.info("refine_cancelled", { ...context, reason: "connection dropped" });
        return;
      }
      log.error("refine_failed", {
        ...context,
        refine_ms: Math.round(performance.now() - startedAt),
        error: String(error?.stack ?? error),
        // Model-layer errors (ModelError) give the user problem, and the model's own text (key scrubbed) goes in detail
        ...(error?.detail ? { model_said: error.detail.slice(0, 1_000) } : {}),
        ...(error?.origin ? { origin: error.origin.slice(0, 2_000) } : {}),
      });
      // code and detail are the protocol's; problem is the sentence for the user (a msg or the original text), translated by the bar into the UI language
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "refine_failed",
        detail: String(error?.message ?? error).slice(0, ERROR_DETAIL_MAX_LENGTH),
        ...(error?.problem ? { problem: error.problem } : {}),
      });
    } finally {
      refining.delete(abort);
    }
  };

  /** An error outside the protocol means a server bug: log it and disconnect rather than continue in a bad state */
  const failConnection = (error) => {
    log.error("connection_failed", { audio_id: session?.audioId, error: String(error?.stack ?? error) });
    socket.close(1011, "internal error");
  };

  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) onChunk(data);
      else onText(data.toString("utf8"));
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        failConnection(error);
        return;
      }
      log.warn("protocol_error", { audio_id: session?.audioId, code: error.code, detail: error.detail });
      send(ServerType.ERROR, { audio_id: session?.audioId ?? null, code: error.code, detail: error.detail });
    }
  });

  socket.on("error", (error) => log.warn("socket_error", { audio_id: session?.audioId, error: String(error) }));

  socket.on("close", (code) => {
    if (session) log.info("session_abandoned", { audio_id: session.audioId, chunks: session.chunkCount, code });
    session = null;
    for (const abort of refining) abort.abort();
  });
}
