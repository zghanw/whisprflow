import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { downloadMeter, EXCLUDE_NEWER, installRuntime, runtimePaths, UV_BUILDS } from "../../src/models/runtime.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MODEL = {
  name: "Phonon-2",
  files: { archive: { path: "phonon-2.bps.tar.zst" }, uv: UV_BUILDS["windows-x64"] },
};

/** A fake run: tar puts a uv.exe where it extracts, uv venv and pip print download lines like the real ones, everything is recorded */
function fakeRun() {
  const ran = [];
  const run = async (command, args, { env, onLine = () => {} } = {}) => {
    ran.push({ command, args, env });
    if (args[0] === "-xf") {
      mkdirSync(args[3], { recursive: true });
      writeFileSync(join(args[3], "uv.exe"), "");
    }
    if (args[0] === "venv") {
      mkdirSync(env.UV_CACHE_DIR, { recursive: true });
      onLine("Downloading cpython-3.12.15-windows-x86_64-none (download) (21.0MiB)");
      onLine(" Downloaded cpython-3.12.15-windows-x86_64-none (download)");
    }
    if (args[0] === "pip") {
      onLine("Downloading torch (118.4MiB)");
      onLine("Downloading numpy (12.0MiB)");
      onLine(" Downloaded numpy");
      onLine(" Downloaded torch");
    }
  };
  return { ran, run };
}

test("uv's download lines count finished downloads by the size each announced; other lines count nothing", () => {
  const meter = downloadMeter();
  for (const line of [
    "Resolved 41 packages in 1.24s",
    "Downloading torch (118.4MiB)",
    "Downloading hf-xet (3.6MiB)",
    " Downloaded hf-xet",
    "Downloading tiny (512.0KiB)",
    " Downloaded tiny",
  ])
    meter.line(line);
  assert.equal(meter.bytes, 3.6 * 1024 ** 2 + 512 * 1024);
  meter.line(" Downloaded torch");
  assert.equal(meter.bytes, (118.4 + 3.6) * 1024 ** 2 + 512 * 1024);
});

test("installing the runtime: extracts uv, makes a pinned CPython environment, installs the pinned package frozen to a date, unpacks the model, and leaves no cache behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-runtime-"));
  dirs.push(dir);
  // A half-finished earlier try is cleared first
  writeFileSync(join(dir, "phonon-2.bps.tar.zst"), "archive");
  writeFileSync(join(dir, "uv-x86_64-pc-windows-msvc.zip"), "uv");
  mkdirSync(join(dir, "runtime", "venv"), { recursive: true });
  writeFileSync(join(dir, "runtime", "venv", "stale"), "");
  const { ran, run } = fakeRun();
  const progress = [];
  await installRuntime({
    model: MODEL,
    dir,
    chip: "windows-x64",
    run,
    platform: "win32",
    onProgress: (fraction) => progress.push(fraction),
  });

  const { root, python, profile } = runtimePaths(dir, "win32");
  const uv = join(root, "uv", "uv.exe");
  assert.match(ran[0].command, /System32[\\/]tar\.exe$/);
  assert.deepEqual(ran[0].args, ["-xf", join(dir, "uv-x86_64-pc-windows-msvc.zip"), "-C", join(root, "uv")]);
  assert.equal(ran[1].command, uv);
  assert.deepEqual(ran[1].args, [
    "venv",
    join(root, "venv"),
    "--python",
    "3.12.15",
    "--python-preference",
    "only-managed",
    "--no-config",
  ]);
  assert.equal(ran[1].env.UV_PYTHON_INSTALL_DIR, join(root, "python"));
  assert.equal(ran[1].env.UV_CACHE_DIR, join(root, "cache"));
  assert.deepEqual(ran[2].args, [
    "pip",
    "install",
    "--python",
    join(root, "venv"),
    "--exclude-newer",
    EXCLUDE_NEWER,
    "--no-config",
    "fermion-research==0.2.11",
  ]);
  assert.equal(ran[3].command, python);
  assert.equal(ran[3].args[0], "-I");
  assert.deepEqual(ran[3].args.slice(3), [join(dir, "phonon-2.bps.tar.zst"), profile]);

  assert.equal(existsSync(join(root, "venv", "stale")), false);
  assert.equal(existsSync(join(root, "cache")), false);
  assert.equal(existsSync(join(root, "uv")), false);
  // The downloads are gone once used
  assert.equal(existsSync(join(dir, "phonon-2.bps.tar.zst")), false);
  assert.equal(existsSync(join(dir, "uv-x86_64-pc-windows-msvc.zip")), false);
  assert.deepEqual(
    progress,
    [...progress].sort((a, b) => a - b),
    "progress only moves forward",
  );
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.some((fraction) => fraction > 0 && fraction < 0.9));
});

test("Apple silicon installs the MLX extra; a chip the runtime doesn't run on is refused before anything happens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisprflow-runtime-"));
  dirs.push(dir);
  const { ran, run } = fakeRun();
  const mac = { ...MODEL, files: { ...MODEL.files, uv: UV_BUILDS["apple-silicon"] } };
  // The fake tar writes uv.exe; the macOS layout is a folder named after the build
  const macRun = async (command, args, options) => {
    await run(command, args, options);
    if (args[0] === "-xf") {
      mkdirSync(join(args[3], "uv-aarch64-apple-darwin"), { recursive: true });
      rmSync(join(args[3], "uv.exe"));
      writeFileSync(join(args[3], "uv-aarch64-apple-darwin", "uv"), "");
    }
  };
  await installRuntime({ model: mac, dir, chip: "apple-silicon", run: macRun, platform: "darwin" });
  assert.equal(ran[0].command, "tar");
  assert.equal(ran[1].command, join(dir, "runtime", "uv", "uv-aarch64-apple-darwin", "uv"));
  assert.equal(ran[2].args.at(-1), "fermion-research[mlx]==0.2.11");
  assert.equal(ran[3].command, join(dir, "runtime", "venv", "bin", "python"));

  await assert.rejects(
    installRuntime({ model: MODEL, dir, chip: "intel-mac", run: fakeRun().run }),
    /Windows \(x64\) and Apple silicon only/,
  );
});
