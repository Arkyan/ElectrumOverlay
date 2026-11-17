//! Simulation d'événements (page /tests, plugin Stream Deck) : port de `src/routes/testtools.js`.

use super::{body_or_empty, ok, ApiError, ApiResult};
use crate::events::{replay, route_test_event};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use electrum_core::time::now_iso;
use serde_json::{json, Map, Value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tests/trigger", post(trigger))
        .route("/api/panels/{panel}/show", post(show_panel))
        .route("/api/events/history", get(history).delete(clear_history))
        .route("/api/events/{id}/replay", post(replay_event))
}

fn with_broadcaster(state: &AppState, fields: Value) -> Value {
    let (id, login) = {
        let store = state.store();
        let twitch = &store.config()["twitch"];
        let pick = |key: &str, fallback: &str| {
            twitch.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(fallback).to_string()
        };
        (pick("BROADCASTER_ID", "test"), pick("BROADCASTER_LOGIN", "broadcaster"))
    };
    let mut event = Map::new();
    event.insert("broadcaster_user_id".into(), json!(id));
    event.insert("broadcaster_user_login".into(), json!(login));
    event.insert("broadcaster_user_name".into(), json!(login));
    if let Value::Object(fields) = fields {
        event.extend(fields);
    }
    Value::Object(event)
}

/// Mêmes fausses données que `TEST_ACTIONS` côté Node.
fn build_test_event(state: &AppState, action: &str) -> Option<(&'static str, Value)> {
    let viewer = || json!({ "user_id": "1", "user_login": "test_viewer", "user_name": "TestViewer" });
    let merge = |a: Value, b: Value| {
        let mut a = a.as_object().cloned().unwrap_or_default();
        a.extend(b.as_object().cloned().unwrap_or_default());
        Value::Object(a)
    };
    let chatter = || json!({ "chatter_user_id": "1", "chatter_user_login": "test_viewer", "chatter_user_name": "TestViewer" });
    Some(match action {
        "follow" => ("channel.follow", with_broadcaster(state, merge(viewer(), json!({ "followed_at": now_iso() })))),
        "sub" => ("channel.subscribe", with_broadcaster(state, merge(viewer(), json!({ "tier": "1000", "is_gift": false })))),
        "subgift" => ("channel.subscription.gift", with_broadcaster(state, merge(viewer(), json!({ "total": 5, "tier": "1000" })))),
        "raid" => {
            let b = with_broadcaster(state, json!({}));
            ("channel.raid", json!({
                "from_broadcaster_user_id": "1",
                "from_broadcaster_user_login": "test_raider",
                "from_broadcaster_user_name": "TestRaider",
                "to_broadcaster_user_id": b["broadcaster_user_id"],
                "to_broadcaster_user_name": b["broadcaster_user_name"],
                "viewers": 42
            }))
        }
        "bits" => ("channel.cheer", with_broadcaster(state, merge(json!({ "is_anonymous": false }), merge(viewer(), json!({ "message": "Super stream !", "bits": 100 }))))),
        "chat" => ("channel.chat.message", with_broadcaster(state, merge(chatter(), json!({
            "message": {
                "text": "Ceci est un message de test dans le chat ! Kappa",
                "fragments": [
                    { "type": "text", "text": "Ceci est un message de test dans le chat ! " },
                    { "type": "emote", "text": "Kappa", "emote": { "id": "25" } }
                ]
            },
            "color": "#9146FF",
            "badges": []
        })))),
        "info" => ("channel.chat.message", with_broadcaster(state, merge(chatter(), json!({
            "message": { "text": "!info", "fragments": [{ "type": "text", "text": "!info" }] },
            "color": "#9146FF",
            "badges": []
        })))),
        "streamOnline" => ("stream.online", with_broadcaster(state, json!({ "id": "test", "type": "live", "started_at": now_iso() }))),
        "streamOffline" => ("stream.offline", with_broadcaster(state, json!({}))),
        _ => return None,
    })
}

async fn trigger(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let action = body.get("action").and_then(Value::as_str).unwrap_or_default();
    let (event_type, event) =
        build_test_event(&state, action).ok_or_else(|| ApiError::bad_request("Action de test inconnue"))?;
    route_test_event(&state, event_type, &event);
    ok()
}

async fn show_panel(State(state): State<AppState>, Path(panel): Path<String>) -> ApiResult {
    if panel != "left" && panel != "bottom" {
        return Err(ApiError::bad_request("Panneau inconnu (left ou bottom)"));
    }
    state.broadcast(&json!({ "type": "show-panel", "panel": panel }));
    ok()
}

/// Dernières alertes reçues (du plus récent au plus ancien).
async fn history(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "events": state.history().list() }))
}

async fn clear_history(State(state): State<AppState>) -> ApiResult {
    state.history().clear();
    ok()
}

/// Rejoue une alerte sur les overlays.
async fn replay_event(State(state): State<AppState>, Path(id): Path<u64>) -> ApiResult {
    if !replay(&state, id) {
        return Err(ApiError(axum::http::StatusCode::NOT_FOUND, "Événement introuvable (l'historique est vidé au redémarrage)".into()));
    }
    ok()
}
