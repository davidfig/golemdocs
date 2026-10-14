fn main() {
    // On iOS the app (Swift, gen/apple/Sources/.../ICloud.swift) defines the iCloud functions that src/icloud.rs calls, and
    // only the static library is linked into it. Cargo also links a dylib, which has no such definitions: leave them open.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
    // Each vault command gets its own permission (allow-vault-scan ...), so a page is given only the ones
    // capabilities/default.json lists.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "vault_root",
            "vault_choose",
            "vault_forget",
            "vault_reveal",
            "vault_check",
            "vault_open_privacy",
            "vault_scan",
            "vault_read",
            "vault_write",
            "vault_remove",
            "set_native_menu",
            "update_check",
            "update_install",
            "incoming_pending",
            "incoming_read",
            "incoming_done",
        ])),
    )
    .expect("failed to run tauri-build");
}
