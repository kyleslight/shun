import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

enum DriverFailure: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value): return value
        }
    }
}

// MARK: - Arguments

struct Arguments {
    let command: String
    private let values: [String: String]

    init(_ raw: [String]) throws {
        guard let command = raw.first else { throw DriverFailure.message("A desktop driver command is required.") }
        self.command = command
        var values: [String: String] = [:]
        var index = 1
        while index < raw.count {
            let token = raw[index]
            guard token.hasPrefix("--") else { throw DriverFailure.message("Unexpected desktop driver argument: \(token)") }
            guard index + 1 < raw.count else { throw DriverFailure.message("Desktop driver argument \(token) requires a value.") }
            values[String(token.dropFirst(2))] = raw[index + 1]
            index += 2
        }
        self.values = values
    }

    func text(_ name: String) -> String? { values[name] }

    func required(_ name: String) throws -> String {
        guard let value = values[name], !value.isEmpty else { throw DriverFailure.message("--\(name) is required.") }
        return value
    }

    func number(_ name: String) throws -> Double {
        guard let value = Double(try required(name)), value.isFinite else { throw DriverFailure.message("--\(name) must be a number.") }
        return value
    }

    func integer(_ name: String) throws -> Int {
        let value = try number(name)
        guard value == value.rounded() else { throw DriverFailure.message("--\(name) must be an integer.") }
        return Int(value)
    }

    func normalized(_ name: String) throws -> Double {
        let value = try number(name)
        guard value >= 0, value <= 1 else { throw DriverFailure.message("--\(name) must be a normalized coordinate from 0 through 1.") }
        return value
    }
}

// MARK: - Permission

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw DriverFailure.message("Accessibility permission is required. Enable Shun in System Settings > Privacy & Security > Accessibility, then retry.")
    }
}

func screenCaptureAllowed() -> Bool {
    if #available(macOS 10.15, *) { return CGPreflightScreenCaptureAccess() }
    return true
}

/** Milliseconds since the last real input event on this Mac, so a driver never races the person using it. */
func userIdleMilliseconds() -> Int {
    let state = CGEventSourceStateID.combinedSessionState
    guard let anyInput = CGEventType(rawValue: 0xFFFF_FFFF) else { return 0 }
    let seconds = CGEventSource.secondsSinceLastEventType(state, eventType: anyInput)
    guard seconds.isFinite, seconds >= 0 else { return 0 }
    return Int((seconds * 1_000).rounded())
}

// MARK: - Windows

struct WindowRecord {
    let id: Int
    let pid: Int
    let app: String
    let title: String
    let layer: Int
    let bounds: CGRect

    var json: [String: Any] {
        [
            "id": id,
            "pid": pid,
            "app": app,
            "title": title,
            "layer": layer,
            "x": Int(bounds.origin.x.rounded()),
            "y": Int(bounds.origin.y.rounded()),
            "width": Int(bounds.width.rounded()),
            "height": Int(bounds.height.rounded()),
        ]
    }
}

let usableWindowFloor = 120.0

func onScreenWindows() throws -> [WindowRecord] {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw DriverFailure.message("macOS returned no window list.")
    }
    let ownPid = Int(ProcessInfo.processInfo.processIdentifier)
    var records: [WindowRecord] = []
    for entry in raw {
        guard let id = entry[kCGWindowNumber as String] as? Int,
              let pid = entry[kCGWindowOwnerPID as String] as? Int,
              pid != ownPid,
              let boundsValue = entry[kCGWindowBounds as String] as? [String: Any] else { continue }
        var bounds = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(boundsValue as CFDictionary, &bounds) else { continue }
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        let app = (entry[kCGWindowOwnerName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let title = (entry[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // A window smaller than a few characters wide is chrome, not a surface to act on.
        if bounds.width < usableWindowFloor || bounds.height < usableWindowFloor { continue }
        records.append(WindowRecord(id: id, pid: pid, app: app, title: title, layer: layer, bounds: bounds))
    }
    // Frontmost application first, then ordinary windows in front-to-back order.
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    return records.enumerated().sorted { left, right in
        let leftFront = left.element.pid == Int(frontmostPid), rightFront = right.element.pid == Int(frontmostPid)
        if leftFront != rightFront { return leftFront }
        if left.element.layer != right.element.layer { return left.element.layer < right.element.layer }
        return left.offset < right.offset
    }.map { $0.element }
}

func resolveWindow(_ selector: String?) throws -> WindowRecord {
    let windows = try onScreenWindows()
    guard !windows.isEmpty else { throw DriverFailure.message("No on-screen window is available to act on.") }
    guard let selector, !selector.isEmpty, selector != "frontmost" else {
        if let front = windows.first(where: { $0.layer == 0 && $0.pid == Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) }) { return front }
        guard let front = windows.first(where: { $0.layer == 0 }) else { throw DriverFailure.message("No ordinary on-screen window is available to act on.") }
        return front
    }
    if let id = Int(selector) {
        guard let match = windows.first(where: { $0.id == id }) else {
            throw DriverFailure.message("No on-screen window has id \(id). List windows again and use a current id.")
        }
        return match
    }
    let matches = windows.filter { $0.app.lowercased() == selector.lowercased() }
    if matches.count > 1 { throw DriverFailure.message("More than one window belongs to \(selector). Use an exact window id from the window list.") }
    guard let match = matches.first else { throw DriverFailure.message("No on-screen window belongs to \(selector). List windows again and use an exact id.") }
    return match
}

// MARK: - Focus

func focusWindow(_ window: WindowRecord) throws {
    if let application = NSRunningApplication(processIdentifier: pid_t(window.pid)) {
        application.activate(options: [.activateAllWindows])
    }
    let app = AXUIElementCreateApplication(pid_t(window.pid))
    if let raw = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] {
        for element in raw {
            // The AX window and the CGWindowList record describe the same rectangle,
            // which is how a window id from the list becomes the AX window to raise.
            let frame = frameOrZero(element)
            if abs(frame.origin.x - window.bounds.origin.x) < 2, abs(frame.origin.y - window.bounds.origin.y) < 2,
               abs(frame.width - window.bounds.width) < 2, abs(frame.height - window.bounds.height) < 2 {
                AXUIElementPerformAction(element, kAXRaiseAction as CFString)
                AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
                break
            }
        }
    }
    usleep(220_000)
}

// MARK: - Accessibility element tree

/**
 What one window's controls look like to the Accessibility API.

 This is the desktop counterpart of the browser's accessibility refs: a named
 control with a stable path can be acted on without reading pixels at all, which
 is cheaper, does not need Screen Recording, and works on text too small for a
 screenshot to carry. Pixels stay the fallback, because a canvas, a game, or a
 custom-drawn surface has no element tree to read.
 */
struct ElementRecord {
    let ref: String
    let role: String
    let subrole: String
    let title: String
    let description: String
    let value: String
    let enabled: Bool
    let focused: Bool
    let pressable: Bool
    let frame: CGRect

    var json: [String: Any] {
        [
            "ref": ref,
            "role": role,
            "subrole": subrole,
            "title": title,
            "description": description,
            "value": value,
            "enabled": enabled,
            "focused": focused,
            "pressable": pressable,
            "x": Int(frame.origin.x.rounded()),
            "y": Int(frame.origin.y.rounded()),
            "width": Int(frame.width.rounded()),
            "height": Int(frame.height.rounded()),
        ]
    }
}

func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool {
    (attribute(element, name) as? Bool) ?? false
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func textAttribute(_ element: AXUIElement, _ name: CFString, limit: Int = 200) -> String {
    guard let raw = attribute(element, name) else { return "" }
    let text = (raw as? String) ?? (raw as? NSNumber)?.stringValue ?? ""
    return String(text.prefix(limit))
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
    return list
}

/**
 A ref is the path of child indices from the window's own element ("2.1.0"),
 which is stable for as long as the tree shape is, and cheap to resolve again.
 */
func collectElements(root: AXUIElement, maxElements: Int, maxDepth: Int) -> (elements: [ElementRecord], truncated: Bool) {
    var records: [ElementRecord] = []
    var truncated = false
    func visit(_ element: AXUIElement, path: String, depth: Int) {
        for (index, child) in children(element).enumerated() {
            if records.count >= maxElements { truncated = true; return }
            let childPath = path.isEmpty ? "\(index)" : "\(path).\(index)"
            let frame = frameOrZero(child)
            let visible = frame.width >= 1 && frame.height >= 1
            if visible {
                let actions = actionNames(child)
                records.append(ElementRecord(
                    ref: childPath,
                    role: textAttribute(child, kAXRoleAttribute as CFString, limit: 40),
                    subrole: textAttribute(child, kAXSubroleAttribute as CFString, limit: 40),
                    title: textAttribute(child, kAXTitleAttribute as CFString),
                    description: textAttribute(child, kAXDescriptionAttribute as CFString),
                    value: textAttribute(child, kAXValueAttribute as CFString),
                    enabled: boolAttribute(child, kAXEnabledAttribute as CFString),
                    focused: boolAttribute(child, kAXFocusedAttribute as CFString),
                    pressable: actions.contains(kAXPressAction as String),
                    frame: frame
                ))
            }
            // A collapsed group often has no frame of its own but still holds the
            // controls that matter, so the walk descends through it.
            if depth + 1 < maxDepth { visit(child, path: childPath, depth: depth + 1) }
        }
    }
    visit(root, path: "", depth: 0)
    return (records, truncated)
}

func accessibilityWindow(_ window: WindowRecord) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(pid_t(window.pid))
    guard let raw = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] else {
        throw DriverFailure.message("That application exposes no accessible window. It may need Accessibility permission, or it may not publish an accessibility tree at all.")
    }
    for element in raw {
        let frame = frameOrZero(element)
        if abs(frame.origin.x - window.bounds.origin.x) < 2, abs(frame.origin.y - window.bounds.origin.y) < 2,
           abs(frame.width - window.bounds.width) < 2, abs(frame.height - window.bounds.height) < 2 {
            return element
        }
    }
    throw DriverFailure.message("That window is not exposed to the Accessibility API right now. List windows again, or act on it with coordinates.")
}

func elementAt(_ root: AXUIElement, ref: String) -> AXUIElement? {
    var current = root
    for part in ref.split(separator: ".") {
        guard let index = Int(part) else { return nil }
        let list = children(current)
        guard index >= 0, index < list.count else { return nil }
        current = list[index]
    }
    return current
}

/**
 The identity a caller read has to still match before the driver acts: a control
 that moved or was replaced between reading and pressing is not the same control,
 and pressing it anyway is how automation clicks the wrong thing.
 */
func requireSameIdentity(_ element: AXUIElement, ref: String, arguments: Arguments) throws -> [String: Any] {
    let role = textAttribute(element, kAXRoleAttribute as CFString, limit: 40)
    let title = textAttribute(element, kAXTitleAttribute as CFString)
    if let expected = arguments.text("expect-role"), !expected.isEmpty, expected != role {
        throw DriverFailure.message("The control at ref \(ref) is now \(role.isEmpty ? "an unknown role" : role) and nothing was performed; read the element tree again.")
    }
    if let expected = arguments.text("expect-title"), !expected.isEmpty, expected != title {
        throw DriverFailure.message("The control at ref \(ref) is now titled \"\(title)\" and nothing was performed; read the element tree again.")
    }
    if let expected = arguments.text("expect-frame") {
        let parts = expected.split(separator: ",").compactMap { Double($0) }
        let frame = frameOrZero(element)
        if parts.count == 4 {
            let drift = max(max(abs(frame.origin.x - parts[0]), abs(frame.origin.y - parts[1])), max(abs(frame.width - parts[2]), abs(frame.height - parts[3])))
            if drift > 2 {
                throw DriverFailure.message("The control at ref \(ref) moved since it was read and nothing was performed; read the element tree again.")
            }
        }
    }
    return [
        "ref": ref,
        "role": role,
        "title": title,
        "pressable": actionNames(element).contains(kAXPressAction as String),
        "frame": boundsJSON(frameOrZero(element)),
    ]
}

// MARK: - Geometry

func point(_ x: Double, _ y: Double, in bounds: CGRect) -> CGPoint {
    CGPoint(x: bounds.origin.x + bounds.width * x, y: bounds.origin.y + bounds.height * y)
}

/**
 The display this driver captures. Screen capture targets the main display, and
 the geometry reported for it has to be the same rectangle, or a normalized
 coordinate would map somewhere the screenshot never showed.
 */
func displayBounds() -> CGRect {
    return CGDisplayBounds(CGMainDisplayID())
}

// MARK: - Input

func mouseEvent(_ type: CGEventType, point: CGPoint, button: CGMouseButton) throws -> CGEvent {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw DriverFailure.message("Could not create a pointer event.")
    }
    return event
}

func postClick(at point: CGPoint, button: CGMouseButton, count: Int) throws {
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    try mouseEvent(.mouseMoved, point: point, button: button).post(tap: .cghidEventTap)
    usleep(40_000)
    for click in 1...max(1, count) {
        let downEvent = try mouseEvent(down, point: point, button: button)
        let upEvent = try mouseEvent(up, point: point, button: button)
        downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        downEvent.post(tap: .cghidEventTap)
        usleep(40_000)
        upEvent.post(tap: .cghidEventTap)
        if click < count { usleep(60_000) }
    }
}

func postDrag(from start: CGPoint, to end: CGPoint, durationMilliseconds: Int) throws {
    let steps = max(8, min(120, durationMilliseconds / 12))
    try mouseEvent(.mouseMoved, point: start, button: .left).post(tap: .cghidEventTap)
    try mouseEvent(.leftMouseDown, point: start, button: .left).post(tap: .cghidEventTap)
    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
        try mouseEvent(.leftMouseDragged, point: point, button: .left).post(tap: .cghidEventTap)
        usleep(useconds_t(max(1_000, durationMilliseconds * 1_000 / steps)))
    }
    try mouseEvent(.leftMouseUp, point: end, button: .left).post(tap: .cghidEventTap)
}

func postScroll(deltaY: Int, deltaX: Int) throws {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) else {
        throw DriverFailure.message("Could not create a scroll event.")
    }
    event.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "forward_delete": 117,
    "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "page_up": 116, "page_down": 121,
]

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        throw DriverFailure.message("Could not create a keyboard event.")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func flagValue(_ value: String?) throws -> CGEventFlags {
    guard let value, !value.isEmpty else { return [] }
    var flags: CGEventFlags = []
    for name in value.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) {
        switch name {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "": break
        default: throw DriverFailure.message("Unsupported key modifier: \(name).")
        }
    }
    return flags
}

func postText(_ text: String) throws {
    let characters = Array(text)
    var buffer: [UniChar] = []
    func flush() throws {
        guard !buffer.isEmpty else { return }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw DriverFailure.message("Could not create a text event.")
        }
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        buffer.removeAll()
        usleep(12_000)
    }
    for character in characters {
        if character == "\n" || character == "\r" {
            try flush()
            try postKey(36, flags: [])
            continue
        }
        buffer.append(contentsOf: Array(String(character).utf16))
        if buffer.count >= 16 { try flush() }
    }
    try flush()
}

// MARK: - Capture

func writePNG(_ image: CGImage, to path: String) throws {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw DriverFailure.message("Could not encode the captured window as PNG.")
    }
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
}

/**
 Capture goes through ScreenCaptureKit, which is the only path macOS still
 supports: `CGWindowListCreateImage` is obsoleted from macOS 15 on. A capture
 without Screen Recording permission fails here, and the message says so.
 */
final class CaptureBox {
    var value: Result<Any, Error>?
    var image: Result<CGImage, Error>?
}

func captureImage(windowID: CGWindowID?, displayID: CGDirectDisplayID?, scale: CGFloat) throws -> CGImage {
    guard #available(macOS 14.0, *) else {
        throw DriverFailure.message("Screen capture requires macOS 14 or later.")
    }
    let box = CaptureBox()
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let filter: SCContentFilter
            let configuration = SCStreamConfiguration()
            configuration.showsCursor = false
            if let windowID {
                guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                    throw DriverFailure.message("macOS no longer reports window \(windowID). Capture the window list again and use a current id.")
                }
                filter = SCContentFilter(desktopIndependentWindow: window)
                configuration.width = Int((window.frame.width * scale).rounded())
                configuration.height = Int((window.frame.height * scale).rounded())
            } else {
                guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
                    throw DriverFailure.message("macOS reports no capturable display. A locked screen or a sleeping display cannot be captured; unlock it and retry, and if it is already unlocked grant Shun Screen Recording permission.")
                }
                filter = SCContentFilter(display: display, excludingWindows: [])
                configuration.width = Int((CGFloat(display.width) * scale).rounded())
                configuration.height = Int((CGFloat(display.height) * scale).rounded())
            }
            configuration.width = max(1, configuration.width)
            configuration.height = max(1, configuration.height)
            box.image = .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration))
        } catch {
            box.image = .failure(error)
        }
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 20) == .success, let value = box.image else {
        throw DriverFailure.message("Screen capture did not finish within 20 seconds.")
    }
    switch value {
    case .success(let image): return image
    case .failure(let error):
        // A DriverFailure already explains itself; only a ScreenCaptureKit error
        // needs the permission hint added to it.
        if let failure = error as? DriverFailure { throw failure }
        throw DriverFailure.message("Screen capture failed: \(String(describing: error)) A locked screen or a sleeping display cannot be captured; unlock it and retry, and if it is already unlocked grant Shun Screen Recording permission in System Settings > Privacy & Security > Screen & System Audio Recording.")
    }
}

func captureScale() -> CGFloat {
    return NSScreen.screens.map { $0.backingScaleFactor }.max() ?? 2
}

/**
 What ScreenCaptureKit can actually see right now. A locked session reports no
 capture surface, which is a different problem from a missing permission, and the
 product has to be able to tell the two apart in what it says.
 */
func captureSummary() -> [String: Any] {
    guard #available(macOS 14.0, *) else { return ["supported": false] }
    let box = CaptureBox()
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            box.value = .success(try captureImageSummary(content))
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 15) == .success, case .success(let image) = box.value, let summary = image as? [String: Any] {
        return summary
    }
    return ["supported": true, "displays": 0, "windows": 0]
}

@available(macOS 14.0, *)
func captureImageSummary(_ content: SCShareableContent) throws -> [String: Any] {
    ["supported": true, "displays": content.displays.count, "windows": content.windows.count]
}

func capture(window: WindowRecord, to path: String) throws {
    guard screenCaptureAllowed() else {
        throw DriverFailure.message("Screen Recording permission is required. Enable Shun in System Settings > Privacy & Security > Screen & System Audio Recording, then retry.")
    }
    try writePNG(try captureImage(windowID: CGWindowID(window.id), displayID: nil, scale: captureScale()), to: path)
}

func captureScreen(to path: String) throws {
    guard screenCaptureAllowed() else {
        throw DriverFailure.message("Screen Recording permission is required. Enable Shun in System Settings > Privacy & Security > Screen & System Audio Recording, then retry.")
    }
    try writePNG(try captureImage(windowID: nil, displayID: CGMainDisplayID(), scale: captureScale()), to: path)
}

// MARK: - AX helpers

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func frameOrZero(_ element: AXUIElement) -> CGRect {
    guard let positionRaw = attribute(element, kAXPositionAttribute as CFString),
          let sizeRaw = attribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(positionRaw) == AXValueGetTypeID(),
          CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return .zero }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionRaw, to: AXValue.self), .cgPoint, &position),
          AXValueGetValue(unsafeBitCast(sizeRaw, to: AXValue.self), .cgSize, &size) else { return .zero }
    return CGRect(origin: position, size: size)
}

// MARK: - Commands

func respond(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

func boundsJSON(_ bounds: CGRect) -> [String: Any] {
    ["x": Int(bounds.origin.x.rounded()), "y": Int(bounds.origin.y.rounded()), "width": Int(bounds.width.rounded()), "height": Int(bounds.height.rounded())]
}

do {
    let arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
    switch arguments.command {
    case "probe":
        let frontmost = NSWorkspace.shared.frontmostApplication
        try respond([
            "ok": true,
            "accessibility": AXIsProcessTrusted(),
            "screen_recording": screenCaptureAllowed(),
            "user_idle_ms": userIdleMilliseconds(),
            "capture": captureSummary(),
            "display": boundsJSON(displayBounds()),
            "frontmost": frontmost?.localizedName ?? "",
            "frontmost_bundle_id": frontmost?.bundleIdentifier ?? "",
        ])
    case "windows":
        let frontmost = NSWorkspace.shared.frontmostApplication
        let windows = try onScreenWindows()
        try respond([
            "ok": true,
            "frontmost": ["app": frontmost?.localizedName ?? "", "pid": Int(frontmost?.processIdentifier ?? 0), "bundle_id": frontmost?.bundleIdentifier ?? ""],
            "display": boundsJSON(displayBounds()),
            "windows": windows.prefix(120).map { $0.json },
        ])
    case "focus":
        try requireAccessibility()
        let window = try resolveWindow(arguments.text("window"))
        try focusWindow(window)
        try respond(["ok": true, "window": window.json])
    case "snapshot":
        let target = arguments.text("window")
        if let target, target != "screen" {
            let window = try resolveWindow(target)
            try capture(window: window, to: try arguments.required("out"))
            try respond(["ok": true, "target": "window", "window": window.json, "display": boundsJSON(displayBounds())])
        } else {
            try captureScreen(to: try arguments.required("out"))
            try respond(["ok": true, "target": "screen", "display": boundsJSON(displayBounds())])
        }
    case "elements":
        try requireAccessibility()
        let window = try resolveWindow(arguments.text("window"))
        let root = try accessibilityWindow(window)
        let maxElements = max(1, min(400, arguments.text("max").flatMap { Int($0) } ?? 150))
        let maxDepth = max(1, min(20, arguments.text("depth").flatMap { Int($0) } ?? 10))
        let collected = collectElements(root: root, maxElements: maxElements, maxDepth: maxDepth)
        try respond([
            "ok": true,
            "window": window.json,
            "display": boundsJSON(displayBounds()),
            "elements": collected.elements.map { $0.json },
            "truncated": collected.truncated,
        ])
    case "press":
        try requireAccessibility()
        let window = try resolveWindow(arguments.text("window"))
        let root = try accessibilityWindow(window)
        let ref = try arguments.required("ref")
        guard let element = elementAt(root, ref: ref) else {
            throw DriverFailure.message("No control at ref \(ref) any more. Read the element tree again and use a current ref.")
        }
        let identity = try requireSameIdentity(element, ref: ref, arguments: arguments)
        guard actionNames(element).contains(kAXPressAction as String) else {
            throw DriverFailure.message("The control at ref \(ref) has no press action. Click it with coordinates instead, or act on a parent control that does.")
        }
        let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard result == .success else {
            throw DriverFailure.message("The application refused the press on ref \(ref) (error \(result.rawValue)). Nothing was changed by this driver.")
        }
        try respond(["ok": true, "action": "press", "performed": identity, "window": window.json, "display": boundsJSON(displayBounds())])
    case "set-value":
        try requireAccessibility()
        let window = try resolveWindow(arguments.text("window"))
        let root = try accessibilityWindow(window)
        let ref = try arguments.required("ref")
        guard let element = elementAt(root, ref: ref) else {
            throw DriverFailure.message("No control at ref \(ref) any more. Read the element tree again and use a current ref.")
        }
        let identity = try requireSameIdentity(element, ref: ref, arguments: arguments)
        let value = try arguments.required("value")
        let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
        guard result == .success else {
            throw DriverFailure.message("The application refused a value on ref \(ref) (error \(result.rawValue)). Select the field with a click first, or type with coordinates.")
        }
        try respond(["ok": true, "action": "set_value", "performed": identity, "window": window.json, "display": boundsJSON(displayBounds())])
    case "act":
        try requireAccessibility()
        let action = try arguments.required("action")
        let selector = arguments.text("window")
        let window = action == "key" ? nil : try resolveWindow(selector)
        let bounds = window?.bounds ?? displayBounds()
        switch action {
        case "click", "double_click", "right_click":
            let button: CGMouseButton = action == "right_click" ? .right : .left
            let count = action == "double_click" ? 2 : 1
            try postClick(at: point(try arguments.normalized("x"), try arguments.normalized("y"), in: bounds), button: button, count: count)
        case "drag":
            let start = point(try arguments.normalized("from_x"), try arguments.normalized("from_y"), in: bounds)
            let end = point(try arguments.normalized("to_x"), try arguments.normalized("to_y"), in: bounds)
            let duration = arguments.text("duration_ms").flatMap { Int($0) } ?? 400
            guard duration >= 100, duration <= 5_000 else { throw DriverFailure.message("--duration_ms must be from 100 through 5000.") }
            try postDrag(from: start, to: end, durationMilliseconds: duration)
        case "scroll":
            try postScroll(deltaY: try arguments.integer("delta_y"), deltaX: (try? arguments.integer("delta_x")) ?? 0)
        case "type":
            guard let data = Data(base64Encoded: try arguments.required("text")), let text = String(data: data, encoding: .utf8) else {
                throw DriverFailure.message("Text input was not valid UTF-8.")
            }
            try postText(text)
        case "key":
            let name = try arguments.required("key").lowercased()
            guard let code = keyCodes[name] else { throw DriverFailure.message("Unsupported key: \(name). Supported keys are \(keyCodes.keys.sorted().joined(separator: ", ")).") }
            try postKey(code, flags: try flagValue(arguments.text("flags")))
        case "focus":
            guard let window else { throw DriverFailure.message("Focus needs an on-screen window.") }
            try focusWindow(window)
        default:
            throw DriverFailure.message("Unsupported desktop action: \(action).")
        }
        try respond([
            "ok": true,
            "action": action,
            "target": window?.json ?? ["screen": true],
            "bounds": boundsJSON(bounds),
            "display": boundsJSON(displayBounds()),
        ])
    default:
        throw DriverFailure.message("Unsupported desktop driver command: \(arguments.command).")
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
