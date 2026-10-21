import assert from "node:assert/strict";
import { test } from "node:test";
import { createLearner, learnPrompt, termsFrom } from "../../../src/server/refine/learner.mjs";
import { MAX_LEARNED_TERMS } from "../../../src/storage/dictionary.mjs";

const quiet = { info() {}, warn() {} };

/** A dictionary kept in memory, with the same learn rules as the file one (known terms skipped) */
function memoryDictionary(initial = []) {
  const terms = [...initial];
  return {
    terms: () => [...terms],
    learn(added) {
      const fresh = added.filter((term) => !terms.some((known) => known.toLowerCase() === term.toLowerCase()));
      terms.push(...fresh);
      return fresh;
    },
  };
}

function fakeClient(reply) {
  const requests = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      if (reply instanceof Error) throw reply;
      return { text: reply, problem: null };
    },
  };
}

test("candidate terms: list marks stripped; kept only if they read as a name in the text (times like 3pm don't)", () => {
  const text = "We moved the api to Kubernetes and Postgres 17 at 3pm last week, said Zoë";
  const output = "- Kubernetes\n* Postgres 17\n\u2022 api\nweek\n3pm\nRedis\nZoë\nK";
  assert.deepEqual(termsFrom(output, text), ["Kubernetes", "Postgres 17", "Zoë"]);
});

test("the prompt lists known terms for the model to leave out, or says there are none", () => {
  assert.match(learnPrompt([]), /already-known terms: \(none\)$/);
  assert.match(learnPrompt(["Ollama", "Qwen3"]), /already-known terms: Ollama, Qwen3$/);
});

test("learns new terms from a finished text: unknown ones only, at most five per dictation", async () => {
  const dictionary = memoryDictionary(["Ollama"]);
  const client = fakeClient("Ollama\nAlpha\nBravo\nCharlie\nDelta\nEcho\nFoxtrot");
  const text = "Ollama Alpha Bravo Charlie Delta Echo Foxtrot all mentioned today";
  const added = await createLearner({ client, dictionary, log: quiet })(text);
  assert.deepEqual(added, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  assert.equal(client.requests[0].user, `Text: ${text}`);
  assert.match(client.requests[0].system, /already-known terms: Ollama$/);
});

test("short texts, a full dictionary, and a failing model all learn nothing without throwing", async () => {
  const short = fakeClient("Kubernetes");
  assert.deepEqual(
    await createLearner({ client: short, dictionary: memoryDictionary(), log: quiet })("Ship Kubernetes now"),
    [],
  );
  assert.equal(short.requests.length, 0, "under four words: no request");

  const full = fakeClient("Kubernetes");
  const crowded = memoryDictionary(Array.from({ length: MAX_LEARNED_TERMS }, (_, i) => `T${i}`));
  assert.deepEqual(
    await createLearner({ client: full, dictionary: crowded, log: quiet })("we use Kubernetes for everything here"),
    [],
  );
  assert.equal(full.requests.length, 0, "at the cap: no request");

  const broken = fakeClient(new Error("fetch failed"));
  const warned = [];
  const log = { info() {}, warn: (event) => warned.push(event) };
  assert.deepEqual(
    await createLearner({ client: broken, dictionary: memoryDictionary(), log })(
      "we use Kubernetes for everything here",
    ),
    [],
  );
  assert.deepEqual(warned, ["dictionary_learn_failed"]);
});

test("words capitalized only because they start a sentence or a list item aren't names; mid-sentence capitals, acronyms, and inner capitals are", () => {
  const text =
    "For the trip, we need:\n- Tickets\n- Hotel booking\nWe moved the API from Heroku to Kubernetes. Supabase hosts PostgreSQL.\nWrite me a poem about the ocean.";
  const output = "Tickets\nHotel booking\nAPI\nHeroku\nKubernetes\nSupabase\nPostgreSQL\nOcean\nWrite";
  assert.deepEqual(termsFrom(output, text), ["API", "Heroku", "Kubernetes", "PostgreSQL"]);
});
