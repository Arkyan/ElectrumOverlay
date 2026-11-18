//! EventSub par WebSocket : l'app ouvre elle-même une connexion vers Twitch, qui y pousse les
//! événements. Remplace les webhooks + ngrok de la version Node : pas d'URL publique, pas de
//! tunnel, et les abonnements disparaissent tout seuls avec la connexion (plus d'abonnements
//! « fantômes » quand l'app est fermée brutalement).
//!
//! Protocole : https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
//! - `session_welcome` : on a ~10 s pour créer les abonnements avec l'id de session ;
//! - `session_keepalive` / `notification` : sans message pendant `keepalive_timeout_seconds`,
//!   la connexion est considérée morte et on se reconnecte ;
//! - `session_reconnect` : Twitch demande de rejoindre une autre URL ; les abonnements suivent ;
//! - `revocation` : un abonnement a été retiré (token révoqué, chaîne bannie...).

use super::api::Credentials;
use super::credentials;
use crate::events::route_event;
use crate::state::AppState;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Délai demandé à Twitch entre deux messages (10 à 600 s).
const KEEPALIVE_SECONDS: u64 = 30;

#[derive(Debug, Clone)]
pub struct Options {
    /// Marge ajoutée au délai keepalive annoncé par Twitch avant de déclarer la connexion morte.
    pub keepalive_grace: Duration,
    /// Attente maximale entre deux tentatives de reconnexion (doublée à chaque échec).
    pub max_backoff: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Options { keepalive_grace: Duration::from_secs(5), max_backoff: Duration::from_secs(60) }
    }
}

/// Fin d'une session.
enum End {
    /// Identifiants changés : se reconnecter tout de suite.
    Restart,
    /// Token refusé : inutile de réessayer avant une nouvelle autorisation.
    Unauthorized(String),
    /// Coupure : réessayer après un délai.
    Lost(String),
}

/// Boucle principale (à lancer une fois, en tâche de fond) : se connecte dès que Twitch est
/// autorisé, se reconnecte en cas de coupure, et redémarre quand `twitch.restart` est notifié.
pub async fn run(state: AppState, options: Options) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let creds = credentials(&state);
        if !creds.is_complete() {
            set_status(&state, |s| {
                *s = Default::default();
                s.last_error = Some("Twitch n'est pas encore autorisé (voir Configuration)".into());
            });
            state.twitch.restart.notified().await;
            continue;
        }

        match session(&state, &creds, &options).await {
            End::Restart => {
                backoff = Duration::from_secs(1);
            }
            End::Unauthorized(message) => {
                state.log("error", format!("❌ {message}"));
                set_status(&state, |s| {
                    *s = Default::default();
                    s.last_error = Some(message);
                    s.needs_authorization = true;
                });
                state.twitch.restart.notified().await;
                backoff = Duration::from_secs(1);
            }
            End::Lost(message) => {
                state.log("warn", format!("⚠️ EventSub déconnecté : {message} — nouvelle tentative dans {} s", backoff.as_secs()));
                set_status(&state, |s| {
                    s.connected = false;
                    s.session_id = None;
                    s.last_error = Some(message);
                });
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = state.twitch.restart.notified() => {}
                }
                backoff = (backoff * 2).min(options.max_backoff);
            }
        }
    }
}

fn with_keepalive(url: &str) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}keepalive_timeout_seconds={KEEPALIVE_SECONDS}")
}

async fn connect(url: &str) -> Result<Socket, String> {
    tokio_tungstenite::connect_async(url)
        .await
        .map(|(socket, _)| socket)
        .map_err(|e| format!("connexion à Twitch impossible ({e})"))
}

/// Vérifie le token avant de se connecter : message clair si expiré / mauvaise application /
/// scopes manquants (c'était la première cause de « chat qui ne marche pas »).
async fn check_token(state: &AppState, creds: &Credentials) -> Result<Vec<String>, End> {
    match state.twitch.api.validate(&creds.token).await {
        Ok(None) => Err(End::Unauthorized(
            "Le token Twitch est expiré ou révoqué — ré-autorise l'application dans Configuration".into(),
        )),
        Ok(Some(info)) => {
            if !info.client_id.is_empty() && info.client_id != creds.client_id {
                return Err(End::Unauthorized(
                    "Le token Twitch a été obtenu avec une autre application (Client ID différent) — ré-autorise dans Configuration".into(),
                ));
            }
            let required: Vec<String> = state.store().config()["twitch"]["SCOPES"]
                .as_array()
                .map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let missing: Vec<&String> = required.iter().filter(|s| !info.scopes.contains(s)).collect();
            if !missing.is_empty() {
                state.log("warn", format!("⚠️ Scopes Twitch manquants : {missing:?} — ré-autorise dans Configuration pour en profiter"));
            }
            if let Some(seconds) = info.expires_in.filter(|s| *s > 0 && *s < 3 * 24 * 3600) {
                state.log("warn", format!("⚠️ Le token Twitch expire dans {} h — pense à ré-autoriser bientôt", seconds / 3600));
            }
            Ok(info.scopes)
        }
        Err(error) => Err(End::Lost(error.to_string())),
    }
}

/// Crée tous les abonnements voulus pour cette session. Erreur seulement si le token est refusé.
async fn subscribe_all(state: &AppState, creds: &Credentials, session_id: &str, scopes: &[String]) -> Result<Vec<Value>, End> {
    let mut wanted = super::wanted_subscriptions(state, &creds.broadcaster_id);
    let (optional, missing) = super::optional_subscriptions(&wanted, &creds.broadcaster_id, scopes);
    wanted.extend(optional);
    if !missing.is_empty() {
        state.log("info", format!("ℹ️ Inactif faute d'autorisation : {} — ré-autorise Twitch dans Configuration pour l'activer", missing.join(", ")));
    }
    set_status(state, |s| s.missing_features = missing);
    let mut created = Vec::new();
    for (kind, version, condition) in &wanted {
        match state.twitch.api.create_subscription(creds, kind, version, condition, session_id).await {
            Ok(subscription) => created.push(subscription),
            Err(error) if error.is_unauthorized() => {
                return Err(End::Unauthorized(format!(
                    "Twitch refuse le token pour {kind} ({}) — ré-autorise l'application dans Configuration",
                    error.message
                )))
            }
            Err(error) => state.log("warn", format!("⚠️ Abonnement {kind} impossible : {error}")),
        }
    }
    state.log("info", format!("✅ EventSub connecté : {}/{} abonnements actifs", created.len(), wanted.len()));
    Ok(created)
}

/// Une session complète, de la connexion à sa fin.
async fn session(state: &AppState, creds: &Credentials, options: &Options) -> End {
    let scopes = match check_token(state, creds).await {
        Ok(scopes) => scopes,
        Err(end) => return end,
    };
    let mut socket = match connect(&with_keepalive(&state.twitch.api.endpoints.eventsub_ws)).await {
        Ok(socket) => socket,
        Err(error) => return End::Lost(error),
    };
    let mut keepalive = Duration::from_secs(KEEPALIVE_SECONDS) + options.keepalive_grace;
    let mut subscribed = false;

    loop {
        let next = tokio::select! {
            _ = state.twitch.restart.notified() => return End::Restart,
            next = tokio::time::timeout(keepalive, socket.next()) => next,
        };
        let text = match next {
            Err(_) => return End::Lost("aucun message de Twitch dans le délai keepalive".into()),
            Ok(None) => return End::Lost("connexion fermée".into()),
            Ok(Some(Err(error))) => return End::Lost(error.to_string()),
            Ok(Some(Ok(Message::Close(frame)))) => {
                let detail = frame.map(|f| format!("code {} {}", u16::from(f.code), f.reason)).unwrap_or_default();
                return End::Lost(format!("fermée par Twitch {detail}").trim().to_string());
            }
            Ok(Some(Ok(Message::Text(text)))) => text,
            Ok(Some(Ok(_))) => continue, // ping/pong gérés par la bibliothèque
        };
        let message: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let kind = message["metadata"]["message_type"].as_str().unwrap_or_default();
        let payload = &message["payload"];

        match kind {
            "session_welcome" => {
                let session = &payload["session"];
                let session_id = session["id"].as_str().unwrap_or_default().to_string();
                if let Some(seconds) = session["keepalive_timeout_seconds"].as_u64() {
                    keepalive = Duration::from_secs(seconds) + options.keepalive_grace;
                }
                if !subscribed {
                    match subscribe_all(state, creds, &session_id, &scopes).await {
                        Ok(subscriptions) => set_status(state, |s| s.subscriptions = subscriptions),
                        Err(end) => return end,
                    }
                }
                // Connecté dès que les abonnements existent (les pages sont prévenues tout de suite).
                set_status(state, |s| {
                    s.connected = true;
                    s.session_id = Some(session_id);
                    s.last_error = None;
                    s.needs_authorization = false;
                });
                if !subscribed {
                    subscribed = true;
                    if scopes.iter().any(|s| s == "channel:read:goals") {
                        load_current_goal(state, creds).await;
                    }
                    // Profil du jeu en cours dès la connexion (pas seulement au prochain changement).
                    if let Ok(game) = state.twitch.api.current_game(creds).await {
                        crate::game_profiles::apply(state, &game);
                    }
                }
            }
            "session_keepalive" => {}
            "notification" => {
                let id = message["metadata"]["message_id"].as_str().unwrap_or_default();
                let fresh = id.is_empty() || state.twitch.seen_notifications.lock().unwrap_or_else(|p| p.into_inner()).insert(id);
                if fresh {
                    let event_type = payload["subscription"]["type"].as_str().unwrap_or_default();
                    route_event(state, event_type, &payload["event"]);
                }
            }
            "session_reconnect" => {
                let Some(url) = payload["session"]["reconnect_url"].as_str() else { continue };
                match reconnect(url, keepalive).await {
                    Ok((new_socket, session_id)) => {
                        // Les abonnements suivent la session : rien à recréer.
                        socket = new_socket;
                        set_status(state, |s| s.session_id = Some(session_id));
                        state.log("info", "🔄 EventSub : reconnexion demandée par Twitch effectuée");
                    }
                    Err(error) => return End::Lost(error),
                }
            }
            "revocation" => {
                let subscription = &payload["subscription"];
                let (kind, status) = (subscription["type"].as_str().unwrap_or("?"), subscription["status"].as_str().unwrap_or("?"));
                state.log("warn", format!("🚫 Abonnement révoqué par Twitch : {kind} ({status})"));
                set_status(state, |s| {
                    s.subscriptions.retain(|sub| sub["id"] != subscription["id"]);
                    if status == "authorization_revoked" {
                        s.needs_authorization = true;
                    }
                });
            }
            other => state.log("warn", format!("⚠️ Message EventSub inconnu : {other}")),
        }
    }
}

/// Objectif en cours sur la chaîne (le premier s'il y en a plusieurs).
async fn load_current_goal(state: &AppState, creds: &Credentials) {
    match state.twitch.api.goals(creds).await {
        Ok(goals) => crate::interactions::set_initial_goal(state, goals.first()),
        Err(error) => state.log("warn", format!("⚠️ Objectifs Twitch illisibles : {error}")),
    }
}

/// Change l'état de la connexion et prévient les pages de l'app ouvertes (tableau de bord,
/// barre latérale) par le WebSocket du serveur.
fn set_status(state: &AppState, change: impl FnOnce(&mut super::EventSubStatus)) {
    state.twitch.set_status(change);
    state.broadcast(&json!({ "type": "twitch-status", "eventsub": status_json(state) }));
}

/// Rejoint l'URL de reconnexion et attend son `session_welcome`.
async fn reconnect(url: &str, keepalive: Duration) -> Result<(Socket, String), String> {
    let mut socket = connect(url).await?;
    loop {
        match tokio::time::timeout(keepalive, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let message: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if message["metadata"]["message_type"] == "session_welcome" {
                    let id = message["payload"]["session"]["id"].as_str().unwrap_or_default().to_string();
                    return Ok((socket, id));
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => return Err("reconnexion demandée par Twitch impossible".into()),
        }
    }
}

/// Résumé pour `/status`.
pub fn status_json(state: &AppState) -> Value {
    let status = state.twitch.status();
    json!({
        "connected": status.connected,
        "sessionId": status.session_id,
        "subscriptions": status.subscriptions.len(),
        "lastError": status.last_error,
        "needsAuthorization": status.needs_authorization,
        "missingFeatures": status.missing_features
    })
}
