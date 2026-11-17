//! Commandes de chat personnalisées (!discord...) : port de `src/services/CommandManager.js`.

use crate::state::AppState;
use electrum_core::commands::COMMAND_PERMISSIONS;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn permission_level(state: &AppState, event: &Value) -> &'static str {
    let broadcaster = state.store().config()["twitch"]["BROADCASTER_ID"].clone();
    if event.get("chatter_user_id").is_some() && event.get("chatter_user_id") == Some(&broadcaster) {
        return "broadcaster";
    }
    let badges: Vec<&str> = event
        .get("badges")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|b| b.get("set_id").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    if badges.contains(&"moderator") {
        "moderator"
    } else if badges.contains(&"vip") {
        "vip"
    } else {
        "everyone"
    }
}

fn rank(level: &str) -> isize {
    COMMAND_PERMISSIONS.iter().position(|p| *p == level).map_or(-1, |i| i as isize)
}

/// Message de chat reçu : déclenche la commande correspondante si elle existe, est activée, et
/// que permission et cooldown le permettent. Ne fait jamais échouer le traitement du message.
pub fn handle_message(state: &AppState, event: &Value) {
    let text = event.get("message").and_then(|m| m.get("text")).and_then(Value::as_str).unwrap_or_default();
    if !text.trim().starts_with('!') {
        return;
    }
    // Écho de notre propre réponse (envoyée au nom du streamer) : à ignorer, sinon une réponse
    // commençant par « ! » relancerait la commande en boucle.
    if let Some(id) = event.get("message_id").and_then(Value::as_str) {
        if state.twitch.sent_messages.lock().unwrap_or_else(|p| p.into_inner()).take(id) {
            return;
        }
    }
    let token = text.split_whitespace().next().unwrap_or_default().to_lowercase();
    let command = state.store().list_commands().into_iter().find(|c| {
        electrum_core::json::is_truthy(c.get("enabled")) && c.get("trigger").and_then(Value::as_str) == Some(token.as_str())
    });
    let Some(command) = command else { return };

    let required = command.get("permission").and_then(Value::as_str).filter(|p| !p.is_empty()).unwrap_or("everyone");
    if rank(permission_level(state, event)) < rank(required) {
        return;
    }

    let id = command.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let cooldown = Duration::from_secs_f64(command.get("cooldownSeconds").and_then(Value::as_f64).unwrap_or(0.0).max(0.0));
    {
        let mut last = state.command_cooldowns.lock().unwrap_or_else(|p| p.into_inner());
        if last.get(&id).is_some_and(|t| t.elapsed() < cooldown) {
            return;
        }
        last.insert(id, Instant::now());
    }
    execute_command(state, &command, event);
}

/// Actions d'une commande (réponse chat / action overlay), sans matching ni cooldown — utilisé
/// aussi par le bouton « Tester » de /commands.
pub fn execute_command(state: &AppState, command: &Value, event: &Value) {
    let reply = command.get("chatReply");
    let message = reply.and_then(|r| r.get("message")).and_then(Value::as_str).unwrap_or_default();
    if electrum_core::json::is_truthy(reply.and_then(|r| r.get("enabled"))) && !message.is_empty() {
        let user = event.get("chatter_user_name").and_then(Value::as_str).unwrap_or_default();
        let message = message.replace("{user}", user);
        crate::twitch::send_chat_message(state, message);
    }
    let action = command.get("overlayAction");
    if electrum_core::json::is_truthy(action.and_then(|a| a.get("enabled"))) {
        let panel = action.and_then(|a| a.get("panel")).cloned().unwrap_or(Value::Null);
        state.broadcast(&json!({ "type": "show-panel", "panel": panel }));
    }
}
