//go:build !windows

package main

import "errors"

// The installer only runs on Windows; this lets it compile on other systems, so tests can run on a Mac

func openApp(string) error { return errors.New("only on Windows") }

func setTitle(string) {}
