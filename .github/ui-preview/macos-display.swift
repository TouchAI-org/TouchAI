import AppKit
import CoreGraphics
import Foundation

let minimumLogicalWidth = 1280
let minimumLogicalHeight = 800
let maximumPixelWidth = 3840
let maximumPixelHeight = 2160
let previewDesktopColour = "#d9d4c8"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func pixelRatio(_ mode: CGDisplayMode) -> Double {
    guard mode.width > 0, mode.height > 0 else {
        return 1
    }

    return Double(mode.pixelWidth) / Double(mode.width)
}

func isWithinCaptureLimit(_ mode: CGDisplayMode) -> Bool {
    mode.pixelWidth <= maximumPixelWidth && mode.pixelHeight <= maximumPixelHeight
}

func isHiDpi(_ mode: CGDisplayMode) -> Bool {
    let ratio = pixelRatio(mode)

    return ratio >= 1.99
        && ratio <= 2.01
        && mode.width >= minimumLogicalWidth
        && mode.height >= minimumLogicalHeight
        && isWithinCaptureLimit(mode)
}

func isUnscaled(_ mode: CGDisplayMode) -> Bool {
    mode.width >= minimumLogicalWidth
        && mode.height >= minimumLogicalHeight
        && mode.pixelWidth == mode.width
        && mode.pixelHeight == mode.height
        && isWithinCaptureLimit(mode)
}

func isUsable(_ mode: CGDisplayMode) -> Bool {
    isHiDpi(mode) || isUnscaled(mode)
}

func modeArea(_ mode: CGDisplayMode) -> Int {
    mode.pixelWidth * mode.pixelHeight
}

func sameMode(_ left: CGDisplayMode, _ right: CGDisplayMode) -> Bool {
    left.width == right.width
        && left.height == right.height
        && left.pixelWidth == right.pixelWidth
        && left.pixelHeight == right.pixelHeight
}

func describe(_ mode: CGDisplayMode) -> String {
    "\(mode.width)x\(mode.height) points, \(mode.pixelWidth)x\(mode.pixelHeight) pixels, \(String(format: "%.2f", pixelRatio(mode)))x"
}

func setPreviewDesktopBackground() {
    guard let screen = NSScreen.main ?? NSScreen.screens.first else {
        fail("No screen is available for the preview desktop background")
    }

    let hex = String(previewDesktopColour.dropFirst())
    guard previewDesktopColour.hasPrefix("#"),
          hex.count == 6,
          let value = UInt64(hex, radix: 16)
    else {
        fail("Invalid preview desktop colour: \(previewDesktopColour)")
    }

    let colour = NSColor(
        srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
        green: CGFloat((value >> 8) & 0xFF) / 255,
        blue: CGFloat(value & 0xFF) / 255,
        alpha: 1
    )
    let width = max(1, Int((screen.frame.width * screen.backingScaleFactor).rounded()))
    let height = max(1, Int((screen.frame.height * screen.backingScaleFactor).rounded()))

    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else {
        fail("Could not create the preview desktop background image")
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    colour.setFill()
    NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)).fill()
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        fail("Could not encode the preview desktop background")
    }

    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("touchai-ui-preview-desktop.png")

    do {
        try data.write(to: url)
        try NSWorkspace.shared.setDesktopImageURL(
            url,
            for: screen,
            options: [.imageScaling: NSImageScaling.scaleAxesIndependently.rawValue]
        )
    } catch {
        fail("Could not set the preview desktop background: \(error)")
    }

    print("preview desktop: \(previewDesktopColour)")
}

func selectCandidates(_ modes: [CGDisplayMode]) -> [CGDisplayMode] {
    var candidates: [CGDisplayMode] = []

    // Every platform publishes the same 1920x1080 stage. An unscaled mode is
    // the exact match; a 2x mode keeps that logical layout only as a fallback
    // when the hosted runner cannot expose an unscaled 1080p mode.
    if let preferred = modes.first(where: {
        $0.width == 1920 && $0.height == 1080 && isUnscaled($0)
    }), !candidates.contains(where: { sameMode($0, preferred) }) {
        candidates.append(preferred)
    }

    if let hiDpi = modes.first(where: {
        $0.width == 1920 && $0.height == 1080 && isHiDpi($0)
    }), !candidates.contains(where: { sameMode($0, hiDpi) }) {
        candidates.append(hiDpi)
    }

    for mode in modes.filter(isUnscaled).sorted(by: { modeArea($0) < modeArea($1) }) {
        if !candidates.contains(where: { sameMode($0, mode) }) {
            candidates.append(mode)
        }
    }

    if let hiDpi = modes.filter(isHiDpi).max(by: { modeArea($0) < modeArea($1) }),
       !candidates.contains(where: { sameMode($0, hiDpi) }) {
        candidates.append(hiDpi)
    }

    return candidates
}

let argument = CommandLine.arguments.dropFirst().first ?? "--check"

guard ["--check", "--configure-hosted", "--list"].contains(argument) else {
    fail("Usage: swift macos-display.swift [--check|--configure-hosted|--list]")
}

let display = CGMainDisplayID()
let modes = (CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode]) ?? []

if argument == "--list" {
    for mode in modes.sorted(by: { modeArea($0) > modeArea($1) }) {
        print("\(isUsable(mode) ? "usable" : "skip") \(describe(mode))")
    }
    exit(0)
}

if argument == "--configure-hosted" {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        fail("Display configuration is only allowed on the disposable hosted runner")
    }

    let candidates = selectCandidates(modes)

    guard !candidates.isEmpty else {
        fail(
            "No display mode at least "
                + "\(minimumLogicalWidth)x\(minimumLogicalHeight) is available"
        )
    }

    let current = CGDisplayCopyDisplayMode(display)
    var applied = current.map { sameMode($0, candidates[0]) } ?? false

    for selected in candidates where !applied {
        var configuration: CGDisplayConfigRef?

        guard CGBeginDisplayConfiguration(&configuration) == .success,
              let configuration
        else {
            print("cannot begin display configuration")
            continue
        }

        guard CGConfigureDisplayWithDisplayMode(configuration, display, selected, nil) == .success
        else {
            CGCancelDisplayConfiguration(configuration)
            print("cannot select the \(describe(selected)) display mode")
            continue
        }

        guard CGCompleteDisplayConfiguration(configuration, .forSession) == .success else {
            print("cannot apply the \(describe(selected)) display mode")
            continue
        }

        applied = true
        Thread.sleep(forTimeInterval: 1)
    }

    if !applied {
        fail("Cannot apply any usable display mode")
    }
}

guard let actual = CGDisplayCopyDisplayMode(display) else {
    fail("No active display mode")
}

guard isUsable(actual) else {
    fail(
        "Display is \(describe(actual)); "
            + "native capture needs a 2x HiDPI mode or an unscaled mode at least "
            + "\(minimumLogicalWidth)x\(minimumLogicalHeight)"
    )
}

let scale = Int(pixelRatio(actual).rounded())
let stageWidth = scale > 1 ? actual.width : actual.pixelWidth
let stageHeight = scale > 1 ? actual.height : actual.pixelHeight
let stageTop = min(64, max(32, Int((Double(stageHeight) * 0.05).rounded())))

print(
    "display: \(describe(actual)); stage: "
        + "\(stageWidth)x\(stageHeight) logical, "
        + "\(stageWidth * scale)x\(stageHeight * scale) pixels"
)

if let envPath = ProcessInfo.processInfo.environment["GITHUB_ENV"] {
    let lines = [
        "UI_PREVIEW_DISPLAY_WIDTH=\(actual.pixelWidth)",
        "UI_PREVIEW_DISPLAY_HEIGHT=\(actual.pixelHeight)",
        "UI_PREVIEW_STAGE_WIDTH=\(stageWidth)",
        "UI_PREVIEW_STAGE_HEIGHT=\(stageHeight)",
        "UI_PREVIEW_STAGE_TOP=\(stageTop)",
        "UI_PREVIEW_SCALE_FACTOR=\(scale)",
    ].joined(separator: "\n") + "\n"

    if let handle = FileHandle(forWritingAtPath: envPath) {
        handle.seekToEndOfFile()
        handle.write(Data(lines.utf8))
        handle.closeFile()
    } else {
        try? lines.write(toFile: envPath, atomically: true, encoding: .utf8)
    }
}

if argument == "--configure-hosted" {
    setPreviewDesktopBackground()
    Thread.sleep(forTimeInterval: 1)
}
