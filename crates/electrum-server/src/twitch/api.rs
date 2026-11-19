//! Appels HTTP à Twitch (Helix + validation de token) : port des parties utiles de
//! `src/services/TwitchAuth.js` et `EventSubManager.js`. Tout passe par le token utilisateur
//! (celui obtenu par l'autorisation dans /setup) : plus besoin de token d'application ni de secret
//! pour EventSub par WebSocket.

use serde_json::{json, Value};
use std::fmt;

/// URLs de Twitch, remplaçables dans les tests par un faux serveur local.
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// `https://api.twitch.tv/helix`
    pub helix: String,
    /// `https://id.twitch.tv/oauth2`
    pub oauth: String,
    /// `wss://eventsub.wss.twitch.tv/ws`
    pub eventsub_ws: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            helix: "https://api.twitch.tv/helix".into(),
            oauth: "https://id.twitch.tv/oauth2".into(),
            eventsub_ws: "wss://eventsub.wss.twitch.tv/ws".into(),
        }
    }
}

/// Identifiants nécessaires à un appel Helix.
#[derive(Debug, Clone, Default)]
pub struct Credentials {
    pub client_id: String,
    pub token: String,
    pub broadcaster_id: String,
}

impl Credentials {
    pub fn is_complete(&self) -> bool {
        !self.client_id.is_empty() && !self.token.is_empty() && !self.broadcaster_id.is_empty()
    }
}

/// Erreur d'un appel Twitch : code HTTP (0 si le réseau a échoué) + message lisible.
#[derive(Debug, Clone)]
pub struct TwitchError {
    pub status: u16,
    pub message: String,
}

impl fmt::Display for TwitchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.status == 0 { write!(f, "{}", self.message) } else { write!(f, "HTTP {} : {}", self.status, self.message) }
    }
}

impl TwitchError {
    /// Token refusé (expiré, révoqué) : il faut ré-autoriser l'application.
    pub fn is_unauthorized(&self) -> bool {
        self.status == 401
    }
}

/// Informations renvoyées par `/oauth2/validate`.
#[derive(Debug, Clone)]
pub struct TokenInfo {
    pub client_id: String,
    pub user_id: String,
    pub login: String,
    pub scopes: Vec<String>,
    pub expires_in: Option<u64>,
}

#[derive(Clone)]
pub struct TwitchApi {
    http: reqwest::Client,
    pub endpoints: Endpoints,
}

impl TwitchApi {
    pub fn new(endpoints: Endpoints) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("ElectrumOverlay")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("client HTTP");
        TwitchApi { http, endpoints }
    }

    async fn read(response: reqwest::Response) -> Result<Value, TwitchError> {
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            let message = body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("erreur").to_string());
            Err(TwitchError { status: status.as_u16(), message })
        }
    }

    fn network(error: reqwest::Error) -> TwitchError {
        TwitchError { status: 0, message: format!("Twitch injoignable : {error}") }
    }

    async fn helix_get(&self, creds: &Credentials, path: &str) -> Result<Value, TwitchError> {
        let response = self
            .http
            .get(format!("{}{path}", self.endpoints.helix))
            .bearer_auth(&creds.token)
            .header("Client-Id", &creds.client_id)
            .send()
            .await
            .map_err(Self::network)?;
        Self::read(response).await
    }

    async fn helix_post(&self, creds: &Credentials, path: &str, body: &Value) -> Result<Value, TwitchError> {
        let response = self
            .http
            .post(format!("{}{path}", self.endpoints.helix))
            .bearer_auth(&creds.token)
            .header("Client-Id", &creds.client_id)
            .json(body)
            .send()
            .await
            .map_err(Self::network)?;
        Self::read(response).await
    }

    /// Valide un token utilisateur. `Ok(None)` = token invalide/expiré.
    pub async fn validate(&self, token: &str) -> Result<Option<TokenInfo>, TwitchError> {
        let response = self
            .http
            .get(format!("{}/validate", self.endpoints.oauth))
            .header("Authorization", format!("OAuth {token}"))
            .send()
            .await
            .map_err(Self::network)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        let data = Self::read(response).await?;
        let text = |key: &str| data.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        Ok(Some(TokenInfo {
            client_id: text("client_id"),
            user_id: text("user_id"),
            login: text("login"),
            scopes: data
                .get("scopes")
                .and_then(Value::as_array)
                .map(|s| s.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            expires_in: data.get("expires_in").and_then(Value::as_u64),
        }))
    }

    /// Crée un abonnement EventSub rattaché à une session WebSocket. Renvoie l'abonnement créé.
    pub async fn create_subscription(
        &self,
        creds: &Credentials,
        kind: &str,
        version: &str,
        condition: &Value,
        session_id: &str,
    ) -> Result<Value, TwitchError> {
        let body = json!({
            "type": kind,
            "version": version,
            "condition": condition,
            "transport": { "method": "websocket", "session_id": session_id }
        });
        let data = self.helix_post(creds, "/eventsub/subscriptions", &body).await?;
        Ok(data["data"][0].clone())
    }

    /// Live en cours (`started_at`, `title`, `game_name`, `viewer_count`), `None` hors ligne.
    pub async fn current_stream(&self, creds: &Credentials) -> Result<Option<Value>, TwitchError> {
        let data = self.helix_get(creds, &format!("/streams?user_id={}", creds.broadcaster_id)).await?;
        Ok(data["data"].get(0).filter(|s| s.is_object()).cloned())
    }

    /// Jeu (catégorie) actuel de la chaîne.
    pub async fn current_game(&self, creds: &Credentials) -> Result<String, TwitchError> {
        let data = self.helix_get(creds, &format!("/channels?broadcaster_id={}", creds.broadcaster_id)).await?;
        Ok(data["data"][0]["game_name"].as_str().unwrap_or_default().to_string())
    }

    /// Catégories Twitch correspondant à une recherche (noms et jaquettes).
    pub async fn search_categories(&self, creds: &Credentials, query: &str) -> Result<Vec<Value>, TwitchError> {
        let data = self.helix_get(creds, &format!("/search/categories?first=8&query={}", form_encode(query))).await?;
        Ok(data["data"].as_array().cloned().unwrap_or_default())
    }

    /// Objectifs actifs de la chaîne (scope `channel:read:goals`).
    pub async fn goals(&self, creds: &Credentials) -> Result<Vec<Value>, TwitchError> {
        let data = self.helix_get(creds, &format!("/goals?broadcaster_id={}", creds.broadcaster_id)).await?;
        Ok(data["data"].as_array().cloned().unwrap_or_default())
    }

    /// Badges de chat d'une chaîne (`Some(id)`) ou globaux (`None`), réponse Helix brute.
    pub async fn badges(&self, creds: &Credentials, broadcaster_id: Option<&str>) -> Result<Value, TwitchError> {
        let path = match broadcaster_id {
            Some(id) => format!("/chat/badges?broadcaster_id={id}"),
            None => "/chat/badges/global".to_string(),
        };
        self.helix_get(creds, &path).await
    }

    /// Envoie un message dans le chat, au nom du streamer (scope `user:write:chat`).
    pub async fn send_chat_message(&self, creds: &Credentials, message: &str) -> Result<Value, TwitchError> {
        let body = json!({ "broadcaster_id": creds.broadcaster_id, "sender_id": creds.broadcaster_id, "message": message });
        let data = self.helix_post(creds, "/chat/messages", &body).await?;
        Ok(data["data"][0].clone())
    }

    /// URL d'autorisation (flux « implicit grant » : le token revient dans le fragment de l'URL
    /// de redirection, lu par la page /auth-callback). Mêmes paramètres et même encodage que
    /// `generateAuthUrl()` côté Node (`URLSearchParams`).
    pub fn authorize_url(&self, client_id: &str, redirect_uri: &str, scopes: &[String], oauth_state: &str) -> String {
        format!(
            "{}/authorize?response_type=token&client_id={}&redirect_uri={}&scope={}&state={}",
            self.endpoints.oauth,
            form_encode(client_id),
            form_encode(redirect_uri),
            form_encode(&scopes.join(" ")),
            form_encode(oauth_state)
        )
    }
}

/// Encodage `application/x-www-form-urlencoded`, comme `URLSearchParams.toString()`.
pub fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(byte as char),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_d_autorisation_identique_a_node() {
        let api = TwitchApi::new(Endpoints::default());
        let url = api.authorize_url("a b", "http://localhost:8080/auth-callback", &["user:read:chat".into(), "chat:edit".into()], "s1");
        assert_eq!(
            url,
            "https://id.twitch.tv/oauth2/authorize?response_type=token&client_id=a+b&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth-callback&scope=user%3Aread%3Achat+chat%3Aedit&state=s1"
        );
    }
}
