//! WebSocket vers les overlays (port 8081 par défaut, n'importe quel chemin, comme `ws` côté
//! Node). Chaque overlay reçoit tous les événements diffusés ; il peut envoyer `ping`.

use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::Extension;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

pub fn router(state: AppState) -> Router {
    Router::new().fallback(upgrade).with_state(state)
}

/// Qui se connecte : un site web quelconque ouvert dans le navigateur ne doit rien recevoir.
#[derive(Debug, PartialEq)]
enum Client {
    /// L'app et ses overlays (même machine) : tout, y compris le journal.
    Trusted,
    /// Overlay sur un autre PC du réseau, ou widget isolé (origine `null`) : les événements du
    /// stream, pas le journal de l'app.
    Overlay,
    Refused,
}

fn host_name(value: &str) -> &str {
    let value = value.split_once("://").map_or(value, |(_, rest)| rest);
    let value = value.split('/').next().unwrap_or(value);
    match value.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => value,
    }
}

fn is_local_name(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

fn classify(headers: &HeaderMap, peer: Option<SocketAddr>) -> Client {
    let get = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());
    let local_peer = peer.is_none_or(|p| p.ip().is_loopback());
    let host = get(header::HOST).map(host_name);
    // Nom de domaine qui pointerait vers 127.0.0.1 (DNS rebinding).
    if local_peer && host.is_some_and(|h| !is_local_name(h)) {
        return Client::Refused;
    }
    match get(header::ORIGIN) {
        // Pas un navigateur (plugin, outil local).
        None => if local_peer { Client::Trusted } else { Client::Overlay },
        Some("null") => Client::Overlay,
        Some(origin) => {
            let origin_host = host_name(origin);
            if local_peer && is_local_name(origin_host) {
                Client::Trusted
            } else if !local_peer && Some(origin_host) == host {
                Client::Overlay
            } else {
                Client::Refused
            }
        }
    }
}

async fn upgrade(ws: WebSocketUpgrade, headers: HeaderMap, peer: Option<Extension<ConnectInfo<SocketAddr>>>, State(state): State<AppState>) -> Response {
    let client = classify(&headers, peer.map(|Extension(ConnectInfo(p))| p));
    if client == Client::Refused {
        return (StatusCode::FORBIDDEN, "Connexion refusée").into_response();
    }
    ws.on_upgrade(move |socket| client_loop(socket, state, client == Client::Trusted))
}

async fn client_loop(mut socket: WebSocket, state: AppState, trusted: bool) {
    let mut events = state.subscribe();
    let mut closing = state.overlays_closing();
    closing.mark_unchanged();
    let welcome = json!({ "type": "connected", "message": "Connexion WebSocket établie" });
    if socket.send(Message::Text(welcome.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            _ = closing.changed() => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
            event = events.recv() => match event {
                Ok(text) => {
                    // Le journal de l'app (erreurs, comptes…) ne part qu'aux pages de l'app.
                    if !trusted && text.starts_with("{\"type\":\"log\"") {
                        continue;
                    }
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                // Overlay trop lent : il a raté des messages, mais reste connecté.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let data: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    match data.get("type").and_then(Value::as_str) {
                        Some("ping") => {
                            let pong = json!({ "type": "pong" }).to_string();
                            if socket.send(Message::Text(pong.into())).await.is_err() {
                                break;
                            }
                        }
                        // Accepté pour compatibilité ; la version Node ne filtrait pas non plus.
                        Some("subscribe") => {}
                        other => eprintln!("Message WebSocket non géré: {other:?}"),
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(header::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        map
    }

    #[test]
    fn origines() {
        let local = Some("127.0.0.1:5000".parse().unwrap());
        let lan = Some("192.168.1.20:5000".parse().unwrap());
        let app = headers(&[("host", "localhost:8081"), ("origin", "http://localhost:8080")]);
        assert_eq!(classify(&app, local), Client::Trusted);
        assert_eq!(classify(&headers(&[("host", "localhost:8081")]), local), Client::Trusted);
        assert_eq!(classify(&headers(&[("host", "localhost:8081"), ("origin", "null")]), local), Client::Overlay);
        assert_eq!(classify(&headers(&[("host", "localhost:8081"), ("origin", "https://evil.example")]), local), Client::Refused);
        assert_eq!(classify(&headers(&[("host", "evil.example:8081"), ("origin", "http://evil.example")]), local), Client::Refused);
        assert_eq!(classify(&headers(&[("host", "192.168.1.10:8081"), ("origin", "http://192.168.1.10:8080")]), lan), Client::Overlay);
        assert_eq!(classify(&headers(&[("host", "192.168.1.10:8081"), ("origin", "http://evil.example")]), lan), Client::Refused);
    }
}
