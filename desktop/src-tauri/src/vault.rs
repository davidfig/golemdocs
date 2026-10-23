//! The vault: one folder on this computer that holds a copy of the account's files.
//!
//! The page never names a folder. The person picks it in a native dialog (`vault_choose`), it is kept here,
//! and every other command takes a path *inside* it. So a page, even a hostile one, can read and write only
//! the vault, and only files that are really inside it (no `..`, no absolute paths, no symbolic links).
//!
//! Files and folders whose name starts with a dot are not part of the vault's documents: `scan` skips them.
//! The one exception is `.golemdocs/`, where the sync state lives; `vault_read` and `vault_write` may use it
//! and nothing else may.

// The folder is chosen and remembered on desktop; on a phone it is fixed (see icloud.rs).
#![cfg_attr(mobile, allow(dead_code))]

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
    /// A folder to keep `.golemdocs/` in instead of the vault. Set on a phone, where the vault is shared through iCloud
    /// with other devices, each of which must have its own sync state; None keeps the state inside the vault.
    state_home: Mutex<Option<PathBuf>>,
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

/// Whether the app may read and write in the vault folder. The first read of a protected folder (Documents, Desktop,
/// Downloads, iCloud Drive) is what makes macOS ask the person for permission, so this is called before every sync: a
/// refusal comes back as a message to show, and asking again after the person allowed it works.
pub fn check_access(root: &Path) -> Result<(), String> {
    let shown = root.display();
    if !root.is_dir() {
        return Err(format!("The folder {shown} is missing."));
    }
    fs::read_dir(root).map_err(|e| format!("Can't read {shown}: {e}"))?;
    let probe = root.join(".golemdocs-access");
    fs::write(&probe, b"").map_err(|e| format!("Can't write in {shown}: {e}"))?;
    let _ = fs::remove_file(&probe);
    Ok(())
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

    /// Where a path is looked up: the sync state goes to `state_home` when there is one, everything else to the vault.
    fn locate(&self, path: &str) -> Result<PathBuf, String> {
        let in_state = path.strip_prefix(STATE_DIR).is_some_and(|rest| rest.starts_with('/'));
        if in_state {
            if let Some(home) = self.state_home.lock().unwrap().clone() {
                return Ok(home);
            }
        }
        self.root()
    }

    /// Whether the folder is fixed (iCloud on a phone): there is nothing for the person to choose or stop.
    fn fixed(&self) -> bool {
        self.state_home.lock().unwrap().is_some()
    }

    /// Makes the app's iCloud folder the vault (iPhone and iPad). Says why not when iCloud is off.
    #[cfg_attr(desktop, allow(dead_code))]
    pub fn use_icloud(&self, app: &AppHandle) -> Result<(), String> {
        let root = crate::icloud::documents().ok_or("iCloud Drive is off, or this device is not signed in to iCloud")?;
        let home = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        *self.state_home.lock().unwrap() = Some(home);
        self.set(Some(root));
        Ok(())
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
    if vault.fixed() {
        return Err("the vault is the app's iCloud Drive folder".to_string());
    }
    choose(app, vault).await
}

#[cfg(mobile)]
async fn choose(_app: AppHandle, _vault: State<'_, Vault>) -> Result<Option<String>, String> {
    Err("choosing a folder is not available on this device".to_string())
}

#[cfg(desktop)]
async fn choose(app: AppHandle, vault: State<'_, Vault>) -> Result<Option<String>, String> {
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
    if vault.fixed() {
        return Err("the vault is the app's iCloud Drive folder".to_string());
    }
    remember(&app, None)?;
    vault.set(None);
    Ok(())
}

/// Checks that the vault folder can be read and written, which also makes macOS ask for permission the first time.
#[tauri::command]
pub async fn vault_check(vault: State<'_, Vault>) -> Result<(), String> {
    check_access(&vault.root()?)
}

/// Opens the system's privacy settings for files and folders (macOS), where the person allows the app a folder.
#[tauri::command]
pub fn vault_open_privacy() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("not available on this system".to_string());
    }
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Shows the vault folder in the system's file manager (Finder, Explorer). The page names nothing: it is always the
/// vault's own root.
#[tauri::command]
pub fn vault_reveal(vault: State<'_, Vault>) -> Result<(), String> {
    let root = vault.root()?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(root).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_scan(vault: State<'_, Vault>) -> Result<Vec<Entry>, String> {
    let root = vault.root()?;
    if vault.fixed() {
        // Files that are only placeholders here would look deleted: get them first, and let the page ask again.
        let pending = crate::icloud::placeholders(&root).map_err(|e| e.to_string())?;
        if !pending.is_empty() {
            for file in &pending {
                crate::icloud::download(file);
            }
            return Err(crate::icloud::DOWNLOADING.to_string());
        }
    }
    scan(&root)
}

#[tauri::command]
pub fn vault_read(path: String, vault: State<'_, Vault>) -> Result<tauri::ipc::Response, String> {
    let file = resolve(&vault.locate(&path)?, &path, true)?;
    fs::read(file).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The bytes are the request body and the percent-encoded path is the `path` header (a body can't carry both).
/// The file's bytes from a request body. The page sends them raw, but when the web view refuses the custom-protocol
/// request (a page on another origin, or one failed fetch, makes it use `postMessage` for the rest of the session) they
/// arrive as a JSON array of numbers instead.
pub fn body_bytes(body: &tauri::ipc::InvokeBody) -> Result<std::borrow::Cow<'_, [u8]>, String> {
    use std::borrow::Cow;
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| item.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect::<Option<Vec<u8>>>()
            .map(Cow::Owned)
            .ok_or_else(|| "expected the file's bytes".to_string()),
        _ => Err("expected the file's bytes".to_string()),
    }
}

#[tauri::command]
pub fn vault_write(request: tauri::ipc::Request<'_>, vault: State<'_, Vault>) -> Result<u64, String> {
    let bytes = body_bytes(request.body())?;
    let path = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("missing path")?;
    let path = percent_decode(path)?;
    write(&vault.locate(&path)?, &path, &bytes)
}

/// Base64 (RFC 4648, with padding): how the `_base64` commands carry a file. A string is one JSON value whichever way the web
/// view sends it, where raw bytes become an array of numbers when it uses `postMessage` (see `body_bytes`), several
/// times the size and far too slow for a file of tens of megabytes.
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let bad = || "expected the file's bytes as base64".to_string();
    let text = text.as_bytes();
    if text.len() % 4 != 0 {
        return Err(bad());
    }
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let quads = text.len() / 4;
    for (q, quad) in text.chunks(4).enumerate() {
        // Padding only at the very end: one or two `=`.
        let pad = if q + 1 == quads { quad.iter().rev().take_while(|&&c| c == b'=').count() } else { 0 };
        if pad > 2 {
            return Err(bad());
        }
        let mut n = 0u32;
        for &c in &quad[..4 - pad] {
            n = (n << 6) | u32::from(value(c).ok_or_else(bad)?);
        }
        n <<= 6 * pad as u32;
        out.extend_from_slice(&n.to_be_bytes()[1..4 - pad]);
    }
    Ok(out)
}

/// `vault_read` with the file as base64 (see `BASE64`). An older shell has only `vault_read`.
#[tauri::command]
pub fn vault_read_base64(path: String, vault: State<'_, Vault>) -> Result<String, String> {
    let file = resolve(&vault.locate(&path)?, &path, true)?;
    fs::read(file).map(|bytes| base64_encode(&bytes)).map_err(|e| e.to_string())
}

/// `vault_write` with the file as base64 (see `BASE64`). An older shell has only `vault_write`.
#[tauri::command]
pub fn vault_write_base64(path: String, data: String, vault: State<'_, Vault>) -> Result<u64, String> {
    let bytes = base64_decode(&data)?;
    write(&vault.locate(&path)?, &path, &bytes)
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
    fn check_access_passes_for_a_folder_and_fails_for_a_missing_one() {
        let dir = vault();
        assert!(check_access(dir.path()).is_ok());
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none(), "the probe file is removed");
        let message = check_access(&dir.path().join("gone")).unwrap_err();
        assert!(message.contains("missing"));
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
    fn a_body_is_raw_bytes_or_a_json_array_of_them() {
        use tauri::ipc::InvokeBody;
        assert_eq!(body_bytes(&InvokeBody::Raw(vec![1, 2, 3])).unwrap().as_ref(), [1, 2, 3]);
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!([4, 5, 255]))).unwrap().as_ref(), [4, 5, 255]);
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([4, 256]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({ "a": 1 }))).is_err());
    }

    #[test]
    fn base64_goes_both_ways() {
        for (bytes, text) in [(&b""[..], ""), (b"f", "Zg=="), (b"fo", "Zm8="), (b"foo", "Zm9v"), (b"foob", "Zm9vYg=="), (&[0, 255, 254, 62, 63][..], "AP/+Pj8=")] {
            assert_eq!(base64_encode(bytes), text);
            assert_eq!(base64_decode(text).unwrap(), bytes);
        }
        let all: Vec<u8> = (0..=255).cycle().take(1000).collect();
        assert_eq!(base64_decode(&base64_encode(&all)).unwrap(), all);
        for bad in ["Zg=", "Z===", "Zg==Zg==", "Zm9*", "Zm 9"] {
            assert!(base64_decode(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn decodes_header_paths() {
        assert_eq!(percent_decode("Notes/caf%C3%A9.md").unwrap(), "Notes/café.md");
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%C3").is_err());
    }
}
