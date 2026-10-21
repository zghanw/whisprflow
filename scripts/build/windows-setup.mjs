// Builds WhisprFlow-Setup-x64.exe, the Windows installer for direct download: the program built from native/windows-setup, followed by
// a stored (uncompressed) zip (install.ps1, plus this version's program package with its checksum and latest, laid out like the download address:
// download/<version>/ and latest/download/latest), with the last 16 bytes a marker and the zip's length. The format matches what native/windows-setup/payload.go reads.
// Double-clicked, it unpacks the zip to a temporary directory and runs install.ps1 with that as the download address: install.ps1 stays the only way to install.
// Called by the release build after the Windows package is made.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { goCommand } from "../../src/cli/native-helper.mjs";
import { tarCommand } from "../../src/models/runtime.mjs";

export const SETUP_MAGIC = "SMSETUP1";
/**
 * The tool that adds the icon, version info, and manifest to the exe, used only at build time. Its version is pinned, and downloads are verified by Go's checksum database.
 * The manifest declares no administrator rights (asInvoker): Windows demands elevation for an exe named with Setup that has no manifest
 */
const GO_WINRES = "github.com/tc-hib/go-winres@v0.3.3";

/** The trailer: an 8-byte marker plus the zip's length (8 bytes, little-endian) */
export function setupTrailer(payloadBytes) {
  const trailer = Buffer.alloc(16);
  trailer.write(SETUP_MAGIC, 0, "ascii");
  trailer.writeBigUInt64LE(BigInt(payloadBytes), 8);
  return trailer;
}

/** An exe's file version only takes four numbers: 0.9.0-rc.1 is recorded as 0.9.0.0 (the full version goes in the product version) */
export const fileVersion = (version) => `${/^\d+\.\d+\.\d+/.exec(version)[0]}.0`;

/**
 * @param {object} options
 * @param {string} options.packageDir the repository root
 * @param {string} options.version the version (from package.json, without v)
 * @param {string} options.versionDir this version's directory name at the download address
 * @param {string} options.archive the packaged Windows program (its .sha256 must sit next to it)
 * @param {string} options.out where to write the installer
 */
export function buildWindowsSetup({ packageDir, version, versionDir, archive, out, run = execFileSync }) {
  const source = join(packageDir, "native", "windows-setup");
  const go = goCommand(packageDir, process.platform);
  const work = mkdtempSync(join(tmpdir(), "whisprflow-setup-"));
  try {
    const program = join(work, "setup.exe");
    try {
      // go build only sees generated resource files in the source directory; they are deleted after building
      run(
        go,
        [
          "run",
          GO_WINRES,
          "simply",
          "--arch",
          "amd64",
          "--out",
          join(source, "rsrc"),
          "--manifest",
          "cli",
          "--icon",
          join(packageDir, "assets", "icon.ico"),
          "--product-name",
          "WhisprFlow",
          "--product-version",
          version,
          "--file-version",
          fileVersion(version),
          "--file-description",
          "WhisprFlow Setup",
          "--original-filename",
          basename(out),
          "--copyright",
          "MIT License",
        ],
        { cwd: source, stdio: "inherit" },
      );
      // A console program: install progress needs to show
      run(go, ["build", "-trimpath", "-ldflags", "-s -w", "-o", program, "."], {
        cwd: source,
        stdio: "inherit",
        env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
      });
    } finally {
      rmSync(join(source, "rsrc_windows_amd64.syso"), { force: true });
    }

    const stage = join(work, "payload");
    const files = join(stage, "download", versionDir);
    mkdirSync(files, { recursive: true });
    mkdirSync(join(stage, "latest", "download"), { recursive: true });
    copyFileSync(archive, join(files, basename(archive)));
    copyFileSync(`${archive}.sha256`, join(files, `${basename(archive)}.sha256`));
    copyFileSync(join(packageDir, "install.ps1"), join(stage, "install.ps1"));
    writeFileSync(join(stage, "latest", "download", "latest"), `${versionDir}\n`);
    const payload = join(work, "payload.zip");
    // Stored, not compressed: the program package is already compressed, and compressing again only wastes time
    run(tarCommand(), ["--format", "zip", "--options", "zip:compression=store", "-cf", payload, "."], { cwd: stage });

    copyFileSync(program, out);
    appendFileSync(out, readFileSync(payload));
    appendFileSync(out, setupTrailer(statSync(payload).size));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
