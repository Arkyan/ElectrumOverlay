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
        .route("/api/app/game-profiles", get(get_game_profiles).post(set_game_profiles))
        .route("/api/app/game-profiles/simulate", axum::routing::post(simulate_game))
        .route("/api/twitch/categories", get(search_categories))
        .route("/api/app/getting-started", get(getting_started).post(update_getting_started))
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

/// Profil par jeu : réglages, jeu en cours et liste des profils.
async fn get_game_profiles(State(state): State<AppState>) -> Json<serde_json::Value> {
    let (settings, profiles, active) = {
        let store = state.store();
        (
            crate::game_profiles::settings(store.config()),
            store.list_profiles().unwrap_or_default(),
            store.active_profile_id().map(str::to_string),
        )
    };
    let game = state.stats().game.clone();
    Json(json!({ "settings": settings, "currentGame": game, "profiles": profiles, "activeProfileId": active }))
}

async fn set_game_profiles(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let rules: Vec<serde_json::Value> = body["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|rule| {
            let game = rule["game"].as_str()?.trim();
            let profile = rule["profileId"].as_str()?.trim();
            (!game.is_empty() && !profile.is_empty()).then(|| json!({ "game": game, "profileId": profile }))
        })
        .collect();
    let settings = json!({
        "enabled": body["enabled"].as_bool().unwrap_or(false),
        "rules": rules,
        "fallbackProfileId": body["fallbackProfileId"].as_str().unwrap_or_default(),
    });
    // Remplacement complet (une règle supprimée doit disparaître, pas être fusionnée).
    {
        let mut store = state.store();
        store.save_config(&json!({ "app": { "gameProfiles": null } }))?;
        store.save_config(&json!({ "app": { "gameProfiles": settings } }))?;
    }
    // Appliqué tout de suite au jeu en cours.
    let game = state.stats().game.clone();
    let activated = crate::game_profiles::apply(&state, &game);
    Ok(Json(json!({ "ok": true, "activated": activated })))
}

/// Simule un changement de jeu (bouton « Tester » des réglages).
async fn simulate_game(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let game = body["game"].as_str().unwrap_or_default().trim().to_string();
    if game.is_empty() {
        return Err(ApiError::bad_request("Indique un jeu"));
    }
    state.stats().update_stream_info(None, Some(&game));
    let activated = crate::game_profiles::apply(&state, &game);
    Ok(Json(json!({ "ok": true, "activated": activated })))
}

/// Recherche de catégories Twitch (saisie du jeu dans les règles).
async fn search_categories(State(state): State<AppState>, axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>) -> ApiResult {
    let query = params.get("q").map(|q| q.trim()).unwrap_or_default().to_string();
    if query.len() < 2 {
        return Ok(Json(json!({ "categories": [] })));
    }
    let creds = crate::twitch::credentials(&state);
    if !creds.is_complete() {
        return Ok(Json(json!({ "categories": [] })));
    }
    let found = state.twitch.api.search_categories(&creds, &query).await.unwrap_or_default();
    let categories: Vec<_> = found.iter().map(|c| json!({ "name": c["name"], "image": c["box_art_url"] })).collect();
    Ok(Json(json!({ "categories": categories })))
}

/// Carte « Premiers pas » du tableau de bord : étapes faites ou non (détectées, ou cochées à la
/// main par l'utilisateur), et masquage de la carte.
async fn getting_started(State(state): State<AppState>) -> Json<serde_json::Value> {
    let twitch = state.twitch.status().connected;
    let tested = state.history().list().iter().any(|e| e["test"] == true);
    let (app, customized) = {
        let store = state.store();
        let app = store.config()["app"].clone();
        let display = store.active_profile_id().and_then(|id| store.effective_display(id).ok()).unwrap_or_default();
        let has = |key: &str| display[key].as_object().is_some_and(|pages| pages.values().any(|p| p.as_object().is_some_and(|m| !m.is_empty())));
        (app, has("customTexts") || has("layout") || has("texts"))
    };
    let manual = |key: &str| app["gettingStarted"]["done"][key].as_bool().unwrap_or(false);
    let steps = [
        ("style", app["onboarded"].as_bool().unwrap_or(false)),
        ("twitch", twitch),
        ("obs", false), // coché à la main
        ("test", tested),
        ("scene", customized),
    ];
    let steps: Vec<_> = steps.iter().map(|(key, auto)| json!({ "key": key, "done": *auto || manual(key) })).collect();
    Json(json!({ "hidden": app["gettingStarted"]["hidden"].as_bool().unwrap_or(false), "steps": steps }))
}

async fn update_getting_started(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let mut patch = json!({});
    if let Some(hidden) = body["hidden"].as_bool() {
        patch["hidden"] = json!(hidden);
    }
    if let Some(step) = body["done"].as_str().filter(|s| ["style", "twitch", "obs", "test", "scene"].contains(s)) {
        patch["done"] = json!({ step: true });
    }
    state.store().save_config(&json!({ "app": { "gettingStarted": patch } }))?;
    Ok(Json(json!({ "ok": true })))
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
