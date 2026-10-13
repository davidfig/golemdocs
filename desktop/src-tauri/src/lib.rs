// The menu bar and the self-updater are desktop only (the phone apps are updated through the App Store and Play). The
// vault is on desktop (a folder the person chooses) and on iOS (the app's iCloud Drive folder, see icloud.rs).
#[cfg(desktop)]
mod menu;
#[cfg(desktop)]
mod update;
mod icloud;
#[cfg(any(desktop, target_os = "ios"))]
mod vault;

#[cfg(any(desktop, target_os = "ios"))]
use tauri::Manager;
#[cfg(desktop)]
use tauri::Emitter;

#[cfg(desktop)]
fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(vault::Vault::default())
        // A click in the native menu bar goes to the page, which knows what each item does.
        .on_menu_event(|app, event| {
            let _ = app.emit("native-menu", event.id().0.clone());
        })
        .setup(|app| {
            app.state::<vault::Vault>().restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_root,
            vault::vault_choose,
            vault::vault_forget,
            vault::vault_reveal,
            vault::vault_check,
            vault::vault_open_privacy,
            vault::vault_scan,
            vault::vault_read,
            vault::vault_write,
            vault::vault_remove,
            menu::set_native_menu,
            update::update_check,
            update::update_install,
        ])
}

// A phone has the vault (in iCloud, with nothing to choose) but not the menu bar or the updater.
#[cfg(target_os = "ios")]
fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(vault::Vault::default())
        .setup(|app| {
            // Without iCloud the vault stays unset and the page shows no folder; the documents are still in the account.
            let _ = app.state::<vault::Vault>().use_icloud(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_root,
            vault::vault_check,
            vault::vault_scan,
            vault::vault_read,
            vault::vault_write,
            vault::vault_remove,
        ])
}

#[cfg(all(mobile, not(target_os = "ios")))]
fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    builder().run(tauri::generate_context!()).expect("error while running GolemDocs");
}
