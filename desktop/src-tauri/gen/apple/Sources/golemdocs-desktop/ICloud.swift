import Foundation

// The iCloud Drive folder that holds the vault on a phone (desktop/src-tauri/src/icloud.rs calls these).
// The container's Documents folder is what appears as iCloud Drive > GolemDocs on every device.

/// The vault folder inside the app's iCloud container, made if it isn't there. Nil when iCloud is off or the
/// person isn't signed in. The caller frees the string. Must not run on the main thread (the first call can wait).
@_cdecl("golem_icloud_documents")
public func golemICloudDocuments() -> UnsafeMutablePointer<CChar>? {
    guard let container = FileManager.default.url(forUbiquityContainerIdentifier: nil) else { return nil }
    let documents = container.appendingPathComponent("Documents", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
    } catch {
        return nil
    }
    return strdup(documents.path)
}

/// Asks iCloud to download a file that is only a placeholder here. True if the request was accepted.
@_cdecl("golem_icloud_download")
public func golemICloudDownload(_ path: UnsafePointer<CChar>) -> Bool {
    let url = URL(fileURLWithPath: String(cString: path))
    do {
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        return true
    } catch {
        return false
    }
}
