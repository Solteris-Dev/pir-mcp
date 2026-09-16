// select-rect.swift — an interactive rectangle selector for macOS that prints
// "x,y wxh" in screencapture's coordinate space (points, origin top-left of
// the main display), so it can serve as PIR_SELECT_CMD:
//
//   PIR_SELECT_CMD='swift /path/to/select-rect.swift'
//
// Drag to select; Escape cancels (exit 1). Untested: written blind on Linux
// as a starting point. Things most likely to need a fix on a real Mac:
//   * the y flip (AppKit origin is bottom-left; screencapture -R wants top-left)
//   * multi-display layouts (this covers every screen with one window each,
//     but the coordinate union assumes NSScreen.screens[0] is the main display)
//   * Screen Recording permission is not needed for the overlay itself, only
//     for the capture command that runs afterwards.
import AppKit

final class SelectView: NSView {
    var start: NSPoint?
    var current: NSPoint?
    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with e: NSEvent) { start = e.locationInWindow; current = start; needsDisplay = true }
    override func mouseDragged(with e: NSEvent) { current = e.locationInWindow; needsDisplay = true }
    override func mouseUp(with e: NSEvent) {
        guard let s = start, let c = current, let win = window else { return }
        let r = NSRect(x: min(s.x, c.x), y: min(s.y, c.y), width: abs(c.x - s.x), height: abs(c.y - s.y))
        if r.width < 1 || r.height < 1 { exit(1) }
        // window coords -> screen coords (bottom-left origin)
        let screenRect = win.convertToScreen(r)
        // -> top-left origin, as screencapture -R expects
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let x = Int(screenRect.origin.x.rounded())
        let y = Int((mainHeight - screenRect.origin.y - screenRect.height).rounded())
        print("\(x),\(y) \(Int(screenRect.width.rounded()))x\(Int(screenRect.height.rounded()))")
        exit(0)
    }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { exit(1) } } // Escape
    override func draw(_ dirty: NSRect) {
        NSColor(white: 0, alpha: 0.25).setFill(); dirty.fill()
        guard let s = start, let c = current else { return }
        let r = NSRect(x: min(s.x, c.x), y: min(s.y, c.y), width: abs(c.x - s.x), height: abs(c.y - s.y))
        NSColor.clear.setFill(); r.fill(using: .copy)
        NSColor.white.setStroke(); NSBezierPath(rect: r).stroke()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var windows: [NSWindow] = []
for screen in NSScreen.screens {
    let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    w.level = .screenSaver
    w.isOpaque = false
    w.backgroundColor = .clear
    w.ignoresMouseEvents = false
    w.contentView = SelectView(frame: NSRect(origin: .zero, size: screen.frame.size))
    w.makeKeyAndOrderFront(nil)
    windows.append(w)
}
NSCursor.crosshair.set()
app.activate(ignoringOtherApps: true)
app.run()
