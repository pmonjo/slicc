import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "WebappOverlay")

/// On-disk store of unpacked `dist/ui` directories that override the one
/// shipped inside Sliccstart.app. Keyed by version so we can hot-swap
/// between releases without redownloading and prune older versions later.
///
/// Layout:
///   ~/Library/Application Support/Sliccstart/ui-overlays/
///     active.json              ← { "version": "2.55.0" }
///     2.55.0/                  ← contents of dist/ui
///     2.55.0.zip               ← original asset (kept for re-extraction)
struct WebappOverlayStore {
    let rootDirectory: URL

    init(rootDirectory: URL = WebappOverlayStore.defaultRootDirectory) {
        self.rootDirectory = rootDirectory
    }

    static var defaultRootDirectory: URL {
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
        return support
            .appendingPathComponent("Sliccstart", isDirectory: true)
            .appendingPathComponent("ui-overlays", isDirectory: true)
    }

    private var activePointerURL: URL {
        rootDirectory.appendingPathComponent("active.json")
    }

    /// Path to the active overlay's `dist/ui`-equivalent directory, or
    /// nil when no overlay is set or the pointed-at directory is missing.
    func activeOverlayPath() -> String? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: activePointerURL.path) else { return nil }
        do {
            let data = try Data(contentsOf: activePointerURL)
            let pointer = try JSONDecoder().decode(OverlayPointer.self, from: data)
            let dir = rootDirectory.appendingPathComponent(pointer.version, isDirectory: true)
            return fm.fileExists(atPath: dir.path) ? dir.path : nil
        } catch {
            log.error("activeOverlayPath: failed to read pointer: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func activeVersion() -> String? {
        let fm = FileManager.default
        guard fm.fileExists(atPath: activePointerURL.path) else { return nil }
        guard let data = try? Data(contentsOf: activePointerURL),
              let pointer = try? JSONDecoder().decode(OverlayPointer.self, from: data) else {
            return nil
        }
        return pointer.version
    }

    func setActive(version: String) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: rootDirectory.path) {
            try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        }
        let data = try JSONEncoder().encode(OverlayPointer(version: version))
        try data.write(to: activePointerURL, options: .atomic)
        log.info("setActive: version=\(version, privacy: .public)")
    }

    /// Returns the directory where an overlay for `version` is/will be
    /// installed. Creates the parent directory but not the overlay dir
    /// itself (that's left to the unzip step).
    func overlayDirectory(for version: String) throws -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: rootDirectory.path) {
            try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        }
        return rootDirectory.appendingPathComponent(version, isDirectory: true)
    }

    /// Cached download path for the webapp zip.
    func zipPath(for version: String) throws -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: rootDirectory.path) {
            try fm.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        }
        return rootDirectory.appendingPathComponent("\(version).zip")
    }

    /// Install an already-downloaded zip as the overlay for `version`.
    /// Idempotent — if the overlay directory exists, it's removed first.
    func install(zipURL: URL, version: String) throws -> URL {
        let fm = FileManager.default
        let overlayDir = try overlayDirectory(for: version)
        if fm.fileExists(atPath: overlayDir.path) {
            try fm.removeItem(at: overlayDir)
        }
        try fm.createDirectory(at: overlayDir, withIntermediateDirectories: true)

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        task.arguments = ["-o", "-q", zipURL.path, "-d", overlayDir.path]
        let stderr = Pipe()
        task.standardError = stderr
        task.standardOutput = FileHandle.nullDevice
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            let detail = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? ""
            throw OverlayError.unzipFailed(detail.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return overlayDir
    }

    /// Delete every overlay other than `version`. Called after a
    /// successful activation to keep disk footprint bounded.
    func pruneOthers(keep version: String) {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(atPath: rootDirectory.path) else { return }
        for entry in contents {
            if entry == "active.json" { continue }
            if entry == version || entry == "\(version).zip" { continue }
            try? fm.removeItem(at: rootDirectory.appendingPathComponent(entry))
        }
    }

    private struct OverlayPointer: Codable {
        let version: String
    }

    enum OverlayError: LocalizedError {
        case unzipFailed(String)

        var errorDescription: String? {
            switch self {
            case .unzipFailed(let detail):
                return "Failed to unzip webapp overlay: \(detail)"
            }
        }
    }
}
