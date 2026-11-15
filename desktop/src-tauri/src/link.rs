//! Links that open a note in the app from somewhere else, and Markdown files opened with the app (desktop).
//!
//! The app is the handler of `golemdocs://` (Info.plist's `CFBundleURLTypes`) and can open `.md` files (`fileAssociations` in
//! tauri.conf.json). macOS hands both to the one running app, starting it first if need be, as `RunEvent::Opened`. Each
//! link, and each file inside the vault (as a `file://` address), is kept here until the page takes the list
//! (`link_pending`); the window comes to the front and a page already showing is nudged (`golem-link`). A file outside the
//! vault is copied in, as the phone apps do (incoming.rs), and opened as a new document. The page decides what a link
//! opens (client/src/desktop/vaultLink.ts); nothing here reads a link's contents.

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::incoming::Incoming;
use crate::vault::{vault_root, Vault};

#[derive(Default)]
pub struct Links {
    pending: Mutex<Vec<String>>,
}

impl Links {
    pub fn add(&self, link: String) {
        let mut pending = self.pending.lock().unwrap();
        // The same link twice in a row (a double click) opens once.
        if pending.last() != Some(&link) {
            pending.push(link);
        }
    }

    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.pending.lock().unwrap())
    }
}

/// Whether a file is inside the vault folder (so the page opens the document it is, rather than a copy).
pub fn in_vault(file: &Path, root: &Path) -> bool {
    let file = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    file.starts_with(&root) && file != root
}

/// What macOS opened the app with: `golemdocs://` links, and files.
pub fn opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    let root = vault_root(app.state::<Vault>()).map(std::path::PathBuf::from);
    let links = app.state::<Links>();
    let (mut linked, mut copied) = (false, false);
    for url in urls {
        match url.scheme() {
            "golemdocs" => {
                links.add(url.to_string());
                linked = true;
            }
            "file" => {
                let Ok(path) = url.to_file_path() else { continue };
                if root.as_deref().is_some_and(|root| in_vault(&path, root)) {
                    links.add(url.to_string());
                    linked = true;
                } else if let Ok(cache) = app.path().app_cache_dir() {
                    copied |= app.state::<Incoming>().take(&cache.join("incoming"), &path);
                }
            }
            _ => {}
        }
    }
    if !linked && !copied {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if linked {
            let _ = window.eval("window.dispatchEvent(new Event('golem-link'))");
        }
        if copied {
            let _ = window.eval("window.dispatchEvent(new Event('golem-incoming'))");
        }
    }
}

/// The links (and vault files) given to the app since the page last asked; asking empties the list.
#[tauri::command]
pub fn link_pending(links: State<'_, Links>) -> Vec<String> {
    links.take()
}

/// Puts text on the clipboard: Copy Link to Note runs from the Mac menu bar, which is no click in the page, so the web view
/// refuses the page's own clipboard. Mac only (`pbcopy`); elsewhere the page uses its own.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("/usr/bin/pbcopy")
            .env("LC_CTYPE", "UTF-8")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child.stdin.take().ok_or("no input")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("pbcopy failed: {status}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("Command clipboard_write_text not found".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_taken_once_and_a_repeat_is_dropped() {
        let links = Links::default();
        links.add("golemdocs://open?file=a.md".into());
        links.add("golemdocs://open?file=a.md".into());
        links.add("golemdocs://open?file=b.md".into());
        assert_eq!(links.take(), vec!["golemdocs://open?file=a.md", "golemdocs://open?file=b.md"]);
        assert!(links.take().is_empty());
    }

    #[test]
    fn a_file_is_in_the_vault_only_under_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("My Vault");
        std::fs::create_dir_all(root.join("Notes")).unwrap();
        std::fs::write(root.join("Notes/a.md"), "# a").unwrap();
        std::fs::write(dir.path().join("b.md"), "# b").unwrap();
        std::fs::create_dir_all(dir.path().join("My Vault 2")).unwrap();
        std::fs::write(dir.path().join("My Vault 2/c.md"), "# c").unwrap();
        assert!(in_vault(&root.join("Notes/a.md"), &root));
        assert!(!in_vault(&dir.path().join("b.md"), &root));
        assert!(
            !in_vault(&dir.path().join("My Vault 2/c.md"), &root),
            "a folder whose name starts the same is another folder"
        );
        assert!(!in_vault(&root, &root));
    }
}
