//! The vault: one folder on this computer that holds a copy of the account's files.
//!
//! The page never names a folder. The person picks it in a native dialog (`vault_choose`), it is kept here,
//! and every other command takes a path *inside* it. So a page, even a hostile one, can read and write only
//! the vault, and only files that are really inside it (no `..`, no absolute paths, no symbolic links).
//!
//! Files and folders whose name starts with a dot are not part of the vault's documents: `scan` skips them.
//! The one exception is `.golemdocs/`, where the sync state lives; `vault_read` and `vault_write` may use it
//! and nothing else may.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// Where the sync state is kept, inside the vault.
pub const STATE_DIR: &str = ".golemdocs";
/// The file (in the app's config folder) that remembers which folder is the vault.
const REMEMBERED: &str = "vault.json";

#[derive(Default)]
pub struct Vault {
    root: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Relative to the vault, with `/` between names on every system.
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct Remembered {
    root: String,
}

// ---- The rules, as plain functions (tested below) ----

/// Turns a relative path from the page into a path inside `root`, or says why not.
pub fn resolve(root: &Path, relative: &str, allow_state: bool) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.contains('\0') || relative.contains('\\') {
        return Err(format!("not a path inside the vault: {relative:?}"));
    }
    let mut names = Vec::new();
    for part in Path::new(relative).components() {
        match part {
            Component::Normal(name) => names.push(name.to_string_lossy().into_owned()),
            _ => return Err(format!("not a path inside the vault: {relative:?}")),
        }
    }
    let Some(first) = names.first() else {
        return Err(format!("not a path inside the vault: {relative:?}"));
    };
    if first.starts_with('.') && !(allow_state && first == STATE_DIR && names.len() > 1) {
        return Err(format!("not a document path: {relative:?}"));
    }
    // A link could point anywhere, so no part of the path that exists may be one.
    let mut path = root.to_path_buf();
    for name in &names {
        path.push(name);
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                return Err(format!("{relative:?} goes through a link"));
            }
        }
    }
    Ok(path)
}

/// Every document in the vault, sorted by path. Hidden names, links and anything that is not a file are left out.
pub fn scan(root: &Path) -> Result<Vec<Entry>, String> {
    let mut found = Vec::new();
    walk(root, "", &mut found).map_err(|e| e.to_string())?;
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

fn walk(dir: &Path, prefix: &str, found: &mut Vec<Entry>) -> std::io::Result<()> {
    for item in fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let kind = item.file_type()?;
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if kind.is_dir() {
            walk(&item.path(), &relative, found)?;
        } else if kind.is_file() {
            let meta = item.metadata()?;
            found.push(Entry { path: relative, size: meta.len(), mtime_ms: modified_ms(&meta) });
        }
    }
    Ok(())
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Writes through a hidden temporary file in the same folder and renames it into place, so a crash or a
/// reader never sees half a file. Returns the new modification time.
pub fn write(root: &Path, relative: &str, bytes: &[u8]) -> Result<u64, String> {
    let target = resolve(root, relative, true)?;
    let parent = target.parent().ok_or("no folder")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = target.file_name().ok_or("no name")?.to_string_lossy().into_owned();
    let temporary = parent.join(format!(".{name}.golemtmp"));
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &target).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        e.to_string()
    })?;
    let meta = fs::metadata(&target).map_err(|e| e.to_string())?;
    Ok(modified_ms(&meta))
}

/// Deletes a file, then any folders it leaves empty (up to, not including, the vault).
pub fn remove(root: &Path, relative: &str) -> Result<(), String> {
    let target = resolve(root, relative, false)?;
    fs::remove_file(&target).map_err(|e| e.to_string())?;
    let mut dir = target.parent();
    while let Some(folder) = dir {
        if folder == root || fs::remove_dir(folder).is_err() {
            break;
        }
        dir = folder.parent();
    }
    Ok(())
}

/// `%XX` escapes and UTF-8: how the page puts a name that is not ASCII into a header.
pub fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or("bad escape")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad escape")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "not UTF-8".to_string())
}

// ---- The commands ----

impl Vault {
    fn root(&self) -> Result<PathBuf, String> {
        self.root.lock().unwrap().clone().ok_or_else(|| "no vault folder chosen".to_string())
    }

    fn set(&self, root: Option<PathBuf>) {
        *self.root.lock().unwrap() = root;
    }

    /// Picks up the folder chosen in an earlier run, if it is still there.
    pub fn restore(&self, app: &AppHandle) {
        let Ok(dir) = app.path().app_config_dir() else { return };
        let Ok(text) = fs::read_to_string(dir.join(REMEMBERED)) else { return };
        let Ok(saved) = serde_json::from_str::<Remembered>(&text) else { return };
        let root = PathBuf::from(saved.root);
        if root.is_dir() {
            self.set(Some(root));
        }
    }
}

fn remember(app: &AppHandle, root: Option<&Path>) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let file = dir.join(REMEMBERED);
    match root {
        Some(root) => {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let text = serde_json::to_string(&Remembered { root: root.to_string_lossy().into_owned() }).map_err(|e| e.to_string())?;
            fs::write(file, text).map_err(|e| e.to_string())
        }
        None => match fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    }
}

/// The vault folder, or null when none is chosen.
#[tauri::command]
pub fn vault_root(vault: State<'_, Vault>) -> Option<String> {
    vault.root().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Asks the person for a folder and makes it the vault. Null if they cancel.
#[tauri::command]
pub async fn vault_choose(app: AppHandle, vault: State<'_, Vault>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let root = picked.into_path().map_err(|e| e.to_string())?;
    remember(&app, Some(&root))?;
    let shown = root.to_string_lossy().into_owned();
    vault.set(Some(root));
    Ok(Some(shown))
}

/// Stops using the vault folder. Its files stay where they are.
#[tauri::command]
pub fn vault_forget(app: AppHandle, vault: State<'_, Vault>) -> Result<(), String> {
    remember(&app, None)?;
    vault.set(None);
    Ok(())
}

#[tauri::command]
pub fn vault_scan(vault: State<'_, Vault>) -> Result<Vec<Entry>, String> {
    scan(&vault.root()?)
}

#[tauri::command]
pub fn vault_read(path: String, vault: State<'_, Vault>) -> Result<tauri::ipc::Response, String> {
    let file = resolve(&vault.root()?, &path, true)?;
    fs::read(file).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The bytes are the request body and the percent-encoded path is the `path` header (a body can't carry both).
#[tauri::command]
pub fn vault_write(request: tauri::ipc::Request<'_>, vault: State<'_, Vault>) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".to_string());
    };
    let path = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("missing path")?;
    write(&vault.root()?, &percent_decode(path)?, bytes)
}

#[tauri::command]
pub fn vault_remove(path: String, vault: State<'_, Vault>) -> Result<(), String> {
    remove(&vault.root()?, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn resolve_keeps_to_the_vault() {
        let dir = vault();
        let root = dir.path();
        assert_eq!(resolve(root, "a/b.docx", false).unwrap(), root.join("a").join("b.docx"));
        assert_eq!(resolve(root, "a/./b", false).unwrap(), root.join("a").join("b"), "a lone dot is harmless");
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "./../x", "a\\b", "a\0b", ".hidden", "a/.."] {
            assert!(resolve(root, bad, true).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn the_state_folder_is_only_for_reading_and_writing() {
        let dir = vault();
        let root = dir.path();
        assert!(resolve(root, ".golemdocs/state.json", true).is_ok());
        assert!(resolve(root, ".golemdocs/state.json", false).is_err());
        assert!(resolve(root, ".golemdocs", true).is_err());
        assert!(resolve(root, ".git/config", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_vault_is_refused() {
        let dir = vault();
        let outside = vault();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
        assert!(resolve(dir.path(), "out/secret.txt", false).is_err());
    }

    #[test]
    fn write_then_scan_then_remove() {
        let dir = vault();
        let root = dir.path();
        write(root, "Notes/one.md", b"hello").unwrap();
        write(root, "two.docx", b"world").unwrap();
        write(root, ".golemdocs/state.json", b"{}").unwrap();
        let found = scan(root).unwrap();
        assert_eq!(found.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["Notes/one.md", "two.docx"]);
        assert_eq!(found[0].size, 5);
        assert!(found[0].mtime_ms > 0);

        write(root, "Notes/one.md", b"changed").unwrap();
        assert_eq!(fs::read(root.join("Notes/one.md")).unwrap(), b"changed");
        assert!(!root.join("Notes/.one.md.golemtmp").exists());

        remove(root, "Notes/one.md").unwrap();
        assert!(!root.join("Notes").exists(), "the empty folder goes too");
        assert!(root.exists());
        assert!(remove(root, ".golemdocs/state.json").is_err());
    }

    #[test]
    fn decodes_header_paths() {
        assert_eq!(percent_decode("Notes/caf%C3%A9.md").unwrap(), "Notes/café.md");
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%C3").is_err());
    }
}
