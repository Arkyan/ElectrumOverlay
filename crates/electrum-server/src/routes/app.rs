//! Réglages de l'app elle-même : langue de l'interface (`app.language`), et traduction des
//! réponses en anglais (voir `crate::i18n`).

use super::{body_or_empty, ApiError, ApiResult};
use crate::i18n;
use crate::state::AppState;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/app/language", get(get_language).post(set_language))
        .route("/js/i18n.js", get(overlay_dictionary))
}

impl AppState {
    /// Langue de l'interface (`fr` si rien n'est choisi).
    pub fn language(&self) -> &'static str {
        i18n::language_of(self.store().config())
    }
}

async fn get_language(State(state): State<AppState>) -> Json<serde_json::Value> {
    let languages: Vec<_> = i18n::LANGUAGES.iter().map(|(code, name)| json!({ "code": code, "name": name })).collect();
    Json(json!({ "language": state.language(), "languages": languages }))
}

async fn set_language(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let language = body.get("language").and_then(|v| v.as_str()).unwrap_or_default();
    if !i18n::LANGUAGES.iter().any(|(code, _)| *code == language) {
        return Err(ApiError::bad_request("Langue inconnue"));
    }
    state.store().save_config(&json!({ "app": { "language": language } }))?;
    // Les overlays ouverts se rechargent pour prendre leurs textes dans la nouvelle langue.
    state.broadcast(&json!({ "type": "language-changed", "language": language }));
    Ok(Json(json!({ "ok": true, "language": language })))
}

/// Dictionnaire des overlays (`globalThis.OVERLAY_I18N`), chargé avant overlay-common.js.
async fn overlay_dictionary(State(state): State<AppState>) -> Response {
    (
        [(CONTENT_TYPE, "application/javascript; charset=utf-8"), (CACHE_CONTROL, "no-store")],
        i18n::overlay_script(state.language()),
    )
        .into_response()
}

/// En anglais : traduit les pages de l'app (pas les overlays, qui se traduisent eux-mêmes) et
/// les messages d'erreur de l'API.
pub async fn translate_responses(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if state.language() != "en" {
        return response;
    }
    let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let html = content_type.starts_with("text/html");
    let error = content_type.starts_with("application/json") && !response.status().is_success();
    if !html && !error {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 32 * 1024 * 1024).await else {
        return Response::from_parts(parts, Body::empty());
    };
    let text = String::from_utf8_lossy(&bytes);
    let translated = if html {
        // Seules les pages de l'app (elles chargent toutes app-v3.css) : les overlays OBS ont
        // leurs propres textes, traduits côté overlay.
        if !text.contains("/css/app-v3.css") {
            return Response::from_parts(parts, Body::from(bytes));
        }
        i18n::page_to_english(&text)
    } else {
        i18n::to_english(&text)
    };
    parts.headers.remove(CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(translated))
}
