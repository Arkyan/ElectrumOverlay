//! Le plugin lancé comme par l'app Stream Deck, face à un faux Stream Deck (WebSocket) et à une
//! fausse API ElectrumOverlay (HTTP).

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::time::Duration;
use tungstenite::Message;

/// Fausse API : renvoie la liste des requêtes reçues (méthode, chemin, corps).
fn fake_api() -> (u16, mpsc::Receiver<(String, String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            let mut parts = text.split_whitespace();
            let (method, path) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
            let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();
            let reply = match path.as_str() {
                "/api/profiles" => json!({ "activeId": "p1", "profiles": [{ "id": "p1", "name": "Néon" }, { "id": "p2", "name": "Vert" }] }),
                "/api/stream-stats" => json!({ "viewerCount": 87, "follows": 3 }),
                _ => json!({ "ok": true }),
            }
            .to_string();
            let _ = tx.send((method, path, body));
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{reply}", reply.len());
        }
    });
    (port, rx)
}

struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn next_json(ws: &mut tungstenite::WebSocket<std::net::TcpStream>) -> Value {
    loop {
        if let Message::Text(text) = ws.read().expect("message du plugin") {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

#[test]
fn plugin_de_bout_en_bout() {
    let (api_port, requests) = fake_api();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let sd_port = listener.local_addr().unwrap().port();
    let _plugin = Guard(
        Command::new(env!("CARGO_BIN_EXE_electrum-deck"))
            .args(["-port", &sd_port.to_string(), "-pluginUUID", "uuid-test", "-registerEvent", "registerPlugin", "-info", "{}"])
            .spawn()
            .unwrap(),
    );
    let (stream, _) = listener.accept().unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut ws = tungstenite::accept(stream).unwrap();
    assert_eq!(next_json(&mut ws), json!({ "event": "registerPlugin", "uuid": "uuid-test" }));

    let settings = |extra: Value| {
        let mut s = json!({ "host": "127.0.0.1", "port": api_port.to_string() });
        s.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        s
    };
    let send = |ws: &mut tungstenite::WebSocket<std::net::TcpStream>, event: &str, action: &str, context: &str, s: Value| {
        let message = json!({ "event": event, "action": format!("com.electrumvtc.overlay.streamdeck.{action}"), "context": context, "payload": { "settings": s } });
        ws.send(Message::text(message.to_string())).unwrap();
    };

    // Touche « Activer un profil » : état + titre selon le profil actif.
    send(&mut ws, "willAppear", "activate-profile", "k1", settings(json!({ "profileId": "p1" })));
    assert_eq!(next_json(&mut ws), json!({ "event": "setState", "context": "k1", "payload": { "state": 1 } }));
    assert_eq!(next_json(&mut ws)["payload"]["title"], "✓ Néon");

    // Alerte de test : POST /api/tests/trigger puis « OK » sur la touche.
    send(&mut ws, "keyDown", "trigger-test-alert", "k2", settings(json!({ "alertType": "raid" })));
    assert_eq!(next_json(&mut ws), json!({ "event": "showOk", "context": "k2" }));
    let posted = std::iter::from_fn(|| requests.recv_timeout(Duration::from_secs(2)).ok())
        .find(|(_, path, _)| path == "/api/tests/trigger")
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&posted.2).unwrap(), json!({ "action": "raid" }));

    // Réglage invalide : alerte sur la touche, aucune requête.
    send(&mut ws, "keyDown", "show-panel", "k3", settings(json!({ "panel": "milieu" })));
    assert_eq!(next_json(&mut ws), json!({ "event": "showAlert", "context": "k3" }));

    // Statistique.
    send(&mut ws, "willAppear", "stream-stats", "k4", settings(json!({ "stat": "viewerCount" })));
    assert_eq!(next_json(&mut ws)["payload"]["title"], "Viewers\n87");

    // Fenêtre de réglages : la liste des profils passe par le plugin (texte, pas de HTML).
    let ask = json!({ "event": "sendToPlugin", "action": "com.electrumvtc.overlay.streamdeck.activate-profile", "context": "k1", "payload": { "event": "getProfiles" } });
    ws.send(Message::text(ask.to_string())).unwrap();
    let reply = next_json(&mut ws);
    assert_eq!((reply["event"].as_str(), reply["context"].as_str()), (Some("sendToPropertyInspector"), Some("k1")));
    assert_eq!(reply["payload"], json!({ "event": "getProfiles", "items": [{ "label": "Néon (actif)", "value": "p1" }, { "label": "Vert", "value": "p2" }] }));
}
