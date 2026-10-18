// The native helper on Windows: listens for the hotkey, pastes text into the current input, and during dictation captures esc and clicks on the floating bar.
// Its protocol with the parent matches the macOS version (native/main.swift) exactly, so the parent (src/app/helper.mjs) doesn't branch on the system:
//
//	stdout  {"event":"ready","listen":true,"trusted":true,"capture":true}
//	          {"event":"hotkey","down":true}
//	          {"event":"other_key"}
//	        {"event":"pasted","id":1,"ok":true}     with ok false the text stays in the clipboard, and reason says why
//	          {"event":"escape"}
//	          {"event":"click","id":"cancel"}
//	stdin   {"cmd":"paste","id":1,"text":"..."}
//	        {"cmd":"capture","regions":[{"id":"cancel","x":0,"y":0,"width":28,"height":28}]}   physical screen pixels
//	          {"cmd":"release"}
//
// It exits when the parent exits (standard input closes). Differences from macOS:
//   - Windows has no "Input Monitoring" or "Accessibility" permissions; listen and trusted report honestly whether the hooks installed;
//   - when the target window runs as administrator and we don't, the system blocks simulated keys (UIPI) without any error:
//     then Ctrl+V isn't pressed; the text stays in the clipboard and ok:false, reason:"elevated" is reported.
//
// This file and keys.go are pure logic that never touch Windows APIs, so go test runs on any system.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

// A screen region: one button on the floating bar. Coordinates are physical screen pixels, matching what the low-level mouse hook reports
type region struct {
	ID     string
	X, Y   float64
	Width  float64
	Height float64
}

// Like macOS CGRect.contains: the left and top edges are inside, the right and bottom edges aren't
func (r region) contains(x, y float64) bool {
	return x >= r.X && x < r.X+r.Width && y >= r.Y && y < r.Y+r.Height
}

type command struct {
	Cmd     string          `json:"cmd"`
	ID      *int            `json:"id"`
	Text    *string         `json:"text"`
	Regions json.RawMessage `json:"regions"`
}

func parseCommand(line []byte) (command, error) {
	var parsed command
	if err := json.Unmarshal(line, &parsed); err != nil || parsed.Cmd == "" {
		return command{}, errors.New("unreadable command line")
	}
	return parsed, nil
}

func parseRegions(raw json.RawMessage) ([]region, error) {
	var items []struct {
		ID     *string  `json:"id"`
		X      *float64 `json:"x"`
		Y      *float64 `json:"y"`
		Width  *float64 `json:"width"`
		Height *float64 `json:"height"`
	}
	bad := errors.New("capture needs regions: a list of { id, x, y, width, height }")
	if len(raw) == 0 || json.Unmarshal(raw, &items) != nil || items == nil {
		return nil, bad
	}
	regions := make([]region, 0, len(items))
	for _, item := range items {
		if item.ID == nil || item.X == nil || item.Y == nil || item.Width == nil || item.Height == nil {
			return nil, bad
		}
		if *item.Width <= 0 || *item.Height <= 0 {
			return nil, bad
		}
		regions = append(regions, region{ID: *item.ID, X: *item.X, Y: *item.Y, Width: *item.Width, Height: *item.Height})
	}
	return regions, nil
}

// One line of event for the parent
type event map[string]any

func encodeEvent(e event) []byte {
	line, err := json.Marshal(e)
	if err != nil {
		// Only the few fields we build ourselves, so this is never reached; if it ever is, say so rather than silently dropping it
		line, _ = json.Marshal(event{"event": "error", "message": fmt.Sprintf("serialization failed: %v", err)})
	}
	return append(line, '\n')
}
