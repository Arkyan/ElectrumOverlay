//! Spotify : connexion du compte (OAuth « authorization code »), renouvellement du token et
//! morceau en cours de lecture. Port de `src/services/SpotifyAuth.js` et du polling de
//! `server.js` : toutes les 5 s, `spotify-track-updated` n'est diffusé que si le morceau change.

use crate::state::AppState;
use crate::twitch::api::form_encode;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

/// URLs de Spotify, remplaçables dans les tests.
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// `https://accounts.spotify.com`
    pub accounts: String,
    /// `https://api.spotify.com/v1`
    pub api: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints { accounts: "https://accounts.spotify.com".into(), api: "https://api.spotify.com/v1".into() }
    }
}

pub struct SpotifyState {
    pub endpoints: Endpoints,
    http: reqwest::Client,
    /// Dernier morceau diffusé (`null` = rien en lecture).
    pub last_track: Mutex<Option<Value>>,
}

impl SpotifyState {
    pub fn new(endpoints: Endpoints) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("ElectrumOverlay")
            .timeout(Duration::from_secs(15))
            .build()
            .expect("client HTTP");
        SpotifyState { endpoints, http, last_track: Mutex::new(None) }
    }

    pub fn last_track(&self) -> Option<Value> {
        self.last_track.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

fn setting(state: &AppState, key: &str) -> Value {
    state.store().config()["spotify"].get(key).cloned().unwrap_or(Value::Null)
}

fn text(state: &AppState, key: &str) -> String {
    setting(state, key).as_str().unwrap_or_default().to_string()
}

/// Client ID et Client Secret renseignés.
pub fn is_configured(state: &AppState) -> bool {
    !text(state, "CLIENT_ID").is_empty() && !text(state, "CLIENT_SECRET").is_empty()
}

/// Un compte a été connecté (un refresh token est enregistré).
pub fn is_connected(state: &AppState) -> bool {
    !text(state, "REFRESH_TOKEN").is_empty()
}

/// URL d'autorisation, mêmes paramètres et même ordre que `generateAuthUrl()` côté Node.
pub fn authorize_url(state: &AppState) -> String {
    let scopes: Vec<String> = setting(state, "SCOPES")
        .as_array()
        .map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    format!(
        "{}/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&show_dialog=true&state={}",
        state.spotify.endpoints.accounts,
        form_encode(&text(state, "CLIENT_ID")),
        form_encode(&text(state, "REDIRECT_URI")),
        form_encode(&scopes.join(" ")),
        form_encode(&state.oauth_state)
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Demande de token (`/api/token`) : échange de code ou renouvellement.
async fn token_request(state: &AppState, form: &[(&str, &str)]) -> Result<(), String> {
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", text(state, "CLIENT_ID"), text(state, "CLIENT_SECRET")));
    let body = form.iter().map(|(k, v)| format!("{k}={}", form_encode(v))).collect::<Vec<_>>().join("&");
    let response = state
        .spotify
        .http
        .post(format!("{}/api/token", state.spotify.endpoints.accounts))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Authorization", format!("Basic {basic}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Spotify injoignable : {e}"))?;
    let status = response.status();
    let data: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let reason = data["error_description"].as_str().or(data["error"].as_str()).unwrap_or("erreur");
        return Err(format!("HTTP {} : {reason}", status.as_u16()));
    }
    // Comme côté Node : 60 s de marge avant l'expiration réelle.
    let expires_in = data["expires_in"].as_i64().unwrap_or(0);
    let mut patch = json!({
        "ACCESS_TOKEN": data["access_token"],
        "EXPIRES_AT": now_ms() + (expires_in - 60).max(0) * 1000
    });
    if let Some(refresh) = data["refresh_token"].as_str().filter(|r| !r.is_empty()) {
        patch["REFRESH_TOKEN"] = json!(refresh);
    }
    state.store().save_config(&json!({ "spotify": patch })).map_err(|e| e.to_string())
}

/// Échange le code reçu sur `/api/spotify/callback` contre les tokens.
pub async fn exchange_code(state: &AppState, code: &str) -> Result<(), String> {
    let redirect = text(state, "REDIRECT_URI");
    token_request(state, &[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", &redirect)]).await
}

/// Oublie le compte connecté.
pub fn disconnect(state: &AppState) -> electrum_core::Result<()> {
    state.store().save_config(&json!({ "spotify": { "ACCESS_TOKEN": "", "REFRESH_TOKEN": "", "EXPIRES_AT": 0 } }))?;
    *state.spotify.last_track.lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(())
}

/// Token d'accès valide, renouvelé si besoin.
async fn ensure_token(state: &AppState) -> Result<String, String> {
    if !is_connected(state) {
        return Err("Spotify non connecté".into());
    }
    let expires_at = setting(state, "EXPIRES_AT").as_i64().unwrap_or(0);
    if text(state, "ACCESS_TOKEN").is_empty() || now_ms() >= expires_at {
        let refresh = text(state, "REFRESH_TOKEN");
        token_request(state, &[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await?;
    }
    Ok(text(state, "ACCESS_TOKEN"))
}

/// Morceau en cours (même forme que `getCurrentlyPlaying()` côté Node), ou `None`.
pub async fn currently_playing(state: &AppState) -> Result<Option<Value>, String> {
    let token = ensure_token(state).await?;
    let response = state
        .spotify
        .http
        .get(format!("{}/me/player/currently-playing", state.spotify.endpoints.api))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Spotify injoignable : {e}"))?;
    match response.status().as_u16() {
        204 => return Ok(None),
        200 => {}
        other => return Err(format!("HTTP {other}")),
    }
    let data: Value = response.json().await.unwrap_or(Value::Null);
    let item = &data["item"];
    if !item.is_object() {
        return Ok(None);
    }
    let artist = item["artists"]
        .as_array()
        .map(|a| a.iter().map(|x| x["name"].as_str().unwrap_or_default()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Ok(Some(json!({
        "isPlaying": data["is_playing"].as_bool().unwrap_or(false),
        "title": item["name"],
        "artist": artist,
        "album": item["album"]["name"].as_str().unwrap_or_default(),
        "albumArt": item["album"]["images"][0]["url"],
        "progressMs": data["progress_ms"].as_u64().unwrap_or(0),
        "durationMs": item["duration_ms"].as_u64().unwrap_or(0)
    })))
}

/// `sameSpotifyTrack()` : même titre, même artiste, même état de lecture.
pub fn same_track(a: &Option<Value>, b: &Option<Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a["title"] == b["title"] && a["artist"] == b["artist"] && a["isPlaying"] == b["isPlaying"],
        _ => false,
    }
}

/// Toutes les `period` : morceau en cours, diffusé aux overlays seulement s'il a changé.
pub async fn poll(state: AppState, period: Duration) {
    let mut interval = tokio::time::interval(period);
    loop {
        interval.tick().await;
        if !is_connected(&state) {
            continue;
        }
        // Une erreur ponctuelle (quota, réseau...) ne doit jamais interrompre le serveur.
        let Ok(track) = currently_playing(&state).await else { continue };
        let changed = {
            let mut last = state.spotify.last_track.lock().unwrap_or_else(|p| p.into_inner());
            let changed = !same_track(&track, &last);
            if changed {
                *last = track.clone();
            }
            changed
        };
        if changed {
            state.broadcast(&json!({ "type": "spotify-track-updated", "track": track }));
        }
    }
}
