package main

import (
	"reflect"
	"testing"
)

func newState(hotkey string) *keyState { return &keyState{hotkey: hotkeys[hotkey]} }

func key(vk uint32, down bool) keyInput { return keyInput{vk: vk, down: down} }

func eventsOf(outs ...outcome) []event {
	var all []event
	for _, out := range outs {
		all = append(all, out.events...)
	}
	return all
}

func TestHotkeyDownUpReportedOnceEachDespiteAutoRepeat(t *testing.T) {
	s := newState("right_ctrl")
	got := eventsOf(s.onKey(key(vkRControl, true)), s.onKey(key(vkRControl, true)), s.onKey(key(vkRControl, false)))
	want := []event{{"event": "hotkey", "down": true}, {"event": "hotkey", "down": false}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestOtherKeyWhileHeldReportedOnceWithoutNamingTheKey(t *testing.T) {
	s := newState("right_ctrl")
	s.onKey(key(vkRControl, true))
	got := eventsOf(s.onKey(key('A', true)), s.onKey(key('A', false)), s.onKey(key('B', true)))
	if want := []event{{"event": "other_key"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// The next hold starts fresh
	s.onKey(key(vkRControl, false))
	s.onKey(key(vkRControl, true))
	if got := eventsOf(s.onKey(key('C', true))); len(got) != 1 {
		t.Fatalf("a new hold didn't report other_key: %v", got)
	}
}

func TestKeysWithoutHotkeyHeldAreNotReportedOrSwallowed(t *testing.T) {
	s := newState("right_alt")
	for _, in := range []keyInput{key('A', true), key('A', false), key(vkEscape, true), key(vkEscape, false)} {
		if out := s.onKey(in); out.swallow || len(out.events) != 0 {
			t.Fatalf("%v: %+v", in, out)
		}
	}
}

func TestRightAltAsksForMaskKeySoMenusDoNotOpen(t *testing.T) {
	s := newState("right_alt")
	if out := s.onKey(key(vkRMenu, true)); !out.mask {
		t.Fatal("pressing right Alt didn't ask to inject vkMask")
	}
	if out := s.onKey(key(vkRMenu, false)); out.mask {
		t.Fatal("releasing needs no injection")
	}
	c := newState("right_ctrl")
	if out := c.onKey(key(vkRControl, true)); out.mask {
		t.Fatal("right Ctrl alone has no side effect and needs no injection")
	}
}

func TestOurOwnInjectedKeysAndAltGrFakeCtrlAreNotOtherKeys(t *testing.T) {
	s := newState("right_alt")
	s.onKey(key(vkRMenu, true))
	got := eventsOf(
		s.onKey(keyInput{vk: vkMask, down: true, ours: true}),
		s.onKey(keyInput{vk: vkMask, down: false, ours: true}),
		// Holding right Alt on an AltGr layout, the system auto-repeats the fake left Ctrl along with it
		s.onKey(keyInput{vk: vkLControl, scan: altGrFakeCtrlScan, down: true}),
	)
	if len(got) != 0 {
		t.Fatalf("got %v", got)
	}
	// A real left Ctrl is another key
	if got := eventsOf(s.onKey(keyInput{vk: vkLControl, scan: 0x1D, down: true})); len(got) != 1 {
		t.Fatalf("a real left Ctrl didn't count as another key: %v", got)
	}
}

func TestEscapeSwallowedOnlyWhileCapturingAndHeldPressIsSwallowedToTheEnd(t *testing.T) {
	s := newState("right_alt")
	s.setCapturing(true, nil)
	down := s.onKey(key(vkEscape, true))
	if !down.swallow || !reflect.DeepEqual(down.events, []event{{"event": "escape"}}) {
		t.Fatalf("esc while capturing: %+v", down)
	}
	// Repeats from holding aren't reported again
	if out := s.onKey(key(vkEscape, true)); !out.swallow || len(out.events) != 0 {
		t.Fatalf("repeat: %+v", out)
	}
	// Cancelled: the parent says stop capturing, but the key is still held
	s.setCapturing(false, nil)
	if out := s.onKey(key(vkEscape, true)); !out.swallow {
		t.Fatal("repeats after capturing stops and before release must be swallowed")
	}
	if out := s.onKey(key(vkEscape, false)); !out.swallow {
		t.Fatal("the release must be swallowed, or the foreground app gets half an event")
	}
	// Later esc presses are none of our business
	if out := s.onKey(key(vkEscape, true)); out.swallow {
		t.Fatal("a new esc press while not capturing was swallowed")
	}
}

func TestEscapeWhileHotkeyHeldAndCapturingIsNotAnOtherKey(t *testing.T) {
	s := newState("right_alt")
	s.onKey(key(vkRMenu, true))
	s.setCapturing(true, nil)
	got := eventsOf(s.onKey(key(vkEscape, true)))
	if want := []event{{"event": "escape"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestClickCountsOnlyWhenPressedAndReleasedInTheSameRegion(t *testing.T) {
	s := newState("right_alt")
	s.setCapturing(true, []region{{ID: "cancel", X: 100, Y: 100, Width: 28, Height: 28}, {ID: "done", X: 140, Y: 100, Width: 28, Height: 28}})
	if out := s.onLeftButton(true, 110, 110); !out.swallow {
		t.Fatal("a press on a button must be swallowed")
	}
	if out := s.onLeftButton(false, 111, 111); !out.swallow || !reflect.DeepEqual(out.events, []event{{"event": "click", "id": "cancel"}}) {
		t.Fatalf("release: %+v", out)
	}
	// Pressing, then dragging to another region before releasing: taken back, not reported, but the release is still swallowed
	s.onLeftButton(true, 110, 110)
	if out := s.onLeftButton(false, 150, 110); !out.swallow || len(out.events) != 0 {
		t.Fatalf("dragged away: %+v", out)
	}
	// The right and bottom edges aren't inside
	if out := s.onLeftButton(true, 128, 110); out.swallow {
		t.Fatal("the right edge counted as inside")
	}
	// Clicks outside every region pass through as is
	if out := s.onLeftButton(true, 10, 10); out.swallow {
		t.Fatal("a click outside the regions was swallowed")
	}
}

func TestClickReleasedAfterCaptureEndedIsSwallowedButNotReported(t *testing.T) {
	s := newState("right_alt")
	s.setCapturing(true, []region{{ID: "done", X: 0, Y: 0, Width: 10, Height: 10}})
	s.onLeftButton(true, 5, 5)
	s.setCapturing(false, nil)
	if !s.wantsCapture() {
		t.Fatal("a press is swallowed and not yet released, so the mouse hook must stay")
	}
	if out := s.onLeftButton(false, 5, 5); !out.swallow || len(out.events) != 0 {
		t.Fatalf("got %+v", out)
	}
	if s.wantsCapture() {
		t.Fatal("after release it shouldn't capture any more")
	}
	if out := s.onLeftButton(true, 5, 5); out.swallow {
		t.Fatal("a click while not capturing was swallowed")
	}
}
