//! Assistant de configuration (/setup) : port de `src/routes/setup.js`, sans ngrok et sans
//! redémarrage (la connexion EventSub est simplement relancée).

use super::{body_or_empty, ok, ApiError, ApiResult};
use crate::pages;
use crate::routes::twitch::authorize_url;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use electrum_core::json::is_truthy;
use electrum_core::store::BUILTIN_PAGE_KEYS;
use serde_json::{json, Map, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup", get(setup_page))
        .route("/api/setup/credentials", post(save_credentials))
        .route("/api/setup/auth-url", get(auth_url))
        .route("/api/setup/auth-status", get(auth_status))
        .route("/api/setup/finish", post(finish))
}

/// Chemins accessibles avant la fin de l'assistant (comme `SETUP_ALLOWED_PREFIXES` côté Node).
const SETUP_ALLOWED_PREFIXES: [&str; 12] = [
    "/setup", "/welcome", "/api/", "/auth-url", "/auth-callback", "/auth/callback", "/favicon.ico", "/logs", "/css/", "/js/", "/fonts/", "/logo.png",
];

/// Tant que la config Twitch n'est pas complète, toute page (overlays compris) redirige vers
/// /setup. Les requêtes autres que GET et les chemins ci-dessus passent.
pub async fn redirect_until_configured(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let allowed = request.method() != axum::http::Method::GET
        || SETUP_ALLOWED_PREFIXES.iter().any(|p| path == *p || path.starts_with(p));
    let (configured, onboarded) = {
        let store = state.store();
        (store.is_configured(), super::welcome::onboarded(store.config()))
    };
    if allowed || configured {
        next.run(request).await
    } else if !onboarded {
        // Tout premier lancement : style du stream d'abord, Twitch ensuite.
        Redirect::to("/welcome").into_response()
    } else {
        Redirect::to("/setup").into_response()
    }
}

async fn setup_page(State(state): State<AppState>) -> Html<String> {
    Html(pages::setup(state.store().config()))
}

async fn save_credentials(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let client_id = body.get("clientId").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let client_secret = body.get("clientSecret").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    if client_id.is_empty() {
        return Err(ApiError::bad_request("Client ID requis"));
    }
    let has_secret = is_truthy(state.store().config()["twitch"].get("CLIENT_SECRET"));
    if client_secret.is_empty() && !has_secret {
        return Err(ApiError::bad_request("Client Secret requis"));
    }
    let mut twitch = Map::new();
    twitch.insert("CLIENT_ID".into(), json!(client_id));
    if !client_secret.is_empty() {
        twitch.insert("CLIENT_SECRET".into(), json!(client_secret));
    }
    state.store().save_config(&json!({ "twitch": twitch }))?;
    state.twitch.restart.notify_one();
    ok()
}

async fn auth_url(State(state): State<AppState>) -> ApiResult {
    let (has_client, redirect) = {
        let store = state.store();
        let twitch = &store.config()["twitch"];
        (is_truthy(twitch.get("CLIENT_ID")), twitch["REDIRECT_URI"].clone())
    };
    if !has_client {
        return Err(ApiError::bad_request("Enregistrez d'abord votre Client ID"));
    }
    Ok(Json(json!({ "url": authorize_url(&state), "redirectUri": redirect })))
}

async fn auth_status(State(state): State<AppState>) -> Json<Value> {
    let store = state.store();
    let twitch = &store.config()["twitch"];
    let or_null = |key: &str| twitch.get(key).filter(|v| is_truthy(Some(v))).cloned().unwrap_or(Value::Null);
    Json(json!({
        "authenticated": is_truthy(twitch.get("USER_ACCESS_TOKEN")),
        "broadcasterId": or_null("BROADCASTER_ID"),
        "broadcasterLogin": or_null("BROADCASTER_LOGIN")
    }))
}

/// Couleur éclaircie / assombrie de `percent` % (`shadeHex` côté Node).
pub fn shade_hex(hex: &str, percent: f64) -> String {
    let normalized = hex.trim_start_matches('#');
    if normalized.len() != 6 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return hex.to_string();
    }
    let num = u32::from_str_radix(normalized, 16).unwrap_or(0) as i64;
    let delta = (255.0 * (percent / 100.0) + 0.5).floor() as i64;
    let clamp = |v: i64| v.clamp(0, 255);
    let (r, g, b) = (clamp((num >> 16) + delta), clamp(((num >> 8) & 0xff) + delta), clamp((num & 0xff) + delta));
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Image de marque. Différence volontaire avec Node : elle est enregistrée dans le PROFIL ACTIF
/// (côté Node, elle partait à la racine d'overlay-config.json, où elle était ignorée dès qu'un
/// profil existait — donc perdue au redémarrage).
async fn finish(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    if !is_truthy(state.store().config()["twitch"].get("USER_ACCESS_TOKEN")) {
        return Err(ApiError::bad_request("Autorisation Twitch requise avant d'enregistrer"));
    }
    let text = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or_default().to_string();

    let mut themes = Map::new();
    let accent = text("accentColor");
    if !accent.is_empty() {
        let secondary = shade_hex(&accent, -10.0);
        for page in BUILTIN_PAGE_KEYS {
            themes.insert(page.into(), json!({ "primary": accent, "secondary": secondary, "panelBorder": accent }));
        }
    }
    let info_texts: Vec<String> =
        ["infoLine1", "infoLine2", "infoLine3"].iter().map(|k| text(k)).filter(|v| !v.trim().is_empty()).collect();
    let mut content = Map::new();
    if !info_texts.is_empty() {
        content.insert("infoTexts".into(), json!(info_texts));
    }
    let scrolling = text("scrollingText");
    if !scrolling.is_empty() {
        content.insert("scrollingText".into(), json!(scrolling));
    }
    let patch = json!({ "panels": { "bottom": { "content": content } }, "themes": themes });

    let active = state.store().active_profile_id().map(str::to_string);
    if let Some(active) = active {
        state.store().save_profile_display(&active, &patch)?;
        state.broadcast_config();
    }
    state.twitch.restart.notify_one();
    ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn shade_hex_comme_node() {
        assert_eq!(super::shade_hex("#a855f7", -10.0), "#8f3cde"); // valeur de shadeHex côté Node
        assert_eq!(super::shade_hex("#000000", -10.0), "#000000");
        assert_eq!(super::shade_hex("rouge", -10.0), "rouge");
    }
}
