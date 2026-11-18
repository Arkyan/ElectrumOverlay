//! Configuration automatique d'OBS (tableau de bord › Sources pour OBS).

use super::{body_or_empty, ApiError, ApiResult};
use crate::obs::{configure, SceneSetup};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use electrum_core::store::BUILTIN_PAGE_KEYS;
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/obs", get(info)).route("/api/obs/setup", post(setup))
}

/// Scènes proposées : les 4 intégrées puis les scènes personnalisées du profil actif
/// (clé, nom de scène OBS, URL de l'overlay).
fn scenes(state: &AppState) -> Vec<(String, String, String)> {
    let store = state.store();
    let config = store.config();
    let port = config["server"]["PORT"].as_u64().unwrap_or(8080);
    let english = crate::i18n::language_of(config) == "en";
    let builtin = [
        ("starting", if english { "Starting" } else { "Démarrage" }, "/starting.html"),
        ("index", if english { "Live" } else { "En direct" }, "/"),
        ("pause", "Pause", "/pause.html"),
        ("ending", if english { "Ending" } else { "Fin" }, "/ending.html"),
    ];
    let mut out: Vec<(String, String, String)> =
        builtin.iter().map(|(key, name, path)| (key.to_string(), name.to_string(), format!("http://localhost:{port}{path}"))).collect();
    for (id, scene) in config["display"]["scenes"].as_object().into_iter().flatten() {
        if BUILTIN_PAGE_KEYS.contains(&id.as_str()) {
            continue;
        }
        let name = scene["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(id).to_string();
        out.push((id.clone(), name, format!("http://localhost:{port}/scene/{id}")));
    }
    out
}

async fn info(State(state): State<AppState>) -> Json<Value> {
    let saved = state.store().config()["app"]["obs"].clone();
    let list: Vec<Value> = scenes(&state).into_iter().map(|(key, name, url)| json!({ "key": key, "name": name, "url": url })).collect();
    Json(json!({
        "host": saved["host"].as_str().unwrap_or("localhost"),
        "port": saved["port"].as_u64().unwrap_or(4455),
        "hasPassword": saved["password"].as_str().is_some_and(|p| !p.is_empty()),
        "configuredAt": saved["configuredAt"],
        "scenes": list,
    }))
}

async fn setup(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let saved = state.store().config()["app"]["obs"].clone();
    let host = body["host"].as_str().map(str::trim).filter(|h| !h.is_empty()).unwrap_or("localhost").to_string();
    let port = body["port"].as_u64().and_then(|p| u16::try_from(p).ok()).unwrap_or(4455);
    // Mot de passe vide = celui déjà enregistré.
    let password = body["password"]
        .as_str()
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| saved["password"].as_str().unwrap_or_default().to_string());
    let wanted: Vec<String> = body["scenes"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(str::to_string)).collect();
    let selected: Vec<SceneSetup> = scenes(&state)
        .into_iter()
        .filter(|(key, _, _)| wanted.is_empty() || wanted.contains(key))
        .map(|(_, name, url)| SceneSetup { name, url })
        .collect();
    let report = configure(&host, port, &password, &selected, body["audio"].as_bool().unwrap_or(true))
        .await
        .map_err(ApiError::bad_request)?;
    state.store().save_config(&json!({ "app": { "obs": {
        "host": host, "port": port, "password": password, "configuredAt": electrum_core::time::now_iso()
    } } }))?;
    state.log("info", format!("🎬 OBS configuré : {}", report.join(" ; ")));
    // Le compte rendu n'est pas une erreur : il n'est donc pas traduit au passage, on le fait ici.
    let report: Vec<String> = if state.language() == "en" { report.iter().map(|line| crate::i18n::to_english(line)).collect() } else { report };
    Ok(Json(json!({ "ok": true, "report": report })))
}
