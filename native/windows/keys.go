package main

// Deciding about keys and clicks (pure logic): the low-level hooks hand each event here, and this says whether to swallow it and what to report to the parent.
// The rules match the macOS version:
//   - The hotkey is a single modifier key, reported once on press and once on release; another key pressed while it is held reports other_key once (a combination, not dictation).
//     Apart from the hotkey's press and release, only "another key" is reported, never which key.
//   - Normally nothing is swallowed. During dictation (after the parent says "start capturing" and before "stop"), esc and left clicks in the floating bar's regions are swallowed:
//     a click landing on our window would steal focus, and esc passed to the foreground app would close its dialog.
//   - A press still held must be swallowed whole: swallowing the press but letting the release through would hand the foreground app half an event.

// Virtual key codes (WinUser.h)
const (
	vkEscape   = 0x1B
	vkLControl = 0xA2
	vkRControl = 0xA3
	vkRMenu    = 0xA5 // right Alt
	// A key code assigned to no key. Pressing and releasing right Alt makes many apps move focus to the menu bar (Office also shows key tips);
	// injecting this key when the hotkey goes down makes the system see "Alt plus another key", so releasing doesn't open the menu. AutoHotkey uses the same trick
	vkMask = 0xE8
)

// On keyboard layouts with AltGr (German and others), pressing right Alt makes the system inject a fake left Ctrl first, with this scan code. It isn't another key the user pressed
const altGrFakeCtrlScan = 0x21D

// The hotkeys to choose from: setting name to virtual key code. The macOS ones (right Option, right Command, fn) have no counterpart on Windows:
// releasing right Win opens the Start menu, and the system never sees fn
var hotkeys = map[string]uint32{
	"right_alt":  vkRMenu,
	"right_ctrl": vkRControl,
}

// One keyboard event
type keyInput struct {
	vk   uint32
	scan uint32
	down bool
	// Ones we simulate ourselves (the injected vkMask, Ctrl+V when pasting): not user key presses, passed through as is
	ours bool
}

type outcome struct {
	swallow bool
	events  []event
	// Whether to inject vkMask (see above). Can't inject inside the hook: done back in the message loop
	mask bool
}

type keyState struct {
	hotkey        uint32
	hotkeyDown    bool
	reportedOther bool

	capturing bool
	regions   []region
	// Presses already swallowed and awaiting release: esc, and the mouse (remembering which region it went down in, "" for none)
	escapeDown bool
	pressed    string
}

// Whether this listener should swallow anything now: capturing, or a swallowed press not yet released
func (s *keyState) wantsCapture() bool { return s.capturing || s.escapeDown || s.pressed != "" }

func (s *keyState) setCapturing(on bool, regions []region) {
	s.capturing = on
	if on {
		s.regions = regions
	} else {
		s.regions = nil
	}
}

func (s *keyState) regionAt(x, y float64) string {
	for _, r := range s.regions {
		if r.contains(x, y) {
			return r.ID
		}
	}
	return ""
}

func (s *keyState) onKey(in keyInput) outcome {
	if in.ours {
		return outcome{}
	}
	// Check capture first: a captured esc no longer counts as "hotkey plus another key" (on macOS there are two listeners, the capturing one first)
	if in.vk == vkEscape {
		if out, handled := s.onEscape(in.down); handled {
			return out
		}
	}
	if in.vk == s.hotkey {
		if in.down == s.hotkeyDown {
			// Held keys make the system repeat the press event (auto-repeat); that isn't a new press
			return outcome{}
		}
		s.hotkeyDown = in.down
		s.reportedOther = false
		return outcome{events: []event{{"event": "hotkey", "down": in.down}}, mask: in.down && s.hotkey == vkRMenu}
	}
	if in.vk == vkLControl && in.scan == altGrFakeCtrlScan {
		return outcome{}
	}
	if in.down && s.hotkeyDown && !s.reportedOther {
		s.reportedOther = true
		return outcome{events: []event{{"event": "other_key"}}}
	}
	return outcome{}
}

// esc: swallowed and reported once while capturing; after capturing stops but the cancelling press isn't released yet, its repeats and release are swallowed too
func (s *keyState) onEscape(down bool) (outcome, bool) {
	if down {
		if s.capturing {
			if s.escapeDown {
				return outcome{swallow: true}, true
			}
			s.escapeDown = true
			return outcome{swallow: true, events: []event{{"event": "escape"}}}, true
		}
		if s.escapeDown {
			return outcome{swallow: true}, true
		}
		return outcome{}, false
	}
	if s.escapeDown {
		s.escapeDown = false
		return outcome{swallow: true}, true
	}
	return outcome{}, false
}

// The left mouse button. As with ordinary buttons, a click counts only when press and release land in the same region: dragging out before releasing takes it back.
// Moves aren't swallowed: swallowing moves on Windows freezes the cursor; the press is already swallowed, so other apps only see a move with no button down
func (s *keyState) onLeftButton(down bool, x, y float64) outcome {
	if down {
		if !s.capturing {
			return outcome{}
		}
		id := s.regionAt(x, y)
		if id == "" {
			return outcome{}
		}
		s.pressed = id
		return outcome{swallow: true}
	}
	if s.pressed == "" {
		return outcome{}
	}
	pressed := s.pressed
	s.pressed = ""
	if s.capturing && s.regionAt(x, y) == pressed {
		return outcome{swallow: true, events: []event{{"event": "click", "id": pressed}}}
	}
	return outcome{swallow: true}
}
