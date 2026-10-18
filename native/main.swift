// The native helper: listens for the hotkey and pastes text into the current input.
// Electron can't do either of these itself, so a small Swift child process does them.
//
// Talks to the parent with one JSON object per line:
//   stdout    {"event":"ready","listen":true,"trusted":true,"capture":true}
//                                                               startup done, with the two permission states; capture: whether esc and clicks can be captured
//             {"event":"hotkey","down":true}                    hotkey pressed / released
//             {"event":"other_key"}                             another key while the hotkey is held (a combination, not dictation)
//             {"event":"pasted","id":1,"ok":true}               pasted; with ok false the text stays in the clipboard
//             {"event":"escape"}                                esc pressed while capturing
//             {"event":"click","id":"cancel"}                   a region clicked while capturing
//   stdin     {"cmd":"paste","id":1,"text":"..."}
//             {"cmd":"capture","regions":[{"id":"cancel","x":0,"y":0,"width":28,"height":28}]}
//                                                               start capturing: esc, and mouse clicks in these regions (screen coordinates)
//             {"cmd":"release"}                                 stop capturing
// Exits when the parent exits (standard input closes).
//
// The hotkey is set with --key, a single modifier key: right_option (default), right_command, right_control, fn.
// Right Option is the default: it rarely collides with other apps' shortcuts.
// --no-prompt: when permissions are missing, don't let the system show a prompt; just report honestly.
//
// Key contents never leave this process: apart from the hotkey's press and release, only "another key" is reported, never which key.
// The one exception is esc, and only after the parent says "start capturing" and before "stop": during that time it cancels dictation.

import AppKit
import ApplicationServices

/// A modifier key: the key code tells "is this event about this key", the flag tells "is it down or up now".
/// Left and right Option share maskAlternate; device-dependent flags (NX_DEVICER*KEYMASK in IOLLEvent.h) tell them apart.
struct Hotkey {
    let keyCode: Int64
    let flagMask: UInt64
}

let hotkeys: [String: Hotkey] = [
    "right_option": Hotkey(keyCode: 61, flagMask: 0x40),
    "right_command": Hotkey(keyCode: 54, flagMask: 0x10),
    "right_control": Hotkey(keyCode: 62, flagMask: 0x2000),
    "fn": Hotkey(keyCode: 63, flagMask: CGEventFlags.maskSecondaryFn.rawValue),
]
var hotkey = hotkeys["right_option"]!
let vKeyCode: CGKeyCode = 9
/// A convention among clipboard managers: content with this type is transient, so don't record it in history
let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
/// How long to wait after simulating paste before restoring the clipboard: too short and the target app hasn't read it yet
let restoreDelay: TimeInterval = 0.3

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else {
        FileHandle.standardError.write("emit: serialization failed \(object)\n".data(using: .utf8)!)
        return
    }
    print(line)
    fflush(stdout)
}

// MARK: - Clipboard

typealias PasteboardSnapshot = [[(NSPasteboard.PasteboardType, Data)]]

/// Saves every format of every item in the clipboard, so images, files, and rich text all come back as they were
func snapshotPasteboard(_ pasteboard: NSPasteboard) -> PasteboardSnapshot {
    (pasteboard.pasteboardItems ?? []).map { item in
        item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
}

func restorePasteboard(_ pasteboard: NSPasteboard, from snapshot: PasteboardSnapshot) {
    pasteboard.clearContents()
    let items = snapshot.map { entries -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in entries { item.setData(data, forType: type) }
        return item
    }
    if !items.isEmpty { pasteboard.writeObjects(items) }
}

func writeTransientText(_ pasteboard: NSPasteboard, _ text: String) {
    pasteboard.clearContents()
    let item = NSPasteboardItem()
    item.setString(text, forType: .string)
    item.setData(Data(), forType: transientType)
    pasteboard.writeObjects([item])
}

// MARK: - Pasting

func postCommandV() {
    let source = CGEventSource(stateID: .combinedSessionState)
    for keyDown in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: keyDown)
        event?.flags = .maskCommand
        event?.post(tap: .cghidEventTap)
    }
}

/// Save the clipboard, write the text, simulate ⌘V, restore the clipboard. Pasting is the only route.
func paste(id: Int, text: String) {
    let pasteboard = NSPasteboard.general
    guard AXIsProcessTrusted() else {
        // Without Accessibility permission simulated keys have no effect. Leave the text in the clipboard for the user to press ⌘V
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        emit(["event": "pasted", "id": id, "ok": false, "reason": "not_trusted"])
        return
    }
    let saved = snapshotPasteboard(pasteboard)
    writeTransientText(pasteboard, text)
    postCommandV()
    DispatchQueue.main.asyncAfter(deadline: .now() + restoreDelay) {
        restorePasteboard(pasteboard, from: saved)
        emit(["event": "pasted", "id": id, "ok": true])
    }
}

// MARK: - Key listening

var hotkeyIsDown = false
var reportedOtherKey = false
var eventTap: CFMachPort?

let onKeyEvent: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // The system stops the listener when the callback is too slow or the user enters secure input, so turn it back on ourselves
        if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
    case .flagsChanged:
        // Events of other keys may carry the same flag (arrow keys carry fn, for example), so check the key code first
        guard event.getIntegerValueField(.keyboardEventKeycode) == hotkey.keyCode else {
            // Another modifier pressed while the hotkey is held is a combination too
            reportOtherKeyIfHeld()
            break
        }
        let down = event.flags.rawValue & hotkey.flagMask != 0
        if down != hotkeyIsDown {
            hotkeyIsDown = down
            reportedOtherKey = false
            emit(["event": "hotkey", "down": down])
        }
    case .keyDown:
        reportOtherKeyIfHeld()
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

func reportOtherKeyIfHeld() {
    if hotkeyIsDown && !reportedOtherKey {
        reportedOtherKey = true
        emit(["event": "other_key"])
    }
}

func startKeyListener() -> Bool {
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue | 1 << CGEventType.keyDown.rawValue)
    // Listen only, never modify: events pass through as is, and the system and other apps receive them as usual
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                      options: .listenOnly, eventsOfInterest: mask,
                                      callback: onKeyEvent, userInfo: nil) else { return false }
    eventTap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}

// MARK: - Capturing esc and clicks on the floating bar
//
// During dictation the floating bar has "Cancel" and "Done" buttons, and esc also cancels. Neither may reach other apps:
// a click landing on the floating bar's window would bring our app to the front, the input the user is writing in would lose focus, and the text couldn't be pasted;
// esc passed to the foreground app as well would close its dialog or interrupt what it is doing while cancelling dictation.
// So a separate listener that can modify events stays off normally, turns on only during dictation, swallows only these two, and passes everything else. It needs Accessibility permission.

struct Region {
    let id: String
    let rect: CGRect
}

let escapeKeyCode: Int64 = 53
var captureTap: CFMachPort?
var capturing = false
var regions: [Region] = []
/// Presses already swallowed and awaiting release: esc, and the mouse (remembering which region it went down in)
var escapeIsDown = false
var pressedRegion: String?
/// A recording lasts at most 9 minutes. If the parent still hasn't said "stop capturing" after that long, something went wrong on its side: release by ourselves,
/// so esc never stays unusable in every app
let captureLimit: TimeInterval = 600
var captureDeadline: DispatchWorkItem?

/// Whether this listener should be on now. A press still held must be swallowed whole, so it may stay on a little after "stop capturing":
/// swallowing the press but letting the release through would hand the foreground app half an event
var captureWanted: Bool { capturing || escapeIsDown || pressedRegion != nil }

func settleCapture() {
    guard let tap = captureTap else { return }
    CGEvent.tapEnable(tap: tap, enable: captureWanted)
}

func setCapturing(_ on: Bool, regions newRegions: [Region] = []) {
    captureDeadline?.cancel()
    captureDeadline = nil
    capturing = on
    regions = newRegions
    settleCapture()
    guard on else { return }
    let deadline = DispatchWorkItem {
        emit(["event": "error", "message": "still capturing after \(Int(captureLimit)) seconds with no word to stop, releasing"])
        setCapturing(false)
    }
    captureDeadline = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + captureLimit, execute: deadline)
}

func regionAt(_ point: CGPoint) -> String? {
    regions.first { $0.rect.contains(point) }?.id
}

let onCaptureEvent: CGEventTapCallBack = { _, type, event, _ in
    let pass = Unmanaged.passUnretained(event)
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // It was stopped: maybe the system found the callback slow, or we turned it off ourselves (that also sends this notification).
        // Turn it back on if it should be on; leave it alone otherwise: turning it off again here sends another notification, looping forever (seen happen)
        if captureWanted, let tap = captureTap { CGEvent.tapEnable(tap: tap, enable: true) }
        return pass
    case .keyDown:
        guard event.getIntegerValueField(.keyboardEventKeycode) == escapeKeyCode else { return pass }
        let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        if capturing {
            if !isRepeat {
                escapeIsDown = true
                emit(["event": "escape"])
            }
            return nil
        }
        // No longer capturing, but the cancelling press is still held: repeats from holding don't get through either
        if escapeIsDown && isRepeat { return nil }
        // A new press: none of our business. If the previous release was missed, clean up here too
        escapeIsDown = false
        settleCapture()
        return pass
    case .keyUp:
        guard escapeIsDown, event.getIntegerValueField(.keyboardEventKeycode) == escapeKeyCode else { return pass }
        escapeIsDown = false
        settleCapture()
        return nil
    case .leftMouseDown:
        guard capturing, let region = regionAt(event.location) else { return pass }
        pressedRegion = region
        return nil
    case .leftMouseDragged:
        return pressedRegion == nil ? pass : nil
    case .leftMouseUp:
        guard let pressed = pressedRegion else { return pass }
        pressedRegion = nil
        // As with ordinary buttons, a click counts only when press and release land in the same region: dragging out before releasing takes it back
        if capturing && regionAt(event.location) == pressed {
            emit(["event": "click", "id": pressed])
        }
        settleCapture()
        return nil
    default:
        return pass
    }
}

func startCaptureTap() -> Bool {
    let types: [CGEventType] = [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .leftMouseDragged]
    let mask = types.reduce(CGEventMask(0)) { $0 | CGEventMask(1 << $1.rawValue) }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                      options: .defaultTap, eventsOfInterest: mask,
                                      callback: onCaptureEvent, userInfo: nil) else { return false }
    captureTap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    // Off normally: never in the path of any key or click
    CGEvent.tapEnable(tap: tap, enable: false)
    return true
}

func parseRegions(_ value: Any?) -> [Region]? {
    guard let list = value as? [[String: Any]] else { return nil }
    var parsed: [Region] = []
    for item in list {
        guard let id = item["id"] as? String,
              let x = item["x"] as? Double, let y = item["y"] as? Double,
              let width = item["width"] as? Double, let height = item["height"] as? Double,
              width > 0, height > 0 else { return nil }
        parsed.append(Region(id: id, rect: CGRect(x: x, y: y, width: width, height: height)))
    }
    return parsed
}

// MARK: - Self-check (no keystrokes, only verifying the clipboard is saved and restored exactly)

func selfTest() -> Bool {
    let pasteboard = NSPasteboard.general
    let before = snapshotPasteboard(pasteboard)
    writeTransientText(pasteboard, "whisprflow self-check (café)")
    let wroteText = pasteboard.string(forType: .string) == "whisprflow self-check (café)"
    let markedTransient = pasteboard.types?.contains(transientType) ?? false
    restorePasteboard(pasteboard, from: before)
    let after = snapshotPasteboard(pasteboard)
    let restored = before.count == after.count && zip(before, after).allSatisfy { old, new in
        old.count == new.count && zip(old, new).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    }
    emit(["event": "selftest", "wrote_text": wroteText, "marked_transient": markedTransient,
          "restored": restored, "items": before.count])
    return wroteText && markedTransient && restored
}

// MARK: - Entry point

let arguments = Array(CommandLine.arguments.dropFirst())
if let flag = arguments.firstIndex(of: "--key") {
    let name = flag + 1 < arguments.count ? arguments[flag + 1] : ""
    guard let chosen = hotkeys[name] else {
        emit(["event": "error", "message": "unknown hotkey \(name), choose from: \(hotkeys.keys.sorted().joined(separator: ", "))"])
        exit(2)
    }
    hotkey = chosen
}
if arguments.contains("--check") {
    emit(["event": "check", "listen": CGPreflightListenEventAccess(), "trusted": AXIsProcessTrusted()])
    exit(0)
}
if arguments.contains("--selftest") {
    exit(selfTest() ? 0 : 1)
}

// Without permissions, let the system show its prompt and add the app to the "Input Monitoring" and "Accessibility" lists.
// --no-prompt: check without prompting. The parent rechecks permissions by restarting this process, and prompting then would prompt on every check
let mayPrompt = !arguments.contains("--no-prompt")
let listenAllowed = CGPreflightListenEventAccess() || (mayPrompt && CGRequestListenEventAccess())
let trusted = mayPrompt
    ? AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    : AXIsProcessTrusted()
let listening = listenAllowed && startKeyListener()
// Start the listen-only one first, then the one that can modify events: the later one goes first, so the esc it swallows never counts as "hotkey plus another key"
let capture = trusted && startCaptureTap()
emit(["event": "ready", "listen": listening, "trusted": trusted, "capture": capture])

Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let command = object["cmd"] as? String else {
            emit(["event": "error", "message": "unreadable command line"])
            continue
        }
        switch command {
        case "paste":
            guard let id = object["id"] as? Int, let text = object["text"] as? String else {
                emit(["event": "error", "message": "paste needs id and text"])
                continue
            }
            DispatchQueue.main.async { paste(id: id, text: text) }
        case "capture":
            guard let parsed = parseRegions(object["regions"]) else {
                emit(["event": "error", "message": "capture needs regions: a list of { id, x, y, width, height }"])
                continue
            }
            DispatchQueue.main.async { setCapturing(true, regions: parsed) }
        case "release":
            DispatchQueue.main.async { setCapturing(false) }
        default:
            emit(["event": "error", "message": "unknown command: \(command)"])
        }
    }
    exit(0)
}

RunLoop.main.run()
