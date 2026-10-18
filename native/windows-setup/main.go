// The WhisprFlow installer for Windows (WhisprFlow-Setup-x64.exe): double-click to install, then it opens the app into onboarding.
//
// It carries this version's program package and install.ps1 (see payload.go), unpacks them to a temporary directory, and runs install.ps1 with that as the download address:
// install.ps1 is the only way to install, identical to the irm | iex line in PowerShell, and no network is needed while installing.
// A console program: install progress is the lines install.ps1 prints. On error it waits for Enter, so the window doesn't vanish before the reason can be read.
// Standard library only; the icon, version info, and manifest (asInvoker: no administrator rights, or Windows would demand elevation for a name containing Setup)
// are generated with go-winres by scripts/build/windows-setup.mjs at build time.
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Runs install.ps1 the same way as src/cli/updater.mjs: read as UTF-8 and run as a script block
// (with -File, Windows PowerShell 5.1 would read a script without a BOM in the system code page)
const runInstall = "& ([scriptblock]::Create([IO.File]::ReadAllText($env:WHISPRFLOW_INSTALL_SCRIPT, [Text.Encoding]::UTF8))); exit $LASTEXITCODE"

func main() {
	setTitle("WhisprFlow Setup")
	code := install()
	if code != 0 {
		fmt.Print("\n  Press Enter to close this window.")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
	os.Exit(code)
}

func install() int {
	dir, err := unpack()
	if dir != "" {
		defer os.RemoveAll(dir)
	}
	if err != nil {
		fmt.Printf("\n  x %v\n", err)
		return 1
	}
	version, err := os.ReadFile(filepath.Join(dir, "latest"))
	if err != nil {
		fmt.Printf("\n  x This setup file is damaged (%v); download it again.\n", err)
		return 1
	}
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", runInstall)
	cmd.Env = append(os.Environ(),
		"WHISPRFLOW_INSTALL_SCRIPT="+filepath.Join(dir, "install.ps1"),
		"WHISPRFLOW_INSTALL_BASE="+dir,
		"WHISPRFLOW_VERSION="+strings.TrimSpace(string(version)),
		// The app is opened from here after installing; install.ps1 itself would start the CLI copy, which asks for keys in the terminal
		"WHISPRFLOW_NO_START=1",
	)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		fmt.Printf("\n  x Couldn't run Windows PowerShell: %v\n", err)
		return 1
	}

	home := os.Getenv("WHISPRFLOW_HOME")
	if home == "" {
		home = filepath.Join(os.Getenv("USERPROFILE"), ".whisprflow")
	}
	if err := openApp(home); err != nil {
		fmt.Printf("  Couldn't open WhisprFlow (%v). Open it from the Start menu.\n", err)
		return 0
	}
	fmt.Println("  Opening WhisprFlow…")
	// Stay a moment so people see it installed, then close the window
	time.Sleep(3 * time.Second)
	return 0
}

// unpack extracts what it carries to a new temporary directory and returns that directory (on error too, so the caller can delete it)
func unpack() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	f, err := os.Open(self)
	if err != nil {
		return "", err
	}
	defer f.Close()
	payload, err := openPayload(f)
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "whisprflow-setup-")
	if err != nil {
		return "", err
	}
	return dir, extract(payload, dir)
}
