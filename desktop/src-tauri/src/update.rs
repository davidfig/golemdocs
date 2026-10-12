//! Updating the shell. The page is the website and updates itself; this replaces the app around it.
//!
//! The page never names a URL or a file: the endpoint and the public key that signatures are checked against are in
//! `tauri.conf.json` (`plugins.updater`), so a page can only ask whether an update exists and whether to install the one
//! the signed manifest offers. The download is verified against that key before anything is replaced.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    /// What the release says changed, if it says.
    pub notes: Option<String>,
}

/// The update on offer for this version of the app, or null if it is up to date.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|update| UpdateInfo { version: update.version, notes: update.body }))
}

/// Downloads the update, checks its signature, installs it and restarts the app. Only returns on failure.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("there is no update to install".to_string());
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}
