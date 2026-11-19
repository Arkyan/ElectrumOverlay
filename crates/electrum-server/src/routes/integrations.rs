//! Intégrations tierces optionnelles : Spotify, Trucky, affichage des touches.
//! Port de `src/routes/integrations.js` (+ `/api/info-panel` de `src/routes/api.js`).

use super::{body_or_empty, ok, ApiError, ApiResult};
use crate::pages::{self, IntegrationsContext};
use crate::spotify;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::response::{Html, Redirect};
use axum::routing::{get, post};
use axum::{Json, Router};
use electrum_core::json::{encode_uri_component, is_truthy, js_string_or_empty};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/integrations", get(page))
        .route("/api/spotify/credentials", post(spotify_credentials))
        .route("/api/spotify/callback", get(spotify_callback))
        .route("/api/spotify/disconnect", post(spotify_disconnect))
        .route("/api/spotify/now-playing", get(now_playing))
        .route("/api/integrations/trucky", post(save_trucky))
        .route("/api/integrations/input-display", post(save_input_display))
        .route("/api/info-panel", get(info_panel))
}

/// Panneau d'infos Trucky (trajet, stats, société).
async fn info_panel(State(state): State<AppState>) -> axum::response::Response {
    use axum::response::IntoResponse;
    match crate::trucky::info_panel(&state).await {
        Ok(panel) => Json(panel).into_response(),
        Err((status, message)) => ApiError(axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR), message).into_response(),
    }
}

async fn page(State(state): State<AppState>, Query(query): Query<HashMap<String, String>>) -> Html<String> {
    let configured = spotify::is_configured(&state);
    let connected = spotify::is_connected(&state);
    let auth_url = configured.then(|| spotify::authorize_url(&state));
    let config = state.store().config().clone();
    Html(pages::integrations(&IntegrationsContext {
        config: &config,
        configured,
        connected,
        auth_url,
        just_connected: query.get("connected").map(String::as_str) == Some("1"),
        error: query.get("error").map(String::as_str),
    }))
}

async fn spotify_credentials(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let client_id = js_string_or_empty(body.get("clientId")).trim().to_string();
    let client_secret = js_string_or_empty(body.get("clientSecret")).trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(ApiError::bad_request("Client ID et Client Secret requis"));
    }
    let port = js_string_or_empty(state.store().config()["server"].get("PORT"));
    let redirect_uri = format!("http://127.0.0.1:{port}/api/spotify/callback");
    state
        .store()
        .save_config(&json!({ "spotify": { "CLIENT_ID": client_id, "CLIENT_SECRET": client_secret, "REDIRECT_URI": redirect_uri } }))?;
    Ok(Json(json!({ "ok": true, "redirectUri": redirect_uri })))
}

/// Retour de Spotify après autorisation (ouvert dans le navigateur de l'utilisateur).
async fn spotify_callback(State(state): State<AppState>, Query(query): Query<HashMap<String, String>>) -> Redirect {
    let back_with_error = |message: &str| Redirect::to(&format!("/integrations?error={}", encode_uri_component(message)));
    if query.get("error").is_some_and(|e| !e.is_empty()) {
        return back_with_error("Autorisation refusée sur Spotify.");
    }
    if query.get("state") != Some(&state.oauth_state) {
        return back_with_error("Autorisation d'origine inconnue : relance la connexion depuis l'app.");
    }
    let Some(code) = query.get("code").filter(|c| !c.is_empty()) else {
        return back_with_error("Code d'autorisation manquant.");
    };
    match spotify::exchange_code(&state, code).await {
        Ok(()) => {
            state.log("info", "🎵 Compte Spotify connecté");
            Redirect::to("/integrations?connected=1")
        }
        Err(error) => {
            state.log("error", format!("❌ Erreur lors de l'échange du code Spotify: {error}"));
            back_with_error("Échec de la connexion à Spotify.")
        }
    }
}

async fn spotify_disconnect(State(state): State<AppState>) -> ApiResult {
    spotify::disconnect(&state)?;
    ok()
}

async fn now_playing(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "connected": spotify::is_connected(&state), "track": state.spotify.last_track() }))
}

async fn save_trucky(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let user_id = js_string_or_empty(body.get("userId")).trim().to_string();
    state.store().save_config(&json!({ "trucky": { "enable": is_truthy(body.get("enabled")), "USER_ID": user_id } }))?;
    ok()
}

async fn save_input_display(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    state.store().save_config(&json!({ "inputDisplay": { "enabled": is_truthy(body.get("enabled")) } }))?;
    ok()
}
