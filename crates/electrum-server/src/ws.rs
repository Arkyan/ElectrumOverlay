//! WebSocket vers les overlays (port 8081 par défaut, n'importe quel chemin, comme `ws` côté
//! Node). Chaque overlay reçoit tous les événements diffusés ; il peut envoyer `ping`.

use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

pub fn router(state: AppState) -> Router {
    Router::new().fallback(upgrade).with_state(state)
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| client(socket, state))
}

async fn client(mut socket: WebSocket, state: AppState) {
    let mut events = state.subscribe();
    let welcome = json!({ "type": "connected", "message": "Connexion WebSocket établie" });
    if socket.send(Message::Text(welcome.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(text) => {
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
