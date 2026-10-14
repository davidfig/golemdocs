//! Files the system hands to the iPhone or iPad app ("Open in GolemDocs" from Files or Mail, or Share to it).
//!
//! iOS reports them as `RunEvent::Opened` with file URLs. Each file is copied at once into the app's cache (the original is
//! the sender's, and may go away), and the page asks for the list (`incoming_pending`), reads each file (`incoming_read`) and
//! says it has it (`incoming_done`, which deletes the copy). `opened` also nudges a page that is already showing; one that is
//! loading asks when it starts. The page never names a path: it names a file by the id given here.

// Used on iOS only; it compiles everywhere so that its tests run on a computer.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

struct Item {
    id: String,
    name: String,
    path: PathBuf,
}

#[derive(Default)]
pub struct Incoming {
    items: Mutex<Vec<Item>>,
    counter: Mutex<u64>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Info {
    pub id: String,
    pub name: String,
    /// Not known from a file address; the page goes by the name.
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
}

/// A file name that is safe to use as one: the last part of the path, without characters a file system or the page's
/// download names would trip on.
pub fn safe_name(raw: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = last
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .take(120)
        .collect();
    if cleaned.trim_matches(|c| c == '.' || c == '_').is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

impl Incoming {
    fn next_id(&self) -> String {
        let mut n = self.counter.lock().unwrap();
        *n += 1;
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        format!("{nanos:x}-{n}")
    }

    /// Copies a file into `dir` and lists it. Returns false if it could not be read.
    pub fn take(&self, dir: &Path, source: &Path) -> bool {
        let name = safe_name(&source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let id = self.next_id();
        let target_dir = dir.join(&id);
        if fs::create_dir_all(&target_dir).is_err() {
            return false;
        }
        let path = target_dir.join(&name);
        if fs::copy(source, &path).is_err() {
            let _ = fs::remove_dir_all(&target_dir);
            return false;
        }
        self.items.lock().unwrap().push(Item { id, name, path });
        true
    }

    pub fn list(&self) -> Vec<Info> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .map(|i| Info { id: i.id.clone(), name: i.name.clone(), kind: String::new(), size: fs::metadata(&i.path).map(|m| m.len()).unwrap_or(0) })
            .collect()
    }

    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.items.lock().unwrap().iter().find(|i| i.id == id).map(|i| i.path.clone())
    }

    pub fn remove(&self, id: &str) {
        let mut items = self.items.lock().unwrap();
        if let Some(at) = items.iter().position(|i| i.id == id) {
            let item = items.remove(at);
            if let Some(dir) = item.path.parent() {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }
}

/// The system opened these URLs in the app: the files among them are taken, and a page that is showing is told.
pub fn opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    let Ok(cache) = app.path().app_cache_dir() else { return };
    let dir = cache.join("incoming");
    let incoming = app.state::<Incoming>();
    let mut any = false;
    for url in urls {
        if url.scheme() != "file" {
            continue;
        }
        let Ok(path) = url.to_file_path() else { continue };
        any |= incoming.take(&dir, &path);
    }
    if any {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval("window.dispatchEvent(new Event('golem-incoming'))");
        }
    }
}

#[tauri::command]
pub fn incoming_pending(incoming: State<'_, Incoming>) -> Vec<Info> {
    incoming.list()
}

#[tauri::command]
pub fn incoming_read(id: String, incoming: State<'_, Incoming>) -> Result<tauri::ipc::Response, String> {
    let path = incoming.path_of(&id).ok_or("no such file")?;
    fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn incoming_done(id: String, incoming: State<'_, Incoming>) {
    incoming.remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("/private/var/mobile/Inbox/Report 1.docx"), "Report 1.docx");
        assert_eq!(safe_name("C:\\Users\\me\\Inbox\\Report 1.docx"), "Report 1.docx", "a Windows path too");
        assert_eq!(safe_name("a:b*c?.md"), "a_b_c_.md");
        assert_eq!(safe_name("/x/.."), "document");
        assert_eq!(safe_name(""), "document");
        assert_eq!(safe_name(&"n".repeat(300)).len(), 120);
    }

    #[test]
    fn a_file_is_copied_listed_read_and_removed() {
        let source_dir = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("note.md");
        fs::write(&source, b"# hi").unwrap();
        let incoming = Incoming::default();
        assert!(incoming.take(cache.path(), &source));
        let list = incoming.list();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].name.as_str(), list[0].size), ("note.md", 4));
        let copy = incoming.path_of(&list[0].id).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"# hi");
        assert!(source.exists(), "the sender's file is left alone");
        incoming.remove(&list[0].id);
        assert!(incoming.list().is_empty());
        assert!(!copy.exists(), "the copy is deleted");
        assert!(!incoming.take(cache.path(), &source_dir.path().join("missing.md")), "a file that can't be read is not listed");
    }
}
