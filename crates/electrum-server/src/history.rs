//! Historique des derniers événements d'alerte (follow, sub, bits, raid...) pour le tableau de
//! bord : de quoi voir ce qui s'est passé et rejouer une alerte ratée (OBS sur la mauvaise
//! scène, overlay rechargé...). En mémoire seulement : vidé au redémarrage de l'app.

use electrum_core::time::now_iso;
use serde_json::{json, Value};
use std::collections::VecDeque;

/// Nombre d'événements conservés.
pub const MAX_EVENTS: usize = 100;

/// Événements qui déclenchent une alerte sur les overlays (et qu'on peut donc rejouer).
pub fn is_alert(event_type: &str) -> bool {
    matches!(
        event_type,
        "channel.follow" | "channel.subscribe" | "channel.subscription.gift" | "channel.cheer" | "channel.raid"
    )
}

#[derive(Default)]
pub struct History {
    events: VecDeque<Value>,
    next_id: u64,
}

fn text<'a>(event: &'a Value, key: &str) -> &'a str {
    event.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Pseudo et détail lisibles d'un événement (`broadcast_type` = type diffusé aux overlays).
fn describe(broadcast_type: &str, event: &Value) -> (String, String) {
    let user = text(event, "user_name").to_string();
    match broadcast_type {
        "channel.follow" => (user, "Follow".into()),
        "channel.subscribe" => {
            let tier = match text(event, "tier") {
                "2000" => " (tier 2)",
                "3000" => " (tier 3)",
                _ => "",
            };
            let detail = if let Some(months) = event.get("cumulative_months").and_then(Value::as_u64).filter(|m| *m > 1) {
                format!("Resub {months} mois{tier}")
            } else if event.get("is_gift") == Some(&Value::Bool(true)) {
                format!("Sub offert{tier}")
            } else {
                format!("Sub{tier}")
            };
            (user, detail)
        }
        "channel.subscription.gift" => {
            let total = event.get("total").and_then(Value::as_u64).unwrap_or(1);
            let user = if event.get("is_anonymous") == Some(&Value::Bool(true)) { "Anonyme".into() } else { user };
            (user, format!("{total} sub{} offert{}", if total > 1 { "s" } else { "" }, if total > 1 { "s" } else { "" }))
        }
        "channel.cheer" => {
            let bits = event.get("bits").and_then(Value::as_u64).unwrap_or(0);
            let user = if event.get("is_anonymous") == Some(&Value::Bool(true)) { "Anonyme".into() } else { user };
            (user, format!("{bits} bits"))
        }
        "channel.raid" => {
            let viewers = event.get("viewers").and_then(Value::as_u64).unwrap_or(0);
            (text(event, "from_broadcaster_user_name").to_string(), format!("{viewers} viewers"))
        }
        other => (user, other.to_string()),
    }
}

impl History {
    /// Mémorise un événement diffusé aux overlays et renvoie son entrée.
    pub fn record(&mut self, broadcast_type: &str, event: &Value, test: bool) -> Value {
        self.next_id += 1;
        let (user, detail) = describe(broadcast_type, event);
        let entry = json!({
            "id": self.next_id,
            "type": broadcast_type,
            "user": user,
            "detail": detail,
            "time": now_iso(),
            "test": test,
            "data": event,
        });
        self.events.push_front(entry.clone());
        self.events.truncate(MAX_EVENTS);
        entry
    }

    /// Du plus récent au plus ancien.
    pub fn list(&self) -> Vec<Value> {
        self.events.iter().cloned().collect()
    }

    pub fn get(&self, id: u64) -> Option<Value> {
        self.events.iter().find(|e| e["id"] == id).cloned()
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_et_limite() {
        let mut history = History::default();
        let resub = history.record("channel.subscribe", &json!({ "user_name": "Bob", "tier": "2000", "cumulative_months": 7 }), false);
        assert_eq!((resub["user"].as_str(), resub["detail"].as_str()), (Some("Bob"), Some("Resub 7 mois (tier 2)")));
        let raid = history.record("channel.raid", &json!({ "from_broadcaster_user_name": "Alice", "viewers": 42 }), true);
        assert_eq!(raid["detail"], "42 viewers");
        let gift = history.record("channel.subscription.gift", &json!({ "is_anonymous": true, "total": 5 }), false);
        assert_eq!((gift["user"].as_str(), gift["detail"].as_str()), (Some("Anonyme"), Some("5 subs offerts")));
        assert_eq!(history.list()[0]["id"], gift["id"]);
        for _ in 0..MAX_EVENTS {
            history.record("channel.follow", &json!({ "user_name": "x" }), false);
        }
        assert_eq!(history.list().len(), MAX_EVENTS);
        assert!(history.get(1).is_none());
    }
}
