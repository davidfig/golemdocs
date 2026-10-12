mod vault;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::Vault::default())
        .setup(|app| {
            app.state::<vault::Vault>().restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_root,
            vault::vault_choose,
            vault::vault_forget,
            vault::vault_scan,
            vault::vault_read,
            vault::vault_write,
            vault::vault_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GolemDocs");
}
