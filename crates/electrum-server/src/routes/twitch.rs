//! Routes liées à Twitch : autorisation (OAuth), statut, abonnements EventSub, badges.
//! Port des parties correspondantes de `src/routes/api.js`.

use super::{body_or_empty, ApiError, ApiResult};
use crate::pages;
use crate::state::AppState;
use crate::twitch::{credentials, eventsub};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth-url", get(auth_url_page))
        .route("/auth/callback", get(|| async { Redirect::to("/auth-callback") }))
        .route("/auth-callback", get(|| async { Html(pages::auth_callback()) }))
        .route("/api/oauth-callback", post(oauth_callback))
        .route("/auth/status", get(auth_status))
        .route("/status", get(status))
        .route("/subscriptions", get(subscriptions))
        .route("/clear-subscriptions", get(clear_subscriptions))
        .route("/badges/{broadcaster_id}", get(channel_badges))
        .route("/badgesglobal", get(global_badges))
}

/// URL d'autorisation Twitch construite depuis la config.
pub fn authorize_url(state: &AppState) -> String {
    let store = state.store();
    let twitch = &store.config()["twitch"];
    let text = |key: &str| twitch.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let scopes: Vec<String> = crate::twitch::authorization_scopes(
        twitch["SCOPES"].as_array().map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
    );
    state.twitch.api.authorize_url(&text("CLIENT_ID"), &text("REDIRECT_URI"), &scopes, &state.oauth_state)
}

async fn auth_url_page(State(state): State<AppState>) -> Html<String> {
    Html(pages::auth_url(&authorize_url(&state)))
}

/// Reçoit le token depuis /auth-callback, le valide auprès de Twitch, l'enregistre avec la chaîne
/// correspondante, puis relance la connexion EventSub.
async fn oauth_callback(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let token = body.get("token").and_then(Value::as_str).filter(|t| !t.is_empty());
    let Some(token) = token else { return Err(ApiError::bad_request("Token manquant")) };
    // Autorisation demandée par cette app (et pas un lien piégé qui ferait enregistrer le compte
    // de quelqu'un d'autre).
    if body.get("state").and_then(Value::as_str) != Some(state.oauth_state.as_str()) {
        return Err(ApiError::bad_request("Autorisation expirée ou d'origine inconnue : relance l'autorisation depuis l'app"));
    }
    let info = match state.twitch.api.validate(token).await {
        Ok(Some(info)) => info,
        Ok(None) => return Err(ApiError::bad_request("Token invalide")),
        Err(error) => return Err(ApiError(StatusCode::BAD_GATEWAY, error.to_string())),
    };
    let client_id = state.store().config()["twitch"]["CLIENT_ID"].as_str().unwrap_or_default().to_string();
    if !client_id.is_empty() && info.client_id != client_id {
        return Err(ApiError::bad_request("Ce token a été créé pour une autre application Twitch"));
    }
    state.store().save_config(&json!({
        "twitch": { "USER_ACCESS_TOKEN": token, "BROADCASTER_ID": info.user_id, "BROADCASTER_LOGIN": info.login }
    }))?;
    state.log("info", format!("🔑 Twitch autorisé pour {} (ID {})", info.login, info.user_id));
    state.twitch.restart.notify_one();
    Ok(Json(json!({ "ok": true, "broadcasterId": info.user_id, "login": info.login })))
}

async fn auth_status(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "authenticated": !credentials(&state).token.is_empty() }))
}

async fn status(State(state): State<AppState>) -> Json<Value> {
    let eventsub = eventsub::status_json(&state);
    Json(json!({
        "status": "online",
        "twitchAuthenticated": !credentials(&state).token.is_empty(),
        "subscriptionsCount": eventsub["subscriptions"],
        "serverTime": electrum_core::time::now_iso(),
        "wsPort": crate::configured_ports(&state).1,
        "eventsub": eventsub
    }))
}

async fn subscriptions(State(state): State<AppState>) -> Json<Value> {
    let subscriptions: Vec<Value> = state
        .twitch
        .status()
        .subscriptions
        .iter()
        .map(|s| json!({ "id": s["id"], "type": s["type"], "status": s["status"], "condition": s["condition"], "created_at": s["created_at"] }))
        .collect();
    Json(json!({ "total": subscriptions.len(), "subscriptions": subscriptions }))
}

/// Avec EventSub par WebSocket, les abonnements vivent avec la connexion : on la relance.
async fn clear_subscriptions(State(state): State<AppState>) -> Json<Value> {
    state.twitch.restart.notify_one();
    Json(json!({ "message": "Connexion EventSub relancée : les abonnements sont recréés" }))
}

async fn badges(state: AppState, broadcaster_id: Option<String>) -> Response {
    let creds = credentials(&state);
    match state.twitch.api.badges(&creds, broadcaster_id.as_deref()).await {
        Ok(data) => Json(data).into_response(),
        Err(error) => {
            state.log("error", format!("❌ Erreur récupération badges: {error}"));
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Erreur récupération badges", "data": { "data": [] } }))).into_response()
        }
    }
}

async fn channel_badges(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    badges(state, Some(id)).await
}

async fn global_badges(State(state): State<AppState>) -> Response {
    badges(state, None).await
}
