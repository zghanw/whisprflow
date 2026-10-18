//go:build !windows

package main

import (
	"fmt"
	"os"
)

// This helper is for Windows only (the macOS one is native/main.swift). This file only lets the pure logic run go test on other systems
func main() {
	fmt.Fprintln(os.Stderr, "key-helper only runs on Windows")
	os.Exit(1)
}
