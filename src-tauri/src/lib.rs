//! Application Tauri : ouvre la config existante (même dossier que la version Electron), lance
//! le serveur HTTP + WebSocket des overlays (`electrum-server`), puis ouvre la fenêtre sur ce
//! serveur.

use electrum_core::Store;
use electrum_server::{AppState, Assets};
use std::path::PathBuf;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
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

/// Un lien vers autre chose que notre propre serveur (autorisation Twitch, Spotify, docs...)
/// s'ouvre dans le navigateur habituel, pas dans la fenêtre de l'app — comme la version Electron.
fn is_own_server(url: &Url, port: u16) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.port_or_known_default() == Some(port)
}

fn open_in_browser(url: &Url) {
    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("❌ Impossible d'ouvrir {url} : {error}");
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
    let startup = [
        format!("📁 Config : {}", store.paths().config_dir.display()),
        format!("🎨 Profil actif : {}", store.active_profile_id().unwrap_or("aucun")),
        format!("🔧 Configuré : {}", if store.is_configured() { "oui" } else { "non" }),
    ];
    let state = AppState::new(store, assets);
    for line in startup {
        state.log("info", line);
    }
    let (http_port, ws_port) = electrum_server::configured_ports(&state);
    let running = match tauri::async_runtime::block_on(electrum_server::start(state.clone(), http_port, ws_port)) {
        Ok(running) => running,
        Err(error) => {
            fatal(app, format!("Le serveur des overlays n'a pas pu démarrer : {error}"));
            return Ok(());
        }
    };
    state.log("info", format!("🌐 Overlays : http://localhost:{}", running.http.port()));
    state.log("info", format!("🔌 WebSocket : ws://localhost:{}", running.ws.port()));
    app.manage(state);

    let port = running.http.port();
    let url = format!("http://localhost:{port}/app").parse()?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("ElectrumOverlay")
        .inner_size(1280.0, 800.0)
        .on_navigation(move |url| {
            if is_own_server(url, port) {
                return true;
            }
            open_in_browser(url);
            false
        })
        // target="_blank" : toujours dans le navigateur, jamais dans une nouvelle fenêtre de l'app.
        .on_new_window(|url, _| {
            open_in_browser(&url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
