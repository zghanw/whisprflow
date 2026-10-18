package main

// The clipboard: saves what is there now, writes the text to paste, and restores it afterwards (like the macOS version: images, files, and rich text all come back).
// Only one window can have the Windows clipboard open at a time, so all of this happens on the message window's thread, opened with that window as owner
// (without an owner, SetClipboardData fails after EmptyClipboard).

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// Formats that are GDI handles rather than memory blocks: their bytes can't be copied, so skip them. Images also come as CF_DIB / CF_DIBV5 byte formats,
// which the system converts between, so images still come back
func isHandleFormat(format uint32) bool {
	switch format {
	case 2 /* CF_BITMAP */, 3 /* CF_METAFILEPICT */, 9 /* CF_PALETTE */, 14, /* CF_ENHMETAFILE */
		0x80 /* CF_OWNERDISPLAY */, 0x82 /* CF_DSPBITMAP */, 0x83 /* CF_DSPMETAFILEPICT */, 0x8E /* CF_DSPENHMETAFILE */ :
		return true
	}
	// CF_GDIOBJFIRST..CF_GDIOBJLAST: private GDI handles
	return format >= 0x300 && format <= 0x3FF
}

type clipboardEntry struct {
	format uint32
	data   []byte
}

type clipboard struct {
	owner uintptr
	// The convention clipboard managers, the system's clipboard history, and cloud sync follow: content with these formats is transient, so don't record or sync it
	exclude, history, cloud uint32
}

func newClipboard(owner uintptr) *clipboard {
	register := func(name string) uint32 {
		format, _, _ := procRegisterClipboardFormat.Call(uintptr(unsafe.Pointer(utf16Ptr(name))))
		return uint32(format)
	}
	return &clipboard{
		owner:   owner,
		exclude: register("ExcludeClipboardContentFromMonitorProcessing"),
		history: register("CanIncludeInClipboardHistory"),
		cloud:   register("CanUploadToCloudClipboard"),
	}
}

// Opens the clipboard. It fails while another program has it open, so retry a few times; never wait long: the same thread also handles the keyboard hook
func (c *clipboard) open() error {
	for attempt := 0; attempt < 10; attempt++ {
		if ok, _, _ := procOpenClipboard.Call(c.owner); ok != 0 {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("the clipboard is held by another program")
}

func (c *clipboard) close() { procCloseClipboard.Call() }

// The bytes in a global memory block
func globalBytes(handle uintptr) ([]byte, bool) {
	size, _, _ := procGlobalSize.Call(handle)
	pointer, _, _ := procGlobalLock.Call(handle)
	if pointer == 0 {
		return nil, false
	}
	defer procGlobalUnlock.Call(handle)
	data := make([]byte, size)
	copy(data, unsafe.Slice((*byte)(unsafe.Pointer(pointer)), size))
	return data, true
}

// Puts bytes into the clipboard in one format. On success the memory belongs to the system; on failure it must be freed here
func (c *clipboard) put(format uint32, data []byte) bool {
	size := len(data)
	if size == 0 {
		// Some formats only signal presence and have empty content; GlobalAlloc won't take 0 bytes
		size = 1
	}
	handle, _, _ := procGlobalAlloc.Call(gmemMoveable, uintptr(size))
	if handle == 0 {
		return false
	}
	pointer, _, _ := procGlobalLock.Call(handle)
	if pointer == 0 {
		procGlobalFree.Call(handle)
		return false
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(pointer)), size), data)
	procGlobalUnlock.Call(handle)
	if ok, _, _ := procSetClipboardData.Call(uintptr(format), handle); ok == 0 {
		procGlobalFree.Call(handle)
		return false
	}
	return true
}

// Every copyable format in the clipboard now
func (c *clipboard) snapshot() ([]clipboardEntry, error) {
	if err := c.open(); err != nil {
		return nil, err
	}
	defer c.close()
	var entries []clipboardEntry
	for format := uint32(0); ; {
		next, _, _ := procEnumClipboardFormats.Call(uintptr(format))
		if next == 0 {
			break
		}
		format = uint32(next)
		if isHandleFormat(format) {
			continue
		}
		handle, _, _ := procGetClipboardData.Call(uintptr(format))
		if handle == 0 {
			continue
		}
		if data, ok := globalBytes(handle); ok {
			entries = append(entries, clipboardEntry{format, data})
		}
	}
	return entries, nil
}

func (c *clipboard) restore(entries []clipboardEntry) error {
	if err := c.open(); err != nil {
		return err
	}
	defer c.close()
	procEmptyClipboard.Call()
	restored := 0
	for _, entry := range entries {
		if c.put(entry.format, entry.data) {
			restored++
		}
	}
	if restored < len(entries) {
		return fmt.Errorf("restored only %d of %d formats", restored, len(entries))
	}
	return nil
}

// Text in CF_UNICODETEXT form: UTF-16, zero-terminated. Text never contains NUL (if it did, it would be cut there)
func utf16Bytes(text string) []byte {
	if i := strings.IndexByte(text, 0); i >= 0 {
		text = text[:i]
	}
	units, _ := syscall.UTF16FromString(text)
	return unsafe.Slice((*byte)(unsafe.Pointer(&units[0])), len(units)*2)
}

// Writes text. transient: marked as temporary, so clipboard history, cloud sync, and clipboard managers don't record it (it is restored right after pasting)
func (c *clipboard) writeText(text string, transient bool) error {
	if err := c.open(); err != nil {
		return err
	}
	defer c.close()
	procEmptyClipboard.Call()
	if !c.put(cfUnicodeText, utf16Bytes(text)) {
		return errors.New("couldn't write to the clipboard")
	}
	if transient {
		zero := []byte{0, 0, 0, 0}
		c.put(c.exclude, zero)
		c.put(c.history, zero)
		c.put(c.cloud, zero)
	}
	return nil
}

// Reads the text in the clipboard (for the self-check)
func (c *clipboard) readText() (string, bool) {
	if err := c.open(); err != nil {
		return "", false
	}
	defer c.close()
	handle, _, _ := procGetClipboardData.Call(cfUnicodeText)
	if handle == 0 {
		return "", false
	}
	data, ok := globalBytes(handle)
	if !ok || len(data) < 2 {
		return "", false
	}
	return syscall.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&data[0])), len(data)/2)), true
}

func (c *clipboard) hasFormat(format uint32) bool {
	ok, _, _ := procIsClipboardFormatAvail.Call(uintptr(format))
	return ok != 0
}
