//! Mises à jour automatiques depuis les releases GitHub : équivalent de la partie electron-updater
//! de `electron/main.js`. Mêmes états, exposés tels quels à la bannière de l'accueil (via le pont
//! `window.electronAPI`) et au menu de l'icône :
//! `idle` → `checking` → `downloading { version, percent }` → `downloaded { version }`, ou
//! `error { message }`.
//!
//! Le fichier téléchargé n'est installé que s'il est signé avec la clé privée du projet (la clé
//! publique est dans tauri.conf.json) : voir docs/RELEASE-RUST.md.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Vérification au démarrage puis toutes les 4 h, comme la version Electron.
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Default)]
pub struct Updater {
    status: Mutex<Value>,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

impl Updater {
    pub fn status(&self) -> Value {
        let status = self.status.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if status.is_null() { json!({ "status": "idle" }) } else { status }
    }

    /// Change l'état et prévient tout de suite les pages ouvertes (bannière du tableau de bord),
    /// par le WebSocket du serveur.
    fn set(&self, app: &AppHandle, status: Value) {
        if let Some(desktop) = app.try_state::<crate::Desktop>() {
            desktop.state.broadcast(&json!({ "type": "updater-status", "status": status }));
        }
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = status;
    }

    /// Version prête à installer, pour le menu de l'icône.
    pub fn downloaded_version(&self) -> Option<String> {
        let status = self.status();
        (status["status"] == "downloaded").then(|| status["version"].as_str().unwrap_or_default().to_string())
    }
}

/// Les mises à jour ne concernent que l'app installée (pas `cargo tauri dev`).
pub fn enabled() -> bool {
    !cfg!(debug_assertions)
}

pub fn spawn(app: AppHandle) {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            check(&app).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

fn log(app: &AppHandle, level: &str, text: String) {
    app.state::<crate::Desktop>().state.log(level, text);
}

/// Cherche une mise à jour et, s'il y en a une, la télécharge (sans l'installer).
pub async fn check(app: &AppHandle) {
    let updater = app.state::<Updater>();
    let busy = matches!(updater.status()["status"].as_str(), Some("checking" | "downloading" | "downloaded"));
    if !enabled() || busy {
        return;
    }
    updater.set(app, json!({ "status": "checking" }));
    log(app, "info", "🔄 Recherche de mise à jour...".into());

    let found = match app.updater() {
        Ok(client) => client.check().await,
        Err(error) => Err(error),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => return updater.set(app, json!({ "status": "idle" })),
        Err(error) => {
            log(app, "error", format!("❌ Erreur de vérification de mise à jour: {error}"));
            return updater.set(app, json!({ "status": "error", "message": error.to_string() }));
        }
    };

    let version = update.version.clone();
    log(app, "info", format!("⬇️  Mise à jour disponible : v{version}"));
    updater.set(app, json!({ "status": "downloading", "version": version, "percent": 0 }));
    let mut received: u64 = 0;
    let progress_app = app.clone();
    let progress_version = version.clone();
    let downloaded = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (received * 100 / total).min(100);
                    progress_app
                        .state::<Updater>()
                        .set(&progress_app, json!({ "status": "downloading", "version": progress_version, "percent": percent }));
                }
            },
            || {},
        )
        .await;
    match downloaded {
        Ok(bytes) => {
            *updater.ready.lock().unwrap_or_else(|p| p.into_inner()) = Some((update, bytes));
            log(app, "info", format!("✅ Mise à jour v{version} prête à installer."));
            updater.set(app, json!({ "status": "downloaded", "version": version }));
            crate::refresh_tray_later(app);
        }
        Err(error) => {
            log(app, "error", format!("❌ Erreur de mise à jour: {error}"));
            updater.set(app, json!({ "status": "error", "message": error.to_string() }));
        }
    }
}

/// Installe la mise à jour téléchargée : l'installateur se lance et l'app se ferme.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let ready = app.state::<Updater>().ready.lock().unwrap_or_else(|p| p.into_inner()).take();
    let Some((update, bytes)) = ready else { return Err("Aucune mise à jour prête à installer".into()) };
    crate::prepare_quit(app).await;
    if let Err(error) = update.install(bytes) {
        // Installation ratée (annulée, droits, antivirus…) : l'app reprend comme avant, serveur
        // relancé, au lieu de rester sans overlays.
        crate::cancel_quit(app).await;
        let updater = app.state::<Updater>();
        updater.set(app, json!({ "status": "error", "message": error.to_string() }));
        crate::refresh_tray_later(app);
        return Err(error.to_string());
    }
    app.restart();
}
