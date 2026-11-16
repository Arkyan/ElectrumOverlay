//! Ce que lisent les overlays OBS : `/js/config.js`, pages des scènes personnalisées, stats.

use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use electrum_core::store::BUILTIN_PAGE_KEYS;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/js/config.js", get(config_js))
        .route("/css/accent.css", get(accent_css))
        .route("/scene/{scene_id}", get(custom_scene))
        .route("/api/stream-stats", get(stream_stats))
        .route("/stream-stats", get(stream_stats))
        .route("/api/stream-info", get(stream_stats))
}

async fn config_js(State(state): State<AppState>) -> Response {
    let script = state.store().frontend_config_script();
    ([(header::CONTENT_TYPE, "application/javascript; charset=utf-8")], script).into_response()
}

/// Couleur de l'interface de l'app, tirée du profil actif (jamais mise en cache : elle change
/// avec le profil ou ses couleurs).
async fn accent_css(State(state): State<AppState>) -> Response {
    let css = crate::pages::shell::accent_css(state.store().config());
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], css).into_response()
}

async fn stream_stats(State(state): State<AppState>) -> Response {
    Json(state.stats().to_json()).into_response()
}

/// Échappement HTML identique à `esc()` côté Node.
pub fn esc(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

const SCENE_NOT_FOUND: &str = "<html><body style=\"background:#0b0d12;color:#e9eaee;font-family:sans-serif;padding:40px;\"><h1>Scène introuvable</h1><p>Cette scène n'existe pas (ou appartient à un profil qui n'est pas actif).</p></body></html>";

/// Page d'une scène personnalisée (source navigateur OBS) — profil actif uniquement.
async fn custom_scene(State(state): State<AppState>, Path(scene_id): Path<String>) -> Response {
    let name = {
        let store = state.store();
        store.config()["display"]["scenes"]
            .get(&scene_id)
            .filter(|_| !BUILTIN_PAGE_KEYS.contains(&scene_id.as_str()))
            .map(|scene| electrum_core::json::js_string_or_empty(scene.get("name")))
    };
    let Some(name) = name else {
        return (StatusCode::NOT_FOUND, Html(SCENE_NOT_FOUND)).into_response();
    };
    let template_path = state.assets.templates_dir.join("custom-scene.html");
    match tokio::fs::read_to_string(&template_path).await {
        Ok(template) => Html(template.replacen("{{title}}", &esc(&name), 1)).into_response(),
        Err(error) => {
            eprintln!("❌ Modèle introuvable {}: {error}", template_path.display());
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
