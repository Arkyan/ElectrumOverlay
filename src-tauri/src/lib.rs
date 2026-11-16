//! Application Tauri : ouvre la config existante (même dossier que la version Electron), lance
//! le serveur HTTP + WebSocket des overlays (`electrum-server`), puis ouvre la fenêtre sur ce
//! serveur.

use electrum_core::Store;
use electrum_server::{AppState, Assets};
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// `public/` et `src/templates/` : lus directement dans le dépôt en développement, embarqués
/// comme ressources de l'installateur en release (voir `bundle.resources` de tauri.conf.json).
fn resolve_assets(app: &tauri::App) -> tauri::Result<Assets> {
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        Ok(Assets { public_dir: repo.join("public"), templates_dir: repo.join("src").join("templates") })
    } else {
        let resources = app.path().resource_dir()?;
        Ok(Assets { public_dir: resources.join("public"), templates_dir: resources.join("templates") })
    }
}

/// Affiche l'erreur dans une fenêtre (l'app n'a pas de console en release) puis quitte.
fn fatal(app: &tauri::App, message: String) {
    eprintln!("❌ {message}");
    app.dialog()
        .message(message)
        .title("ElectrumOverlay")
        .kind(MessageDialogKind::Error)
        .show(|_| std::process::exit(1));
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let assets = resolve_assets(app)?;
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(error) => {
            fatal(app, format!("Impossible de lire la configuration : {error}"));
            return Ok(());
        }
    };
    println!("📁 Config : {}", store.paths().config_dir.display());
    println!("🎨 Profil actif : {:?}", store.active_profile_id());
    println!("🔧 Configuré : {}", store.is_configured());

    let state = AppState::new(store, assets);
    let (http_port, ws_port) = electrum_server::configured_ports(&state);
    let running = match tauri::async_runtime::block_on(electrum_server::start(state.clone(), http_port, ws_port)) {
        Ok(running) => running,
        Err(error) => {
            fatal(app, format!("Le serveur des overlays n'a pas pu démarrer : {error}"));
            return Ok(());
        }
    };
    println!("🌐 Overlays : http://localhost:{}", running.http.port());
    println!("🔌 WebSocket : ws://localhost:{}", running.ws.port());
    app.manage(state);

    let url = format!("http://localhost:{}/", running.http.port()).parse()?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("ElectrumOverlay")
        .inner_size(1280.0, 800.0)
        .build()?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
