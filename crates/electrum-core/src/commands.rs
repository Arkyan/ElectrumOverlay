//! Commandes de chat personnalisées (`config.commands`) : port de la section « Commandes » de
//! `src/config/store.js`. Le tableau est toujours réécrit en entier (les tableaux ne sont jamais
//! fusionnés élément par élément, voir docs/FORMATS.md §3).

use crate::error::{Error, Result};
use crate::json::{is_truthy, js_number, js_string_or_empty, number_value};
use crate::store::{new_uuid, Store};
use crate::time::now_iso;
use serde_json::{json, Map, Value};

pub const COMMAND_PERMISSIONS: [&str; 4] = ["everyone", "vip", "moderator", "broadcaster"];

/// `!xxx` en minuscules, sans espace.
fn normalize_trigger(trigger: Option<&Value>) -> Result<String> {
    let value = js_string_or_empty(trigger).trim().to_lowercase();
    let valid = value.len() > 1 && value.starts_with('!') && !value.chars().any(char::is_whitespace);
    if !valid {
        return Err(Error::msg("Le déclencheur doit commencer par \"!\" et ne pas contenir d'espace"));
    }
    Ok(value)
}

fn chat_reply(value: Option<&Value>) -> Value {
    json!({
        "enabled": is_truthy(value.and_then(|v| v.get("enabled"))),
        "message": js_string_or_empty(value.and_then(|v| v.get("message"))).trim()
    })
}

fn overlay_action(value: Option<&Value>) -> Value {
    let panel = value.and_then(|v| v.get("panel")).and_then(Value::as_str);
    json!({
        "enabled": is_truthy(value.and_then(|v| v.get("enabled"))),
        "panel": if panel == Some("bottom") { "bottom" } else { "left" }
    })
}

fn valid_permission(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|p| COMMAND_PERMISSIONS.contains(p))
}

impl Store {
    pub fn list_commands(&self) -> Vec<Value> {
        self.config.get("commands").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn trigger_taken(commands: &[Value], trigger: &str, except_id: Option<&str>) -> bool {
        commands.iter().any(|c| {
            c.get("trigger").and_then(Value::as_str) == Some(trigger)
                && except_id.is_none_or(|id| c.get("id").and_then(Value::as_str) != Some(id))
        })
    }

    pub fn create_command(&mut self, data: &Value) -> Result<Value> {
        let trigger = normalize_trigger(data.get("trigger"))?;
        let mut commands = self.list_commands();
        if Self::trigger_taken(&commands, &trigger, None) {
            return Err(Error::msg(format!("Une commande {trigger} existe déjà")));
        }
        let cooldown = js_number(data.get("cooldownSeconds"));
        let now = now_iso();
        let command = json!({
            "id": new_uuid(),
            "trigger": trigger,
            "enabled": data.get("enabled") != Some(&Value::Bool(false)),
            "permission": valid_permission(data.get("permission")).unwrap_or("everyone"),
            "cooldownSeconds": if cooldown.is_finite() { number_value(cooldown.max(0.0)) } else { json!(5) },
            "chatReply": chat_reply(data.get("chatReply")),
            "overlayAction": overlay_action(data.get("overlayAction")),
            "createdAt": now,
            "updatedAt": now
        });
        commands.push(command.clone());
        self.save_config(&json!({ "commands": commands }))?;
        Ok(command)
    }

    pub fn update_command(&mut self, id: &str, patch: &Value) -> Result<Value> {
        let commands = self.list_commands();
        let existing = commands
            .iter()
            .find(|c| c.get("id").and_then(Value::as_str) == Some(id))
            .and_then(Value::as_object)
            .cloned()
            .ok_or_else(|| Error::msg("Commande introuvable"))?;

        let trigger = match patch.get("trigger") {
            Some(t) => normalize_trigger(Some(t))?,
            None => existing.get("trigger").and_then(Value::as_str).unwrap_or_default().to_string(),
        };
        if Self::trigger_taken(&commands, &trigger, Some(id)) {
            return Err(Error::msg(format!("Une commande {trigger} existe déjà")));
        }

        let mut updated: Map<String, Value> = existing.clone();
        let keep = |key: &str| existing.get(key).cloned().unwrap_or(Value::Null);
        updated.insert("trigger".into(), Value::String(trigger));
        updated.insert(
            "enabled".into(),
            match patch.get("enabled") {
                Some(v) => Value::Bool(is_truthy(Some(v))),
                None => keep("enabled"),
            },
        );
        updated.insert(
            "permission".into(),
            valid_permission(patch.get("permission")).map(Value::from).unwrap_or_else(|| keep("permission")),
        );
        let cooldown = js_number(patch.get("cooldownSeconds"));
        updated.insert(
            "cooldownSeconds".into(),
            if patch.get("cooldownSeconds").is_some() && cooldown.is_finite() {
                number_value(cooldown.max(0.0))
            } else {
                keep("cooldownSeconds")
            },
        );
        updated.insert(
            "chatReply".into(),
            if patch.get("chatReply").is_some() { chat_reply(patch.get("chatReply")) } else { keep("chatReply") },
        );
        updated.insert(
            "overlayAction".into(),
            if patch.get("overlayAction").is_some() {
                overlay_action(patch.get("overlayAction"))
            } else {
                keep("overlayAction")
            },
        );
        updated.insert("updatedAt".into(), Value::String(now_iso()));
        let updated = Value::Object(updated);

        let commands: Vec<Value> = commands
            .into_iter()
            .map(|c| if c.get("id").and_then(Value::as_str) == Some(id) { updated.clone() } else { c })
            .collect();
        self.save_config(&json!({ "commands": commands }))?;
        Ok(updated)
    }

    pub fn delete_command(&mut self, id: &str) -> Result<()> {
        let commands = self.list_commands();
        if !commands.iter().any(|c| c.get("id").and_then(Value::as_str) == Some(id)) {
            return Err(Error::msg("Commande introuvable"));
        }
        let remaining: Vec<Value> = commands
            .into_iter()
            .filter(|c| c.get("id").and_then(Value::as_str) != Some(id))
            .collect();
        self.save_config(&json!({ "commands": remaining }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_comme_js() {
        assert!(js_number(None).is_nan());
        assert_eq!(js_number(Some(&json!(null))), 0.0);
        assert_eq!(js_number(Some(&json!(""))), 0.0);
        assert_eq!(js_number(Some(&json!(" 12 "))), 12.0);
        assert!(js_number(Some(&json!("abc"))).is_nan());
        assert_eq!(number_value(5.0), json!(5));
    }

    #[test]
    fn declencheurs() {
        assert_eq!(normalize_trigger(Some(&json!("  !Discord "))).unwrap(), "!discord");
        assert!(normalize_trigger(Some(&json!("discord"))).is_err());
        assert!(normalize_trigger(Some(&json!("!"))).is_err());
        assert!(normalize_trigger(Some(&json!("!a b"))).is_err());
        assert!(normalize_trigger(None).is_err());
    }
}
