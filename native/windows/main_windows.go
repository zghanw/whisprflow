package main

// Entry point and threads: low-level hook callbacks are called by the thread that installed them while it fetches messages, and the clipboard needs a window as owner, so all of this
// runs a message loop on one locked OS thread. Reading standard input and writing standard output are one goroutine each: work for the hook thread
// is passed over through tasks, then a posted message wakes it; hook callbacks never do anything that waits (the system silently removes hooks it finds slow).

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

// How long to wait after simulating paste before restoring the clipboard: too short and the target app hasn't read it yet (like the macOS version)
const restoreDelay = 300 * time.Millisecond

// A recording lasts at most 9 minutes. If the parent still hasn't said "stop capturing" after that long, something went wrong on its side: release by ourselves,
// so esc never stays unusable in every app
const captureLimit = 600 * time.Second

const wmTask = wmApp + 1

var (
	out   = make(chan []byte, 256)
	tasks = make(chan func(), 64)

	state     keyState
	board     *clipboard
	window    uintptr
	mouseHook uintptr
	// The capture deadline: each capture gets a new number, and an expired one doesn't count
	captureGeneration int
)

func emit(e event) { out <- encodeEvent(e) }

// Hands work to the hook thread
func onUIThread(task func()) {
	tasks <- task
	procPostMessageW.Call(window, wmTask, 0, 0)
}

func keyboardProc(code int32, wParam, lParam uintptr) uintptr {
	if code >= 0 {
		info := (*kbdLLHookStruct)(unsafe.Pointer(lParam))
		down := wParam == wmKeyDown || wParam == wmSysKeyDown
		if down || wParam == wmKeyUp || wParam == wmSysKeyUp {
			result := state.onKey(keyInput{vk: info.vkCode, scan: info.scanCode, down: down, ours: info.extraInfo == ourMark})
			report(result)
			if result.swallow {
				return 1
			}
		}
	}
	next, _, _ := procCallNextHookEx.Call(0, uintptr(code), wParam, lParam)
	return next
}

func mouseProc(code int32, wParam, lParam uintptr) uintptr {
	if code >= 0 && (wParam == wmLButtonDown || wParam == wmLButtonUp) {
		info := (*msLLHookStruct)(unsafe.Pointer(lParam))
		if info.extraInfo != ourMark {
			result := state.onLeftButton(wParam == wmLButtonDown, float64(info.x), float64(info.y))
			report(result)
			if !state.wantsCapture() {
				// A hook can't remove itself inside its own callback: done back in the message loop
				onUIThread(settleMouseHook)
			}
			if result.swallow {
				return 1
			}
		}
	}
	next, _, _ := procCallNextHookEx.Call(0, uintptr(code), wParam, lParam)
	return next
}

func report(result outcome) {
	for _, e := range result.events {
		// The app the text will go into: cleanup adjusts its tone to it
		if e["event"] == "hotkey" && e["down"] == true {
			if app := foregroundApp(); app != "" {
				e["app"] = app
			}
		}
		emit(e)
	}
	if result.mask {
		onUIThread(func() { sendKeys([]uint16{vkMask, vkMask}, []bool{true, false}) })
	}
}

// Callbacks handed to the system. Built in init: the mouse callback installs and removes itself, so as a package variable's initial value it would be a cycle
var keyboardCallback, mouseCallback, windowCallback uintptr

func init() {
	keyboardCallback = syscall.NewCallback(func(code, wParam, lParam uintptr) uintptr {
		return keyboardProc(int32(code), wParam, lParam)
	})
	mouseCallback = syscall.NewCallback(func(code, wParam, lParam uintptr) uintptr {
		return mouseProc(int32(code), wParam, lParam)
	})
	windowCallback = syscall.NewCallback(windowProc)
}

func installHook(kind int, callback uintptr) uintptr {
	module, _, _ := procGetModuleHandleW.Call(0)
	hook, _, _ := procSetWindowsHookExW.Call(uintptr(kind), callback, module, 0)
	return hook
}

// The mouse hook is only installed while capturing: while installed, every mouse event on the whole system passes through us first
func settleMouseHook() {
	if state.wantsCapture() && mouseHook == 0 {
		mouseHook = installHook(whMouseLL, mouseCallback)
		if mouseHook == 0 {
			emit(event{"event": "error", "message": "couldn't install the mouse hook, so the floating bar's buttons can't be clicked"})
		}
	} else if !state.wantsCapture() && mouseHook != 0 {
		procUnhookWindowsHookEx.Call(mouseHook)
		mouseHook = 0
	}
}

func setCapturing(on bool, regions []region) {
	captureGeneration++
	state.setCapturing(on, regions)
	settleMouseHook()
	if !on {
		return
	}
	generation := captureGeneration
	time.AfterFunc(captureLimit, func() {
		onUIThread(func() {
			if generation != captureGeneration || !state.capturing {
				return
			}
			emit(event{"event": "error", "message": fmt.Sprintf("still capturing after %d seconds with no word to stop, releasing", int(captureLimit.Seconds()))})
			setCapturing(false, nil)
		})
	})
}

// Save the clipboard, write the text, simulate Ctrl+V, wait a moment, restore the clipboard. Pasting is the only route, like the macOS version
func paste(id int, text string) {
	if foregroundBlocksInput() {
		// The system blocks simulated keys into administrator windows without any error. Leave the text in the clipboard for the user to press Ctrl+V
		if err := board.writeText(text, false); err != nil {
			emit(event{"event": "error", "message": err.Error()})
		}
		emit(event{"event": "pasted", "id": id, "ok": false, "reason": "elevated"})
		return
	}
	saved, err := board.snapshot()
	restorable := err == nil
	if !restorable {
		// If the original content can't be saved it can't be restored: this text isn't marked transient, so it stays in the clipboard and clipboard history (Win+V),
		// where the user's original copy can still be found too
		emit(event{"event": "error", "message": "couldn't save the clipboard, so it won't be restored after pasting: " + err.Error()})
	}
	if err := board.writeText(text, restorable); err != nil {
		emit(event{"event": "error", "message": err.Error()})
		emit(event{"event": "pasted", "id": id, "ok": false, "reason": "clipboard"})
		return
	}
	if !sendKeys([]uint16{vkControl, vkV, vkV, vkControl}, []bool{true, true, false, false}) {
		// The text is already in the clipboard: don't restore, let the user paste
		emit(event{"event": "pasted", "id": id, "ok": false, "reason": "send_input"})
		return
	}
	time.AfterFunc(restoreDelay, func() {
		onUIThread(func() {
			if restorable {
				if err := board.restore(saved); err != nil {
					emit(event{"event": "error", "message": "couldn't restore the clipboard: " + err.Error()})
				}
			}
			emit(event{"event": "pasted", "id": id, "ok": true})
		})
	})
}

func handle(line []byte) {
	cmd, err := parseCommand(line)
	if err != nil {
		emit(event{"event": "error", "message": err.Error()})
		return
	}
	switch cmd.Cmd {
	case "paste":
		if cmd.ID == nil || cmd.Text == nil {
			emit(event{"event": "error", "message": "paste needs id and text"})
			return
		}
		id, text := *cmd.ID, *cmd.Text
		onUIThread(func() { paste(id, text) })
	case "capture":
		regions, err := parseRegions(cmd.Regions)
		if err != nil {
			emit(event{"event": "error", "message": err.Error()})
			return
		}
		onUIThread(func() { setCapturing(true, regions) })
	case "release":
		onUIThread(func() { setCapturing(false, nil) })
	default:
		emit(event{"event": "error", "message": "unknown command: " + cmd.Cmd})
	}
}

func windowProc(hwnd, message, wParam, lParam uintptr) uintptr {
	if message == wmTask {
		for {
			select {
			case task := <-tasks:
				task()
			default:
				return 0
			}
		}
	}
	result, _, _ := procDefWindowProcW.Call(hwnd, message, wParam, lParam)
	return result
}

func createMessageWindow() uintptr {
	module, _, _ := procGetModuleHandleW.Call(0)
	class := wndClassEx{wndProc: windowCallback, instance: module, className: utf16Ptr("WhisprFlowKeyHelper")}
	class.size = uint32(unsafe.Sizeof(class))
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	hwnd, _, _ := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(class.className)), 0, 0, 0, 0, 0, 0,
		hwndMessage, 0, module, 0)
	return hwnd
}

// Self-check (no keystrokes): the clipboard can be written, the "transient" mark is set, and after restoring it matches the original exactly
func selfTest() bool {
	before, err := board.snapshot()
	if err != nil {
		emit(event{"event": "error", "message": err.Error()})
		return false
	}
	const probe = "whisprflow self-check (café)"
	wrote := board.writeText(probe, true) == nil
	text, _ := board.readText()
	wroteText := wrote && text == probe
	markedTransient := wrote && board.hasFormat(board.exclude)
	restored := board.restore(before) == nil
	after, _ := board.snapshot()
	same := restored && sameEntries(before, after)
	emit(event{"event": "selftest", "wrote_text": wroteText, "marked_transient": markedTransient, "restored": same, "items": len(before)})
	return wroteText && markedTransient && same
}

// Whether two clipboard contents match: format order doesn't matter, since the system may list them in its own order
func sameEntries(a, b []clipboardEntry) bool {
	if len(a) != len(b) {
		return false
	}
	byFormat := map[uint32]string{}
	for _, entry := range a {
		byFormat[entry.format] = string(entry.data)
	}
	for _, entry := range b {
		if data, ok := byFormat[entry.format]; !ok || data != string(entry.data) {
			return false
		}
	}
	return true
}

func main() {
	runtime.LockOSThread()
	go func() {
		writer := bufio.NewWriter(os.Stdout)
		for line := range out {
			writer.Write(line)
			if len(out) == 0 {
				writer.Flush()
			}
		}
	}()
	exit := func(code int) {
		// Wait for the write to finish before exiting: the error line mustn't be lost
		for len(out) > 0 {
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(20 * time.Millisecond)
		os.Exit(code)
	}

	name := "right_alt"
	args := os.Args[1:]
	for i, arg := range args {
		if arg == "--key" {
			if i+1 < len(args) {
				name = args[i+1]
			} else {
				name = ""
			}
		}
	}
	vk, ok := hotkeys[name]
	if !ok {
		emit(event{"event": "error", "message": "unknown hotkey " + name + ", choose from: right_alt, right_ctrl"})
		exit(2)
	}
	state.hotkey = vk

	has := func(flag string) bool {
		for _, arg := range args {
			if arg == flag {
				return true
			}
		}
		return false
	}
	// Windows has no "Input Monitoring" or "Accessibility" permissions
	if has("--check") {
		emit(event{"event": "check", "listen": true, "trusted": true})
		exit(0)
	}

	window = createMessageWindow()
	if window == 0 {
		emit(event{"event": "error", "message": "couldn't create the message window"})
		exit(1)
	}
	board = newClipboard(window)
	if has("--selftest") {
		if selfTest() {
			exit(0)
		}
		exit(1)
	}

	// --no-prompt is accepted as is: Windows has no permission prompt to show
	keyboard := installHook(whKeyboardLL, keyboardCallback)
	listening := keyboard != 0
	emit(event{"event": "ready", "listen": listening, "trusted": true, "capture": listening})

	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		// One paste can be long text: allow up to 16 MB
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			handle(append([]byte(nil), scanner.Bytes()...))
		}
		if err := scanner.Err(); err != nil {
			emit(event{"event": "error", "message": "error reading standard input: " + err.Error()})
		}
		exit(0)
	}()

	var m msg
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	exit(0)
}
