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
        .route("/api/interactions", get(interactions))
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

/// Objectif, sondage, prédiction et hype train en cours (affichage immédiat d'un overlay ouvert).
async fn interactions(State(state): State<AppState>) -> Json<Value> {
    Json(state.interactions().to_json())
}

fn in_seconds(seconds: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Scénario de démonstration : (délai en ms depuis le début, type EventSub, événement).
fn interaction_scenario(state: &AppState, action: &str) -> Option<Vec<(u64, &'static str, Value)>> {
    let b = |fields: Value| with_broadcaster(state, fields);
    let choices = |votes: [u64; 3]| {
        json!([
            { "id": "c1", "title": "Euro Truck Simulator 2", "votes": votes[0] },
            { "id": "c2", "title": "Minecraft", "votes": votes[1] },
            { "id": "c3", "title": "Just Chatting", "votes": votes[2] }
        ])
    };
    let outcomes = |users: [u64; 2], points: [u64; 2]| {
        json!([
            { "id": "o1", "title": "Livraison sans dégâts", "color": "blue", "users": users[0], "channel_points": points[0] },
            { "id": "o2", "title": "Au moins une rayure", "color": "pink", "users": users[1], "channel_points": points[1] }
        ])
    };
    let hype = |level: u64, total: u64, progress: u64, goal: u64| {
        json!({ "id": "test-hype", "type": "regular", "level": level, "total": total, "progress": progress, "goal": goal, "expires_at": in_seconds(300),
            "top_contributions": [{ "user_name": "TestViewer", "type": "bits", "total": 500 }, { "user_name": "Alice", "type": "subscription", "total": 1000 }] })
    };
    Some(match action {
        "goal" => vec![(0, "channel.goal.progress", b(json!({ "id": "test-goal", "type": "follower", "description": "Objectif followers", "current_amount": 842, "target_amount": 1000 })))],
        "poll" => vec![
            (0, "channel.poll.begin", b(json!({ "id": "test-poll", "title": "On joue à quoi ensuite ?", "choices": choices([0, 0, 0]), "ends_at": in_seconds(20) }))),
            (3000, "channel.poll.progress", b(json!({ "id": "test-poll", "title": "On joue à quoi ensuite ?", "choices": choices([12, 5, 3]), "ends_at": in_seconds(17) }))),
            (8000, "channel.poll.progress", b(json!({ "id": "test-poll", "title": "On joue à quoi ensuite ?", "choices": choices([21, 14, 6]), "ends_at": in_seconds(12) }))),
            (14000, "channel.poll.end", b(json!({ "id": "test-poll", "title": "On joue à quoi ensuite ?", "choices": choices([27, 15, 6]), "status": "completed", "ended_at": in_seconds(0) }))),
        ],
        "prediction" => vec![
            (0, "channel.prediction.begin", b(json!({ "id": "test-pred", "title": "La prochaine livraison ?", "outcomes": outcomes([0, 0], [0, 0]), "locks_at": in_seconds(20) }))),
            (3000, "channel.prediction.progress", b(json!({ "id": "test-pred", "title": "La prochaine livraison ?", "outcomes": outcomes([8, 5], [4200, 2100]), "locks_at": in_seconds(17) }))),
            (8000, "channel.prediction.lock", b(json!({ "id": "test-pred", "title": "La prochaine livraison ?", "outcomes": outcomes([14, 9], [7300, 5200]) }))),
            (14000, "channel.prediction.end", b(json!({ "id": "test-pred", "title": "La prochaine livraison ?", "outcomes": outcomes([14, 9], [7300, 5200]), "status": "resolved", "winning_outcome_id": "o1" }))),
        ],
        "hypetrain" => vec![
            (0, "channel.hype_train.begin", b(hype(1, 600, 600, 1800))),
            (4000, "channel.hype_train.progress", b(hype(2, 2500, 700, 2100))),
            (12000, "channel.hype_train.end", b(json!({ "id": "test-hype", "level": 2, "total": 2500, "top_contributions": [] }))),
        ],
        _ => return None,
    })
}

async fn trigger(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let action = body.get("action").and_then(Value::as_str).unwrap_or_default();
    if let Some(steps) = interaction_scenario(&state, action) {
        tokio::spawn(async move {
            let start = tokio::time::Instant::now();
            for (at, event_type, event) in steps {
                tokio::time::sleep_until(start + std::time::Duration::from_millis(at)).await;
                route_test_event(&state, event_type, &event);
            }
        });
        return ok();
    }
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
    let mut events = state.history().list();
    if state.language() == "en" {
        for event in &mut events {
            if let Some(detail) = event["detail"].as_str() {
                event["detail"] = json!(crate::i18n::to_english(detail));
            }
        }
    }
    Json(json!({ "events": events }))
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
