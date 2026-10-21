#!/usr/bin/env node
// Screenshots of the app's windows with real state: onboarding (first step and prepare), Settings > Dictionary, the main window's home and Models page.
// Runs Electron on a fresh data directory (a few dictionary terms seeded), so nothing of yours is touched; the windows show briefly while it works.
//
// Usage: node scripts/dev/screens.mjs <output directory>
// Settings can be given as environment variables, as for the app (WHISPRFLOW_MODE, WHISPRFLOW_POLISH, WHISPRFLOW_THEME, ...):
//   WHISPRFLOW_POLISH=ollama/llama3.2:1b node scripts/dev/screens.mjs shots   (cleanup model not pulled in Ollama)
// WHISPRFLOW_SCREENS_MEDIA emulates media features, comma-separated:
//   WHISPRFLOW_SCREENS_MEDIA=prefers-color-scheme=dark,prefers-contrast=more node scripts/dev/screens.mjs shots

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const out = process.argv[2] && resolve(process.argv[2]);
if (!out) {
  console.error("Usage: node scripts/dev/screens.mjs <output directory>");
  process.exit(2);
}

const electron = createRequire(import.meta.url)("electron");
// A short name: the home directory holds the control channel socket, and its path has a length limit
const workDir = mkdtempSync(join(tmpdir(), "wf-screens-"));
const home = join(workDir, "home");
mkdirSync(home);
writeFileSync(join(home, "dictionary.txt"), "Kubernetes\nPostgreSQL\nSupabase\nHeroku\n");

const child = spawn(electron, ["."], {
  cwd: resolve(import.meta.dirname, "../.."),
  env: { ...process.env, WHISPRFLOW_SCREENS_OUT: out, WHISPRFLOW_HOME: home },
  stdio: ["ignore", "inherit", "inherit"],
});
// A page that never finishes shouldn't hang this forever
const watchdog = setTimeout(() => child.kill("SIGKILL"), 120_000);
child.on("exit", (code) => {
  clearTimeout(watchdog);
  rmSync(workDir, { recursive: true, force: true });
  console.log(code === 0 ? `Screenshots in ${out}` : `Electron exited with ${code}`);
  process.exitCode = code ?? 1;
});
