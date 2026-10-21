import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { compareVersions } from "../../src/cli/commands/update.mjs";
import { createUpdater, DOWNLOAD_URL, downloadBase } from "../../src/cli/updater.mjs";
import { createTranslator, LocalizedError } from "../../src/i18n/index.mjs";

const en = createTranslator("en");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-up-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The installer and app differ by system: macOS has install.sh and WhisprFlow.app, Windows has install.ps1 and no separate app
const macOnly = { skip: process.platform === "win32" && "the macOS installer and WhisprFlow.app" };
const windowsOnly = { skip: process.platform !== "win32" && "the Windows install.ps1" };

test("version comparison is numeric, not textual; a prerelease is older than the release of the same number", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(compareVersions("0.6.0", "0.6.0-rc.1") > 0);
  assert.ok(compareVersions("0.6.0-rc.10", "0.6.0-rc.9") > 0);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.ok(compareVersions("0.5.9", "0.6.0") < 0);
});

test("where to download from: like the installer, the release address by default; WHISPRFLOW_INSTALL_BASE can point at a URL or a local directory", () => {
  assert.equal(downloadBase({}), DOWNLOAD_URL);
  assert.equal(downloadBase({ WHISPRFLOW_INSTALL_BASE: "https://example.com/sm" }), "https://example.com/sm");
  assert.equal(downloadBase({ WHISPRFLOW_INSTALL_BASE: "/tmp/release" }), "file:///tmp/release");
  assert.equal(downloadBase({ WHISPRFLOW_INSTALL_BASE: "C:\\dist\\release" }), "file:///C:/dist/release");
});

test(
  "really checks and really runs the installer, using a local directory as the download address",
  macOnly,
  async () => {
    const release = join(dir, "release");
    const record = join(dir, "record");
    const home = join(dir, "home");
    publish(release, "v9.9.9");
    // A fake installer: records where and which version it installs, and exits with the requested code
    writeFileSync(
      join(release, "download", "v9.9.9", "install.sh"),
      `printf '%s|%s|%s\\n' "$WHISPRFLOW_HOME" "$WHISPRFLOW_VERSION" "$#" > ${JSON.stringify(record)}\nexit "\${FAKE_EXIT:-0}"\n`,
    );
    const updater = createUpdater({ env: { ...process.env, WHISPRFLOW_INSTALL_BASE: release }, home });
    assert.equal(await updater.latest(5), "v9.9.9");
    assert.equal(await updater.install("v9.9.9"), 0);
    assert.equal(readFileSync(record, "utf8"), `${home}|v9.9.9|0\n`);

    const failing = createUpdater({ env: { ...process.env, WHISPRFLOW_INSTALL_BASE: release, FAKE_EXIT: "3" }, home });
    assert.equal(await failing.install("v9.9.9"), 3);
  },
);

test("an unreachable download address reports the address and what curl said", async () => {
  const updater = createUpdater({ env: { ...process.env, WHISPRFLOW_INSTALL_BASE: join(dir, "nowhere") }, home: dir });
  for (const attempt of [() => updater.latest(5), () => updater.install("v9.9.9")]) {
    await assert.rejects(attempt, (error) => {
      assert.ok(error instanceof LocalizedError);
      const said = en.text(error.problem);
      // With a local directory as the download address, Windows reports its file:// URL (Node encodes ~ in short paths as %7E)
      const where = join(dir, "nowhere");
      assert.ok(said.includes(where) || said.includes(decodeURIComponent(pathToFileURL(where).href)), said);
      assert.match(said, /curl/);
      return true;
    });
  }
});

// ---------- App ----------

const ARCH = process.arch === "arm64" ? "arm64" : "x64";

/**
 * Makes a fake WhisprFlow.app in parent: the program is the system's sleep under another name. With sign true it gets an ad-hoc signature (no developer),
 * matching the installed and downloaded ones, whose developer is "none" on both sides
 */
function fakeApp(parent, version, { sign = true, bundleId = "com.zghanw.whisprflow" } = {}) {
  const app = join(parent, "WhisprFlow.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  copyFileSync("/bin/sleep", join(app, "Contents", "MacOS", "WhisprFlow"));
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>WhisprFlow</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  if (sign) execFileSync("codesign", ["--sign", "-", "--force", "--deep", app], { stdio: "ignore" });
  return app;
}

/**
 * Lays out a release directory the way GitHub Releases serves one: latest/download/latest names the newest version, and that version's files go under
 * download/<version>/. @returns the version's directory
 */
function publish(release, version) {
  mkdirSync(join(release, "latest", "download"), { recursive: true });
  writeFileSync(join(release, "latest", "download", "latest"), `${version}\n`);
  const folder = join(release, "download", version);
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** Puts an app into a dmg like a release does, under release/download/<version>/, with a checksum */
function publishDmg(release, version, app) {
  const stage = mkdtempSync(join(dir, "stage-"));
  execFileSync("ditto", [app, join(stage, "WhisprFlow.app")]);
  const folder = join(release, "download", version);
  mkdirSync(folder, { recursive: true });
  const dmg = join(folder, `WhisprFlow-${ARCH}.dmg`);
  execFileSync("hdiutil", [
    "create",
    "-quiet",
    "-volname",
    "WhisprFlow",
    "-srcfolder",
    stage,
    "-format",
    "UDZO",
    "-ov",
    dmg,
  ]);
  const hash = createHash("sha256").update(readFileSync(dmg)).digest("hex");
  writeFileSync(`${dmg}.sha256`, `${hash}  WhisprFlow-${ARCH}.dmg\n`);
  return dmg;
}

const versionOf = (app) =>
  execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")],
    {
      encoding: "utf8",
    },
  ).trim();

test(
  "finding the app: the one WHISPRFLOW_APP points at; one that isn't WhisprFlow (wrong bundle id) or doesn't exist counts as not installed",
  macOnly,
  async () => {
    const mine = fakeApp(mkdtempSync(join(dir, "a-")), "0.3.0", { sign: false });
    const other = fakeApp(mkdtempSync(join(dir, "b-")), "1.0.0", { sign: false, bundleId: "com.example.other" });
    const find = (path) => createUpdater({ env: { ...process.env, WHISPRFLOW_APP: path }, home: dir }).findApp(null);
    assert.deepEqual(await find(mine), { path: mine, version: "0.3.0" });
    assert.equal(await find(other), null);
    assert.equal(await find(join(dir, "nowhere", "WhisprFlow.app")), null);
  },
);

test("finding the app: wherever the running one is (its bundle found by process id)", macOnly, async () => {
  // It must be signed: an unsigned program is killed for an invalid signature as soon as it runs, leaving a crash report
  const app = fakeApp(mkdtempSync(join(dir, "run-")), "0.4.0");
  const child = spawn(join(app, "Contents", "MacOS", "WhisprFlow"), ["30"], { stdio: "ignore" });
  try {
    const { WHISPRFLOW_APP: _ignored, ...env } = process.env;
    const found = await createUpdater({ env, home: dir }).findApp(child.pid);
    assert.deepEqual(found, { path: app, version: "0.4.0" });
  } finally {
    child.kill();
  }
});

test("replacing the app downloads the dmg for this chip, checks the checksum and signature, replaces the installed one, and leaves nothing half-done", {
  ...macOnly,
  timeout: 60_000,
}, async () => {
  const release = join(dir, "release");
  const applications = mkdtempSync(join(dir, "Applications-"));
  const installed = fakeApp(applications, "0.1.0");
  publishDmg(release, "v0.2.0", fakeApp(mkdtempSync(join(dir, "new-")), "0.2.0"));
  const updater = createUpdater({ env: { ...process.env, WHISPRFLOW_INSTALL_BASE: release }, home: dir });

  await updater.installApp("v0.2.0", installed);
  assert.equal(versionOf(installed), "0.2.0");
  execFileSync("codesign", ["--verify", "--deep", "--strict", installed]);
  assert.deepEqual(readdirSync(applications), ["WhisprFlow.app"]);

  // The dmg's version doesn't match the one to install: not installed
  cpSync(join(release, "download", "v0.2.0"), join(release, "download", "v0.3.0"), { recursive: true });
  await assert.rejects(updater.installApp("v0.3.0", installed), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(en.text(error.problem), /0\.3\.0/);
    return true;
  });
  assert.equal(versionOf(installed), "0.2.0");
  assert.deepEqual(readdirSync(applications), ["WhisprFlow.app"]);
});

test("replacing the app: a checksum mismatch or a missing signature means no install, and the installed one stays as it was", {
  ...macOnly,
  timeout: 60_000,
}, async () => {
  const release = join(dir, "release");
  const applications = mkdtempSync(join(dir, "Applications-"));
  const installed = fakeApp(applications, "0.1.0");
  const updater = createUpdater({ env: { ...process.env, WHISPRFLOW_INSTALL_BASE: release }, home: dir });

  const dmg = publishDmg(release, "v0.2.0", fakeApp(mkdtempSync(join(dir, "new-")), "0.2.0"));
  writeFileSync(`${dmg}.sha256`, `${"0".repeat(64)}  WhisprFlow-${ARCH}.dmg\n`);
  await assert.rejects(updater.installApp("v0.2.0", installed), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(en.text(error.problem), new RegExp(`WhisprFlow-${ARCH}\\.dmg`));
    return true;
  });

  publishDmg(release, "v0.2.1", fakeApp(mkdtempSync(join(dir, "unsigned-")), "0.2.1", { sign: false }));
  await assert.rejects(updater.installApp("v0.2.1", installed), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(en.text(error.problem), /signature/);
    return true;
  });

  assert.equal(versionOf(installed), "0.1.0");
  assert.deepEqual(readdirSync(applications), ["WhisprFlow.app"]);
});

test("whether to start after installing: when not, the installer gets --no-start", macOnly, async () => {
  const release = join(dir, "release");
  const record = join(dir, "args");
  publish(release, "v9.9.9");
  writeFileSync(join(release, "download", "v9.9.9", "install.sh"), `printf '%s' "$*" > ${JSON.stringify(record)}\n`);
  const updater = createUpdater({ env: { ...process.env, WHISPRFLOW_INSTALL_BASE: release }, home: dir });
  assert.equal(await updater.install("v9.9.9", { start: false }), 0);
  assert.equal(readFileSync(record, "utf8"), "--no-start");
  assert.equal(await updater.install("v9.9.9"), 0);
  assert.equal(readFileSync(record, "utf8"), "");
});

test("opening the app doesn't pass the CLI's own ELECTRON_RUN_AS_NODE (the app would run as Node and exit at once)", {
  ...macOnly,
  timeout: 30_000,
}, async () => {
  // The fake app's program is a script that writes the environment it got to a file. Its bundle id is separate, never mixed up with the real WhisprFlow
  const app = join(mkdtempSync(join(dir, "open-")), "WhisprFlowOpenTest.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const record = join(dir, "env");
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.zghanw.whisprflow.open-test</string>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  writeFileSync(
    join(app, "Contents", "MacOS", "run"),
    `#!/bin/sh\nenv > ${JSON.stringify(`${record}.tmp`)}\nmv ${JSON.stringify(`${record}.tmp`)} ${JSON.stringify(record)}\n`,
    {
      mode: 0o755,
    },
  );
  const updater = createUpdater({
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WHISPRFLOW_OPEN_TEST: "passed-through" },
    home: dir,
  });
  await updater.openApp(app);
  for (let waited = 0; !existsSync(record) && waited < 20_000; waited += 200) await delay(200);
  const seen = readFileSync(record, "utf8");
  assert.match(
    seen,
    /^WHISPRFLOW_OPEN_TEST=passed-through$/m,
    "other environment variables pass through (WHISPRFLOW_HOME and the like)",
  );
  assert.doesNotMatch(seen, /^ELECTRON_RUN_AS_NODE=/m);
});

test(
  "Windows: really checks and really runs install.ps1 (read as UTF-8, then run); where, which version, and whether to start all go through environment variables",
  windowsOnly,
  async () => {
    const release = join(dir, "release");
    const record = join(dir, "record");
    const home = join(dir, "home");
    publish(release, "v9.9.9");
    // A fake installer: records the environment variables it got (with a non-ASCII word, so it must be read as UTF-8), and finishes as requested
    writeFileSync(
      join(release, "download", "v9.9.9", "install.ps1"),
      `& { Set-Content -Encoding UTF8 -Path $env:RECORD -Value "install\u00e9|$($env:WHISPRFLOW_HOME)|$($env:WHISPRFLOW_VERSION)|$($env:WHISPRFLOW_NO_START)"; $global:LASTEXITCODE = [int]$env:FAKE_EXIT }\n`,
    );
    const env = { ...process.env, WHISPRFLOW_INSTALL_BASE: release, RECORD: record, FAKE_EXIT: "0" };
    const updater = createUpdater({ env, home });
    assert.equal(await updater.latest(5), "v9.9.9");
    assert.equal(await updater.install("v9.9.9"), 0);
    assert.equal(
      readFileSync(record, "utf8")
        .replace(/^\uFEFF/, "")
        .trim(),
      `install\u00e9|${home}|v9.9.9|`,
    );
    assert.equal(await updater.install("v9.9.9", { start: false }), 0);
    assert.equal(
      readFileSync(record, "utf8")
        .replace(/^\uFEFF/, "")
        .trim(),
      `install\u00e9|${home}|v9.9.9|1`,
    );
    const failing = createUpdater({ env: { ...env, FAKE_EXIT: "1" }, home });
    assert.equal(await failing.install("v9.9.9"), 1);
  },
);
