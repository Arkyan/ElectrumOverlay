//! Sauvegardes de la config : liste, création, restauration, suppression (Paramètres ›
//! Sauvegardes), et sauvegarde automatique quotidienne.

use super::{ok, ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use electrum_core::backup::{Backups, Reason};
use electrum_core::Store;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/backups", get(list).post(create))
        .route("/api/backups/{id}/restore", post(restore))
        .route("/api/backups/{id}", delete(remove))
}

/// Accès aux sauvegardes, config verrouillée pendant l'opération (pas d'écriture concurrente).
fn with_backups<T>(state: &AppState, action: impl FnOnce(&Backups) -> T) -> T {
    let store = state.store();
    action(&Backups::new(store.paths()))
}

async fn list(State(state): State<AppState>) -> Json<Value> {
    let (backups, dir) = with_backups(&state, |b| (b.list(), b.dir().display().to_string()));
    Json(json!({ "backups": backups, "dir": dir }))
}

async fn create(State(state): State<AppState>) -> ApiResult {
    let backup = with_backups(&state, |b| b.create(Reason::Manual, false))?;
    state.log("info", "💾 Sauvegarde de la config créée");
    Ok(Json(json!({ "ok": true, "backup": backup })))
}

async fn restore(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    {
        let mut store = state.store();
        let dir = store.paths().config_dir.clone();
        Backups::new(store.paths()).restore(&id)?;
        *store = Store::open(&dir)?;
    }
    state.log("info", format!("♻️ Config restaurée depuis la sauvegarde du {id}"));
    state.broadcast_config();
    ok()
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    with_backups(&state, |b| b.delete(&id)).map_err(ApiError::from)?;
    ok()
}

/// Sauvegarde automatique : vérifiée au lancement puis toutes les heures, faite si la dernière a
/// plus de 24 h et que la config a changé depuis. À lancer par l'app (pas par les tests).
pub async fn auto_backup_loop(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        interval.tick().await;
        match with_backups(&state, |b| b.auto_if_due(chrono::Duration::hours(24))) {
            Ok(Some(_)) => state.log("info", "💾 Sauvegarde automatique de la config effectuée"),
            Ok(None) => {}
            Err(error) => state.log("warn", format!("⚠️ Sauvegarde automatique impossible : {error}")),
        }
    }
}
