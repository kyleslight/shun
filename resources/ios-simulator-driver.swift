import AppKit
import ApplicationServices
import Foundation

enum DriverFailure: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value): return value
        }
    }
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
    attribute(element, name) as? String ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func findElement(_ root: AXUIElement, where predicate: (AXUIElement) -> Bool, depth: Int = 0) -> AXUIElement? {
    if predicate(root) { return root }
    if depth >= 12 { return nil }
    for child in children(root) {
        if let match = findElement(child, where: predicate, depth: depth + 1) { return match }
    }
    return nil
}

func focusedSimulator() throws -> (NSRunningApplication, AXUIElement, AXUIElement) {
    guard AXIsProcessTrusted() else {
        throw DriverFailure.message("Accessibility permission is required. Enable Shun in System Settings > Privacy & Security > Accessibility, then retry.")
    }
    guard let simulator = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first else {
        throw DriverFailure.message("Simulator is not running. Boot and open the selected device first.")
    }
    _ = simulator.activate(options: [.activateAllWindows])
    usleep(180_000)
    let app = AXUIElementCreateApplication(simulator.processIdentifier)
    guard let windowValue = attribute(app, kAXFocusedWindowAttribute as CFString) ?? attribute(app, kAXMainWindowAttribute as CFString),
          CFGetTypeID(windowValue) == AXUIElementGetTypeID() else {
        throw DriverFailure.message("Could not find the active Simulator window.")
    }
    let window = unsafeBitCast(windowValue, to: AXUIElement.self)
    guard let content = findElement(window, where: {
        stringAttribute($0, kAXSubroleAttribute as CFString) == "iOSContentGroup"
    }) else {
        throw DriverFailure.message("Could not find the active iOS display inside Simulator.")
    }
    return (simulator, app, content)
}

func frame(_ element: AXUIElement) throws -> CGRect {
    guard let positionRaw = attribute(element, kAXPositionAttribute as CFString),
          let sizeRaw = attribute(element, kAXSizeAttribute as CFString),
          CFGetTypeID(positionRaw) == AXValueGetTypeID(),
          CFGetTypeID(sizeRaw) == AXValueGetTypeID() else {
        throw DriverFailure.message("Could not read the iOS display bounds.")
    }
    let positionValue = unsafeBitCast(positionRaw, to: AXValue.self)
    let sizeValue = unsafeBitCast(sizeRaw, to: AXValue.self)
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size), size.width > 0, size.height > 0 else {
        throw DriverFailure.message("Simulator returned invalid iOS display bounds.")
    }
    return CGRect(origin: position, size: size)
}

func normalizedPoint(_ x: Double, _ y: Double, in bounds: CGRect) throws -> CGPoint {
    guard x >= 0, x <= 1, y >= 0, y <= 1 else {
        throw DriverFailure.message("Touch coordinates must be normalized values from 0 through 1.")
    }
    return CGPoint(x: bounds.minX + bounds.width * x, y: bounds.minY + bounds.height * y)
}

func mouseEvent(_ type: CGEventType, point: CGPoint) throws -> CGEvent {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        throw DriverFailure.message("Could not create a Simulator pointer event.")
    }
    return event
}

func postTap(_ point: CGPoint) throws {
    try mouseEvent(.mouseMoved, point: point).post(tap: .cghidEventTap)
    usleep(30_000)
    try mouseEvent(.leftMouseDown, point: point).post(tap: .cghidEventTap)
    usleep(70_000)
    try mouseEvent(.leftMouseUp, point: point).post(tap: .cghidEventTap)
}

func postSwipe(from start: CGPoint, to end: CGPoint, durationMilliseconds: Int) throws {
    let steps = max(8, min(120, durationMilliseconds / 12))
    try mouseEvent(.mouseMoved, point: start).post(tap: .cghidEventTap)
    try mouseEvent(.leftMouseDown, point: start).post(tap: .cghidEventTap)
    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
        try mouseEvent(.leftMouseDragged, point: point).post(tap: .cghidEventTap)
        usleep(useconds_t(max(1_000, durationMilliseconds * 1_000 / steps)))
    }
    try mouseEvent(.leftMouseUp, point: end).post(tap: .cghidEventTap)
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        throw DriverFailure.message("Could not create a Simulator keyboard event.")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func postText(_ text: String) throws {
    for character in text {
        if character == "\n" || character == "\r" {
            try postKey(36)
        } else if character == "\t" {
            try postKey(48)
        } else {
            var units = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                throw DriverFailure.message("Could not create a Simulator text event.")
            }
            units.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
        usleep(8_000)
    }
}

func pressMenuItem(_ app: AXUIElement, title: String) throws {
    guard let menuBarRaw = attribute(app, kAXMenuBarAttribute as CFString),
          CFGetTypeID(menuBarRaw) == AXUIElementGetTypeID() else {
        throw DriverFailure.message("Simulator menu bar is unavailable.")
    }
    let menuBar = unsafeBitCast(menuBarRaw, to: AXUIElement.self)
    guard let item = findElement(menuBar, where: {
              stringAttribute($0, kAXRoleAttribute as CFString) == (kAXMenuItemRole as String)
                  && stringAttribute($0, kAXTitleAttribute as CFString) == title
          }) else {
        throw DriverFailure.message("Simulator menu action is unavailable: \(title).")
    }
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else {
        throw DriverFailure.message("Simulator could not perform menu action: \(title).")
    }
}

func doubleArgument(_ args: [String], _ index: Int, name: String) throws -> Double {
    guard args.indices.contains(index), let value = Double(args[index]), value.isFinite else {
        throw DriverFailure.message("Missing or invalid \(name).")
    }
    return value
}

func integerArgument(_ args: [String], _ index: Int, name: String) throws -> Int {
    guard args.indices.contains(index), let value = Int(args[index]) else {
        throw DriverFailure.message("Missing or invalid \(name).")
    }
    return value
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let action = args.first else { throw DriverFailure.message("An interaction action is required.") }
    let (_, app, content) = try focusedSimulator()
    let display = try frame(content)

    switch action {
    case "probe":
        break
    case "tap":
        let point = try normalizedPoint(doubleArgument(args, 1, name: "x"), doubleArgument(args, 2, name: "y"), in: display)
        try postTap(point)
    case "swipe":
        let start = try normalizedPoint(doubleArgument(args, 1, name: "start x"), doubleArgument(args, 2, name: "start y"), in: display)
        let end = try normalizedPoint(doubleArgument(args, 3, name: "end x"), doubleArgument(args, 4, name: "end y"), in: display)
        let duration = try integerArgument(args, 5, name: "duration")
        guard duration >= 100, duration <= 2_000 else { throw DriverFailure.message("Swipe duration must be between 100 and 2000 milliseconds.") }
        try postSwipe(from: start, to: end, durationMilliseconds: duration)
    case "type":
        guard args.indices.contains(1), let data = Data(base64Encoded: args[1]), let text = String(data: data, encoding: .utf8) else {
            throw DriverFailure.message("Text input was not valid UTF-8.")
        }
        try postText(text)
    case "button":
        guard args.indices.contains(1) else { throw DriverFailure.message("A Simulator button is required.") }
        let titles = [
            "home": "Home",
            "lock": "Lock",
            "shake": "Shake",
            "app_switcher": "App Switcher",
            "rotate_left": "Rotate Left",
            "rotate_right": "Rotate Right",
        ]
        guard let title = titles[args[1]] else { throw DriverFailure.message("Unsupported Simulator button: \(args[1]).") }
        try pressMenuItem(app, title: title)
    default:
        throw DriverFailure.message("Unsupported interaction action: \(action).")
    }

    let response: [String: Any] = [
        "ok": true,
        "action": action,
        "display": ["x": display.origin.x, "y": display.origin.y, "width": display.width, "height": display.height],
    ]
    let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
