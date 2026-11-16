//! Application Tauri. Pour l'instant : ouvre la config existante (même dossier que la version
//! Electron) via `electrum-core` pour valider la compatibilité, puis affiche la fenêtre.
//! Le serveur HTTP/WebSocket (overlays OBS) viendra ensuite.

use electrum_core::Store;
use std::sync::Mutex;

/// État partagé de l'app : la config et les profils.
pub struct AppState {
    pub store: Mutex<Store>,
}

/// Petit diagnostic appelable depuis la fenêtre (`invoke('core_status')`).
#[tauri::command]
fn core_status(state: tauri::State<AppState>) -> serde_json::Value {
    let store = state.store.lock().expect("verrou de config empoisonné");
    serde_json::json!({
        "configDir": store.paths().config_dir,
        "configured": store.is_configured(),
        "activeProfileId": store.active_profile_id(),
        "profiles": store.list_profiles().unwrap_or_default(),
    })
}

pub fn run() {
    let store = Store::open_default().expect("impossible d'ouvrir la configuration");
    println!("📁 Config : {}", store.paths().config_dir.display());
    println!("🎨 Profil actif : {:?}", store.active_profile_id());
    println!("🔧 Configuré : {}", store.is_configured());

    tauri::Builder::default()
        .manage(AppState { store: Mutex::new(store) })
        .invoke_handler(tauri::generate_handler![core_status])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
