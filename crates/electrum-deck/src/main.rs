//! Plugin Stream Deck d'ElectrumOverlay, en exécutable natif (aucun Node.js à installer ni à
//! embarquer). L'app Stream Deck le lance avec `-port`, `-pluginUUID`, `-registerEvent`, `-info`,
//! puis lui parle par WebSocket (protocole des plugins Stream Deck) :
//! https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin
//!
//! Actions (identiques à l'ancien plugin en TypeScript) :
//! - `trigger-test-alert` : POST /api/tests/trigger ;
//! - `activate-profile`   : POST /api/profiles/:id/activate, la touche indique si le profil est actif ;
//! - `show-panel`         : POST /api/panels/:panel/show ;
//! - `stream-stats`       : affiche une statistique de /api/stream-stats.
//!
//! Chaque touche peut viser un autre hôte/port (réglages `host` / `port`, défaut localhost:8080).
#![cfg_attr(windows, windows_subsystem = "windows")]

mod http;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

const PREFIX: &str = "com.electrumvtc.overlay.streamdeck.";
const ALERT_TYPES: [&str; 9] = ["follow", "sub", "subgift", "raid", "bits", "chat", "info", "streamOnline", "streamOffline"];

/// Arguments passés par l'app Stream Deck.
fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// Touche visible : son action, ses réglages, prochain rafraîchissement.
struct Key {
    action: String,
    settings: Value,
    next_refresh: Instant,
}

struct Plugin {
    socket: WebSocket<TcpStream>,
    keys: HashMap<String, Key>,
}

fn setting<'a>(settings: &'a Value, key: &str) -> &'a str {
    settings.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn server(settings: &Value) -> http::Server {
    http::Server::new(setting(settings, "host"), setting(settings, "port"))
}

/// Délai entre deux rafraîchissements d'une touche (`None` : pas de rafraîchissement).
fn refresh_period(action: &str) -> Option<Duration> {
    match action {
        "activate-profile" => Some(Duration::from_secs(5)),
        "stream-stats" => Some(Duration::from_secs(10)),
        _ => None,
    }
}

/// Profils au format de `sdpi-select` (texte affiché tel quel, jamais interprété comme du HTML).
fn profile_items(server: &http::Server) -> Value {
    let Ok(data) = server.get("/api/profiles") else {
        return json!([{ "label": "ElectrumOverlay injoignable (serveur démarré ?)", "value": "", "disabled": true }]);
    };
    let active = data["activeId"].as_str();
    let items: Vec<Value> = data["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let id = p["id"].as_str()?;
            let name = p["name"].as_str().unwrap_or(id);
            Some(json!({ "label": if Some(id) == active { format!("{name} (actif)") } else { name.to_string() }, "value": id }))
        })
        .collect();
    json!(items)
}

impl Plugin {
    fn send(&mut self, message: Value) {
        let _ = self.socket.send(Message::text(message.to_string()));
    }

    fn show_ok(&mut self, context: &str) {
        self.send(json!({ "event": "showOk", "context": context }));
    }

    fn show_alert(&mut self, context: &str) {
        self.send(json!({ "event": "showAlert", "context": context }));
    }

    fn set_title(&mut self, context: &str, title: &str) {
        self.send(json!({ "event": "setTitle", "context": context, "payload": { "title": title, "target": 0 } }));
    }

    fn set_state(&mut self, context: &str, state: u8) {
        self.send(json!({ "event": "setState", "context": context, "payload": { "state": state } }));
    }

    fn handle(&mut self, message: &Value) {
        let event = message["event"].as_str().unwrap_or_default();
        let context = message["context"].as_str().unwrap_or_default().to_string();
        let action = message["action"].as_str().unwrap_or_default().strip_prefix(PREFIX).unwrap_or_default().to_string();
        let settings = message["payload"]["settings"].clone();
        match event {
            "willAppear" | "didReceiveSettings" => {
                self.keys.insert(context.clone(), Key { action, settings, next_refresh: Instant::now() });
                self.refresh_due();
            }
            "willDisappear" => {
                self.keys.remove(&context);
            }
            // Liste des profils demandée par la fenêtre de réglages (sdpi-select `datasource`) :
            // le plugin la récupère pour elle, la fenêtre n'appelle pas le serveur elle-même.
            "sendToPlugin" if message["payload"]["event"] == "getProfiles" => {
                let settings = self.keys.get(&context).map(|key| key.settings.clone()).unwrap_or(settings);
                let items = profile_items(&server(&settings));
                self.send(json!({
                    "event": "sendToPropertyInspector", "context": context, "action": message["action"],
                    "payload": { "event": "getProfiles", "items": items }
                }));
            }
            "keyDown" => {
                if let Some(key) = self.keys.get_mut(&context) {
                    key.settings = settings.clone();
                }
                self.key_down(&context, &action, &settings);
            }
            _ => {}
        }
    }

    fn key_down(&mut self, context: &str, action: &str, settings: &Value) {
        let server = server(settings);
        let ok = match action {
            "trigger-test-alert" => {
                let alert = setting(settings, "alertType");
                ALERT_TYPES.contains(&alert) && server.post("/api/tests/trigger", &json!({ "action": alert })).is_ok()
            }
            "activate-profile" => {
                let id = setting(settings, "profileId");
                !id.is_empty() && server.post(&format!("/api/profiles/{}/activate", http::encode(id)), &json!({})).is_ok()
            }
            "show-panel" => {
                let panel = setting(settings, "panel");
                (panel == "left" || panel == "bottom") && server.post(&format!("/api/panels/{panel}/show"), &json!({})).is_ok()
            }
            "stream-stats" => !setting(settings, "stat").is_empty(),
            _ => false,
        };
        if ok {
            self.show_ok(context);
            if let Some(key) = self.keys.get_mut(context) {
                key.next_refresh = Instant::now();
            }
            self.refresh_due();
        } else {
            self.show_alert(context);
        }
    }

    /// Rafraîchit les touches dont c'est le moment (profil actif, statistique).
    fn refresh_due(&mut self) {
        let now = Instant::now();
        let due: Vec<(String, String, Value)> = self
            .keys
            .iter_mut()
            .filter_map(|(context, key)| {
                let period = refresh_period(&key.action)?;
                if key.next_refresh > now {
                    return None;
                }
                key.next_refresh = now + period;
                Some((context.clone(), key.action.clone(), key.settings.clone()))
            })
            .collect();
        for (context, action, settings) in due {
            self.refresh(&context, &action, &settings);
        }
    }

    fn refresh(&mut self, context: &str, action: &str, settings: &Value) {
        let server = server(settings);
        // Serveur injoignable : on garde le dernier affichage plutôt que de l'effacer à chaque
        // coupure passagère.
        match action {
            "activate-profile" => {
                let id = setting(settings, "profileId");
                if id.is_empty() {
                    return;
                }
                let Ok(data) = server.get("/api/profiles") else { return };
                let active = data["activeId"].as_str() == Some(id);
                let name = data["profiles"]
                    .as_array()
                    .and_then(|list| list.iter().find(|p| p["id"].as_str() == Some(id)))
                    .and_then(|p| p["name"].as_str())
                    .unwrap_or("?")
                    .to_string();
                self.set_state(context, u8::from(active));
                self.set_title(context, &format!("{}{name}", if active { "✓ " } else { "" }));
            }
            "stream-stats" => {
                let stat = setting(settings, "stat");
                let label = match stat {
                    "follows" => "Follows",
                    "subscribers" => "Abonnés",
                    "chatMessages" => "Messages",
                    "viewerCount" => "Viewers",
                    _ => return,
                };
                let Ok(data) = server.get("/api/stream-stats") else { return };
                let value = data[stat].as_u64().unwrap_or(0);
                self.set_title(context, &format!("{label}\n{value}"));
            }
            _ => {}
        }
    }
}

fn main() {
    let (Some(port), Some(uuid), Some(register)) = (arg("-port"), arg("-pluginUUID"), arg("-registerEvent")) else {
        eprintln!("Plugin Stream Deck : à lancer par l'app Stream Deck (-port, -pluginUUID, -registerEvent).");
        std::process::exit(2);
    };
    let stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(0))).expect("connexion à Stream Deck");
    let (socket, _) = tungstenite::client(format!("ws://127.0.0.1:{port}"), stream).expect("WebSocket Stream Deck");
    // Lecture avec délai : la même boucle traite les messages et les rafraîchissements.
    socket.get_ref().set_read_timeout(Some(Duration::from_millis(250))).ok();
    let mut plugin = Plugin { socket, keys: HashMap::new() };
    plugin.send(json!({ "event": register, "uuid": uuid }));

    loop {
        match plugin.socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(message) = serde_json::from_str::<Value>(&text) {
                    plugin.handle(&message);
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            // Stream Deck fermé ou plugin désactivé : on s'arrête.
            Err(_) => break,
        }
        plugin.refresh_due();
    }
}
