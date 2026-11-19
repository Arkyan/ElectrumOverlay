//! Événements Twitch → stats du stream + diffusion aux overlays.
//! Port de `WebhookHandler.routeEvent()` (`src/services/WebhookHandler.js`) : utilisé par les
//! outils de test aujourd'hui, et par EventSub demain — un seul chemin pour les deux.

use crate::state::AppState;
use electrum_core::time::now_iso;
use serde_json::{json, Map, Value};

fn text<'a>(event: &'a Value, key: &str) -> Option<&'a str> {
    event.get(key).and_then(Value::as_str)
}

fn broadcast_raw(state: &AppState, event_type: &str, event: &Value) {
    state.broadcast(&json!({ "type": event_type, "data": event }));
}

/// Diffuse une alerte et la garde dans l'historique du tableau de bord.
fn broadcast_alert(state: &AppState, event_type: &str, event: &Value, test: bool) {
    state.history().record(event_type, event, test);
    broadcast_raw(state, event_type, event);
}

/// Profil automatique selon le jeu (catégorie de l'événement).
fn apply_game_profile(state: &AppState, event: &Value) {
    if let Some(game) = text(event, "category_name").filter(|g| !g.is_empty()).or_else(|| text(event, "game_name")) {
        crate::game_profiles::apply(state, game);
    }
}

/// Rejoue une alerte de l'historique (sans recompter les stats).
pub fn replay(state: &AppState, id: u64) -> bool {
    let Some(entry) = state.history().get(id) else { return false };
    broadcast_raw(state, entry["type"].as_str().unwrap_or_default(), &entry["data"]);
    true
}

/// Message de chat au format attendu par les overlays (`type: "message"`).
pub fn chat_message_payload(event: &Value) -> Value {
    let mut badges = Map::new();
    if let Some(list) = event.get("badges").and_then(Value::as_array) {
        for badge in list {
            if let (Some(set_id), Some(id)) = (badge.get("set_id"), badge.get("id")) {
                let key = set_id.as_str().map(str::to_string).unwrap_or_else(|| set_id.to_string());
                badges.insert(key, id.clone());
            }
        }
    }
    let color = text(event, "color").filter(|c| !c.is_empty()).unwrap_or("#ffffff");
    let message = event.get("message");
    json!({
        "type": "message",
        "username": event.get("chatter_user_name"),
        "message": message.and_then(|m| m.get("text")),
        "color": color,
        "badges": badges,
        "fragments": message.and_then(|m| m.get("fragments")).cloned().unwrap_or_else(|| json!([])),
        "timestamp": now_iso(),
        "userId": event.get("chatter_user_id"),
        "displayName": event.get("chatter_user_name")
    })
}

/// Traite un événement EventSub (`subscription.type` + `event`).
pub fn route_event(state: &AppState, event_type: &str, event: &Value) {
    route(state, event_type, event, false);
}

/// Comme `route_event`, pour un faux événement des outils de test (marqué dans l'historique).
pub fn route_test_event(state: &AppState, event_type: &str, event: &Value) {
    route(state, event_type, event, true);
}

fn route(state: &AppState, event_type: &str, event: &Value, test: bool) {
    if let Some((kind, phase)) = crate::interactions::classify(event_type) {
        crate::interactions::handle(state, kind, phase, event);
        return;
    }
    match event_type {
        "stream.online" => {
            state.stats().start_stream(
                text(event, "started_at"),
                text(event, "title"),
                text(event, "category_name").filter(|g| !g.is_empty()).or_else(|| text(event, "game_name")),
            );
            broadcast_raw(state, "stream.online", event);
            apply_game_profile(state, event);
        }
        "stream.offline" => {
            state.stats().end_stream();
            broadcast_raw(state, "stream.offline", event);
        }
        "channel.update" => {
            state.stats().update_stream_info(
                text(event, "title"),
                text(event, "category_name").filter(|g| !g.is_empty()).or_else(|| text(event, "game_name")),
            );
            broadcast_raw(state, "channel.update", event);
            apply_game_profile(state, event);
        }
        "channel.follow" => {
            state.stats().add_follow();
            broadcast_alert(state, "channel.follow", event, test);
        }
        // Un renouvellement est diffusé comme un abonnement (même alerte côté overlay).
        // Un abonnement offert arrive deux fois : dans `channel.subscription.gift` (avec le total)
        // puis en `channel.subscribe` (is_gift) pour chaque bénéficiaire. Il n'est compté qu'une fois.
        "channel.subscribe" | "channel.subscription.message" => {
            if event.get("is_gift").and_then(Value::as_bool) != Some(true) {
                state.stats().add_subscriber(1);
            }
            broadcast_alert(state, "channel.subscribe", event, test);
        }
        "channel.subscription.gift" => {
            let total = event.get("total").and_then(Value::as_u64).filter(|t| *t > 0).unwrap_or(1);
            state.stats().add_subscriber(total);
            broadcast_alert(state, "channel.subscription.gift", event, test);
        }
        "channel.cheer" => broadcast_alert(state, "channel.cheer", event, test),
        "channel.raid" => broadcast_alert(state, "channel.raid", event, test),
        "channel.chat.message" => {
            state.stats().add_chat_message();
            state.broadcast(&chat_message_payload(event));
            crate::commands::handle_message(state, event);
        }
        other => state.log("warn", format!("⚠️ Type d'événement non géré: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_du_message_de_chat() {
        let payload = chat_message_payload(&json!({
            "chatter_user_id": "1",
            "chatter_user_name": "Bob",
            "color": "",
            "badges": [{ "set_id": "subscriber", "id": "12", "info": "12" }],
            "message": { "text": "salut", "fragments": [{ "type": "text", "text": "salut" }] }
        }));
        assert_eq!(payload["color"], "#ffffff");
        assert_eq!(payload["badges"], json!({ "subscriber": "12" }));
        assert_eq!(payload["message"], "salut");
        let keys: Vec<_> = payload.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["type", "username", "message", "color", "badges", "fragments", "timestamp", "userId", "displayName"]);
    }
}
