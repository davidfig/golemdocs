fn main() {
    // Each vault command gets its own permission (allow-vault-scan ...), so a page is given only the ones
    // capabilities/default.json lists.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "vault_root",
            "vault_choose",
            "vault_forget",
            "vault_scan",
            "vault_read",
            "vault_write",
            "vault_remove",
            "set_native_menu",
        ])),
    )
    .expect("failed to run tauri-build");
}
