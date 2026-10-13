//! The vault on a phone: a folder in the app's iCloud container, which appears as iCloud Drive › GolemDocs on every
//! device the person has (the Mac's vault can be pointed at the same folder). There is nothing to choose, and iOS lets
//! an app sync only while it runs, so the page syncs on opening and while it is open.
//!
//! iCloud keeps a file that is not on this device as a hidden placeholder named `.<name>.icloud`. A scan that skipped
//! those would see the files as missing, and the sync would carry that to the account as deletions. So `scan` refuses
//! to run while any placeholder exists, asks iCloud to fetch each one (the Swift side, `ICloud.swift`), and the page
//! tries again shortly.

use std::path::{Path, PathBuf};

/// What `vault_scan` says while files are still coming down from iCloud; the page waits and tries again.
pub const DOWNLOADING: &str = "icloud-downloading";

/// The real name behind a placeholder's name (`.report.docx.icloud` is `report.docx`), or None for an ordinary name.
pub fn placeholder_target(name: &str) -> Option<String> {
    let inner = name.strip_prefix('.')?.strip_suffix(".icloud")?;
    (!inner.is_empty()).then(|| inner.to_string())
}

/// Every placeholder under `root`, as the path of the file it stands for. Looks through folders, skips the sync state.
pub fn placeholders(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    collect(root, &mut found)?;
    Ok(found)
}

fn collect(dir: &Path, found: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if let Some(real) = placeholder_target(&name) {
            found.push(dir.join(real));
        } else if !name.starts_with('.') && item.file_type()?.is_dir() {
            collect(&item.path(), found)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "ios")]
mod native {
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::path::{Path, PathBuf};

    extern "C" {
        fn golem_icloud_documents() -> *mut c_char;
        fn golem_icloud_download(path: *const c_char) -> bool;
        fn free(pointer: *mut c_void);
    }

    pub fn documents() -> Option<PathBuf> {
        // SAFETY: the Swift side returns null or a strdup'ed C string, which is copied and freed here.
        unsafe {
            let raw = golem_icloud_documents();
            if raw.is_null() {
                return None;
            }
            let path = CStr::from_ptr(raw).to_string_lossy().into_owned();
            free(raw.cast());
            Some(PathBuf::from(path))
        }
    }

    pub fn download(path: &Path) -> bool {
        let Ok(c) = CString::new(path.to_string_lossy().as_bytes()) else { return false };
        // SAFETY: `c` is a valid C string for the duration of the call.
        unsafe { golem_icloud_download(c.as_ptr()) }
    }
}

/// The vault folder in the iCloud container, or None when iCloud is off, the person is signed out of it, or this is
/// not an iPhone or iPad.
pub fn documents() -> Option<PathBuf> {
    #[cfg(target_os = "ios")]
    return native::documents();
    #[cfg(not(target_os = "ios"))]
    None
}

/// Asks iCloud to download the file a placeholder stands for.
pub fn download(path: &Path) -> bool {
    #[cfg(target_os = "ios")]
    return native::download(path);
    #[cfg(not(target_os = "ios"))]
    {
        let _ = path;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_placeholder_name_gives_the_real_name() {
        assert_eq!(placeholder_target(".report.docx.icloud").as_deref(), Some("report.docx"));
        assert_eq!(placeholder_target(".a b.md.icloud").as_deref(), Some("a b.md"));
        for plain in ["report.docx", ".hidden", ".icloud", "..icloud", "x.icloud"] {
            assert_eq!(placeholder_target(plain), None, "{plain}");
        }
    }

    #[test]
    fn placeholders_are_found_in_folders_but_not_in_the_state_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::create_dir_all(root.join(".golemdocs")).unwrap();
        std::fs::write(root.join("here.docx"), b"x").unwrap();
        std::fs::write(root.join(".there.docx.icloud"), b"").unwrap();
        std::fs::write(root.join("notes").join(".deep.md.icloud"), b"").unwrap();
        std::fs::write(root.join(".golemdocs").join(".state.json.icloud"), b"").unwrap();
        let mut found = placeholders(root).unwrap();
        found.sort();
        assert_eq!(found, vec![root.join("notes").join("deep.md"), root.join("there.docx")]);
    }
}
