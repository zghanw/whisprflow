import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { countWords } from "../usage/insights.mjs";

// History and billing. The history table holds the columns dictation needs;
// the model_calls table records every model call (the billing ledger).
// Node's built-in SQLite instead of better-sqlite3: one less native module to rebuild for Electron.
// The background app writes and the CLI only reads, both through this same code.

/**
 * The schema version, stored in PRAGMA user_version. To change the schema later, append a step to MIGRATIONS; never edit existing ones.
 * Before going back to an older version, downgrade the database first: an older version won't touch a newer database and can't start. From 2 (billing) back to 1:
 *   sqlite3 ~/.whisprflow/data/history.db "DROP TABLE model_calls; PRAGMA user_version = 1;"
 * Only the ledger is lost; everything said is kept.
 */
const MIGRATIONS = [
  `CREATE TABLE history (
     id               TEXT PRIMARY KEY,   -- audio_id
     status           TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
     refined_text     TEXT NOT NULL,      -- empty string on failure
     error            TEXT,               -- why it failed, empty on success
     duration         REAL NOT NULL,      -- recording length, seconds
     audio_local_path TEXT,               -- the recording; kept for failed entries so nothing said is lost
     created_at       TEXT NOT NULL       -- ISO 8601
   );
   CREATE INDEX history_created_at ON history (created_at DESC);`,
  // The ledger and history are separate, with no foreign key: billing happens when the model replies, history only once the text is pasted; key checks and the prompt cache
  // (building and extending storage, see src/server/providers/gemini-cache.mjs) belong to no dictation
  `CREATE TABLE model_calls (
     id              INTEGER PRIMARY KEY,
     audio_id        TEXT,               -- which dictation (history.id); empty for key checks and the prompt cache
     purpose         TEXT NOT NULL CHECK (purpose IN ('dictation', 'check', 'cache')),
     provider        TEXT NOT NULL,      -- gemini / openai / ollama ...; on-device transcription is local
     model           TEXT NOT NULL,      -- the model that actually replied, which sets the price
     input_tokens    INTEGER NOT NULL,   -- input, audio and cache hits included
     audio_tokens    INTEGER NOT NULL,   -- of which audio
     cached_tokens   INTEGER NOT NULL,   -- of which cache hits
     output_tokens   INTEGER NOT NULL,   -- output, thinking included
     thinking_tokens INTEGER NOT NULL,   -- of which thinking
     cost_usd        REAL,               -- US dollars at the list price then; empty when the model isn't in the price list
     latency_ms      INTEGER NOT NULL,   -- from sending the request to receiving the whole reply
     created_at      TEXT NOT NULL       -- ISO 8601
   );
   CREATE INDEX model_calls_created_at ON model_calls (created_at);
   CREATE INDEX model_calls_audio_id ON model_calls (audio_id);`,
];

function migrate(db) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get();
  if (current > MIGRATIONS.length) {
    throw new LocalizedError(msg("storage.historyTooNew", { found: current, known: MIGRATIONS.length }));
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A read-only reader can't upgrade the database for it, and the columns may differ when versions don't match, so it doesn't read */
function openReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  if (version !== MIGRATIONS.length) {
    db.close();
    throw new LocalizedError(msg("storage.historyTooOld", { found: version, known: MIGRATIONS.length }));
  }
  return db;
}

/**
 * Opens the history database. By default it is created if missing and the schema upgraded to the latest.
 * @param {string} dbPath
 * @param {{ readOnly?: boolean }} [options] read-only neither creates nor upgrades; returns null when the database doesn't exist yet
 */
export function openHistory(dbPath, { readOnly = false } = {}) {
  let db;
  if (readOnly) {
    if (!existsSync(dbPath)) return null;
    db = openReadOnly(dbPath);
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    try {
      migrate(db);
    } catch (error) {
      // Close the file even when opening fails (a database newer than the program, say): open files can't be deleted or moved on Windows
      db.close();
      throw error;
    }
  }
  // Wait a moment when another process is writing, instead of failing at once with "database is locked"
  db.exec("PRAGMA busy_timeout = 2000");
  // Words are counted the same way as the home page insights, so the CLI and the window agree
  db.function("word_count", { deterministic: true }, (text) => countWords(text ?? ""));

  const insert = db.prepare(
    `INSERT INTO history (id, status, refined_text, error, duration, audio_local_path, created_at)
     VALUES (:id, :status, :refinedText, :error, :duration, :audioLocalPath, :createdAt)`,
  );
  const insertCall = db.prepare(
    `INSERT INTO model_calls (audio_id, purpose, provider, model, input_tokens, audio_tokens, cached_tokens,
                              output_tokens, thinking_tokens, cost_usd, latency_ms, created_at)
     VALUES (:audioId, :purpose, :provider, :model, :inputTokens, :audioTokens, :cachedTokens,
             :outputTokens, :thinkingTokens, :costUsd, :latencyMs, :createdAt)`,
  );
  // Take the latest few entries first, then match their billing, so however large the ledger gets only these entries are looked up by the audio_id index.
  // If any call in an entry has an unknown price, the entry's cost is null: counting half as the whole would undercount
  const select = db.prepare(
    `WITH recent AS (
       SELECT * FROM history ORDER BY created_at DESC LIMIT :limit
     )
     SELECT recent.id, recent.status, recent.refined_text AS refinedText, recent.error, recent.duration,
            recent.audio_local_path AS audioLocalPath, recent.created_at AS createdAt,
            count(call.id) AS calls,
            sum(call.input_tokens) AS inputTokens,
            sum(call.output_tokens) AS outputTokens,
            CASE WHEN count(call.cost_usd) = count(call.id) THEN sum(call.cost_usd) END AS costUsd,
            sum(call.latency_ms) AS latencyMs
     FROM recent LEFT JOIN model_calls AS call ON call.audio_id = recent.id
     GROUP BY recent.id
     ORDER BY recent.created_at DESC`,
  );
  const summarize = db.prepare(
    `SELECT count(*) FILTER (WHERE status = 'completed') AS dictations,
            coalesce(sum(word_count(refined_text)) FILTER (WHERE status = 'completed'), 0) AS words,
            coalesce(sum(duration) FILTER (WHERE status = 'completed'), 0) AS seconds,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            (SELECT coalesce(sum(cost_usd), 0) FROM model_calls WHERE created_at >= :since) AS costUsd,
            (SELECT count(*) - count(cost_usd) FROM model_calls WHERE created_at >= :since) AS unpricedCalls
     FROM history WHERE created_at >= :since`,
  );
  const completed = db.prepare(
    `SELECT created_at AS createdAt, refined_text AS text, duration FROM history
     WHERE status = 'completed' AND refined_text <> '' ORDER BY created_at`,
  );
  // The usage summary columns, shared by the totals and the per-model split
  const USAGE_COLUMNS = `count(*) AS calls,
            count(*) FILTER (WHERE purpose = 'check') AS checks,
            count(DISTINCT audio_id) AS dictations,
            coalesce(sum(input_tokens), 0) AS inputTokens,
            coalesce(sum(audio_tokens), 0) AS audioTokens,
            coalesce(sum(cached_tokens), 0) AS cachedTokens,
            coalesce(sum(output_tokens), 0) AS outputTokens,
            coalesce(sum(thinking_tokens), 0) AS thinkingTokens,
            coalesce(sum(cost_usd), 0) AS costUsd,
            coalesce(sum(cost_usd) FILTER (WHERE purpose = 'cache'), 0) AS cacheCostUsd,
            count(*) - count(cost_usd) AS unpricedCalls`;
  const usageTotals = db.prepare(`SELECT ${USAGE_COLUMNS} FROM model_calls WHERE created_at >= :since`);
  const usageByModel = db.prepare(
    `SELECT provider, model, ${USAGE_COLUMNS} FROM model_calls WHERE created_at >= :since
     GROUP BY provider, model ORDER BY costUsd DESC, calls DESC`,
  );
  // How long each dictation waited on models: retries for a stray timestamp add up to what the user waited; the local path's two steps (the local entry plus cleanup)
  // add up too. Split by model, each counts on its own
  const totalLatencies = db.prepare(
    `SELECT sum(latency_ms) AS ms FROM model_calls
     WHERE purpose = 'dictation' AND audio_id IS NOT NULL AND created_at >= :since
     GROUP BY audio_id ORDER BY ms`,
  );
  const dictationLatencies = db.prepare(
    `SELECT provider, model, sum(latency_ms) AS ms FROM model_calls
     WHERE purpose = 'dictation' AND audio_id IS NOT NULL AND created_at >= :since
     GROUP BY audio_id, provider, model ORDER BY ms`,
  );

  return {
    /** @param {{ id: string, status: "completed" | "failed", refinedText: string, error: string | null, duration: number, audioLocalPath: string | null, createdAt: string }} entry */
    add(entry) {
      insert.run(entry);
    },
    /**
     * The latest entries, newest first. Each carries its usage: { calls, inputTokens, outputTokens, costUsd, latencyMs },
     * with timestamp retries added up; null when nothing was billed (it failed before reaching a model, or was saved before billing existed)
     */
    list({ limit = 200 } = {}) {
      return select.all({ limit }).map(({ calls, inputTokens, outputTokens, costUsd, latencyMs, ...row }) => ({
        ...row,
        usage: calls === 0 ? null : { calls, inputTokens, outputTokens, costUsd, latencyMs },
      }));
    },
    /**
     * How many dictations, words, and how much time (completed ones only), how many failed, and what was spent in US dollars (key checks included).
     * Only calls with a known price add to the cost; unpriced calls are reported apart (unpricedCalls), so show it as "at least"
     * @param {{ since?: string }} [range] only count after this moment (ISO 8601)
     */
    stats({ since = "" } = {}) {
      return { ...summarize.get({ since }) };
    },
    /**
     * Every completed dictation, oldest first, with only what the home page statistics need (src/usage/insights.mjs): word counts and days come from the text and time.
     * Dictations that heard nothing (the model returned empty text) don't count: a stray press shouldn't count as an active day or drag down the speaking rate.
     * An entry is about a hundred characters, so thousands are a few hundred KB; nothing is pre-aggregated in the database
     */
    dictations() {
      return completed.all().map((row) => ({ ...row }));
    },
    /**
     * Records a billed call: a model call that got a reply (shaped like onCall in src/server/refine/refiner.mjs).
     * @param {{ purpose: "dictation" | "check" | "cache", audioId: string | null, provider: string, model: string, inputTokens: number, audioTokens: number, cachedTokens: number, outputTokens: number, thinkingTokens: number, costUsd: number | null, latencyMs: number, createdAt: string }} call
     */
    addCall(call) {
      // Only the columns the table has: one extra field makes SQLite report "unknown named parameter", and an adapter's extra usage field shouldn't break billing
      insertCall.run({
        audioId: call.audioId,
        purpose: call.purpose,
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        audioTokens: call.audioTokens,
        cachedTokens: call.cachedTokens,
        outputTokens: call.outputTokens,
        thinkingTokens: call.thinkingTokens,
        costUsd: call.costUsd,
        latencyMs: call.latencyMs,
        createdAt: call.createdAt,
      });
    },
    /**
     * Usage summary: how many calls (how many were key checks), how many dictations, each token count, US dollars (of which the prompt cache), how many calls had no price (not in the cost),
     * latenciesMs is each dictation's wait on models in ms (fastest first); models is the same split by model, biggest spend first.
     * @param {{ since?: string }} [range] only count after this moment (ISO 8601)
     */
    usage({ since = "" } = {}) {
      const latencies = dictationLatencies.all({ since });
      const latenciesOf = (provider, model) =>
        latencies.filter((row) => row.provider === provider && row.model === model).map(({ ms }) => ms);
      return {
        ...usageTotals.get({ since }),
        latenciesMs: totalLatencies.all({ since }).map(({ ms }) => ms),
        models: usageByModel
          .all({ since })
          .map((row) => ({ ...row, latenciesMs: latenciesOf(row.provider, row.model) })),
      };
    },
    close() {
      db.close();
    },
  };
}
