/// Commandes de l'app appelées par le pont `window.electronAPI` (src/bridge.js). Les déclarer ici
/// génère une permission `allow-<commande>` pour chacune ; lib.rs ne les autorise que pour les
/// pages de notre propre serveur local.
const COMMANDS: &[&str] = &[
    "app_version",
    "autostart_status",
    "autostart_set",
    "profile_share_save",
    "tray_refresh",
    "window_minimize",
    "window_toggle_maximize",
    "window_close",
    "window_is_maximized",
    "server_status",
    "server_start",
    "server_stop",
    "updater_status",
    "updater_check",
    "updater_install",
];

fn main() {
    // Liste réutilisée par lib.rs pour accorder ces permissions aux pages locales.
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("commands.rs");
    std::fs::write(&out, format!("{COMMANDS:?}")).unwrap();
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("échec de tauri-build");
}
