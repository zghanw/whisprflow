package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParsesTheThreeCommands(t *testing.T) {
	paste, err := parseCommand([]byte(`{"cmd":"paste","id":3,"text":"café\nnaïve"}`))
	if err != nil || paste.Cmd != "paste" || *paste.ID != 3 || *paste.Text != "café\nnaïve" {
		t.Fatalf("paste: %+v %v", paste, err)
	}
	capture, err := parseCommand([]byte(`{"cmd":"capture","regions":[{"id":"cancel","x":1.5,"y":2,"width":28,"height":28}]}`))
	if err != nil {
		t.Fatal(err)
	}
	regions, err := parseRegions(capture.Regions)
	if err != nil || len(regions) != 1 || regions[0] != (region{ID: "cancel", X: 1.5, Y: 2, Width: 28, Height: 28}) {
		t.Fatalf("regions: %+v %v", regions, err)
	}
	release, err := parseCommand([]byte(`{"cmd":"release"}`))
	if err != nil || release.Cmd != "release" {
		t.Fatalf("release: %+v %v", release, err)
	}
}

func TestRejectsLinesItCannotRead(t *testing.T) {
	for _, line := range []string{"", "not json", `{"id":1}`, `[]`} {
		if _, err := parseCommand([]byte(line)); err == nil {
			t.Fatalf("%q wasn't rejected", line)
		}
	}
}

func TestRejectsRegionsWithMissingFieldsOrNoArea(t *testing.T) {
	for _, raw := range []string{
		``,
		`null`,
		`{}`,
		`[{"x":0,"y":0,"width":1,"height":1}]`,
		`[{"id":"a","y":0,"width":1,"height":1}]`,
		`[{"id":"a","x":0,"y":0,"width":0,"height":1}]`,
		`[{"id":"a","x":0,"y":0,"width":1,"height":-1}]`,
	} {
		if _, err := parseRegions(json.RawMessage(raw)); err == nil {
			t.Fatalf("%q wasn't rejected", raw)
		}
	}
	// An empty list is valid: capture esc but no clicks (when the floating bar has no buttons drawn)
	if regions, err := parseRegions(json.RawMessage(`[]`)); err != nil || len(regions) != 0 {
		t.Fatalf("empty list: %v %v", regions, err)
	}
}

func TestEventsAreOneLineOfJson(t *testing.T) {
	line := string(encodeEvent(event{"event": "pasted", "id": 1, "ok": false, "reason": "elevated"}))
	if !strings.HasSuffix(line, "\n") || strings.Count(line, "\n") != 1 {
		t.Fatalf("not one line: %q", line)
	}
	var back map[string]any
	if err := json.Unmarshal([]byte(line), &back); err != nil || back["reason"] != "elevated" || back["id"] != float64(1) {
		t.Fatalf("%q → %v %v", line, back, err)
	}
}

func TestAppNameIsTheExecutableWithoutFolderOrExe(t *testing.T) {
	for path, want := range map[string]string{
		`C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE`: "OUTLOOK",
		`C:\Users\me\AppData\Local\slack\app-4.41.0\slack.exe`:        "slack",
		`/Applications/Mail.app/Contents/MacOS/Mail`:                  "Mail",
		`notepad`: "notepad",
	} {
		if got := appName(path); got != want {
			t.Fatalf("appName(%q) = %q, want %q", path, got, want)
		}
	}
}
