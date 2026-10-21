import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Cancelled } from "../../src/cli/ask-secret.mjs";
import { run } from "../../src/cli/main.mjs";
import { NotRunningError, TimeoutError } from "../../src/control.mjs";
import { createTranslator, LocalizedError, msg } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER, downloadSize, findModel, MODELS } from "../../src/models/catalog.mjs";
import { RUNTIME_STAMP } from "../../src/models/runtime.mjs";
import { CHAT_VENDORS } from "../../src/server/chat/vendors.mjs";
import { openHistory } from "../../src/storage/history.mjs";
import { keyFile, resolvePaths } from "../../src/storage/paths.mjs";
import { HOTKEY_IDS, resolveSettings } from "../../src/storage/settings.mjs";
import { assertOwnerOnlyDir } from "../helpers/owner-only.mjs";

/** Hotkeys depend on the OS: the default is the first, another is a non-default one; the choices follow this OS */
const DEFAULT_HOTKEY = HOTKEY_IDS[0];
const OTHER_HOTKEY = HOTKEY_IDS.at(-1);
const HOTKEY_CHOICES = new RegExp(HOTKEY_IDS.join(" \\/ "));
const enHotkey = createTranslator("en")(`hotkeys.${DEFAULT_HOTKEY}.name`);

const READY = {
  pid: 4321,
  version: "0.1.0",
  starting: false,
  hotkey: DEFAULT_HOTKEY,
  hotkeyLabel: enHotkey,
  provider: "gemini",
  mode: "native",
  model: "gemini/gemini-3.6-flash",
  thinking: "MINIMAL",
  packaged: false,
  helper: "running",
  key: { state: "ready", source: "stored", problem: null, verified: true },
  permissions: { microphone: "granted", listen: true, trusted: true },
  summary: { ready: true, missing: [], blocker: null, degraded: null },
};
/** The stored key was revoked */
const REVOKED_KEY = {
  ...READY,
  key: {
    state: "rejected",
    source: "stored",
    cause: "key",
    problem: "This key is invalid. Check it was copied in full",
  },
  summary: { ready: false, missing: ["Gemini API key"], blocker: "API key not working", degraded: null },
};
/** A misspelled model: Gemini rejected the request, the key itself is fine */
const WRONG_MODEL = {
  ...READY,
  model: "gemini/gemini-nope",
  key: {
    state: "rejected",
    source: "stored",
    cause: "other",
    problem: "Gemini rejected the request: models/gemini-nope is not found",
  },
  summary: { ready: false, missing: ["Gemini check"], blocker: "Gemini check failed", degraded: null },
};
const NO_KEY = {
  ...READY,
  key: { state: "missing", source: null, problem: null },
  summary: { ready: false, missing: ["Gemini API key"], blocker: "No Gemini API key", degraded: null },
};
const NO_PERMISSIONS = {
  ...READY,
  permissions: { microphone: "denied", listen: false, trusted: true },
  summary: {
    ready: false,
    missing: ["microphone access", "Input Monitoring access"],
    blocker: "No microphone access",
    degraded: null,
  },
};

let dir;
let paths;
/** Some tests put things outside the home directory */
let outside = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-"));
  paths = resolvePaths({ WHISPRFLOW_HOME: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (outside) rmSync(outside, { recursive: true, force: true });
  outside = null;
});

/**
 * A fake background app. running is its current state (null when not running), afterStart its state after starting,
 * saveKey decides the result of saving a key, stopped is what stopping reports, and hung true means it hangs without answering.
 * reloadTheme and reloadLanguage answer requests to reread the theme and language, by default like the real one: whatever the settings file says now.
 * changeRoute answers mode changes and model changes within modes (set-mode, set-model, set-transcriber, set-polish).
 * calls records what the CLI did to it.
 */
function fakeDaemon({
  running = null,
  afterStart = READY,
  saveKey = () => ({ ok: true }),
  checkModel = () => ({ ok: true, source: "stored", ms: 812 }),
  changeRoute = () => ({ ok: true }),
  stopped = "quit",
  hung = false,
  reloadTheme = () => ({ theme: resolveSettings({ file: paths.settingsFile, env: {} }).theme.value }),
  reloadLanguage = () => ({ language: resolveSettings({ file: paths.settingsFile, env: {} }).language.value }),
} = {}) {
  const daemon = {
    calls: [],
    /** Each command's parameters */
    requests: [],
    current: running,
    hung,
    async status(params = {}) {
      if (daemon.hung) throw new TimeoutError("status", 5_000);
      if (params.recheck) daemon.calls.push("recheck");
      return daemon.current;
    },
    async start({ onProgress }) {
      daemon.calls.push("start");
      onProgress("Verifying the key...");
      if (afterStart instanceof Error) throw afterStart;
      daemon.current = afterStart;
      return afterStart;
    },
    async stop() {
      daemon.calls.push("stop");
      const was = daemon.current !== null || daemon.hung;
      daemon.current = null;
      daemon.hung = false;
      return was ? stopped : "not-running";
    },
    async request(cmd, params) {
      daemon.calls.push(cmd);
      daemon.requests.push({ cmd, params });
      if (daemon.current === null) throw new NotRunningError();
      if (cmd === "check-model") return checkModel(params.model);
      if (cmd === "check-polish") return checkModel(params.polish);
      if (cmd === "check-mode") return checkModel(params.changes?.transcriber ?? params.mode);
      if (["set-mode", "set-model", "set-transcriber", "set-polish"].includes(cmd)) return changeRoute(cmd, params);
      if (cmd === "set-key") {
        const result = saveKey(params.key, params.provider);
        // Saving a key only changes the key state; which vendor is in use stays
        if (result.ok) daemon.current = { ...daemon.current, key: READY.key, summary: READY.summary };
        return result;
      }
      if (cmd === "forget-key") daemon.current = NO_KEY;
      if (cmd === "reload-theme") return reloadTheme();
      if (cmd === "reload-language") return reloadLanguage();
      return null;
    },
  };
  return daemon;
}

/** secrets: the answers given each time a key is asked for, in order. Text, an error to throw, or a function computing one */
function harness({
  daemon = fakeDaemon(),
  interactive = true,
  env = {},
  secrets = [],
  answers = [],
  confirms = [],
  keychain = () => true,
  locale = "en",
  latest = "v0.1.0",
  installerExit = 0,
  packageDir = paths.appDir,
  app = null,
  appInstall = () => {},
  modelDownload = "finish",
  // Which OS to uninstall like; the Windows parts (windows-system.mjs) are recorded and answered from system
  platform = "darwin",
  system = {},
} = {}) {
  const output = { out: "", err: "" };
  const asked = [];
  /** Plain questions asked (echoed ones, like which vendor to use) */
  const questions = [];
  const tails = [];
  const confirmed = [];
  /**
   * How many times the latest version was checked (with the time limit), versions the installer installed and whether to start after (starts),
   * the process ids given when looking for the app (lookedFor), apps replaced (apps: version, location, whether the background was still running), apps reopened
   */
  const updates = { checks: [], installs: [], starts: [], lookedFor: [], apps: [], opened: [] };
  /** On-device models the CLI downloaded and deleted itself while the background wasn't running (a fake library: a download finishes as soon as it reports progress, or fails) */
  const local = { downloads: [], removed: [], sources: [] };
  /** Path entries removed, shortcuts recognized, and directories to delete after exit during a Windows uninstall */
  const windows = { pathEntries: [], shortcuts: [], later: [] };
  const io = {
    out: (text) => {
      output.out += `${text}\n`;
    },
    err: (text) => {
      output.err += `${text}\n`;
    },
    env,
    interactive,
    color: false,
    version: "0.1.0",
    t: createTranslator(locale),
    paths,
    daemon,
    now: () => new Date("2026-10-13T07:00:00.000Z"),
    sleep: async () => {},
    localModels: ({ source, onChange = () => {} }) => {
      local.sources.push(source);
      const state = new Map();
      const models = {
        status: (id) => state.get(id) ?? { id, installed: false, download: null, problem: null },
        async download(id) {
          local.downloads.push(id);
          const total = downloadSize(findModel(id));
          state.set(id, { id, installed: false, download: { received: total / 2, total }, problem: null });
          onChange(id);
          if (modelDownload === "finish") {
            haveModel(id);
            state.set(id, { id, installed: true, download: null, problem: null });
          } else {
            state.set(id, {
              id,
              installed: false,
              download: null,
              problem: msg("localModels.downloadFailed", { model: id, reason: modelDownload }),
            });
          }
          onChange(id);
          return { ok: true };
        },
        remove(id) {
          local.removed.push(id);
          rmSync(join(paths.modelsDir, id), { recursive: true, force: true });
          return { ok: true };
        },
      };
      return models;
    },
    timeZone: "Asia/Shanghai",
    openHistory,
    async askSecret(prompt) {
      asked.push(prompt);
      const next = secrets.shift();
      const answer = typeof next === "function" ? next() : next;
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    async ask(question) {
      questions.push(question);
      const next = answers.shift();
      const answer = typeof next === "function" ? next() : next;
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    async tail(args) {
      tails.push(args);
      return 0;
    },
    async confirm(question) {
      confirmed.push(question);
      return confirms.shift() ?? false;
    },
    removeKeychainKey: keychain,
    platform,
    system: {
      removePathEntry: (entry) => {
        windows.pathEntries.push(entry);
        return true;
      },
      isOurShortcut: (file) => {
        windows.shortcuts.push(file);
        return system.ourShortcut?.(file) ?? true;
      },
      removeLoginItem: () => system.loginItem ?? false,
      removeAfterExit: (dirs) => windows.later.push(...dirs),
    },
    sharedPreferencesFile: join(dir, "com.github.Electron.plist"),
    packageDir,
    updater: {
      async latest(timeoutSeconds) {
        updates.checks.push(timeoutSeconds);
        const answer = typeof latest === "function" ? latest() : latest;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async install(version, { start = true } = {}) {
        updates.installs.push(version);
        updates.starts.push(start);
        // Like the real installer: stop the running one first
        daemon.current = null;
        return installerExit;
      },
      async findApp(pid) {
        updates.lookedFor.push(pid);
        return app;
      },
      async installApp(version, path) {
        updates.apps.push({ version, path, stillRunning: daemon.current !== null });
        appInstall();
      },
      async openApp(path) {
        updates.opened.push(path);
      },
    },
  };
  return {
    io,
    output,
    asked,
    questions,
    tails,
    confirmed,
    daemon,
    updates,
    local,
    windows,
    whisprflow: (...argv) => run(argv, io),
  };
}

/** An on-device model is downloaded: writes a receipt like the model store does (the CLI only reads receipts, never model files) */
function haveModel(id = DEFAULT_TRANSCRIBER) {
  const model = findModel(id);
  const where = join(paths.modelsDir, id);
  mkdirSync(where, { recursive: true });
  const files = Object.fromEntries(Object.values(model.files).map((file) => [file.path, file.sha256]));
  const runtime = model.runtime ? { runtime: RUNTIME_STAMP } : {};
  writeFileSync(
    join(where, ".complete.json"),
    JSON.stringify({ id, revision: model.origin.revision, files, ...runtime }),
  );
}

/** Pretends a key was saved earlier */
const haveStoredKey = () => writeFileSync(keyFile(paths, "gemini"), "ciphertext");
/** Native mode already chosen in settings: no first-run question, so the key flow starts at once */
const useNative = () => writeFileSync(paths.settingsFile, JSON.stringify({ mode: "native" }));

// ---------- Starting ----------

test("no arguments: starts it if not running, then shows the status panel", async () => {
  const { whisprflow, output, daemon } = harness();
  assert.equal(await whisprflow(), 0);
  assert.deepEqual(daemon.calls, ["start", "recheck"]);
  assert.match(output.out, /Starting/);
  assert.match(output.out, /WhisprFlow 0\.1\.0 · running/);
  assert.match(output.out, new RegExp(`press ${enHotkey} to start talking`));
});

test("already running: no second start, only the panel; start and no arguments are the same", async () => {
  for (const argv of [[], ["start"]]) {
    const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
    assert.equal(await whisprflow(...argv), 0);
    assert.ok(!daemon.calls.includes("start"));
    assert.match(output.out, /running/);
  }
});

test("native mode without a key: asks for the key, then starts; once saved it works; the key appears in no output", async () => {
  useNative();
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  // While waiting for startup the terminal echoes as usual: asking for the key only then would show a key pasted early on screen
  const whenAsked = () => {
    assert.deepEqual(daemon.calls, [], "startup hasn't begun when the key is asked for");
    return "AIza-my-secret";
  };
  const { whisprflow, output, asked } = harness({ daemon, secrets: [whenAsked] });
  assert.equal(await whisprflow(), 0);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.deepEqual(saved, ["AIza-my-secret"]);
  assert.equal(asked.length, 1);
  // Where to get one and where it is stored go with the prompt to the no-echo step: echo must be off before people see "key needed"
  assert.match(asked[0], /aistudio\.google\.com\/apikey/);
  assert.doesNotMatch(output.out, /aistudio/);
  assert.match(output.out, /Key saved and verified/);
  assert.match(output.out, /running/);
  assert.ok(!(output.out + output.err).includes("AIza-my-secret"));
});

test("first use: asks which vendor, grouped by mode, local first; picking Ollama saves local mode and asks for no key", async () => {
  const keyless = { state: "ready", source: "none", problem: null };
  const daemon = fakeDaemon({ afterStart: { ...READY, provider: null, mode: "local", key: keyless } });
  const { whisprflow, questions, asked, output } = harness({ daemon, answers: ["1"] });
  const code = await whisprflow();
  assert.equal(code, 0, output.out + output.err);
  assert.match(
    questions[0],
    /local mode.*\d+ MB[\s\S]*1.*Ollama.*no key needed[\s\S]*native mode[\s\S]*2.*Gemini[\s\S]*3.*OpenAI[\s\S]*4/,
  );
  assert.match(questions[0], /custom\/<model> --url/);
  assert.deepEqual([saved("mode"), saved("polish")], ["local", "ollama/qwen3:4b-instruct"]);
  assert.equal(asked.length, 0);
});

test("first use: asks which vendor first; picking OpenAI saves it to settings and asks for the OpenAI key, and only then starts", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" },
    saveKey: (key, provider) => {
      saved.push([key, provider]);
      return { ok: true };
    },
  });
  const whenChosen = () => {
    assert.deepEqual(daemon.calls, [], "startup hasn't begun while choosing");
    return "3";
  };
  const { whisprflow, questions, asked, output } = harness({
    daemon,
    answers: [whenChosen],
    secrets: ["sk-my-secret"],
  });
  assert.equal(await whisprflow(), 0);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /2.*Gemini/);
  assert.match(questions[0], /3.*OpenAI/);
  // It also says how to change later, so nobody thinks the choice is final
  assert.match(questions[0], /whisprflow model/);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /platform\.openai\.com\/api-keys/);
  assert.deepEqual(saved, [["sk-my-secret", "openai"]]);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.match(output.out, /OpenAI/);
  assert.ok(!(output.out + output.err).includes("sk-my-secret"));
});

test("first use: plain Enter means local mode with Ollama, and the choice is saved so it is asked only once", async () => {
  const first = harness({ daemon: fakeDaemon({ afterStart: LOCAL_READY }), answers: [""] });
  assert.equal(await first.whisprflow(), 0);
  assert.equal(first.questions.length, 1);
  assert.equal(first.asked.length, 0, "no key needed");
  assert.equal(JSON.parse(readFileSync(paths.settingsFile, "utf8")).mode, "local");

  const again = harness({ daemon: fakeDaemon({ afterStart: LOCAL_READY }) });
  assert.equal(await again.whisprflow(), 0);
  assert.equal(again.questions.length, 0);
});

test("names work when choosing too; a wrong answer lists the choices and asks again", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "openai" } });
  const { whisprflow, questions, output } = harness({ daemon, answers: ["nope", "OpenAI"], secrets: ["sk-key"] });
  assert.equal(await whisprflow(), 0);
  assert.equal(questions.length, 2);
  assert.match(output.err, /nope/);
  assert.match(output.err, /1.*2/);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
});

test("another vendor that already has a key is marked; choosing it needs no key entry and starts with it", async () => {
  writeFileSync(keyFile(paths, "openai"), "ciphertext");
  const daemon = fakeDaemon({ afterStart: { ...READY, provider: "openai", model: "openai/gpt-audio-mini" } });
  const { whisprflow, questions, asked } = harness({ daemon, answers: ["3"] });
  assert.equal(await whisprflow(), 0);
  assert.match(questions[0], /OpenAI.*key already set/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-key"));
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
});

test("when settings or the environment already chose the vendor: no vendor question, straight to that vendor's key", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "native", model: "openai/gpt-audio-1.5" }));
  const fromFile = harness({ daemon: fakeDaemon({ afterStart: NO_KEY }), secrets: ["sk-key"] });
  assert.equal(await fromFile.whisprflow(), 0);
  assert.equal(fromFile.questions.length, 0);
  assert.match(fromFile.asked[0], /OpenAI/);
  rmSync(paths.settingsFile);

  const fromEnv = harness({
    daemon: fakeDaemon({ afterStart: NO_KEY }),
    env: { WHISPRFLOW_MODE: "native", WHISPRFLOW_MODEL: "gemini" },
    secrets: ["AIza"],
  });
  assert.equal(await fromEnv.whisprflow(), 0);
  assert.equal(fromEnv.questions.length, 0);
});

test("Ctrl-C while choosing: no key question, nothing saved, and it starts with the default (local)", async () => {
  const daemon = fakeDaemon({ afterStart: LOCAL_READY });
  const { whisprflow, questions, asked } = harness({ daemon, answers: [new Cancelled()] });
  assert.equal(await whisprflow(), 0);
  assert.equal(questions.length, 1);
  assert.equal(asked.length, 0);
  assert.deepEqual(daemon.calls, ["start", "recheck"]);
  assert.ok(!existsSync(paths.settingsFile));
});

test("with a key already (stored or from the environment) it starts directly without asking", async () => {
  useNative();
  haveStoredKey();
  const stored = harness();
  assert.equal(await stored.whisprflow(), 0);
  assert.equal(stored.asked.length, 0);
  rmSync(keyFile(paths, "gemini"));

  const fromEnv = harness({ env: { GEMINI_API_KEY: "AIza-env" } });
  assert.equal(await fromEnv.whisprflow(), 0);
  assert.equal(fromEnv.asked.length, 0);
});

test("a malformed key (line breaks, spaces) is reported and asked again on the spot, never sent to the background, and its content stays out of the output", async () => {
  useNative();
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  const { whisprflow, output, asked } = harness({ daemon, secrets: ["two\nlines-SECRET", "AIza-good"] });
  assert.equal(await whisprflow(), 0);
  assert.equal(asked.length, 2);
  assert.deepEqual(saved, ["AIza-good"]);
  assert.match(output.err, /This key has spaces or line breaks/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("a stored key found unusable after starting: then it asks for another", async () => {
  useNative();
  haveStoredKey();
  const daemon = fakeDaemon({ afterStart: REVOKED_KEY });
  const { whisprflow, asked, output } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await whisprflow(), 0);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.equal(asked.length, 1);
  assert.match(output.out, /running/);
});

test("no key question when the problem isn't the key: a misspelled model or a bad key in the environment are only reported in the panel", async () => {
  useNative();
  haveStoredKey();
  const wrongModel = harness({ daemon: fakeDaemon({ afterStart: WRONG_MODEL }) });
  assert.equal(await wrongModel.whisprflow(), 0);
  assert.equal(wrongModel.asked.length, 0);
  assert.match(wrongModel.output.out, /gemini-nope is not found/);
  assert.match(wrongModel.output.out, /whisprflow config/);

  const badEnv = { ...REVOKED_KEY, key: { ...REVOKED_KEY.key, source: "env" } };
  const fromEnv = harness({ daemon: fakeDaemon({ afterStart: badEnv }), env: { GEMINI_API_KEY: "AIza-env" } });
  assert.equal(await fromEnv.whisprflow(), 0);
  assert.equal(fromEnv.asked.length, 0);
  assert.match(fromEnv.output.out, /GEMINI_API_KEY/);
});

test("a wrong key gets the reason and another question", async () => {
  useNative();
  const answers = [{ ok: false, problem: "This key is invalid. Check it was copied in full" }, { ok: true }];
  const daemon = fakeDaemon({ afterStart: NO_KEY, saveKey: () => answers.shift() });
  const { whisprflow, output, asked } = harness({ daemon, secrets: ["wrong", "right"] });
  assert.equal(await whisprflow(), 0);
  assert.equal(asked.length, 2);
  assert.match(output.err, /This key is invalid/);
  assert.match(output.out, /running/);
});

test("nothing entered or Ctrl-C at the key question: no pestering, and the panel says the key is missing", async () => {
  useNative();
  for (const secret of ["", new Cancelled()]) {
    const daemon = fakeDaemon({ afterStart: NO_KEY });
    const { whisprflow, output, asked } = harness({ daemon, secrets: [secret] });
    assert.equal(await whisprflow(), 0);
    // Asked once before starting and left empty, so it isn't asked a second time after
    assert.equal(asked.length, 1);
    assert.ok(!daemon.calls.includes("set-key"));
    assert.match(output.out, /1 thing missing/);
    assert.match(output.out, /whisprflow key/);
  }
});

test("not in a terminal (scripts, pipes): no key question and no window", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, ...{ permissions: NO_PERMISSIONS.permissions } } });
  const { whisprflow, asked, questions } = harness({ daemon, interactive: false });
  assert.equal(await whisprflow(), 0);
  assert.equal(asked.length, 0);
  assert.equal(questions.length, 0);
  assert.ok(!daemon.calls.includes("show-settings"));
});

test("first use with system permissions missing: opens onboarding and says so in the panel", async () => {
  const daemon = fakeDaemon({ afterStart: NO_PERMISSIONS });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow(), 0);
  // The request keeps the name show-settings: an older background that doesn't know the onboarding parameter still opens settings
  assert.deepEqual(
    daemon.requests.find(({ cmd }) => cmd === "show-settings"),
    { cmd: "show-settings", params: { onboarding: true } },
  );
  assert.match(output.out, /2 things missing/);
  assert.match(output.out, /Opened the setup guide/);
});

test("an existing user missing system permissions: only settings open", async () => {
  useNative();
  haveStoredKey();
  const daemon = fakeDaemon({ afterStart: NO_PERMISSIONS });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow(), 0);
  const request = daemon.requests.find(({ cmd }) => cmd === "show-settings");
  assert.ok(request);
  assert.notEqual(request.params?.onboarding, true);
  assert.match(output.out, /Opened Settings/);
});

test("a failed start reports the reason and exits non-zero", async () => {
  const daemon = fakeDaemon({ afterStart: new Error("WhisprFlow couldn't start (exit code 2)") });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow(), 1);
  assert.match(output.err, /couldn't start \(exit code 2\)/);
});

// ---------- Stop, restart, status ----------

test("stop: stops it if running, says so honestly if not, and says so when it had to force-quit", async () => {
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.whisprflow("stop"), 0);
  assert.match(running.output.out, /WhisprFlow stopped/);
  const idle = harness();
  assert.equal(await idle.whisprflow("stop"), 0);
  assert.match(idle.output.out, /wasn't running/);
  const stuck = harness({ daemon: fakeDaemon({ hung: true, stopped: "killed" }) });
  assert.equal(await stuck.whisprflow("stop"), 0);
  assert.match(stuck.output.out, /force-quit/);
});

test("restart: stops, then starts", async () => {
  const { whisprflow, daemon, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("restart"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /running/);
});

test("restart works even when it hangs without answering", async () => {
  haveStoredKey();
  const { whisprflow, daemon, output } = harness({ daemon: fakeDaemon({ hung: true, stopped: "killed" }) });
  assert.equal(await whisprflow("restart"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /running/);
});

test("when the running one is the packaged app: no restart on its behalf (it would be replaced by a terminal-started one with separate permissions and keys); it says what to do", async () => {
  const packaged = { ...READY, packaged: true };
  const restarting = harness({ daemon: fakeDaemon({ running: packaged }) });
  assert.equal(await restarting.whisprflow("restart"), 1);
  assert.deepEqual(restarting.daemon.calls, []);
  assert.match(restarting.output.err, /WhisprFlow\.app/);
  assert.match(restarting.output.err, /Quit/);

  const configuring = harness({ daemon: fakeDaemon({ running: packaged }) });
  assert.equal(await configuring.whisprflow("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { hotkey: OTHER_HOTKEY });
  assert.deepEqual(configuring.daemon.calls, []);
  assert.match(configuring.output.out, /WhisprFlow\.app/);
  assert.doesNotMatch(configuring.output.out, /Applied/);
});

test("when it hangs, other commands say it is stuck and how to stop it, without a screen of stack trace", async () => {
  for (const argv of [[], ["status"], ["settings"]]) {
    const { whisprflow, output } = harness({ daemon: fakeDaemon({ hung: true }) });
    assert.equal(await whisprflow(...argv), 1);
    assert.match(output.err, /didn't reply within 5 seconds/);
    assert.match(output.err, /whisprflow stop/);
  }
});

test("if it disappears halfway through a command, it says honestly that it isn't running", async () => {
  const daemon = fakeDaemon({ running: READY });
  daemon.request = async () => {
    throw new NotRunningError();
  };
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("settings"), 1);
  assert.match(output.err, /isn't running/);
});

test("status only looks: 0 when usable, 1 when not running or something is missing", async () => {
  const idle = harness();
  assert.equal(await idle.whisprflow("status"), 1);
  // It only asks for a permission recheck and never starts it
  assert.deepEqual(idle.daemon.calls, ["recheck"]);
  assert.match(idle.output.out, /not running/);

  const ready = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await ready.whisprflow("status"), 0);
  assert.ok(!ready.daemon.calls.includes("show-settings"));

  const incomplete = harness({ daemon: fakeDaemon({ running: NO_KEY }) });
  assert.equal(await incomplete.whisprflow("status"), 1);
});

test("status --json: one line of JSON for programs, with run state, settings, and statistics", async () => {
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  await whisprflow("status", "--json");
  const parsed = JSON.parse(output.out);
  assert.equal(parsed.running, true);
  assert.equal(parsed.status.pid, 4321);
  assert.equal(parsed.settings.hotkey.value, DEFAULT_HOTKEY);
  assert.deepEqual(parsed.stats, { today: null, total: null });
});

// ---------- Updating ----------

/** Looks installed by the installer: the program is in the home's app directory */
const installed = () => mkdirSync(paths.appDir, { recursive: true });

test("update: when the download address has a newer version, the installer installs it (the version is fixed up front, so a newer one appearing midway is not installed)", async () => {
  installed();
  const { whisprflow, output, updates } = harness({ latest: "v0.2.0" });
  assert.equal(await whisprflow("update"), 0);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
  assert.match(output.out, /Updating WhisprFlow 0\.1\.0 → 0\.2\.0/);

  // The installer failed: it already gave the reason, so only its exit code is passed on
  const failing = harness({ latest: "v0.2.0", installerExit: 1 });
  assert.equal(await failing.whisprflow("update"), 1);
});

const APP = "/Applications/WhisprFlow.app";
/** The running one is the one installed in "Applications" */
const APP_RUNNING = { ...READY, packaged: true, pid: 4242 };

test("update without the app installed works as before: the installer installs, then starts", async () => {
  installed();
  const { whisprflow, updates } = harness({ latest: "v0.2.0" });
  assert.equal(await whisprflow("update"), 0);
  assert.deepEqual(updates.starts, [true]);
  assert.deepEqual(updates.lookedFor, [null]);
  assert.deepEqual(updates.apps, []);
});

test("update while the app is running: stop it first, the CLI copy installs without starting, and the app reopens at the end", async () => {
  installed();
  const daemon = fakeDaemon({ running: APP_RUNNING });
  const { whisprflow, output, updates } = harness({ daemon, latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await whisprflow("update"), 0);
  // Found by the running process: the user may not have put it in "Applications"
  assert.deepEqual(updates.lookedFor, [4242]);
  assert.deepEqual(updates.apps, [{ version: "v0.2.0", path: APP, stillRunning: false }]);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
  assert.deepEqual(updates.starts, [false]);
  assert.deepEqual(updates.opened, [APP]);
  assert.match(output.out, /Updating WhisprFlow\.app 0\.1\.0 → 0\.2\.0/);
  assert.match(output.out, /Updating WhisprFlow 0\.1\.0 → 0\.2\.0/);
  assert.match(output.out, /Reopened WhisprFlow\.app/);
});

test("update with only the app outdated: only the app is replaced, and it isn't opened if it wasn't running", async () => {
  installed();
  const { whisprflow, output, updates } = harness({ latest: "v0.1.0", app: { path: APP, version: "0.0.9" } });
  assert.equal(await whisprflow("update"), 0);
  assert.deepEqual(updates.apps, [{ version: "v0.1.0", path: APP, stillRunning: false }]);
  assert.deepEqual(updates.installs, []);
  assert.deepEqual(updates.opened, []);
  assert.match(output.out, /Updating WhisprFlow\.app 0\.0\.9 → 0\.1\.0/);
  assert.doesNotMatch(output.out, /Already up to date/);
});

test("update with the app installed while the CLI copy runs: the app is replaced too, and the installer restarts the CLI copy", async () => {
  installed();
  const daemon = fakeDaemon({ running: READY });
  const { whisprflow, updates } = harness({ daemon, latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await whisprflow("update"), 0);
  // The running CLI copy is no obstacle: another program is being replaced
  assert.deepEqual(updates.apps, [{ version: "v0.2.0", path: APP, stillRunning: true }]);
  assert.deepEqual(updates.starts, [true]);
  assert.deepEqual(updates.opened, []);
});

test("update with the app installed and nothing running: both are replaced, and neither starts", async () => {
  installed();
  const { whisprflow, updates } = harness({ latest: "v0.2.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await whisprflow("update"), 0);
  assert.equal(updates.apps.length, 1);
  assert.deepEqual(updates.starts, [false]);
  assert.deepEqual(updates.opened, []);
});

test("update when the app and the CLI copy are both current: nothing happens", async () => {
  installed();
  const { whisprflow, output, updates } = harness({ latest: "v0.1.0", app: { path: APP, version: "0.1.0" } });
  assert.equal(await whisprflow("update"), 0);
  assert.deepEqual(updates.apps, []);
  assert.deepEqual(updates.installs, []);
  assert.match(output.out, /Already up to date \(0\.1\.0\)/);
});

test("update when replacing the app fails: it says so honestly, the CLI copy is untouched, and the stopped app reopens", async () => {
  installed();
  const daemon = fakeDaemon({ running: APP_RUNNING });
  const { whisprflow, output, updates } = harness({
    daemon,
    latest: "v0.2.0",
    app: { path: APP, version: "0.1.0" },
    appInstall: () => {
      throw new LocalizedError(msg("cli.update.appChecksum", { file: "WhisprFlow-arm64.dmg" }));
    },
  });
  assert.equal(await whisprflow("update"), 1);
  assert.match(output.err, /WhisprFlow-arm64\.dmg/);
  assert.deepEqual(updates.installs, []);
  assert.deepEqual(updates.opened, [APP]);
});

test("update when the background hangs: which one runs is unknown, so the app is found by its install location", async () => {
  installed();
  const { whisprflow, updates } = harness({
    daemon: fakeDaemon({ hung: true }),
    latest: "v0.2.0",
    app: { path: APP, version: "0.1.0" },
  });
  assert.equal(await whisprflow("update"), 0);
  assert.deepEqual(updates.lookedFor, [null]);
  assert.deepEqual(updates.opened, []);
});

test("update when already current (or newer than the download address) does nothing", async () => {
  installed();
  for (const latest of ["v0.1.0", "0.1.0", "v0.0.9", "v0.1.0-rc.1"]) {
    const { whisprflow, output, updates } = harness({ latest });
    assert.equal(await whisprflow("update"), 0, latest);
    assert.deepEqual(updates.installs, [], latest);
    assert.match(output.out, /Already up to date \(0\.1\.0\)/, latest);
  }
});

test("update recognizes the installed copy even when the home goes through a symlink (/tmp being /private/tmp, say)", async () => {
  installed();
  outside = mkdtempSync(join(tmpdir(), "wf-link-"));
  const link = join(outside, "home");
  symlinkSync(dir, link);
  const { whisprflow, updates } = harness({ latest: "v0.2.0", packageDir: join(link, "app") });
  assert.equal(await whisprflow("update"), 0);
  assert.deepEqual(updates.installs, ["v0.2.0"]);
});

test("update for a copy running from source: not the installer's business, it says to use git pull and never checks the download address", async () => {
  outside = mkdtempSync(join(tmpdir(), "wf-src-"));
  const { whisprflow, output, updates } = harness({ latest: "v0.2.0", packageDir: outside });
  assert.equal(await whisprflow("update"), 1);
  assert.deepEqual([updates.checks, updates.installs, updates.apps], [[], [], []]);
  assert.match(output.err, /git pull/);
  assert.ok(output.err.includes(outside));
});

test("update when the latest version can't be fetched or doesn't look like a version: it says so honestly and installs nothing", async () => {
  installed();
  const offline = harness({
    latest: new LocalizedError(
      msg("cli.update.unreachable", { url: "https://x/latest", reason: "curl: (6) Could not resolve host" }),
    ),
  });
  assert.equal(await offline.whisprflow("update"), 1);
  assert.match(offline.output.err, /https:\/\/x\/latest/);
  assert.match(offline.output.err, /curl: \(6\)/);
  assert.deepEqual(offline.updates.installs, []);

  const garbled = harness({ latest: "<html>error</html>" });
  assert.equal(await garbled.whisprflow("update"), 1);
  assert.match(garbled.output.err, /<html>/);
  assert.deepEqual(garbled.updates.installs, []);

  assert.equal(await harness().whisprflow("update", "now"), 2);
});

test("status mentions a new version; the download address is checked at most once a day", async () => {
  installed();
  const { io, whisprflow, output, updates } = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  await whisprflow("status");
  assert.match(output.out, /WhisprFlow 0\.2\.0 is out \(you have 0\.1\.0\): run whisprflow update/);
  await whisprflow("status");
  assert.equal(updates.checks.length, 1, "not checked again within a day");
  // Checked again a day later
  io.now = () => new Date("2026-10-14T07:00:01.000Z");
  await whisprflow("status");
  assert.equal(updates.checks.length, 2);
  // status must not wait long for this
  assert.ok(updates.checks.every((seconds) => seconds <= 3));
});

/** Forgets the last check of the download address: for switching scenarios within one test */
const forgetUpdateCheck = () => rmSync(paths.updateCheckFile, { force: true });

test("status says nothing when there is no new version, the check fails, or it runs from source, and the exit code is unaffected", async () => {
  installed();
  const same = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await same.whisprflow("status"), 0);
  assert.doesNotMatch(same.output.out, /is out/);

  forgetUpdateCheck();
  const offline = harness({ daemon: fakeDaemon({ running: READY }), latest: new Error("offline") });
  assert.equal(await offline.whisprflow("status"), 0);
  assert.doesNotMatch(offline.output.out + offline.output.err, /is out|offline/);
  // A failed check is recorded too: not waited on every time status is viewed within a day
  await offline.whisprflow("status");
  assert.equal(offline.updates.checks.length, 1);

  forgetUpdateCheck();
  outside = mkdtempSync(join(tmpdir(), "wf-src-"));
  const source = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0", packageDir: outside });
  await source.whisprflow("status");
  assert.deepEqual(source.updates.checks, []);
});

test("status --json includes whether there is a new version (newVersion, null when none)", async () => {
  installed();
  const newer = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  await newer.whisprflow("status", "--json");
  assert.equal(JSON.parse(newer.output.out).newVersion, "0.2.0");
  forgetUpdateCheck();
  const same = harness({ daemon: fakeDaemon({ running: READY }) });
  await same.whisprflow("status", "--json");
  assert.equal(JSON.parse(same.output.out).newVersion, null);
});

// ---------- key ----------

test("key: starts it if not running, asks for a key, and saves it", async () => {
  useNative();
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  const { whisprflow, output } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await whisprflow("key"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["start", "set-key"]);
  assert.deepEqual(saved, ["AIza-new"]);
  assert.match(output.out, /Key saved and verified/);
});

test("key: a failed verification gives the reason and exits non-zero, without asking again and again", async () => {
  useNative();
  const daemon = fakeDaemon({
    running: READY,
    saveKey: () => ({ ok: false, problem: "Can't reach Gemini. Check your network" }),
  });
  const { whisprflow, output, asked } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await whisprflow("key"), 1);
  assert.equal(asked.length, 1);
  assert.match(output.err, /Can't reach Gemini/);
});

test("key: nothing read means the background app is left alone", async () => {
  useNative();
  const daemon = fakeDaemon({ running: READY });
  const { whisprflow, output } = harness({ daemon, secrets: [""] });
  assert.equal(await whisprflow("key"), 1);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.err, /No key read/);
});

test("key: piped content that looks wrong (multiple lines, say): no start, nothing sent to the background, and the content stays out of the output", async () => {
  useNative();
  const { whisprflow, output, daemon } = harness({ secrets: ["line-one-SECRET\nline-two-SECRET"] });
  assert.equal(await whisprflow("key"), 1);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.err, /This key has spaces or line breaks/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("a key right after the key command is not used or echoed back, with a warning that it would stay in shell history", async () => {
  const { whisprflow, output, daemon, asked } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("key", "AIza-typed-SECRET"), 2);
  assert.deepEqual(daemon.calls, []);
  assert.equal(asked.length, 0);
  assert.match(output.err, /shell history/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("key --forget deletes the saved key; if running, it forgets it too", async () => {
  useNative();
  const seed = () => {
    writeFileSync(keyFile(paths, "gemini"), "ciphertext");
  };
  seed();
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.whisprflow("key", "--forget"), 0);
  assert.deepEqual(running.daemon.calls, ["forget-key"]);
  assert.equal(existsSync(keyFile(paths, "gemini")), false);

  seed();
  const idle = harness();
  assert.equal(await idle.whisprflow("key", "--forget"), 0);
  assert.equal(existsSync(keyFile(paths, "gemini")), false);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /Deleted the saved/);
});

// ---------- Settings ----------

test("config lists every setting and the file location", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("config"), 0);
  assert.match(output.out, new RegExp(`hotkey\\s+${DEFAULT_HOTKEY}`));
  assert.ok(output.out.includes(paths.settingsFile), output.out);
});

test("config set saves to the file; if running, it restarts to apply", async () => {
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { hotkey: OTHER_HOTKEY });
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, new RegExp(`hotkey set to ${OTHER_HOTKEY}`));
  assert.match(output.out, /Applied/);

  const idle = harness();
  assert.equal(await idle.whisprflow("config", "set", "thinking", "low"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /Takes effect next launch/);
});

test("config set when Gemini rejects the value after restart (a misspelled model, say): it doesn't say applied, and gives the reason and how to undo", async () => {
  const daemon = fakeDaemon({ running: READY, afterStart: WRONG_MODEL });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("config", "set", "model", "gemini-nope"), 1);
  assert.doesNotMatch(output.out, /Applied/);
  assert.match(output.err, /gemini-nope is not found/);
  assert.match(output.err, /whisprflow config unset model/);
});

test("config set when Gemini can't be reached on restart, so the new setting isn't known to work: it doesn't say applied", async () => {
  const unverified = { ...READY, key: { ...READY.key, verified: false } };
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: READY, afterStart: unverified }) });
  assert.equal(await whisprflow("config", "set", "model", "gemini-next"), 0);
  assert.doesNotMatch(output.out, /Applied/);
  assert.match(output.out, /aren't verified yet.*whisprflow status/);
});

test("config set before the first start creates the directory with owner-only access too", async () => {
  rmSync(dir, { recursive: true });
  const { whisprflow } = harness();
  assert.equal(await whisprflow("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assertOwnerOnlyDir(paths.home);
});

test("config set with a wrong value lists the choices, leaves the file alone, and exits 2", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("config", "set", "hotkey", "caps_lock"), 2);
  assert.match(output.err, HOTKEY_CHOICES);
  assert.equal(existsSync(paths.settingsFile), false);
  assert.equal(await whisprflow("config", "set", "hotkey"), 2);
  assert.equal(await whisprflow("config", "dance"), 2);
});

test("config set warns when an environment variable overrides the setting", async () => {
  const { whisprflow, output } = harness({ env: { WHISPRFLOW_HOTKEY: DEFAULT_HOTKEY } });
  assert.equal(await whisprflow("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assert.match(output.out, /WHISPRFLOW_HOTKEY/);
});

test("config set is the unchecked back door: mode-layer settings are written as is, with the usual command named; settings of another mode take effect once switched", async () => {
  useNative();
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("config", "set", "transcriber", "qwen3-asr-0.6b-int8"), 0);
  assert.equal(saved("transcriber"), "qwen3-asr-0.6b-int8");
  assert.match(output.out, /usually changed with whisprflow transcriber.*config set skips the checks/);
  assert.match(output.out, /You're in native mode now; this takes effect when you switch to local mode/);

  const native = harness();
  assert.equal(await native.whisprflow("config", "set", "model", "openai"), 0);
  assert.match(native.output.out, /usually changed with whisprflow model/);
  assert.doesNotMatch(native.output.out, /takes effect when you switch/);

  // Settings only config set changes mention no other command
  const plain = harness();
  assert.equal(await plain.whisprflow("config", "set", "thinking", "low"), 0);
  assert.doesNotMatch(plain.output.out, /usually changed with|takes effect when you switch/);
  assert.equal(await plain.whisprflow("config", "set", "hotkey", OTHER_HOTKEY), 0);
  assert.doesNotMatch(plain.output.out, /usually changed with|takes effect when you switch/);
});

test("config set changing local's step one to an undownloaded model: after restart it says it isn't downloaded and how to download, never downloading for the user", async () => {
  const missing = { ...LOCAL_READY, localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" } };
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: LOCAL_READY, afterStart: missing }) });
  assert.equal(await whisprflow("config", "set", "transcriber", "qwen3-asr-0.6b-q8"), 0);
  assert.match(
    output.out,
    /Qwen3-ASR 0\.6B \(Q8_0\) isn't downloaded yet: run whisprflow transcriber download qwen3-asr-0\.6b-q8 first/,
  );
  assert.ok(!daemon.calls.includes("download-model"));
});

test("config unset returns to the default", async () => {
  const { whisprflow, output } = harness();
  await whisprflow("config", "set", "hotkey", OTHER_HOTKEY);
  assert.equal(await whisprflow("config", "unset", "hotkey"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), {});
  assert.match(output.out, new RegExp(`hotkey reset to the default, ${DEFAULT_HOTKEY}`));
});

// ---------- Theme ----------

test("theme lists the themes, marking the one in use and how to change", async () => {
  const { whisprflow, output, daemon } = harness();
  assert.equal(await whisprflow("theme"), 0);
  assert.match(output.out, /● violet\s+Violet/);
  assert.match(output.out, / {4}ink\s+Ink/);
  assert.match(output.out, / {4}cinnabar\s+Cinnabar/);
  assert.match(output.out, / {4}indigo\s+Indigo/);
  assert.match(output.out, /Using Violet \(violet\).*default/);
  assert.match(output.out, /whisprflow theme ink/);
  assert.deepEqual(daemon.calls, []);
});

test("theme <name> saves it; if running it switches at once without a restart; an id or a name both work", async () => {
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("theme", "Cinnabar"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { theme: "cinnabar" });
  assert.deepEqual(daemon.calls, ["reload-theme"]);
  assert.match(output.out, /Theme set to Cinnabar \(cinnabar\)/);
  assert.match(output.out, /Applied/);

  assert.equal(await whisprflow("theme"), 0);
  assert.match(output.out, /● cinnabar\s+Cinnabar/);
  assert.match(output.out, /Using Cinnabar \(cinnabar\).*from the settings file/);

  const idle = harness();
  assert.equal(await idle.whisprflow("theme", "indigo"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /Takes effect next launch/);
});

test("theme: an unknown theme isn't saved, the themes are listed, and it exits 2; extra arguments too", async () => {
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("theme", "neon"), 2);
  assert.match(output.err, /ink \/ cinnabar \/ indigo/);
  assert.equal(existsSync(paths.settingsFile), false);
  assert.equal(await whisprflow("theme", "ink", "cinnabar"), 2);
  assert.deepEqual(daemon.calls, []);
});

test("theme warns when the environment overrides it; if the running one started with the variable, it says which theme it still uses", async () => {
  const daemon = fakeDaemon({ running: READY, reloadTheme: () => ({ theme: "indigo" }) });
  const { whisprflow, output } = harness({ daemon, env: { WHISPRFLOW_THEME: "indigo" } });
  assert.equal(await whisprflow("theme", "cinnabar"), 0);
  assert.match(output.out, /the WHISPRFLOW_THEME env var is set/);
  assert.doesNotMatch(output.out, /Applied/);
  assert.match(output.out, /still uses Indigo \(indigo\).*WHISPRFLOW_THEME/);
});

test("theme when the running one is an older version without this command: the setting is saved, and it says the change comes after a restart", async () => {
  const daemon = fakeDaemon({
    running: READY,
    reloadTheme: () => {
      throw new Error('Unknown command: "reload-theme"');
    },
  });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("theme", "cinnabar"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { theme: "cinnabar" });
  assert.doesNotMatch(output.out, /Applied/);
  assert.match(output.out, /old version.*whisprflow restart/);
});

test("config set theme / config unset theme switch at once like the theme command, without a restart", async () => {
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("config", "set", "theme", "indigo"), 0);
  assert.deepEqual(daemon.calls, ["reload-theme"]);
  assert.match(output.out, /theme set to indigo/);
  assert.match(output.out, /Applied/);
  assert.equal(await whisprflow("config", "unset", "theme"), 0);
  assert.deepEqual(daemon.calls, ["reload-theme", "reload-theme"]);
  assert.match(output.out, /theme reset to the default, violet/);
});

// ---------- UI language ----------

test("help, the panel, and usage errors are all in English", async () => {
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: READY }), locale: "en" });
  assert.equal(await whisprflow("help"), 0);
  assert.match(output.out, /^WhisprFlow: press a hotkey, speak/);
  assert.match(
    output.out,
    /whisprflow theme <name> +Switch theme \(violet Violet \/ ink Ink \/ cinnabar Cinnabar \/ indigo Indigo\)/,
  );
  assert.match(output.out, /latest 20 by default/);

  assert.equal(await whisprflow("status"), 0);
  assert.match(output.out, /WhisprFlow 0\.1\.0 · running/);
  assert.match(output.out, new RegExp(`press ${enHotkey} to start talking`));
  assert.match(output.out, /Permissions +Microphone ✓ {3}Input Monitoring ✓ {3}Accessibility ✓/);
  assert.match(output.out, /Model +Gemini gemini-3\.6-flash \(MINIMAL\)/);

  assert.equal(await whisprflow("frobnicate"), 2);
  assert.match(output.err, /There's no command called frobnicate\.\nRun whisprflow help to see all commands\./);
  assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/);
});

test("the new version reminder and what update says are in English", async () => {
  installed();
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: READY }), locale: "en", latest: "v0.2.0" });
  assert.equal(await whisprflow("status"), 0);
  assert.match(output.out, /WhisprFlow 0\.2\.0 is out \(you have 0\.1\.0\): run whisprflow update\./);
  assert.equal(await whisprflow("update"), 0);
  assert.match(output.out, /Updating WhisprFlow 0\.1\.0 → 0\.2\.0/);

  const withApp = harness({
    daemon: fakeDaemon({ running: APP_RUNNING }),
    locale: "en",
    latest: "v0.2.0",
    app: { path: APP, version: "0.1.0" },
  });
  assert.equal(await withApp.whisprflow("update"), 0);
  assert.match(withApp.output.out, /Updating WhisprFlow\.app 0\.1\.0 → 0\.2\.0/);
  assert.match(withApp.output.out, /Reopened WhisprFlow\.app/);
  output.out += withApp.output.out;
  output.err += withApp.output.err;
  assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/);
});

test("reasons the background reports (msg) are translated to the CLI's language; plain text from an older background is shown as is", async () => {
  const problem = { key: "model.rejected", params: { provider: "Gemini", said: "models/gemini-nope is not found" } };
  const fresh = {
    ...READY,
    key: { state: "rejected", source: "stored", cause: "other", problem },
    summary: {
      ready: false,
      missing: [{ key: "setup.missing.check", params: { provider: "Gemini" } }],
      blocker: null,
      degraded: null,
    },
  };
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: fresh }), locale: "en" });
  assert.equal(await whisprflow("status"), 1);
  assert.match(output.out, /Missing: Gemini check\./);
  assert.match(output.out, /Check failed: Gemini rejected the request: models\/gemini-nope is not found\./);

  const old = harness({ daemon: fakeDaemon({ running: WRONG_MODEL }), locale: "en" });
  assert.equal(await old.whisprflow("status"), 1);
  assert.match(old.output.out, /Missing: Gemini check\./);
});

test("config set language saves it; if running it switches at once without a restart; if not running it applies next launch", async () => {
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("config", "set", "language", "EN"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { language: "en" });
  assert.deepEqual(daemon.calls, ["reload-language"]);
  assert.match(output.out, /language set to en\.\nApplied, no restart needed/);
  assert.equal(await whisprflow("config", "unset", "language"), 0);
  assert.deepEqual(daemon.calls, ["reload-language", "reload-language"]);
  assert.match(output.out, /language reset to the default, system/);

  const idle = harness();
  assert.equal(await idle.whisprflow("config", "set", "language", "en"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /Takes effect next launch/);

  assert.equal(await idle.whisprflow("config", "set", "language", "fr"), 2);
  assert.match(idle.output.err, /system \/ en/);
});

test("config set language when the environment overrides it says which language is still in use; an older background says to restart", async () => {
  const pinned = fakeDaemon({ running: READY, reloadLanguage: () => ({ language: "en" }) });
  const { whisprflow, output } = harness({ daemon: pinned, env: { WHISPRFLOW_LANGUAGE: "en" } });
  assert.equal(await whisprflow("config", "set", "language", "system"), 0);
  assert.match(output.out, /the WHISPRFLOW_LANGUAGE env var is set/);
  assert.match(output.out, /still uses English: .*WHISPRFLOW_LANGUAGE/);

  const legacy = fakeDaemon({
    running: READY,
    reloadLanguage: () => {
      throw new Error('Unknown command: "reload-language"');
    },
  });
  const old = harness({ daemon: legacy });
  assert.equal(await old.whisprflow("config", "set", "language", "en"), 0);
  assert.match(old.output.out, /old version.*whisprflow restart/);
});

test("the panel shows the UI language; following the system, it adds the one in use", async () => {
  const running = { ...READY, language: "system", locale: "en" };
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running }) });
  assert.equal(await whisprflow("status"), 0);
  assert.match(output.out, /Language +System · English/);
  const english = harness({
    daemon: fakeDaemon({ running: { ...READY, language: "en", locale: "en" } }),
    locale: "en",
  });
  assert.equal(await english.whisprflow("status"), 0);
  assert.match(english.output.out, /Language +English/);
});

test("the panel shows the theme in use", async () => {
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: { ...READY, theme: "cinnabar" } }) });
  assert.equal(await whisprflow("status"), 0);
  assert.match(output.out, /Theme\s+Cinnabar \(cinnabar\)/);
});

test("when the settings file is corrupt, every command says so first", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.settingsFile, "{ broken");
  const { whisprflow, output, daemon } = harness();
  assert.equal(await whisprflow(), 2);
  assert.match(output.err, /settings\.json/);
  assert.deepEqual(daemon.calls, []);
});

// ---------- History ----------

function seedHistory() {
  const history = openHistory(paths.historyDb);
  const entry = (id, createdAt, refinedText) => ({
    id,
    status: "completed",
    refinedText,
    error: null,
    duration: 4,
    audioLocalPath: null,
    createdAt,
  });
  history.add(entry("a", "2026-10-12T01:05:00.000Z", "said yesterday"));
  history.add(entry("b", "2026-10-13T06:32:00.000Z", "said today"));
  history.close();
}

test("history before any use says so and never creates a database", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("history"), 0);
  assert.match(output.out, /No dictations yet/);
  assert.equal(existsSync(paths.historyDb), false);
});

test("history groups by day; -n limits the count; works whether or not the background app runs", async () => {
  seedHistory();
  const all = harness();
  assert.equal(await all.whisprflow("history"), 0);
  assert.match(
    all.output.out,
    /Today · October 13\n {2}14:32 {2}said today\n\nYesterday · October 12\n {2}09:05 {2}said yesterday/,
  );
  assert.deepEqual(all.daemon.calls, []);

  const one = harness();
  assert.equal(await one.whisprflow("history", "-n", "1"), 0);
  assert.doesNotMatch(one.output.out, /said yesterday/);
  assert.match(one.output.out, /Showing the latest 1 of 2/);
});

test("history --json gives the entries as they are", async () => {
  seedHistory();
  const { whisprflow, output } = harness();
  await whisprflow("history", "--json");
  assert.deepEqual(
    JSON.parse(output.out).map((entry) => entry.refinedText),
    ["said today", "said yesterday"],
  );
});

test("history -n must be a positive integer", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("history", "-n", "abc"), 2);
  assert.match(output.err, /-n/);
});

test("with history, the panel shows today's and all-time numbers; with billing, the spend too", async () => {
  seedHistory();
  const before = harness({ daemon: fakeDaemon({ running: READY }) });
  await before.whisprflow("status");
  assert.match(before.output.out, /All time\s+2 dictations · 4 words · 8 ?s\n/);

  seedCall();
  const after = harness({ daemon: fakeDaemon({ running: READY }) });
  await after.whisprflow("status");
  assert.match(after.output.out, /All time\s+2 dictations · 4 words · 8 ?s · \$0\.0011\n/);
  assert.match(after.output.out, /whisprflow usage/);
});

// ---------- Usage ----------

/** Records one billed call: today's sentence called Gemini once */
function seedCall() {
  const history = openHistory(paths.historyDb);
  history.addCall({
    purpose: "dictation",
    audioId: "b",
    provider: "gemini",
    model: "gemini-3.6-flash",
    inputTokens: 1390,
    audioTokens: 25,
    cachedTokens: 0,
    outputTokens: 4,
    thinkingTokens: 0,
    costUsd: 0.0011,
    latencyMs: 1700,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.close();
}

test("usage before any use says so and never creates a database", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("usage"), 0);
  assert.match(output.out, /No usage yet/);
  assert.equal(existsSync(paths.historyDb), false);
});

test("usage lists spend, tokens, and model reply times; works without the background app running", async () => {
  seedHistory();
  seedCall();
  const { whisprflow, output, daemon } = harness();
  assert.equal(await whisprflow("usage"), 0);
  assert.match(output.out, /All time\s+\$0\.0011\s+1\.39K\s+1\s+usually 1\.7s, slow 1\.7s/);
  assert.match(output.out, /Gemini gemini-3\.6-flash/);
  assert.deepEqual(daemon.calls, []);
});

test("usage --json gives the report as is; null before there is a history database", async () => {
  const empty = harness();
  await empty.whisprflow("usage", "--json");
  assert.equal(JSON.parse(empty.output.out), null);

  seedHistory();
  seedCall();
  const { whisprflow, output } = harness();
  await whisprflow("usage", "--json");
  const report = JSON.parse(output.out);
  assert.equal(report.total.costUsd, 0.0011);
  assert.equal(report.total.tokens, 1394);
  assert.deepEqual(report.total.latency, { medianMs: 1700, p90Ms: 1700 });
  assert.equal(report.models[0].model, "gemini-3.6-flash");
});

test("usage takes no other arguments", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("usage", "today"), 2);
  assert.match(output.err, /whisprflow usage/);
});

// ---------- Uninstalling ----------

/** Sets up an installed, used home, plus a command link outside the home */
function seedInstalled() {
  for (const file of [
    join(paths.binDir, "whisprflow"),
    join(paths.appDir, "package.json"),
    join(paths.runtimeDir, "Electron.app", "Info.plist"),
    paths.settingsFile,
    keyFile(paths, "gemini"),
    paths.historyDb,
    join(paths.recordingsDir, "a.webm"),
    paths.logFile,
    join(paths.cacheDir, "GPUCache", "data_0"),
  ]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "x");
  }
  // One place outside the home (like ~/.local/bin)
  outside = mkdtempSync(join(tmpdir(), "wf-bin-"));
  const link = join(outside, "whisprflow");
  symlinkSync(join(paths.binDir, "whisprflow"), link);
  // Something at the same spot that isn't ours: someone else's file of the same name
  const foreign = join(outside, "not-ours");
  writeFileSync(foreign, "someone else's");
  writeFileSync(paths.linksFile, `${link}\n${foreign}\n`);
  return { link, foreign };
}

test("uninstall --yes stops the background and deletes the whole directory, command links outside the home, and the keychain item in one go", async () => {
  const { link, foreign } = seedInstalled();
  const removedFromKeychain = [];
  const { whisprflow, output, daemon } = harness({
    daemon: fakeDaemon({ running: READY }),
    keychain: () => {
      removedFromKeychain.push(true);
      return true;
    },
  });
  assert.equal(await whisprflow("uninstall", "--yes"), 0);
  assert.deepEqual(daemon.calls, ["stop"]);
  assert.equal(existsSync(paths.home), false);
  assert.equal(existsSync(link), false);
  assert.equal(removedFromKeychain.length, 1);
  // Listed but not a link to us: left alone
  assert.equal(readFileSync(foreign, "utf8"), "someone else's");
  assert.match(output.out, /WhisprFlow uninstalled/);
  assert.match(output.out, /keychain/);
  // What can't be removed is said honestly too
  assert.match(output.out, /Accessibility access for your terminal/);
  assert.doesNotMatch(output.out, /com\.github\.Electron/);
});

test("uninstall (Windows) also removes the user Path entry, the Start menu shortcut, and launch at login; leaves shortcuts that aren't ours; says nothing about terminal permissions", async () => {
  mkdirSync(paths.binDir, { recursive: true });
  // Things outside the home go in another temporary directory (afterEach deletes it)
  outside = mkdtempSync(join(tmpdir(), "wf-link-"));
  const ours = join(outside, "WhisprFlow.lnk");
  const theirs = join(outside, "Other.lnk");
  writeFileSync(ours, "shortcut");
  writeFileSync(theirs, "someone else's shortcut");
  // As install.ps1 really writes it: Windows PowerShell 5.1 Add-Content -Encoding UTF8 starts with a BOM and uses CRLF line endings
  writeFileSync(
    paths.linksFile,
    `\uFEFFpath %USERPROFILE%\\.whisprflow\\bin\r\nshortcut ${ours}\r\nshortcut ${theirs}\r\n`,
  );
  const { whisprflow, output, windows } = harness({
    platform: "win32",
    keychain: () => false,
    system: { ourShortcut: (file) => file === ours, loginItem: true },
  });
  assert.equal(await whisprflow("uninstall", "--yes"), 0);
  assert.deepEqual(windows.pathEntries, ["%USERPROFILE%\\.whisprflow\\bin"]);
  assert.equal(existsSync(ours), false);
  assert.equal(readFileSync(theirs, "utf8"), "someone else's shortcut");
  assert.match(output.out, /%USERPROFILE%.* in your user Path/);
  assert.match(output.out, /Open at login/);
  assert.doesNotMatch(output.out, /Accessibility access/);
  // whisprflow.cmd in bin is running this command: cmd reads the file again after it exits, so bin goes after exit with the home
  assert.deepEqual(readdirSync(paths.home), ["bin"]);
  assert.deepEqual(windows.later, [paths.home]);
  assert.match(output.out, /removed a few seconds after it exits/);
});

test("uninstall --keep-data (Windows): bin is also removed after exit, and your things stay", async () => {
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(join(paths.binDir, "whisprflow.cmd"), "@echo off");
  writeFileSync(paths.settingsFile, "{}");
  const { whisprflow, windows } = harness({ platform: "win32", keychain: () => assert.fail("should not touch keys") });
  assert.equal(await whisprflow("uninstall", "--keep-data", "--yes"), 0);
  assert.equal(existsSync(join(paths.binDir, "whisprflow.cmd")), true);
  assert.equal(existsSync(paths.settingsFile), true);
  assert.deepEqual(windows.later, [paths.binDir]);
});

test("uninstall --keep-data (Windows): Local State in the cache stays and the rest of the cache goes (kept keys need it to decrypt)", async () => {
  mkdirSync(join(paths.cacheDir, "GPUCache"), { recursive: true });
  writeFileSync(join(paths.cacheDir, "Local State"), "{}");
  writeFileSync(join(paths.cacheDir, "Preferences"), "{}");
  const { whisprflow } = harness({ platform: "win32", keychain: () => assert.fail("should not touch keys") });
  assert.equal(await whisprflow("uninstall", "--keep-data", "--yes"), 0);
  assert.deepEqual(readdirSync(paths.cacheDir), ["Local State"]);
});

test("uninstall mentions the shared preferences file the runtime leaves elsewhere, without deleting it", async () => {
  seedInstalled();
  const { whisprflow, output, io } = harness();
  // In tests the home is the temporary directory itself, so this file goes elsewhere
  io.sharedPreferencesFile = join(outside, "com.github.Electron.plist");
  writeFileSync(io.sharedPreferencesFile, "plist");
  assert.equal(await whisprflow("uninstall", "--yes"), 0);
  assert.match(output.out, /com\.github\.Electron\.plist is untouched/);
  assert.equal(existsSync(io.sharedPreferencesFile), true);
});

test("uninstall --keep-data deletes only the program; settings, keys, history, and recordings stay, and so does the keychain (kept keys need it to decrypt)", async () => {
  const { link } = seedInstalled();
  const { whisprflow, output } = harness({ keychain: () => assert.fail("should not touch the keychain") });
  assert.equal(await whisprflow("uninstall", "--keep-data", "--yes"), 0);
  for (const kept of [
    paths.settingsFile,
    keyFile(paths, "gemini"),
    paths.historyDb,
    join(paths.recordingsDir, "a.webm"),
  ]) {
    assert.equal(existsSync(kept), true, kept);
  }
  for (const gone of [paths.binDir, paths.appDir, paths.runtimeDir, paths.cacheDir, paths.logFile, link]) {
    assert.equal(existsSync(gone), false, gone);
  }
  assert.match(output.out, /Kept:/);
});

test("uninstall says what will be deleted and asks first; declining changes nothing", async () => {
  seedInstalled();
  const declined = harness({ daemon: fakeDaemon({ running: READY }), confirms: [false] });
  assert.equal(await declined.whisprflow("uninstall"), 1);
  assert.equal(declined.confirmed.length, 1);
  assert.match(declined.output.out, /history, and recordings/);
  assert.deepEqual(declined.daemon.calls, []);
  assert.equal(existsSync(paths.historyDb), true);

  const agreed = harness({ confirms: [true] });
  assert.equal(await agreed.whisprflow("uninstall"), 0);
  assert.equal(existsSync(paths.home), false);
});

test("uninstall outside a terminal without --yes does nothing", async () => {
  seedInstalled();
  const { whisprflow, output, confirmed } = harness({ interactive: false });
  assert.equal(await whisprflow("uninstall"), 2);
  assert.equal(confirmed.length, 0);
  assert.match(output.err, /--yes/);
  assert.equal(existsSync(paths.historyDb), true);
});

test("uninstall stops when the background can't be stopped (it still holds those files open)", async () => {
  seedInstalled();
  const daemon = fakeDaemon({ running: READY });
  daemon.stop = async () => {
    throw new Error("WhisprFlow can't be stopped (process id 4321)");
  };
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("uninstall", "--yes"), 1);
  assert.match(output.err, /can't be stopped/);
  assert.equal(existsSync(paths.appDir), true);
});

test("uninstall when the keychain item can't be deleted removes everything else and says what remains", async () => {
  seedInstalled();
  const { whisprflow, output } = harness({
    keychain: () => {
      throw new Error("keychain locked");
    },
  });
  assert.equal(await whisprflow("uninstall", "--yes"), 0);
  assert.equal(existsSync(paths.home), false);
  assert.match(output.out, /keychain locked/);
  assert.match(output.out, /Keychain Access/);
});

// ---------- The rest ----------

test("logs prints the last lines of the log file, -f keeps following; says so honestly when there is no log yet", async () => {
  const empty = harness();
  assert.equal(await empty.whisprflow("logs"), 0);
  assert.match(empty.output.out, /No logs yet/);

  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(paths.logFile, "{}\n");
  const { whisprflow, tails } = harness();
  await whisprflow("logs");
  await whisprflow("logs", "-n", "5", "-f");
  assert.deepEqual(tails, [
    { file: paths.logFile, lines: 40, follow: false },
    { file: paths.logFile, lines: 5, follow: true },
  ]);
});

test("settings opens settings while running; when not running it says to start first", async () => {
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.whisprflow("settings"), 0);
  assert.deepEqual(running.daemon.calls, ["show-settings"]);
  const idle = harness();
  assert.equal(await idle.whisprflow("settings"), 1);
  assert.match(idle.output.err, /whisprflow/);
});

test("help and --help list every command; --version gives the version", async () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const { whisprflow, output } = harness();
    assert.equal(await whisprflow(...argv), 0);
    for (const command of [
      "start",
      "stop",
      "restart",
      "status",
      "key",
      "config",
      "history",
      "usage",
      "logs",
      "settings",
      "theme",
      "uninstall",
    ]) {
      assert.match(output.out, new RegExp(`whisprflow ${command}`));
    }
  }
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("--version"), 0);
  assert.equal(output.out.trim(), "0.1.0");
});

test("unknown commands and options say so, point to help, and exit 2", async () => {
  const { whisprflow, output, daemon } = harness();
  assert.equal(await whisprflow("dance"), 2);
  assert.match(output.err, /dance/);
  assert.match(output.err, /whisprflow help/);
  assert.equal(await whisprflow("status", "--loud"), 2);
  assert.deepEqual(daemon.calls, []);
});

// ---------- Models ----------

/** Pretends an OpenAI key was saved earlier */
const haveOpenAIKey = () => writeFileSync(keyFile(paths, "openai"), "ciphertext");
const savedModel = () => resolveSettings({ file: paths.settingsFile, env: {} }).model.value;

test("model lists the vendors, their models, whether each has a key, and which one is in use", async () => {
  haveStoredKey();
  const { whisprflow, output } = harness({ env: { OPENAI_API_KEY: "sk-env" } });
  assert.equal(await whisprflow("model"), 0);
  assert.match(output.out, /● gemini\s+Gemini\s+gemini-3\.6-flash\s+key saved/);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini \(default\)\s+key from the OPENAI_API_KEY env var/);
});

test("model <vendor> switches directly when its key exists; if running it switches at once without a restart", async () => {
  useNative();
  haveOpenAIKey();
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("model", "openai"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-model", params: { model: "openai/gpt-audio-mini" } });
  assert.match(output.out, /Model switched to OpenAI gpt-audio-mini/);
  assert.ok(!daemon.calls.includes("stop"));
  assert.match(output.out, /Switched, no restart needed/);

  const notRunning = harness();
  assert.equal(await notRunning.whisprflow("model", "openai/gpt-audio-1.5"), 0);
  assert.equal(savedModel(), "openai/gpt-audio-1.5");
  assert.match(notRunning.output.out, /Takes effect next launch/);
});

test("model <vendor/model> when the core switched but the vendor failed (a misspelled model, say): it says honestly it can't be used yet, exit code 1", async () => {
  haveStoredKey();
  const problem = "Gemini rejected the request: models/gemini-typo is not found";
  const daemon = fakeDaemon({
    running: READY,
    changeRoute: () => {
      daemon.current = { ...daemon.current, key: { state: "rejected", cause: "other", problem } };
      return { ok: true };
    },
  });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("model", "gemini/gemini-typo"), 1);
  assert.match(output.out, /Model switched/);
  assert.match(output.err, /doesn't work yet: Gemini rejected the request: models\/gemini-typo is not found/);
});

test("model <vendor> without its key asks first; the answer is verified by the background, saved for that vendor, then switched", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { whisprflow, output, asked } = harness({ daemon, secrets: ["sk-my-secret"] });
  assert.equal(await whisprflow("model", "openai"), 0);
  assert.deepEqual(saved, [{ key: "sk-my-secret", provider: "openai" }]);
  // It asks for the OpenAI key and says where to get one
  assert.match(asked[0], /OpenAI API key/);
  assert.match(asked[0], /platform\.openai\.com\/api-keys/);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-model", params: { model: "openai/gpt-audio-mini" } });
  assert.ok(!(output.out + output.err).includes("sk-my-secret"));
});

test("model <vendor> without its key and no way to ask (not a terminal), or no answer given: no switch, and it says what to do first", async () => {
  useNative();
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.whisprflow("model", "openai"), 1);
  assert.match(quiet.output.err, /No OpenAI key yet.*whisprflow key openai/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  const declined = harness({ daemon: fakeDaemon({ running: READY }), secrets: [""] });
  assert.equal(await declined.whisprflow("model", "openai"), 1);
  assert.match(declined.output.err, /Not switched/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  const rejected = harness({
    daemon: fakeDaemon({ running: READY, saveKey: () => ({ ok: false, problem: "This key is invalid" }) }),
    secrets: ["sk-bad", "", ""],
  });
  assert.equal(await rejected.whisprflow("model", "openai"), 1);
  assert.match(rejected.output.err, /This key didn't pass: This key is invalid/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");
});

test("model with an unknown vendor or a misspelled model exits 2 listing the choices; a cleanup vendor points to local mode", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("model", "nope"), 2);
  assert.match(output.err, /gemini \/ openai/);
  assert.equal(await whisprflow("model", "ollama"), 2);
  assert.match(output.err, /Ollama.*local.*whisprflow polish ollama/);
  assert.equal(await whisprflow("model", "openai/gpt audio"), 2);
  assert.equal(await whisprflow("model", "openai", "extra"), 2);
});

test("model check checks the one in use: whether it works, where the key comes from, and the round trip", async () => {
  haveStoredKey();
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("model", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-model", params: { model: "gemini/gemini-3.6-flash" } });
  assert.match(output.out, /Gemini gemini-3\.6-flash.*0\.8 ?s/);
});

test("model check <model> checks another; when it doesn't work it gives the reason and next step, exit 1", async () => {
  const missing = harness({
    daemon: fakeDaemon({
      running: READY,
      checkModel: () => ({ ok: false, cause: "missing", problem: "No OpenAI key yet: run whisprflow key openai" }),
    }),
  });
  assert.equal(await missing.whisprflow("model", "check", "openai"), 1);
  assert.deepEqual(missing.daemon.requests.at(-1).params, { model: "openai/gpt-audio-mini" });
  assert.match(missing.output.err, /Not usable: No OpenAI key yet/);

  const wrong = harness({
    daemon: fakeDaemon({
      running: READY,
      checkModel: () => ({
        ok: false,
        cause: "other",
        problem: "OpenAI doesn't have this model, or this key can't use it: ...",
      }),
    }),
  });
  assert.equal(await wrong.whisprflow("model", "check", "openai/gpt-audio-9"), 1);
  assert.match(wrong.output.err, /Not usable: OpenAI doesn't have this model/);
});

test("model check starts it if not running; an older running version without this command says to restart", async () => {
  const fresh = harness();
  assert.equal(await fresh.whisprflow("model", "check"), 0);
  assert.deepEqual(fresh.daemon.calls, ["start", "check-model"]);

  const old = fakeDaemon({ running: READY });
  old.request = async (cmd) => {
    throw new Error(`Unknown command: ${cmd}`);
  };
  const outdated = harness({ daemon: old });
  assert.equal(await outdated.whisprflow("model", "check"), 1);
  assert.match(outdated.output.err, /old version.*whisprflow restart/);
});

// ---------- One key per vendor ----------

test("key <vendor> asks for that vendor's key and saves it for that vendor; when it isn't the one in use it says how to switch (by its layer)", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { whisprflow, output, asked } = harness({ daemon, secrets: ["sk-new"] });
  assert.equal(await whisprflow("key", "openai"), 0);
  assert.deepEqual(saved, [{ key: "sk-new", provider: "openai" }]);
  assert.match(asked[0], /OpenAI API key/);
  assert.match(output.out, /To use it: whisprflow model openai/);

  // Ollama runs on this computer: nothing is asked or saved
  const ollama = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await ollama.whisprflow("key", "ollama"), 0);
  assert.equal(ollama.asked.length, 0);
  assert.match(ollama.output.out, /Ollama runs on this computer and needs no key/);

  const fromLocal = harness({ daemon: fakeDaemon({ running: LOCAL_READY }), secrets: ["sk-ds", "sk-oa"] });
  assert.equal(await fromLocal.whisprflow("key", "openai"), 0);
  assert.match(fromLocal.output.out, /To use it: whisprflow mode native --model openai/);
});

test("key followed by something that isn't a vendor: most likely the key itself typed into the command, so it isn't used or printed", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("key", "sk-proj-SECRET"), 2);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
  assert.match(output.err, /shell history/);
});

test("key --forget <vendor> deletes only that vendor's key; without one it deletes the key in use", async () => {
  haveStoredKey();
  haveOpenAIKey();
  const { whisprflow, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("key", "--forget", "openai"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "forget-key", params: { provider: "openai" } });
  assert.equal(existsSync(keyFile(paths, "openai")), false);
  assert.equal(existsSync(keyFile(paths, "gemini")), true);
  assert.match(output.out, /Deleted the saved OpenAI key/);
});

test("first start while using OpenAI asks for the OpenAI key", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "native", model: "openai/gpt-audio-mini" }));
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" } });
  const { whisprflow, asked } = harness({ daemon, secrets: ["sk-first"] });
  assert.equal(await whisprflow(), 0);
  assert.match(asked[0], /OpenAI API key/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-first",
    provider: "openai",
  });
});

test("after changing the model, a restart finding that vendor has no key says it is missing, not applied", async () => {
  const daemon = fakeDaemon({
    running: READY,
    afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" },
  });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("config", "set", "model", "openai"), 1);
  assert.match(output.err, /no OpenAI key yet.*whisprflow key openai/i);
  assert.doesNotMatch(output.out, /Applied/);
});

test("changing the model while GEMINI_MODEL (the older name) is set warns that it overrides the new value", async () => {
  useNative();
  haveOpenAIKey();
  const { whisprflow, output } = harness({ env: { GEMINI_MODEL: "gemini-3.5-flash" } });
  assert.equal(await whisprflow("model", "openai"), 0);
  assert.match(output.out, /the GEMINI_MODEL env var is set/);
});

test("model reports a key given by the environment when the background started (not visible to the CLI) honestly, not as missing", async () => {
  const fromEnv = { ...READY, key: { state: "ready", source: "env", problem: null, verified: true } };
  const { whisprflow, output } = harness({ daemon: fakeDaemon({ running: fromEnv }) });
  assert.equal(await whisprflow("model"), 0);
  assert.match(output.out, /● gemini\s+Gemini\s+gemini-3\.6-flash\s+key from the GEMINI_API_KEY env var/);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini \(default\)\s+no key yet/);
});

// ---------- Added after review ----------

test("when the vendor's key is rejected while changing models: no switch, the reason, settings untouched, exit 1", async () => {
  haveOpenAIKey();
  const daemon = fakeDaemon({
    running: READY,
    changeRoute: () => ({ ok: false, problem: "This key is invalid. Check it was copied in full" }),
  });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("model", "openai"), 1);
  assert.match(output.err, /Not switched: This key is invalid/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");
  assert.doesNotMatch(output.out, /Switched/);
});

test("changing models when the running version can't switch on the fly: saved to settings and restarted to apply (the old way)", async () => {
  haveOpenAIKey();
  const old = fakeDaemon({ running: READY });
  const request = old.request;
  old.request = async (cmd, params) => {
    if (cmd === "set-model") throw new Error(`Unknown command: ${cmd}`);
    return request(cmd, params);
  };
  const { whisprflow, output } = harness({ daemon: old });
  assert.equal(await whisprflow("model", "openai"), 0);
  assert.equal(savedModel(), "openai/gpt-audio-mini");
  assert.deepEqual(old.calls.slice(-2), ["stop", "start"]);
  assert.match(output.out, /Applied/);
});

test("with the packaged app running, its keys live in its own files, so whether a key exists follows what it reports", async () => {
  const app = { ...READY, packaged: true, keys: { gemini: "stored", openai: "stored" } };
  const { whisprflow, output, asked } = harness({ daemon: fakeDaemon({ running: app }) });
  assert.equal(await whisprflow("model"), 0);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini \(default\)\s+key saved/);
  // No second key question; the packaged app also switches on the fly without quitting
  assert.equal(await whisprflow("model", "openai"), 0);
  assert.equal(asked.length, 0);
  assert.match(output.out, /Switched, no restart needed/);
});

test("every command's output in English has no untranslated Chinese (except what the user said)", async () => {
  const history = openHistory(paths.historyDb);
  history.add({
    id: "a",
    status: "completed",
    refinedText: "Let's meet at 9:30.",
    error: null,
    duration: 4,
    audioLocalPath: null,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.add({
    id: "b",
    status: "failed",
    refinedText: "",
    error: null,
    duration: 75,
    audioLocalPath: null,
    createdAt: "2026-10-12T06:32:00.000Z",
  });
  history.addCall({
    purpose: "dictation",
    audioId: "a",
    provider: "gemini",
    model: "gemini-3.6-flash",
    inputTokens: 1390,
    audioTokens: 25,
    cachedTokens: 0,
    outputTokens: 4,
    thinkingTokens: 0,
    costUsd: 0.0011,
    latencyMs: 1700,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.addCall({
    purpose: "check",
    audioId: null,
    provider: "openai",
    model: "gpt-unknown",
    inputTokens: 10,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 1,
    thinkingTokens: 0,
    costUsd: null,
    latencyMs: 900,
    createdAt: "2026-10-13T06:33:00.000Z",
  });
  history.close();
  const missing = { ...NO_PERMISSIONS, summary: { ...NO_PERMISSIONS.summary, missing: [], blocker: null } };
  const commands = [
    [["status"], READY],
    [["status"], missing],
    [["status"], null],
    [["config"], READY],
    [["theme"], READY],
    [["model"], READY],
    [["usage"], null],
    [["history"], null],
    [["logs"], null],
    [["stop"], READY],
    [["settings"], null],
    [["key", "--forget", "openai"], READY],
    [["uninstall"], null],
    [["model", "nope"], READY],
    [["model", "ollama"], READY],
    [["mode"], READY],
    [["mode", "local"], READY],
    [["mode", "cloud"], READY],
    [["transcriber"], READY],
    [["polish"], READY],
    [["polish", "custom/m"], READY],
    [["history", "extra"], null],
  ];
  for (const [argv, running] of commands) {
    const { whisprflow, output } = harness({ daemon: fakeDaemon({ running }), locale: "en", interactive: false });
    await whisprflow(...argv);
    assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/, argv.join(" "));
  }
});

// ---------- Modes, and the models within each ----------

/** Pretends a custom service key was saved earlier */
const haveCustomKey = () => writeFileSync(keyFile(paths, "custom"), "ciphertext");
/** Arguments that point local cleanup at a custom service */
const CUSTOM = ["--polish", "custom/qwen3:8b", "--url", "http://127.0.0.1:8080/v1"];
const saved = (name) => resolveSettings({ file: paths.settingsFile, env: {} })[name].value;
/** A background in local mode, cleaning up with Ollama */
const LOCAL_READY = {
  ...READY,
  provider: null,
  mode: "local",
  model: null,
  thinking: null,
  transcriber: DEFAULT_TRANSCRIBER,
  polish: "ollama/qwen3:4b-instruct",
  key: { state: "ready", source: "none", problem: null },
  localModel: { state: "ready", model: DEFAULT_TRANSCRIBER, backend: "MTL0" },
};

/** Private mode: no key, only an on-device model */
const PRIVATE_READY = {
  ...LOCAL_READY,
  provider: null,
  mode: "private",
  polish: null,
  key: { state: "ready", source: "none", problem: null },
};

test("whisprflow mode private asks for no key and switches once the model is downloaded; the panel shows no key needed and on-device only", async () => {
  haveModel();
  const { whisprflow, output, daemon, asked } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await whisprflow("mode", "private"), 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-mode").params, { mode: "private", changes: {} });
  assert.ok(output.out.includes(DEFAULT_TRANSCRIBER), output.out);

  const panel = harness({ daemon: fakeDaemon({ running: PRIVATE_READY }) });
  assert.equal(await panel.whisprflow("status"), 0);
  assert.match(panel.output.out, /Key +Not needed/);
  assert.match(panel.output.out, /Private: /);
});

test("whisprflow transcriber in private mode changes its own setting and leaves local's step one alone; a key must name its vendor", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "private" }));
  haveModel("qwen3-asr-0.6b-int8");
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 0);
  const settings = resolveSettings({ file: paths.settingsFile, env: {} });
  assert.equal(settings.privateTranscriber.value, "qwen3-asr-0.6b-int8");
  assert.equal(settings.transcriber.value, DEFAULT_TRANSCRIBER);

  assert.equal(await whisprflow("key"), 2);
  assert.match(output.err, /doesn't use a key/);
});

test("the first-start options include private mode: choosing it asks for no key and saves private", async () => {
  const { whisprflow, questions, asked } = harness({
    daemon: fakeDaemon({ afterStart: PRIVATE_READY }),
    answers: ["private"],
  });
  assert.equal(await whisprflow(), 0);
  assert.match(questions.join("\n"), /private mode/);
  assert.deepEqual(asked, []);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).mode.value, "private");
});

test("mode lists the modes and the models each uses, marks the one in use, and says how to switch and change models", async () => {
  useNative();
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("mode"), 0);
  assert.match(output.out, /● native\s+.*Gemini gemini-3\.6-flash/);
  assert.match(output.out, new RegExp(`\\n {4}local\\s+.*${DEFAULT_TRANSCRIBER} → Ollama qwen3:4b-instruct`));
  assert.match(output.out, /whisprflow mode local/);
  assert.match(output.out, /whisprflow model\b/);
  assert.match(output.out, /whisprflow transcriber/);
  assert.match(output.out, /whisprflow polish/);
});

test("mode <mode> needing no key (Ollama cleanup) switches the running one at once, without a restart", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: READY });
  const { whisprflow, output, asked } = harness({ daemon });
  assert.equal(await whisprflow("mode", "local"), 0);
  assert.equal(asked.length, 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-mode", params: { mode: "local", changes: {} } });
  assert.ok(!daemon.calls.includes("stop"));
  assert.ok(output.out.includes(`local mode: ${DEFAULT_TRANSCRIBER} → Ollama qwen3:4b-instruct`), output.out);
  assert.match(output.out, /Switched, no restart needed/);
});

test("mode local carrying step two: without a key for the custom service it asks first, verifies with the new settings, then switches", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: READY });
  const { whisprflow, asked, output } = harness({ daemon, secrets: ["sk-custom"] });
  assert.equal(await whisprflow("mode", "local", ...CUSTOM), 0);
  assert.match(asked[0], /Custom/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-custom",
    provider: "custom",
    changes: { mode: "local", polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:8080/v1" },
  });
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "set-mode",
    params: { mode: "local", changes: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:8080/v1" } },
  });
  assert.ok(!(output.out + output.err).includes("sk-custom"));
});

test("mode <mode> without the needed key and no way to ask doesn't switch and says what to do; when not running it saves for next launch", async () => {
  useNative();
  haveModel();
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.whisprflow("mode", "local", ...CUSTOM), 1);
  assert.match(quiet.output.err, /whisprflow key custom/);
  assert.equal(saved("mode"), "native");

  haveCustomKey();
  const notRunning = harness();
  assert.equal(await notRunning.whisprflow("mode", "local", ...CUSTOM), 0);
  assert.equal(saved("mode"), "local");
  assert.match(notRunning.output.out, /Takes effect next launch/);
  assert.deepEqual(notRunning.daemon.calls, []);
});

test("mode with a misspelled mode exits 2 listing the choices; a refused switch exits 1 with the reason", async () => {
  haveModel();
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("mode", "cloud"), 2);
  assert.match(output.err, /native \/ local/);

  const refused = harness({
    daemon: fakeDaemon({ running: READY, changeRoute: () => ({ ok: false, problem: "Ollama isn't running" }) }),
  });
  assert.equal(await refused.whisprflow("mode", "local"), 1);
  assert.match(refused.output.err, /Not switched: Ollama isn't running/);
});

test("changing the native model while in local mode: refused with a hint to switch back to native; no key question, no request, settings untouched", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { whisprflow, output, asked } = harness({ daemon, secrets: ["sk-x"] });
  assert.equal(await whisprflow("model", "openai"), 1);
  assert.match(output.err, /in local mode.*audio model.*native mode.*whisprflow mode native/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-model"));
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  // Not running: the mode in settings decides
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "local" }));
  const offline = harness();
  assert.equal(await offline.whisprflow("model", "openai"), 1);
  assert.match(offline.output.err, /in local mode/);
});

test("changing local's two steps while in native mode: refused with a hint to switch to local; listing is fine but marked as not in use", async () => {
  const daemon = fakeDaemon({ running: READY });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 1);
  assert.match(
    output.err,
    /in native mode.*on-device transcription model \(step 1\).*local mode.*whisprflow mode local/,
  );
  assert.equal(await whisprflow("polish", "ollama/llama3.2:3b"), 1);
  assert.match(output.err, /polishing model \(step 2\)/);
  assert.ok(!daemon.calls.some((call) => call.startsWith("set-")));

  const list = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await list.whisprflow("transcriber"), 0);
  assert.match(list.output.out, /native mode.*whisprflow mode local/);
});

test("settings carried with a mode that belong to another mode exit 2, naming what can be carried", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("mode", "native", "--polish", "ollama"), 2);
  assert.match(output.err, /--model/);
  assert.equal(await whisprflow("mode", "local", "--model", "openai"), 2);
  assert.match(output.err, /--transcriber.*--polish.*--url/);
});

test("transcriber lists on-device models (step one) with size, download state, and progress, marks the one in use, and ends with how many are downloaded and how to download or delete", async () => {
  haveModel("qwen3-asr-0.6b-int8");
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("transcriber"), 0);
  assert.match(output.out, new RegExp(`● ${DEFAULT_TRANSCRIBER} `));
  assert.match(output.out, / {4}qwen3-asr-0\.6b-q8\s+Qwen3-ASR 0\.6B \(Q8_0\)\s+850 MB\s+/);
  assert.match(output.out, /qwen3-asr-0\.6b-int8\s+Qwen3-ASR 0\.6B \(int8\)\s+987 MB\s+/);
  assert.match(output.out, new RegExp(`1 of ${MODELS.length} downloaded`));
  assert.match(output.out, /whisprflow transcriber qwen3-asr-0\.6b-int8/);
  assert.ok(output.out.includes(`whisprflow transcriber download ${DEFAULT_TRANSCRIBER}`), output.out);

  // With the background running, its report wins (download progress, the last failure)
  const total = downloadSize(findModel("qwen3-asr-0.6b-q8"));
  const running = {
    ...LOCAL_READY,
    localModels: [
      {
        id: "qwen3-asr-0.6b-q8",
        installed: false,
        download: { received: total / 4, total },
        partial: 0,
        problem: null,
      },
      {
        id: "qwen3-asr-0.6b-int8",
        installed: false,
        download: null,
        partial: 0,
        problem: "Qwen3-ASR 0.6B (int8) didn't download: network down",
      },
    ],
  };
  const busy = harness({ daemon: fakeDaemon({ running }) });
  assert.equal(await busy.whisprflow("transcriber"), 0);
  assert.match(busy.output.out, /qwen3-asr-0\.6b-q8.*25%/);
  assert.match(busy.output.out, /network down/);
});

test("transcriber <model> needs no key and switches the running one at once; a wrong one exits 2 listing the choices", async () => {
  haveModel("qwen3-asr-0.6b-int8");
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { whisprflow, output, asked } = harness({ daemon });
  assert.equal(await whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-transcriber", params: { transcriber: "qwen3-asr-0.6b-int8" } });
  assert.equal(asked.length, 0);
  assert.match(output.out, /qwen3-asr-0\.6b-int8/);

  const wrong = harness();
  assert.equal(await wrong.whisprflow("transcriber", "gemini"), 2);
  assert.match(wrong.output.err, /qwen3-asr-0\.6b-q8/);
});

// ---------- On-device models: download, cancel, delete ----------

/**
 * A downloading background: after download-model each status check advances, done by the second (with outcome other than "finish", it fails).
 * delete-model follows the core's rule: the one in use (local's step one) can't be deleted
 */
function modelDaemon({ running = LOCAL_READY, outcome = "finish" } = {}) {
  const daemon = fakeDaemon({ running });
  const total = (id) => downloadSize(findModel(id));
  const views = new Map();
  const view = (id) =>
    views.get(id) ?? {
      id,
      installed: existsSync(join(paths.modelsDir, id, ".complete.json")),
      download: null,
      partial: 0,
      problem: null,
    };
  const polls = new Map();
  const status = daemon.status;
  daemon.status = async (params) => {
    const current = await status.call(daemon, params);
    if (current === null) return null;
    for (const [id, count] of polls) {
      polls.set(id, count + 1);
      if (count >= 1) {
        polls.delete(id);
        if (outcome === "finish") {
          haveModel(id);
          views.delete(id);
        } else views.set(id, { ...view(id), download: null, problem: `${id} didn't download: ${outcome}` });
      }
    }
    return { ...current, localModels: MODELS.map(({ id }) => view(id)) };
  };
  const request = daemon.request;
  daemon.request = async (cmd, params) => {
    if (cmd === "download-model") {
      daemon.calls.push(cmd);
      daemon.requests.push({ cmd, params });
      views.set(params.id, {
        ...view(params.id),
        download: { received: total(params.id) / 2, total: total(params.id) },
      });
      polls.set(params.id, 0);
      return { ok: true };
    }
    if (cmd === "cancel-download") {
      daemon.calls.push(cmd);
      polls.delete(params.id);
      views.delete(params.id);
      return { ok: true };
    }
    if (cmd === "delete-model") {
      daemon.calls.push(cmd);
      const current = daemon.current;
      if (current.mode === "local" && current.transcriber === params.id) {
        return {
          ok: false,
          problem: `${params.id} is in use and can't be deleted: switch to another model or back to native first`,
        };
      }
      rmSync(join(paths.modelsDir, params.id), { recursive: true, force: true });
      return { ok: true };
    }
    return request.call(daemon, cmd, params);
  };
  return daemon;
}

test("transcriber <model> not downloaded yet asks first; yes hands the download to the background, reporting progress, then switches", async () => {
  const daemon = modelDaemon();
  const { whisprflow, output, confirmed } = harness({ daemon, confirms: [true] });
  assert.equal(await whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 0);
  assert.match(confirmed[0], /Qwen3-ASR 0\.6B \(int8\) isn't downloaded yet \(987 MB, from Hugging Face\)/);
  assert.match(output.out, /50%/);
  assert.match(output.out, /Qwen3-ASR 0\.6B \(int8\)/);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-transcriber", params: { transcriber: "qwen3-asr-0.6b-int8" } });
});

test("transcriber <model> declined is neither downloaded nor switched; without a way to ask it names the command to run; a failed download doesn't switch", async () => {
  const declined = harness({ daemon: modelDaemon(), confirms: [false] });
  assert.equal(await declined.whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 1);
  assert.match(declined.output.out, /Nothing downloaded or switched/);
  assert.ok(!declined.daemon.calls.includes("download-model") && !declined.daemon.calls.includes("set-transcriber"));

  const quiet = harness({ daemon: modelDaemon(), interactive: false });
  assert.equal(await quiet.whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 1);
  assert.match(quiet.output.err, /run whisprflow transcriber download qwen3-asr-0\.6b-int8 first/);

  const failing = harness({ daemon: modelDaemon({ outcome: "network down" }), confirms: [true] });
  assert.equal(await failing.whisprflow("transcriber", "qwen3-asr-0.6b-int8"), 1);
  assert.match(failing.output.err, /didn't download: network down/);
  assert.ok(!failing.daemon.calls.includes("set-transcriber"));
});

test("transcriber download is the user's own request, so no question; without the background it downloads in the CLI process; an installed one says so", async () => {
  const idle = harness();
  assert.equal(await idle.whisprflow("transcriber", "download", "qwen3-asr-0.6b-q8"), 0);
  assert.deepEqual(idle.local.downloads, ["qwen3-asr-0.6b-q8"]);
  assert.deepEqual(idle.local.sources, ["original"]);
  assert.match(idle.output.out, /Qwen3-ASR 0\.6B \(Q8_0\).*850 MB.*Hugging Face/);
  assert.equal(idle.confirmed.length, 0);

  const again = harness();
  assert.equal(await again.whisprflow("transcriber", "download", "qwen3-asr-0.6b-q8"), 0);
  assert.match(again.output.out, /already downloaded/);
  assert.deepEqual(again.local.downloads, []);

  const failing = harness({ modelDownload: "disk not writable" });
  assert.equal(await failing.whisprflow("transcriber", "download", "qwen3-asr-0.6b-int8"), 1);
  assert.match(failing.output.err, /didn't download: disk not writable/);

  const wrong = harness();
  assert.equal(await wrong.whisprflow("transcriber", "download"), 2);
  assert.equal(await wrong.whisprflow("transcriber", "download", "gemini"), 2);
});

test("transcriber check has the background speak a sentence and transcribe it, reporting what was said, the text, and the time; without a model it checks the chosen one", async () => {
  haveModel();
  const daemon = modelDaemon();
  const request = daemon.request;
  daemon.request = async (cmd, params, options) => {
    if (cmd !== "check-transcriber") return request.call(daemon, cmd, params, options);
    daemon.calls.push(cmd);
    daemon.requests.push({ cmd, params });
    const said = "The meeting is at three this afternoon.";
    return { ok: true, said, text: said, transcribeMs: 312, loadMs: 1840, backend: "metal" };
  };
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("transcriber", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-transcriber", params: { id: DEFAULT_TRANSCRIBER } });
  assert.ok(output.out.includes(findModel(DEFAULT_TRANSCRIBER).name), output.out);
  assert.match(output.out, /The meeting is at three this afternoon\./);
  assert.match(output.out, /0\.3 ?s/);
  assert.match(output.out, /1\.8 ?s/);

  // An undownloaded one isn't sent to the background; it says how to download
  const asked = daemon.calls.filter((cmd) => cmd === "check-transcriber").length;
  assert.equal(await whisprflow("transcriber", "check", "qwen3-asr-0.6b-int8"), 1);
  assert.match(output.err, /run whisprflow transcriber download qwen3-asr-0\.6b-int8 first/);
  assert.equal(daemon.calls.filter((cmd) => cmd === "check-transcriber").length, asked);
  assert.equal(await whisprflow("transcriber", "check", "gemini"), 2);
  assert.equal(await whisprflow("transcriber", "check", "qwen3-asr-0.6b-q8", "extra"), 2);
});

test("transcriber cancel stops a background download; nothing downloading says so", async () => {
  const daemon = modelDaemon();
  const { whisprflow, output } = harness({ daemon });
  await daemon.request("download-model", { id: "qwen3-asr-0.6b-int8" });
  assert.equal(await whisprflow("transcriber", "cancel", "qwen3-asr-0.6b-int8"), 0);
  assert.ok(daemon.calls.includes("cancel-download"));
  assert.match(output.out, /Qwen3-ASR 0\.6B \(int8\)/);
  assert.equal(await whisprflow("transcriber", "cancel", "qwen3-asr-0.6b-int8"), 0);
  assert.match(output.out, /isn't downloading/);
});

test("transcriber delete confirms first; --yes skips it; no way to ask and no --yes exits 2; the one in use can't be deleted; an undownloaded one needs nothing", async () => {
  haveModel("qwen3-asr-0.6b-int8");
  const asked = harness({ daemon: modelDaemon(), confirms: [false] });
  assert.equal(await asked.whisprflow("transcriber", "delete", "qwen3-asr-0.6b-int8"), 1);
  assert.match(asked.confirmed[0], /Qwen3-ASR 0\.6B \(int8\).*987 MB/);
  assert.ok(existsSync(join(paths.modelsDir, "qwen3-asr-0.6b-int8")));

  const quiet = harness({ daemon: modelDaemon(), interactive: false });
  assert.equal(await quiet.whisprflow("transcriber", "delete", "qwen3-asr-0.6b-int8"), 2);
  assert.match(quiet.output.err, /--yes/);

  const sure = harness({ daemon: modelDaemon() });
  assert.equal(await sure.whisprflow("transcriber", "delete", "qwen3-asr-0.6b-int8", "--yes"), 0);
  assert.match(sure.output.out, /987 MB/);
  assert.equal(existsSync(join(paths.modelsDir, "qwen3-asr-0.6b-int8")), false);

  haveModel();
  const inUse = harness({ daemon: modelDaemon() });
  assert.equal(await inUse.whisprflow("transcriber", "delete", DEFAULT_TRANSCRIBER, "--yes"), 1);
  assert.match(inUse.output.err, /in use and can't be deleted/);

  const nothing = harness();
  assert.equal(await nothing.whisprflow("transcriber", "delete", "qwen3-asr-0.6b-int8", "--yes"), 0);
  assert.match(nothing.output.out, /isn't downloaded/);
});

test("transcriber delete without the background deletes it itself; the model local mode uses in settings isn't deleted", async () => {
  haveModel("qwen3-asr-0.6b-int8");
  const idle = harness();
  assert.equal(await idle.whisprflow("transcriber", "delete", "qwen3-asr-0.6b-int8", "--yes"), 0);
  assert.deepEqual(idle.local.removed, ["qwen3-asr-0.6b-int8"]);

  haveModel();
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "local" }));
  const inUse = harness();
  assert.equal(await inUse.whisprflow("transcriber", "delete", DEFAULT_TRANSCRIBER, "--yes"), 1);
  assert.match(inUse.output.err, /in use and can't be deleted/);
  assert.deepEqual(inUse.local.removed, []);
});

test("mode local with its on-device model not downloaded asks first; declining switches nothing and asks for no key", async () => {
  const daemon = modelDaemon({ running: READY });
  const { whisprflow, output, asked } = harness({ daemon, confirms: [false] });
  assert.equal(await whisprflow("mode", "local"), 1);
  assert.match(output.out, /Nothing downloaded or switched/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-mode"));

  const yes = harness({ daemon: modelDaemon({ running: READY }), confirms: [true] });
  assert.equal(await yes.whisprflow("mode", "local"), 0);
  assert.match(yes.output.out, /local mode/);
});

test("polish lists the cleanup vendors (step two), their models and keys, and how to set up a custom service", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("polish"), 0);
  assert.match(output.out, /ollama\s+Ollama\s+qwen3:4b-instruct/);
  assert.match(output.out, /custom\s+/);
  assert.match(output.out, /whisprflow polish custom\/<model> --url <url>/);
});

test("polish <vendor>/<model> switches the running one at once", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("polish", "ollama/llama3.2:3b"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-polish", params: { polish: "ollama/llama3.2:3b" } });
  assert.match(output.out, /Ollama llama3\.2:3b/);
});

test("polish custom/<model> --url <address> asks for the custom service key first, verifies it with the model and address, then switches", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { whisprflow, asked } = harness({ daemon, secrets: ["sk-custom"] });
  assert.equal(await whisprflow("polish", "custom/qwen3:8b", "--url", "http://127.0.0.1:8080/v1/chat/completions"), 0);
  // The custom service has no page for getting a key
  assert.doesNotMatch(asked[0], /Get one here/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-custom",
    provider: "custom",
    changes: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:8080/v1" },
  });
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "set-polish",
    params: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:8080/v1" },
  });
});

test("polish with a custom service but no address, or an audio vendor, exits 2 and says why", async () => {
  const { whisprflow, output } = harness();
  assert.equal(await whisprflow("polish", "custom/m"), 2);
  assert.match(output.err, /--url/);
  assert.equal(await whisprflow("polish", "openai"), 2);
  // It names every vendor that can be used
  assert.ok(output.err.includes(CHAT_VENDORS.map(({ id }) => id).join(" / ")), output.err);
});

test("polish check checks the step-two model in use", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { whisprflow, output } = harness({ daemon });
  assert.equal(await whisprflow("polish", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-polish", params: { polish: "ollama/qwen3:4b-instruct" } });
  assert.match(output.out, /Ollama qwen3:4b-instruct/);
});
