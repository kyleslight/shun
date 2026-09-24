import AppKit
import Foundation

/**
 The controlled target for Computer Use's macOS closed loop.

 It is a plain AppKit window with two large, distinctly coloured buttons and a
 text field between them, and it records every click and every keystroke it
 receives to the file given as the first argument. That makes the loop
 independently verifiable: the driver acts on a normalized coordinate, and this
 process — not the driver — says what arrived.

 The window title carries the last action, so the fresh screenshot the driver
 returns after an action shows the new state as well.

 Layout, from the bottom of the 480x420 content area:

   bottom button   y   0 ... 140   green
   text field      y 150 ... 270   typed text, Enter recorded as a key
   top button      y 280 ... 420   red

 Build and run:
   swiftc -O scripts/desktop-loop-target.swift -o /tmp/shun-desktop-loop-target
   /tmp/shun-desktop-loop-target /tmp/shun-desktop-loop-target.log
 It is built and driven for you by scripts/desktop-loop.mjs (pnpm smoke:computer-use).
*/

let targetWidth = 480.0
let targetHeight = 420.0

final class Recorder {
    private let path: String

    init(path: String) {
        self.path = path
        try? FileManager.default.removeItem(atPath: path)
    }

    func record(_ event: String) {
        let line = "\(event)\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            handle.closeFile()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }
}

final class Controller: NSObject, NSTextFieldDelegate {
    let recorder: Recorder
    let window: NSWindow
    let topButton = NSButton(title: "LEFT", target: nil, action: nil)
    let bottomButton = NSButton(title: "RIGHT", target: nil, action: nil)
    let field = NSTextField(string: "")

    init(recorder: Recorder) {
        self.recorder = recorder
        self.window = NSWindow(
            contentRect: NSRect(x: 240, y: 240, width: targetWidth, height: targetHeight),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.title = "loop target: nothing yet"
        window.isReleasedWhenClosed = false

        topButton.frame = NSRect(x: 0, y: 280, width: targetWidth, height: 140)
        bottomButton.frame = NSRect(x: 0, y: 0, width: targetWidth, height: 140)
        for button in [topButton, bottomButton] {
            button.bezelStyle = .regularSquare
            button.font = NSFont.boldSystemFont(ofSize: 36)
            button.isBordered = false
            button.wantsLayer = true
        }
        topButton.layer?.backgroundColor = NSColor.systemRed.cgColor
        bottomButton.layer?.backgroundColor = NSColor.systemGreen.cgColor
        topButton.target = self
        topButton.action = #selector(clickedTop)
        bottomButton.target = self
        bottomButton.action = #selector(clickedBottom)

        field.frame = NSRect(x: 0, y: 150, width: targetWidth, height: 120)
        field.font = NSFont.systemFont(ofSize: 28)
        field.alignment = .center
        field.placeholderString = "type here"
        field.delegate = self
        field.target = self
        field.action = #selector(submitted)

        window.contentView?.addSubview(topButton)
        window.contentView?.addSubview(field)
        window.contentView?.addSubview(bottomButton)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @objc private func clickedTop() { record("CLICK LEFT", title: "loop target: clicked LEFT") }
    @objc private func clickedBottom() { record("CLICK RIGHT", title: "loop target: clicked RIGHT") }

    // Every keystroke the field receives is recorded, so typing is verified by the
    // text that actually arrived rather than by the absence of an error.
    func controlTextDidChange(_ notification: Notification) {
        recorder.record("TYPED:\(field.stringValue)")
        window.title = "loop target: typed \(field.stringValue)"
    }

    @objc private func submitted() {
        recorder.record("KEY return")
        window.title = "loop target: entered"
    }

    private func record(_ event: String, title: String) {
        recorder.record(event)
        window.title = title
    }
}

let arguments = CommandLine.arguments
let logPath = arguments.count > 1 ? arguments[1] : "/tmp/shun-desktop-loop-target.log"
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let controller = Controller(recorder: Recorder(path: logPath))
withExtendedLifetime(controller) {
    application.run()
}
