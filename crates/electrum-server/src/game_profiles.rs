//! Profil automatique selon le jeu : quand la catégorie Twitch change (titre/catégorie modifiés,
//! début du live, connexion de l'app), le profil associé à ce jeu devient le profil actif.
//!
//! Config (`overlay-config.json`, propre à la version Rust) :
//! `app.gameProfiles = { enabled, rules: [{ game, profileId }], fallbackProfileId }`.
//! `fallbackProfileId` (facultatif) : profil des jeux sans règle ; vide = ne rien changer.

use crate::state::AppState;
use serde_json::{json, Value};

/// Règles telles qu'enregistrées.
pub fn settings(config: &Value) -> Value {
    let raw = &config["app"]["gameProfiles"];
    json!({
        "enabled": raw["enabled"].as_bool().unwrap_or(false),
        "rules": raw["rules"].as_array().cloned().unwrap_or_default(),
        "fallbackProfileId": raw["fallbackProfileId"].as_str().unwrap_or_default(),
    })
}

/// Comparaison de noms de jeux insensible à la casse et aux espaces superflus.
fn same_game(a: &str, b: &str) -> bool {
    let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    !a.trim().is_empty() && normalize(a) == normalize(b)
}

/// Profil à activer pour ce jeu (`None` : ne rien changer).
pub fn profile_for_game(config: &Value, game: &str) -> Option<String> {
    let settings = settings(config);
    if !settings["enabled"].as_bool().unwrap_or(false) {
        return None;
    }
    let rule = settings["rules"].as_array()?.iter().find(|rule| same_game(rule["game"].as_str().unwrap_or_default(), game)).cloned();
    let id = match rule {
        Some(rule) => rule["profileId"].as_str().unwrap_or_default().to_string(),
        None => settings["fallbackProfileId"].as_str().unwrap_or_default().to_string(),
    };
    (!id.is_empty()).then_some(id)
}

/// Active le profil associé au jeu s'il y en a un et qu'il n'est pas déjà actif. Renvoie le nom
/// du profil activé.
pub fn apply(state: &AppState, game: &str) -> Option<String> {
    if game.trim().is_empty() {
        return None;
    }
    let name = {
        let mut store = state.store();
        let id = profile_for_game(store.config(), game)?;
        if store.active_profile_id() == Some(id.as_str()) {
            return None;
        }
        let profiles = store.list_profiles().ok()?;
        let name = profiles.iter().find(|p| p["id"] == id.as_str())?["name"].as_str().unwrap_or_default().to_string();
        if let Err(error) = store.set_active_profile(&id) {
            drop(store);
            state.log("warn", format!("⚠️ Profil du jeu {game} impossible à activer : {error}"));
            return None;
        }
        name
    };
    state.broadcast_config();
    state.log("info", format!("🎮 Jeu « {game} » : profil « {name} » activé"));
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regles_et_profil_par_defaut() {
        let config = json!({ "app": { "gameProfiles": {
            "enabled": true,
            "rules": [{ "game": "Euro Truck Simulator 2", "profileId": "camion" }, { "game": "Minecraft", "profileId": "vert" }],
            "fallbackProfileId": "defaut"
        } } });
        assert_eq!(profile_for_game(&config, "euro truck  simulator 2").as_deref(), Some("camion"));
        assert_eq!(profile_for_game(&config, "Just Chatting").as_deref(), Some("defaut"));
        let mut disabled = config.clone();
        disabled["app"]["gameProfiles"]["enabled"] = json!(false);
        assert_eq!(profile_for_game(&disabled, "Minecraft"), None);
        let mut no_fallback = config.clone();
        no_fallback["app"]["gameProfiles"]["fallbackProfileId"] = json!("");
        assert_eq!(profile_for_game(&no_fallback, "Just Chatting"), None);
    }
}
