package main

// The Win32 APIs used. Looked up by name with only the standard library's syscall, no third-party packages. Structs follow WinUser.h's x64 layout.

import (
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")

	procSetWindowsHookExW       = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx     = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx          = user32.NewProc("CallNextHookEx")
	procGetMessageW             = user32.NewProc("GetMessageW")
	procTranslateMessage        = user32.NewProc("TranslateMessage")
	procDispatchMessageW        = user32.NewProc("DispatchMessageW")
	procPostMessageW            = user32.NewProc("PostMessageW")
	procRegisterClassExW        = user32.NewProc("RegisterClassExW")
	procCreateWindowExW         = user32.NewProc("CreateWindowExW")
	procDefWindowProcW          = user32.NewProc("DefWindowProcW")
	procSendInput               = user32.NewProc("SendInput")
	procOpenClipboard           = user32.NewProc("OpenClipboard")
	procCloseClipboard          = user32.NewProc("CloseClipboard")
	procEmptyClipboard          = user32.NewProc("EmptyClipboard")
	procEnumClipboardFormats    = user32.NewProc("EnumClipboardFormats")
	procGetClipboardData        = user32.NewProc("GetClipboardData")
	procSetClipboardData        = user32.NewProc("SetClipboardData")
	procIsClipboardFormatAvail  = user32.NewProc("IsClipboardFormatAvailable")
	procRegisterClipboardFormat = user32.NewProc("RegisterClipboardFormatW")
	procGetForegroundWindow     = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcess  = user32.NewProc("GetWindowThreadProcessId")

	procGetModuleHandleW  = kernel32.NewProc("GetModuleHandleW")
	procGlobalAlloc       = kernel32.NewProc("GlobalAlloc")
	procGlobalFree        = kernel32.NewProc("GlobalFree")
	procGlobalLock        = kernel32.NewProc("GlobalLock")
	procGlobalUnlock      = kernel32.NewProc("GlobalUnlock")
	procGlobalSize        = kernel32.NewProc("GlobalSize")
	procOpenProcess       = kernel32.NewProc("OpenProcess")
	procCloseHandle       = kernel32.NewProc("CloseHandle")
	procGetCurrentProcess = kernel32.NewProc("GetCurrentProcess")

	procOpenProcessToken    = advapi32.NewProc("OpenProcessToken")
	procGetTokenInformation = advapi32.NewProc("GetTokenInformation")
)

const (
	whKeyboardLL = 13
	whMouseLL    = 14

	wmKeyDown     = 0x0100
	wmKeyUp       = 0x0101
	wmSysKeyDown  = 0x0104
	wmSysKeyUp    = 0x0105
	wmLButtonDown = 0x0201
	wmLButtonUp   = 0x0202
	wmApp         = 0x8000

	inputKeyboard  = 1
	keyEventFKeyUp = 0x0002

	vkControl = 0x11
	vkV       = 0x56

	cfUnicodeText = 13
	gmemMoveable  = 0x0002

	processQueryLimitedInformation = 0x1000
	tokenQuery                     = 0x0008
	tokenElevationClass            = 20
)

// The parent window for message windows: message only, never shown (HWND_MESSAGE = -3)
var hwndMessage = ^uintptr(2)

// Keys we simulate carry this mark (dwExtraInfo), so the hook recognizes and passes them through. Only our own count:
// keys simulated by other tools (PowerToys remapping, AutoHotkey) also carry the "injected" flag, but those are what the user wants, so they count as usual
const ourMark = 0x53504B48 // "SPKH"

type kbdLLHookStruct struct {
	vkCode    uint32
	scanCode  uint32
	flags     uint32
	time      uint32
	extraInfo uintptr
}

type msLLHookStruct struct {
	x, y      int32
	mouseData uint32
	flags     uint32
	time      uint32
	extraInfo uintptr
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	x, y    int32
	private uint32
}

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSm     uintptr
}

// The keyboard kind of INPUT. The union is sized by the largest member, MOUSEINPUT, for a 40-byte struct
type keyboardInput struct {
	kind  uint32
	_     uint32
	vk    uint16
	scan  uint16
	flags uint32
	time  uint32
	_     uint32
	extra uintptr
	_     [8]byte
}

func init() {
	if size := unsafe.Sizeof(keyboardInput{}); size != 40 {
		panic("keyboardInput isn't 40 bytes; SendInput would reject it")
	}
}

// Simulates these keystrokes in order (down true means press)
func sendKeys(keys []uint16, downs []bool) bool {
	inputs := make([]keyboardInput, len(keys))
	for i, vk := range keys {
		inputs[i] = keyboardInput{kind: inputKeyboard, vk: vk, extra: ourMark}
		if !downs[i] {
			inputs[i].flags = keyEventFKeyUp
		}
	}
	sent, _, _ := procSendInput.Call(uintptr(len(inputs)), uintptr(unsafe.Pointer(&inputs[0])), unsafe.Sizeof(inputs[0]))
	return int(sent) == len(inputs)
}

func utf16Ptr(text string) *uint16 {
	p, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		// Only names we hard-code ourselves reach here, and they contain no NUL
		panic(err)
	}
	return p
}

// Whether a process runs as administrator (an elevated token). A token that can't be opened counts as yes: only processes with higher rights than ours do that,
// and the system blocks simulated keys into them just the same
func processElevated(process uintptr) bool {
	var token uintptr
	if ok, _, _ := procOpenProcessToken.Call(process, tokenQuery, uintptr(unsafe.Pointer(&token))); ok == 0 {
		return true
	}
	defer procCloseHandle.Call(token)
	var elevated, returned uint32
	ok, _, _ := procGetTokenInformation.Call(token, tokenElevationClass, uintptr(unsafe.Pointer(&elevated)),
		unsafe.Sizeof(elevated), uintptr(unsafe.Pointer(&returned)))
	return ok != 0 && elevated != 0
}

// Whether the foreground window runs as administrator while we don't: then the simulated Ctrl+V is silently blocked by the system (UIPI)
func foregroundBlocksInput() bool {
	self, _, _ := procGetCurrentProcess.Call()
	if processElevated(self) {
		return false
	}
	window, _, _ := procGetForegroundWindow.Call()
	if window == 0 {
		return false
	}
	var pid uint32
	procGetWindowThreadProcess.Call(window, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return false
	}
	process, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if process == 0 {
		// Processes that can't even be opened this way are protected system processes, which won't accept our keys either
		return true
	}
	defer procCloseHandle.Call(process)
	return processElevated(process)
}
