#!/usr/bin/env node
// Screenshots of the app's windows with real state: every onboarding step it can reach, the main window's home, mode menu, Models page (each tab and
// the recommended setups), history, and two Settings panes. Runs Electron with a fake microphone (a tone), so the microphone step never opens yours;
// the windows show briefly while it works.
//
// Usage: node scripts/dev/screens.mjs <output directory> [--home <directory>] [--demo] [--audio <wav>]
//   By default it runs on a fresh data directory (a few dictionary terms seeded), deleted afterwards, so nothing of yours is touched.
//   --home uses that data directory instead and keeps it: one where an on-device model is downloaded shows the app ready, with no "missing" notes
//   --audio plays a WAV as the fake microphone (looping), so the microphone step shows a voice instead of an occasional beep
//   --demo fills an empty history with four months of sample dictations, so the home page and history have something to show (README screenshots)
// Settings can be given as environment variables, as for the app (WHISPRFLOW_MODE, WHISPRFLOW_POLISH, WHISPRFLOW_THEME, ...):
//   WHISPRFLOW_POLISH=ollama/llama3.2:1b node scripts/dev/screens.mjs shots   (cleanup model not pulled in Ollama)
// WHISPRFLOW_SCREENS_MEDIA emulates media features, comma-separated:
//   WHISPRFLOW_SCREENS_MEDIA=prefers-color-scheme=dark,prefers-contrast=more node scripts/dev/screens.mjs shots

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openHistory } from "../../src/storage/history.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

/** Sample dictations: the kind of thing people say into a text box all day */
const SAMPLES = [
  "Thanks for the quick turnaround. I'll review the PR this afternoon and leave comments by end of day.",
  "Can we push the standup to 10:30 tomorrow? I have a dentist appointment first thing.",
  "The build failed again because the cache was stale. We should clear it before every release.",
  "Quick update: the migration to PostgreSQL is done, and the API now runs on Kubernetes.",
  "Hey, are you free for a call later? I want to walk through the onboarding flow before we ship it.",
  "For the trip we need:\n- Tickets\n- The hotel booking\n- A rental car",
  "Let's keep the scope small for this sprint and leave the dashboard redesign for next quarter.",
  "I tested it on Windows and the latency is under two seconds from the end of speech to the pasted text.",
  "Please send me the slides from yesterday's review when you get a chance.",
  "Note to self: rotate the Supabase keys and update the staging environment variables.",
  "Great question. The short answer is yes, but it depends on how much data you're moving each night.",
  "Happy birthday! Hope you have a wonderful day and get some time off to celebrate.",
  "Can you write up a summary of the Q4 numbers for Monday's meeting?",
  "The new onboarding cut our setup time in half. Nice work, everyone.",
  "Reminder: the office is closed on Friday, so plan your deploys for Thursday at the latest.",
  "I think the bug is in the retry logic. It never resets the counter after a successful request.",
  "Dear Ms. Tan, thank you for your time today. I've attached the proposal we discussed.",
  "Grocery list: oat milk, eggs, spinach, and coffee beans.",
  "We moved the API from Heroku to Kubernetes last week, and costs dropped by about a third.",
  "Let's meet at 3pm instead. The earlier slot clashes with the design review.",
  "Could you double-check the numbers in row 42? They don't match the invoice.",
  "First, update the docs. Second, fix the login bug. Third, ship the release.",
  "I'm running about ten minutes late, start without me.",
  "This looks good to me. Approving now, and feel free to merge once the checks pass.",
];

/** A repeatable sequence of numbers from 0 to 1, so the sample history is the same every run */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Four months of sample dictations, picking up over time and busier on weekdays (no sample twice in a day), each with its on-device transcription
 * and Ollama cleanup calls (free). Only into an empty history
 */
function seedDemoHistory(dbPath) {
  const history = openHistory(dbPath);
  try {
    if (history.stats().dictations > 0) return;
    const random = seeded(42);
    const today = new Date();
    const DAYS = 120;
    for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
      const day = new Date(today);
      day.setDate(today.getDate() - daysAgo);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      // From an occasional try at the start to most weekdays lately
      const habit = 1 - daysAgo / DAYS;
      if (random() > (weekend ? 0.3 : 0.25 + 0.65 * habit)) continue;
      const count = Math.min(
        SAMPLES.length,
        Math.round((weekend ? 2 : 3 + 6 * habit) + random() * (weekend ? 3 : 4 + 6 * habit)),
      );
      const order = [...SAMPLES].sort(() => random() - 0.5);
      for (let i = 0; i < count; i++) {
        const at = new Date(day);
        at.setHours(9 + Math.floor(random() * 10), Math.floor(random() * 60), Math.floor(random() * 60));
        if (at > today) continue;
        const text = order[i];
        const words = text.split(/\s+/).length;
        // Speaking at about 140 words a minute, with a pause or two
        const duration = Math.round((words / 2.3 + 1 + random() * 2) * 10) / 10;
        const id = randomUUID();
        const createdAt = at.toISOString();
        history.add({
          id,
          status: "completed",
          refinedText: text,
          error: null,
          duration,
          audioLocalPath: null,
          createdAt,
        });
        const call = {
          audioId: id,
          purpose: "dictation",
          audioTokens: 0,
          cachedTokens: 0,
          thinkingTokens: 0,
          costUsd: 0,
          createdAt,
        };
        history.addCall({
          ...call,
          provider: "local",
          model: "phonon-2",
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Math.round(380 + random() * 260),
        });
        history.addCall({
          ...call,
          provider: "ollama",
          model: "qwen3:4b-instruct",
          inputTokens: 330 + words * 2,
          outputTokens: Math.round(words * 1.4),
          latencyMs: Math.round(550 + random() * 500),
        });
      }
    }
  } finally {
    history.close();
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { home: { type: "string" }, demo: { type: "boolean", default: false }, audio: { type: "string" } },
});
const out = positionals[0] && resolve(positionals[0]);
if (!out) {
  console.error("Usage: node scripts/dev/screens.mjs <output directory> [--home <directory>] [--demo] [--audio <wav>]");
  process.exit(2);
}

const electron = createRequire(import.meta.url)("electron");
// A short name: the home directory holds the control channel socket, and its path has a length limit
const workDir = values.home ? null : mkdtempSync(join(tmpdir(), "wf-screens-"));
const home = values.home ? resolve(values.home) : join(workDir, "home");
mkdirSync(home, { recursive: true });
if (!existsSync(join(home, "dictionary.txt"))) {
  writeFileSync(join(home, "dictionary.txt"), "Kubernetes\nPostgreSQL\nSupabase\nHeroku\n");
}
if (values.demo) seedDemoHistory(resolvePaths({ WHISPRFLOW_HOME: home }).historyDb);

const child = spawn(
  electron,
  [
    ".",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // The audio service is sandboxed and can't read the WAV otherwise (as in scripts/dev/e2e.mjs)
    ...(values.audio
      ? [`--use-file-for-fake-audio-capture=${resolve(values.audio)}`, "--disable-features=AudioServiceSandbox"]
      : []),
  ],
  {
    cwd: resolve(import.meta.dirname, "../.."),
    env: { ...process.env, WHISPRFLOW_SCREENS_OUT: out, WHISPRFLOW_HOME: home },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
// A page that never finishes shouldn't hang this forever
const watchdog = setTimeout(() => child.kill("SIGKILL"), 180_000);
child.on("exit", (code) => {
  clearTimeout(watchdog);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  console.log(code === 0 ? `Screenshots in ${out}` : `Electron exited with ${code}`);
  process.exitCode = code ?? 1;
});
