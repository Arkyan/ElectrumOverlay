//! Application Tauri : équivalent de `electron/main.js`.
//!
//! - ouvre la config existante (même dossier que la version Electron) et lance le serveur des
//!   overlays (`electrum-server`) ;
//! - une seule instance : relancer l'app ramène la fenêtre existante ;
//! - fenêtre sans bordure avec la barre de titre maison des pages, pilotée par le pont
//!   `window.electronAPI` (src/bridge.js) ;
//! - fermer la fenêtre la cache dans la zone de notification ; l'icône y propose Ouvrir,
//!   Paramètres, Logs, Tests, Démarrer/Arrêter le serveur et Quitter ;
//! - liens externes ouverts dans le navigateur ; affichage des touches (src/input.rs).

mod input;
mod updater;

use electrum_core::Store;
use electrum_server::{AppState, Assets, Running};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const WINDOW: &str = "main";
const TRAY: &str = "tray";
const BRIDGE: &str = include_str!("bridge.js");
/// Argument ajouté au lancement automatique avec Windows (entrée « Run » du registre).
const AUTOSTART_ARG: &str = "--autostart";

/// État de l'app desktop, accessible partout via `app.state::<Desktop>()`.
pub struct Desktop {
    pub state: AppState,
    server: tokio::sync::Mutex<Option<Running>>,
    http_port: u16,
    ws_port: u16,
    quitting: AtomicBool,
}

impl Desktop {
    pub async fn server_running(&self) -> bool {
        self.server.lock().await.is_some()
    }

    fn url(&self, path: &str) -> String {
        format!("http://localhost:{}{path}", self.http_port)
    }
}

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

/// Affiche l'erreur dans une fenêtre (pas de console en release) puis quitte.
fn fatal(app: &tauri::App, message: String) {
    eprintln!("❌ {message}");
    app.dialog()
        .message(message)
        .title("ElectrumOverlay ne peut pas démarrer")
        .kind(MessageDialogKind::Error)
        .show(|_| std::process::exit(1));
}

/// Un lien vers autre chose que notre propre serveur s'ouvre dans le navigateur habituel.
fn is_own_server(url: &Url, port: u16) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.port_or_known_default() == Some(port)
}

fn open_in_browser(url: &Url) {
    // Seulement des pages web (ou un e-mail) : jamais un fichier local, un partage réseau ou un
    // protocole qui lancerait un programme (file:, smb:, ms-settings:…).
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        eprintln!("⛔ Lien ignoré (protocole non autorisé) : {}", url.scheme());
        return;
    }
    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("❌ Impossible d'ouvrir {url} : {error}");
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW)
}

/// Montre la fenêtre (en la recréant si elle a été fermée), optionnellement sur une page.
fn show(app: &AppHandle, path: Option<&str>) {
    let window = match main_window(app) {
        Some(window) => {
            if let Some(path) = path {
                if let Ok(url) = app.state::<Desktop>().url(path).parse() {
                    let _ = window.navigate(url);
                }
            }
            window
        }
        None => match create_window(app, path.unwrap_or("/app")) {
            Ok(window) => window,
            Err(error) => return eprintln!("❌ Impossible d'ouvrir la fenêtre : {error}"),
        },
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Crée la fenêtre principale sur `path`.
///
/// Fermer la fenêtre la DÉTRUIT (au lieu de la cacher comme la version Electron) : le moteur web
/// qui affiche les pages représente presque toute la mémoire de l'app, alors que le serveur des
/// overlays ne pèse qu'une dizaine de Mo. Pendant un live, l'app réduite dans la zone de
/// notification ne garde donc que le serveur ; la fenêtre est recréée à la demande.
fn create_window(app: &AppHandle, path: &str) -> tauri::Result<WebviewWindow> {
    let desktop = app.state::<Desktop>();
    let port = desktop.http_port;
    let url: Url = desktop.url(path).parse().map_err(tauri::Error::InvalidUrl)?;
    let version = app.package_info().version.to_string();
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title(format!("ElectrumOverlay v{version}"))
        .inner_size(1180.0, 760.0)
        .min_inner_size(820.0, 520.0)
        .decorations(false)
        .background_color(tauri::window::Color(0x18, 0x19, 0x1d, 0xff))
        .initialization_script(BRIDGE)
        // Les fichiers glissés sur la fenêtre arrivent à la page (import de profil par
        // glisser-déposer) au lieu d'être interceptés par Tauri.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if is_own_server(url, port) {
                return true;
            }
            open_in_browser(url);
            false
        })
        .on_new_window(|url, _| {
            open_in_browser(&url);
            NewWindowResponse::Deny
        })
        .build()
}

// ------------------------------------------------------------------------------------------------
// Serveur
// ------------------------------------------------------------------------------------------------

async fn start_server(app: &AppHandle) -> Result<(), String> {
    let desktop = app.state::<Desktop>();
    let mut server = desktop.server.lock().await;
    if server.is_none() {
        let running = electrum_server::start(desktop.state.clone(), desktop.http_port, desktop.ws_port)
            .await
            .map_err(|e| e.to_string())?;
        desktop.state.log("info", format!("🌐 Overlays : http://localhost:{}", running.http.port()));
        desktop.state.log("info", format!("🔌 WebSocket : ws://localhost:{}", running.ws.port()));
        *server = Some(running);
    }
    drop(server);
    refresh_tray(app).await;
    Ok(())
}

async fn stop_server(app: &AppHandle) {
    let desktop = app.state::<Desktop>();
    let running = desktop.server.lock().await.take();
    if let Some(running) = running {
        running.stop().await;
        desktop.state.log("info", "⏹️ Serveur arrêté");
    }
    refresh_tray(app).await;
}

// ------------------------------------------------------------------------------------------------
// Icône de la zone de notification
// ------------------------------------------------------------------------------------------------

/// Texte de l'app (menus, fenêtres de dialogue) dans la langue de l'interface.
fn t(app: &AppHandle, french: &str) -> String {
    match app.try_state::<Desktop>() {
        Some(desktop) if desktop.state.language() == "en" => electrum_server::i18n::to_english(french),
        _ => french.to_string(),
    }
}

/// Langue au premier lancement : celle de Windows (français si Windows est en français, anglais
/// sinon). Ensuite, c'est le réglage de Paramètres › Application qui compte.
fn initial_language() -> &'static str {
    let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if locale.starts_with("fr") { "fr" } else { "en" }
}

async fn refresh_tray(app: &AppHandle) {
    let running = app.state::<Desktop>().server_running().await;
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let downloaded = app.state::<updater::Updater>().downloaded_version();
    let build = || -> tauri::Result<_> {
        let update_item = match &downloaded {
            Some(version) => MenuItemBuilder::with_id("install-update", format!("{} (v{version})", t(app, "Installer la mise à jour"))).build(app)?,
            None => MenuItemBuilder::with_id("check-update", t(app, "Vérifier les mises à jour")).enabled(updater::enabled()).build(app)?,
        };
        let toggle = t(app, if running { "Arrêter le serveur" } else { "Démarrer le serveur" });
        MenuBuilder::new(app)
            .item(&MenuItemBuilder::with_id("open", t(app, "Ouvrir")).build(app)?)
            .item(&MenuItemBuilder::with_id("settings", t(app, "Paramètres")).build(app)?)
            .item(&MenuItemBuilder::with_id("logs", "Logs").build(app)?)
            .item(&MenuItemBuilder::with_id("tests", "Tests").build(app)?)
            .separator()
            .item(&MenuItemBuilder::with_id("toggle-server", toggle).build(app)?)
            .separator()
            .item(&update_item)
            .item(&MenuItemBuilder::with_id("quit", t(app, "Quitter")).build(app)?)
            .build()
    };
    match build() {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(error) => eprintln!("❌ Menu de l'icône : {error}"),
    }
}

fn on_tray_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show(app, None),
        "settings" => show(app, Some("/settings")),
        "logs" => show(app, Some("/logs")),
        "tests" => show(app, Some("/tests")),
        "toggle-server" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if app.state::<Desktop>().server_running().await {
                    stop_server(&app).await;
                } else if let Err(error) = start_server(&app).await {
                    app.state::<Desktop>().state.log("error", format!("❌ Erreur au démarrage du serveur : {error}"));
                }
            });
        }
        "check-update" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::check(&app).await });
        }
        "install-update" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = updater::install(&app).await {
                    app.state::<Desktop>().state.log("error", format!("❌ Installation de la mise à jour impossible : {error}"));
                }
            });
        }
        "quit" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                prepare_quit(&app).await;
                app.exit(0);
            });
        }
        _ => {}
    }
}

/// Avant de quitter (Quitter, ou installation d'une mise à jour) : la fenêtre doit pouvoir se
/// fermer pour de bon, et le serveur libérer ses ports.
pub(crate) async fn prepare_quit(app: &AppHandle) {
    app.state::<Desktop>().quitting.store(true, Ordering::SeqCst);
    stop_server(app).await;
}

/// Annule `prepare_quit` (installation de mise à jour ratée) : l'app et le serveur repartent.
pub(crate) async fn cancel_quit(app: &AppHandle) {
    app.state::<Desktop>().quitting.store(false, Ordering::SeqCst);
    if let Err(error) = start_server(app).await {
        app.state::<Desktop>().state.log("error", format!("❌ Erreur au démarrage du serveur : {error}"));
    }
}

/// Met à jour le menu de l'icône en tâche de fond (après un changement d'état).
pub(crate) fn refresh_tray_later(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { refresh_tray(&app).await });
}

// ------------------------------------------------------------------------------------------------
// Commandes du pont window.electronAPI (src/bridge.js)
// ------------------------------------------------------------------------------------------------

/// Démarrage avec Windows : `{ enabled, minimized, available }`. `enabled` est lu dans Windows
/// (l'utilisateur peut aussi le couper depuis le Gestionnaire des tâches), `minimized` dans la
/// config (`desktop.startMinimized`, oui par défaut).
#[tauri::command]
fn autostart_status(app: AppHandle) -> Value {
    use tauri_plugin_autostart::ManagerExt;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    serde_json::json!({ "enabled": enabled, "minimized": start_minimized(&app), "available": cfg!(windows) })
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool, minimized: bool) -> Result<Value, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|error| format!("Réglage du démarrage avec Windows impossible : {error}"))?;
    let desktop = app.state::<Desktop>();
    desktop
        .state
        .store()
        .save_config(&serde_json::json!({ "desktop": { "startMinimized": minimized } }))
        .map_err(|error| error.to_string())?;
    desktop.state.log(
        "info",
        match (enabled, minimized) {
            (false, _) => "🚀 Démarrage avec Windows désactivé".to_string(),
            (true, true) => "🚀 Démarrage avec Windows activé (dans la zone de notification)".to_string(),
            (true, false) => "🚀 Démarrage avec Windows activé (fenêtre ouverte)".to_string(),
        },
    );
    Ok(autostart_status(app))
}

/// Partage d'un profil : fenêtre « Enregistrer sous » de Windows, puis écriture du fichier.
/// `params` : `name`, `author`, `description`, `assets` (comme `GET /api/profiles/:id/share`).
/// Renvoie le chemin choisi, ou `None` si l'utilisateur a annulé.
#[tauri::command]
async fn profile_share_save(app: AppHandle, id: String, params: std::collections::HashMap<String, String>) -> Result<Option<String>, String> {
    let state = app.state::<Desktop>().state.clone();
    let (filename, content) =
        electrum_server::routes::profiles::shared_profile(&state, &id, &params).map_err(|error| error.1)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(t(&app, "Partager le profil"))
        .set_file_name(&filename)
        .add_filter(t(&app, "Profil ElectrumOverlay"), &["zip"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.map_err(|error| error.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|error| error.to_string())?;
    std::fs::write(&path, content).map_err(|error| format!("Écriture de {} impossible : {error}", path.display()))?;
    state.log("info", format!("📤 Profil partagé enregistré : {}", path.display()));
    Ok(Some(path.display().to_string()))
}

fn start_minimized(app: &AppHandle) -> bool {
    let desktop = app.state::<Desktop>();
    let store = desktop.state.store();
    store.config()["desktop"]["startMinimized"].as_bool().unwrap_or(true)
}

/// Reconstruit le menu de l'icône (après un changement de langue).
#[tauri::command]
async fn tray_refresh(app: AppHandle) {
    refresh_tray(&app).await;
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn window_close(window: WebviewWindow) {
    let _ = window.close(); // détruit la fenêtre ; l'app continue dans la zone de notification
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
async fn server_status(app: AppHandle) -> bool {
    app.state::<Desktop>().server_running().await
}

#[tauri::command]
async fn server_start(app: AppHandle) -> Result<bool, String> {
    start_server(&app).await?;
    Ok(true)
}

#[tauri::command]
async fn server_stop(app: AppHandle) -> bool {
    stop_server(&app).await;
    false
}

#[tauri::command]
fn updater_status(app: AppHandle) -> Value {
    app.state::<updater::Updater>().status()
}

#[tauri::command]
fn updater_check(app: AppHandle) -> bool {
    tauri::async_runtime::spawn(async move { updater::check(&app).await });
    true
}

#[tauri::command]
async fn updater_install(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

// ------------------------------------------------------------------------------------------------
// Démarrage
// ------------------------------------------------------------------------------------------------

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let assets = resolve_assets(app)?;
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(error) => {
            fatal(app, format!("Impossible de lire la configuration : {error}"));
            return Ok(());
        }
    };
    if electrum_server::i18n::configured_language(store.config()).is_none() {
        let mut store = store;
        let _ = store.save_config(&serde_json::json!({ "app": { "language": initial_language() } }));
        return setup_with_store(app, assets, store);
    }
    setup_with_store(app, assets, store)
}

fn setup_with_store(app: &mut tauri::App, assets: Assets, store: Store) -> Result<(), Box<dyn std::error::Error>> {
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
    app.manage(updater::Updater::default());
    app.manage(Desktop {
        state,
        server: tokio::sync::Mutex::new(None),
        http_port,
        ws_port,
        quitting: AtomicBool::new(false),
    });

    let handle = app.handle().clone();
    if let Err(error) = tauri::async_runtime::block_on(start_server(&handle)) {
        fatal(
            app,
            format!(
                "{} : {error}\n\n{}",
                t(app.handle(), "Le serveur n'a pas pu démarrer"),
                t(app.handle(), "Une autre instance est peut-être déjà lancée (vérifiez l'icône dans la zone de notification).")
            ),
        );
        return Ok(());
    }

    // Seules les pages de NOTRE serveur local peuvent appeler les commandes du pont.
    let mut capability = tauri::ipc::CapabilityBuilder::new("pages-locales")
        .window(WINDOW)
        .remote(format!("http://localhost:{http_port}/*"))
        .remote(format!("http://127.0.0.1:{http_port}/*"))
        .permission("core:default")
        .permission("core:window:allow-start-dragging");
    for command in include!(concat!(env!("OUT_DIR"), "/commands.rs")) {
        capability = capability.permission(format!("allow-{}", command.replace('_', "-")));
    }
    app.add_capability(capability)?;

    // Lancé par Windows à l'ouverture de session : directement dans la zone de notification si
    // c'est le réglage choisi (les overlays sont servis, la fenêtre s'ouvre d'un clic sur l'icône).
    let autostarted = std::env::args().any(|arg| arg == AUTOSTART_ARG);
    if autostarted && start_minimized(app.handle()) {
        app.state::<Desktop>().state.log("info", "🚀 Lancé avec Windows : app réduite dans la zone de notification");
    } else {
        create_window(app.handle(), "/app")?;
    }

    let icon = app.default_window_icon().cloned().ok_or("icône de l'app introuvable")?;
    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .tooltip("ElectrumOverlay")
        .show_menu_on_left_click(false)
        .on_menu_event(on_tray_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle(), None);
            }
        })
        .build(app)?;
    tauri::async_runtime::block_on(refresh_tray(&handle));

    input::spawn(handle.clone());
    tauri::async_runtime::spawn(electrum_server::routes::backups::auto_backup_loop(app.state::<Desktop>().state.clone()));
    updater::spawn(handle);
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        // En premier : une deuxième instance ramène la fenêtre de la première, puis se ferme.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app, None)))
        .plugin(tauri_plugin_autostart::Builder::new().app_name("ElectrumOverlay").args([AUTOSTART_ARG]).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_version,
            autostart_status,
            autostart_set,
            profile_share_save,
            tray_refresh,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
            server_status,
            server_start,
            server_stop,
            updater_status,
            updater_check,
            updater_install
        ])
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
    app.run(|app, event| {
        // Fermer la dernière fenêtre ne quitte pas l'app : elle continue de servir les overlays
        // depuis la zone de notification. Seul « Quitter » (ou une mise à jour) l'arrête.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            if !app.state::<Desktop>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}
