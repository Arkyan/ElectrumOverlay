//! Objectifs, sondages, prédictions et hype train : état en cours (pour qu'un overlay ouvert en
//! plein sondage l'affiche tout de suite) et diffusion aux overlays sous une forme simplifiée :
//! `{ type: "interaction", kind: "goal" | "poll" | "prediction" | "hypetrain",
//!    phase: "begin" | "progress" | "lock" | "end", data: {...} }`.

use crate::state::AppState;
use serde_json::{json, Value};

/// Ce qui est en cours (un de chaque au plus, comme sur Twitch... sauf les objectifs).
#[derive(Default, Clone)]
pub struct Interactions {
    pub goal: Option<Value>,
    pub poll: Option<Value>,
    pub prediction: Option<Value>,
    pub hypetrain: Option<Value>,
}

impl Interactions {
    pub fn to_json(&self) -> Value {
        json!({ "goal": self.goal, "poll": self.poll, "prediction": self.prediction, "hypetrain": self.hypetrain })
    }

    fn slot(&mut self, kind: &str) -> &mut Option<Value> {
        match kind {
            "goal" => &mut self.goal,
            "poll" => &mut self.poll,
            "prediction" => &mut self.prediction,
            _ => &mut self.hypetrain,
        }
    }
}

fn text(event: &Value, key: &str) -> Value {
    event.get(key).cloned().unwrap_or(Value::Null)
}

fn number(event: &Value, key: &str) -> u64 {
    event.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Libellé d'un objectif Twitch selon son type.
fn goal_unit(kind: &str) -> &'static str {
    match kind {
        "follow" | "follower" => "followers",
        "subscription" => "points d'abonnement",
        "subscription_count" => "abonnés",
        "new_subscription" => "points de nouveaux abonnements",
        "new_subscription_count" => "nouveaux abonnés",
        "new_bit" => "bits",
        "new_cheerer" => "donateurs de bits",
        _ => "",
    }
}

/// Objectif au format Helix (`GET /goals`) ou EventSub (`channel.goal.*`).
pub fn goal(event: &Value) -> Value {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
    json!({
        "id": text(event, "id"),
        "type": kind,
        "unit": goal_unit(kind),
        "description": event.get("description").and_then(Value::as_str).unwrap_or_default(),
        "current": number(event, "current_amount"),
        "target": number(event, "target_amount"),
        "achieved": event.get("is_achieved").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn poll(event: &Value) -> Value {
    let choices: Vec<Value> = event
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| json!({ "id": text(c, "id"), "title": text(c, "title"), "votes": number(c, "votes") }))
        .collect();
    json!({
        "id": text(event, "id"),
        "title": text(event, "title"),
        "choices": choices,
        "endsAt": event.get("ends_at").or_else(|| event.get("ended_at")).cloned().unwrap_or(Value::Null),
        "status": event.get("status").and_then(Value::as_str).unwrap_or("active"),
    })
}

fn prediction(event: &Value) -> Value {
    let outcomes: Vec<Value> = event
        .get("outcomes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|o| {
            json!({
                "id": text(o, "id"),
                "title": text(o, "title"),
                "color": o.get("color").and_then(Value::as_str).unwrap_or("blue").to_lowercase(),
                "users": number(o, "users"),
                "points": number(o, "channel_points"),
            })
        })
        .collect();
    json!({
        "id": text(event, "id"),
        "title": text(event, "title"),
        "outcomes": outcomes,
        "locksAt": text(event, "locks_at"),
        "status": event.get("status").and_then(Value::as_str).unwrap_or("active"),
        "winningOutcomeId": text(event, "winning_outcome_id"),
    })
}

fn hypetrain(event: &Value) -> Value {
    let contributions: Vec<Value> = event
        .get("top_contributions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| json!({ "user": text(c, "user_name"), "type": text(c, "type"), "total": number(c, "total") }))
        .collect();
    json!({
        "id": text(event, "id"),
        "level": number(event, "level").max(1),
        "total": number(event, "total"),
        "progress": number(event, "progress"),
        "goal": number(event, "goal"),
        "expiresAt": text(event, "expires_at"),
        "golden": event.get("type").and_then(Value::as_str) == Some("golden_kappa"),
        "topContributions": contributions,
    })
}

/// `channel.poll.progress` → `("poll", "progress")`, etc. `None` si ce n'est pas une interaction.
pub fn classify(event_type: &str) -> Option<(&'static str, &'static str)> {
    let (kind, phase) = event_type.strip_prefix("channel.")?.rsplit_once('.')?;
    let kind = match kind {
        "goal" => "goal",
        "poll" => "poll",
        "prediction" => "prediction",
        "hype_train" => "hypetrain",
        _ => return None,
    };
    let phase = match phase {
        "begin" => "begin",
        "progress" => "progress",
        "lock" => "lock",
        "end" => "end",
        _ => return None,
    };
    Some((kind, phase))
}

/// Traite un événement d'interaction : met à jour l'état en cours et le diffuse.
pub fn handle(state: &AppState, kind: &str, phase: &str, event: &Value) {
    let data = match kind {
        "goal" => goal(event),
        "poll" => poll(event),
        "prediction" => prediction(event),
        _ => hypetrain(event),
    };
    {
        let mut current = state.interactions();
        // Fini : plus rien en cours (l'overlay garde le résultat affiché quelques secondes).
        *current.slot(kind) = if phase == "end" { None } else { Some(data.clone()) };
    }
    state.broadcast(&json!({ "type": "interaction", "kind": kind, "phase": phase, "data": data }));
}

/// Objectif en cours au démarrage (sinon l'overlay attendrait le prochain follow pour l'afficher).
pub fn set_initial_goal(state: &AppState, helix_goal: Option<&Value>) {
    let data = helix_goal.map(goal);
    state.interactions().goal = data.clone();
    if let Some(data) = data {
        state.broadcast(&json!({ "type": "interaction", "kind": "goal", "phase": "progress", "data": data }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classement_et_formats() {
        assert_eq!(classify("channel.hype_train.progress"), Some(("hypetrain", "progress")));
        assert_eq!(classify("channel.prediction.lock"), Some(("prediction", "lock")));
        assert_eq!(classify("channel.follow"), None);
        assert_eq!(classify("channel.subscription.gift"), None);

        let g = goal(&json!({ "type": "follow", "description": "", "current_amount": 120, "target_amount": 200 }));
        assert_eq!((g["unit"].as_str(), g["current"].as_u64(), g["target"].as_u64()), (Some("followers"), Some(120), Some(200)));

        let p = prediction(&json!({ "title": "Gagne ?", "outcomes": [{ "id": "a", "title": "Oui", "color": "BLUE", "users": 3, "channel_points": 500 }] }));
        assert_eq!(p["outcomes"][0]["color"], "blue");
        assert_eq!(p["outcomes"][0]["points"], 500);
    }
}
