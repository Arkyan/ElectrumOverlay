//! Tout ce qui parle à Twitch : API Helix (`api`), EventSub par WebSocket (`eventsub`), et
//! l'état partagé correspondant.

pub mod api;
pub mod eventsub;

use crate::state::AppState;
use api::{Credentials, Endpoints, TwitchApi};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use tokio::sync::Notify;

/// État de la connexion EventSub, exposé par `/status` et `/subscriptions`.
#[derive(Debug, Clone, Default)]
pub struct EventSubStatus {
    pub connected: bool,
    pub session_id: Option<String>,
    /// Abonnements tels que renvoyés par Twitch (`id`, `type`, `status`, `condition`...).
    pub subscriptions: Vec<Value>,
    pub last_error: Option<String>,
    /// Le token a été refusé : il faut ré-autoriser l'application dans /setup.
    pub needs_authorization: bool,
    /// Fonctions facultatives inactives faute d'autorisation (« Bits », « Sondages »...) :
    /// une nouvelle autorisation dans /setup les active.
    pub missing_features: Vec<String>,
}

/// Abonnements facultatifs propres à la version Rust (la config `eventTypes` est partagée avec
/// la version Electron, qui ne sait pas les traiter) : type, version, scope requis, libellé.
/// Créés seulement si le token a le scope : un token obtenu avant leur ajout continue de marcher.
pub const OPTIONAL_EVENTS: &[(&str, &str, Option<&str>, &str)] = &[
    ("channel.update", "2", None, "Titre et catégorie"),
    ("channel.cheer", "1", Some("bits:read"), "Bits"),
    ("channel.goal.begin", "1", Some("channel:read:goals"), "Objectifs"),
    ("channel.goal.progress", "1", Some("channel:read:goals"), "Objectifs"),
    ("channel.goal.end", "1", Some("channel:read:goals"), "Objectifs"),
    ("channel.poll.begin", "1", Some("channel:read:polls"), "Sondages"),
    ("channel.poll.progress", "1", Some("channel:read:polls"), "Sondages"),
    ("channel.poll.end", "1", Some("channel:read:polls"), "Sondages"),
    ("channel.prediction.begin", "1", Some("channel:read:predictions"), "Prédictions"),
    ("channel.prediction.progress", "1", Some("channel:read:predictions"), "Prédictions"),
    ("channel.prediction.lock", "1", Some("channel:read:predictions"), "Prédictions"),
    ("channel.prediction.end", "1", Some("channel:read:predictions"), "Prédictions"),
    ("channel.hype_train.begin", "2", Some("channel:read:hype_train"), "Hype train"),
    ("channel.hype_train.progress", "2", Some("channel:read:hype_train"), "Hype train"),
    ("channel.hype_train.end", "2", Some("channel:read:hype_train"), "Hype train"),
];

/// Scopes demandés à l'autorisation : ceux de la config + ceux des abonnements facultatifs.
pub fn authorization_scopes(config_scopes: Vec<String>) -> Vec<String> {
    let mut scopes = config_scopes;
    for scope in OPTIONAL_EVENTS.iter().filter_map(|e| e.2) {
        if !scopes.iter().any(|s| s == scope) {
            scopes.push(scope.to_string());
        }
    }
    scopes
}

/// Abonnements facultatifs possibles avec ces scopes (sans doublon avec la config), et libellés
/// des fonctions qui restent inactives faute de scope.
pub fn optional_subscriptions(
    already: &[(String, String, Value)],
    broadcaster_id: &str,
    scopes: &[String],
) -> (Vec<(String, String, Value)>, Vec<String>) {
    let mut wanted = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for (kind, version, scope, label) in OPTIONAL_EVENTS {
        if already.iter().any(|(k, _, _)| k == kind) {
            continue;
        }
        if scope.is_some_and(|scope| !scopes.iter().any(|s| s == scope)) {
            if !missing.iter().any(|m| m == label) {
                missing.push(label.to_string());
            }
            continue;
        }
        wanted.push((kind.to_string(), version.to_string(), json!({ "broadcaster_user_id": broadcaster_id })));
    }
    (wanted, missing)
}

/// Ensemble borné d'identifiants déjà vus (dédoublonnage des notifications Twitch, échos de nos
/// propres messages de chat).
pub struct SeenIds {
    order: VecDeque<String>,
    set: HashSet<String>,
    capacity: usize,
}

impl SeenIds {
    pub fn new(capacity: usize) -> Self {
        SeenIds { order: VecDeque::new(), set: HashSet::new(), capacity }
    }

    /// `true` si l'id est nouveau (et le mémorise).
    pub fn insert(&mut self, id: &str) -> bool {
        if !self.set.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > self.capacity {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }

    /// Retire l'id s'il était présent (`true` dans ce cas).
    pub fn take(&mut self, id: &str) -> bool {
        if self.set.remove(id) {
            self.order.retain(|x| x != id);
            true
        } else {
            false
        }
    }
}

pub struct TwitchState {
    pub api: TwitchApi,
    pub status: Mutex<EventSubStatus>,
    /// Réveille la boucle EventSub pour qu'elle se reconnecte (nouveau token, nouvelle chaîne...).
    pub restart: Notify,
    pub(crate) seen_notifications: Mutex<SeenIds>,
    pub(crate) sent_messages: Mutex<SeenIds>,
}

impl TwitchState {
    pub fn new(endpoints: Endpoints) -> Self {
        TwitchState {
            api: TwitchApi::new(endpoints),
            status: Mutex::new(EventSubStatus::default()),
            restart: Notify::new(),
            seen_notifications: Mutex::new(SeenIds::new(1000)),
            sent_messages: Mutex::new(SeenIds::new(200)),
        }
    }

    pub fn status(&self) -> EventSubStatus {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub(crate) fn set_status(&self, change: impl FnOnce(&mut EventSubStatus)) {
        change(&mut self.status.lock().unwrap_or_else(|p| p.into_inner()));
    }
}

/// Identifiants Twitch actuels (relus à chaque fois : ils changent après une autorisation).
pub fn credentials(state: &AppState) -> Credentials {
    let store = state.store();
    let twitch = &store.config()["twitch"];
    let text = |key: &str| twitch.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    Credentials { client_id: text("CLIENT_ID"), token: text("USER_ACCESS_TOKEN"), broadcaster_id: text("BROADCASTER_ID") }
}

/// Abonnements voulus : `eventTypes.basic` + `eventTypes.chat` de la config, avec les mêmes
/// conditions par défaut que `defaultConditionFor()` côté Node.
pub fn wanted_subscriptions(state: &AppState, broadcaster_id: &str) -> Vec<(String, String, Value)> {
    let store = state.store();
    let event_types = &store.config()["eventTypes"];
    let mut wanted = Vec::new();
    for (group, chat) in [("basic", false), ("chat", true)] {
        for event in event_types.get(group).and_then(Value::as_array).into_iter().flatten() {
            let Some(kind) = event.get("type").and_then(Value::as_str) else { continue };
            let version = event.get("version").and_then(Value::as_str).unwrap_or("1").to_string();
            let condition = match event.get("condition").filter(|c| electrum_core::json::is_truthy(Some(c))) {
                Some(condition) => condition.clone(),
                None if chat => json!({ "broadcaster_user_id": broadcaster_id, "user_id": broadcaster_id }),
                None => match kind {
                    "channel.raid" => json!({ "to_broadcaster_user_id": broadcaster_id }),
                    "channel.follow" => json!({ "broadcaster_user_id": broadcaster_id, "moderator_user_id": broadcaster_id }),
                    _ => json!({ "broadcaster_user_id": broadcaster_id }),
                },
            };
            wanted.push((kind.to_string(), version, condition));
        }
    }
    wanted
}

/// Envoie la réponse d'une commande dans le chat (en tâche de fond) et mémorise l'id du message
/// pour ignorer son écho, que Twitch renvoie par EventSub comme un message normal.
pub fn send_chat_message(state: &AppState, message: String) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let state = state.clone();
    runtime.spawn(async move {
        let creds = credentials(&state);
        if !creds.is_complete() {
            state.log("warn", "⚠️ Réponse chat non envoyée : Twitch n'est pas autorisé");
            return;
        }
        match state.twitch.api.send_chat_message(&creds, &message).await {
            Ok(result) => {
                if let Some(id) = result.get("message_id").and_then(Value::as_str) {
                    state.twitch.sent_messages.lock().unwrap_or_else(|p| p.into_inner()).insert(id);
                }
                if result.get("is_sent") == Some(&Value::Bool(false)) {
                    let reason = result["drop_reason"]["message"].as_str().unwrap_or("raison inconnue");
                    state.log("warn", format!("⚠️ Message chat refusé par Twitch: {reason}"));
                }
            }
            Err(error) => state.log("error", format!("❌ Erreur lors de l'envoi du message de chat: {error}")),
        }
    });
}

/// Nombre de viewers toutes les 60 s (Twitch ne le pousse pas par EventSub). Le premier passage,
/// au démarrage, reprend aussi un live déjà commencé : `stream.online` n'arrive qu'au lancement du
/// stream, pas quand l'app est ouverte en cours de route.
pub async fn poll_viewer_count(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        let creds = credentials(&state);
        if !creds.is_complete() {
            continue;
        }
        match state.twitch.api.current_stream(&creds).await {
            Ok(Some(stream)) => {
                let text = |key: &str| stream[key].as_str().map(str::to_string);
                let mut stats = state.stats();
                if !stats.is_live {
                    stats.resume_stream(text("started_at").as_deref(), text("title").as_deref(), text("game_name").as_deref());
                }
                stats.update_viewer_count(stream["viewer_count"].as_u64().unwrap_or(0));
            }
            Ok(None) => state.stats().update_viewer_count(0),
            Err(_) => {}
        }
    }
}
