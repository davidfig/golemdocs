//! The app's log: lines the page writes about what the vault is doing (syncs started, finished, failed or stuck), so a
//! problem can be looked into after the fact. On a Mac it is `~/Library/Logs/com.golemdocs.desktop/golemdocs.log`.
//!
//! The page is the website, so it may only append text: it names no file, and the log is kept small (when it passes
//! `MAX_BYTES` it becomes `golemdocs.old.log`, replacing the one before).

use std::fs::{self, OpenOptions};
use std::io::Write;
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 1024 * 1024;
/// The longest line kept; a longer one is cut.
const MAX_LINE: usize = 2000;

/// Appends `line` (one line; newlines in it become spaces) to the log.
#[tauri::command]
pub fn app_log(line: String, app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("golemdocs.log");
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("golemdocs.old.log"));
    }
    let mut text: String = line.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).take(MAX_LINE).collect();
    text.push('\n');
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())
}
