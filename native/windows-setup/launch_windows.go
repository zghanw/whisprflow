package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// openApp opens the installed app the way the Start menu shortcut does: the installed Electron runs the app directory, with the home directory as working directory.
// It doesn't wait: the app stays open after the installer closes
func openApp(home string) error {
	cmd := exec.Command(filepath.Join(home, "runtime", "electron.exe"), filepath.Join(home, "app"))
	cmd.Dir = home
	cmd.Env = appEnv(os.Environ())
	// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: not attached to the installer's console
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// appEnv drops the environment variables meant only for installing, so the app sees what it would when opened from the Start menu
func appEnv(env []string) []string {
	kept := env[:0:0]
	for _, entry := range env {
		name := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if strings.HasPrefix(name, "WHISPRFLOW_INSTALL_") || name == "WHISPRFLOW_VERSION" || name == "WHISPRFLOW_NO_START" || name == "ELECTRON_RUN_AS_NODE" {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

func setTitle(title string) {
	text, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	// Only the window title; failing to set it doesn't affect the install
	syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(text)))
}
