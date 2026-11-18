//! EventSub par WebSocket contre un FAUX serveur Twitch local, qui joue le protocole officiel :
//! session_welcome → création des abonnements, notifications (dont un doublon), keepalive,
//! session_reconnect vers une autre URL, silence (keepalive dépassé) → reconnexion complète,
//! token refusé puis ré-autorisation.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use electrum_core::Store;
use electrum_server::twitch::api::Endpoints;
use electrum_server::twitch::eventsub;
use electrum_server::{AppState, Assets};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Mock {
    /// Corps des POST /helix/eventsub/subscriptions reçus.
    subscriptions: Mutex<Vec<Value>>,
    /// Nombre de connexions sur /ws.
    connections: AtomicUsize,
    /// Token accepté par /oauth2/validate.
    good_token: Mutex<String>,
}

fn message(kind: &str, id: &str, payload: Value) -> Message {
    let text = json!({
        "metadata": { "message_id": id, "message_type": kind, "message_timestamp": "2026-11-16T20:00:00.000Z" },
        "payload": payload
    })
    .to_string();
    Message::Text(text.into())
}

fn welcome(session: &str, keepalive: u64) -> Message {
    message("session_welcome", &format!("w-{session}"), json!({ "session": { "id": session, "status": "connected", "keepalive_timeout_seconds": keepalive, "reconnect_url": null } }))
}

fn notification(id: &str, kind: &str, event: Value) -> Message {
    message("notification", id, json!({ "subscription": { "type": kind, "version": "1" }, "event": event }))
}

async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..200 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("délai dépassé : {what}");
}

/// Première connexion : welcome, notifications, keepalive, puis demande de reconnexion.
async fn first_session(mut socket: WebSocket, mock: Arc<Mock>, port: u16) {
    socket.send(welcome("s1", 1)).await.unwrap();
    // Laisser le client créer ses abonnements (il a ~10 s pour le faire chez Twitch).
    wait_for("abonnements de la session 1", || mock.subscriptions.lock().unwrap().len() >= 12).await;
    socket.send(notification("n1", "channel.follow", json!({ "user_name": "Alice" }))).await.unwrap();
    socket.send(notification("n1", "channel.follow", json!({ "user_name": "Alice" }))).await.unwrap(); // doublon
    socket.send(message("session_keepalive", "k1", json!({}))).await.unwrap();
    socket.send(notification("n2", "channel.chat.message", json!({
        "chatter_user_id": "9", "chatter_user_name": "Bob", "color": "", "badges": [],
        "message": { "text": "salut", "fragments": [{ "type": "text", "text": "salut" }] }
    }))).await.unwrap();
    let reconnect_url = format!("ws://127.0.0.1:{port}/ws-reconnect");
    socket
        .send(message("session_reconnect", "r1", json!({ "session": { "id": "s1", "status": "reconnecting", "keepalive_timeout_seconds": null, "reconnect_url": reconnect_url } })))
        .await
        .unwrap();
    // Twitch garde l'ancienne connexion ouverte un moment : on attend que le client la ferme.
    while let Some(Ok(_)) = socket.recv().await {}
}

async fn ws(ws: WebSocketUpgrade, State((mock, port)): State<(Arc<Mock>, u16)>) -> Response {
    let n = mock.connections.fetch_add(1, Ordering::SeqCst);
    ws.on_upgrade(move |mut socket| async move {
        if n == 0 {
            first_session(socket, mock, port).await;
        } else {
            // Après le silence de /ws-reconnect : nouvelle session complète.
            socket.send(welcome(&format!("s{}", n + 2), 10)).await.unwrap();
            while let Some(Ok(_)) = socket.recv().await {}
        }
    })
}

/// URL de reconnexion : welcome, une notification, puis plus rien (keepalive dépassé).
async fn ws_reconnect(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket| async move {
        socket.send(welcome("s2", 1)).await.unwrap();
        socket.send(notification("n3", "channel.raid", json!({ "from_broadcaster_user_name": "Carol", "viewers": 7 }))).await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
    })
}

async fn validate(State((mock, _)): State<(Arc<Mock>, u16)>, headers: HeaderMap) -> Response {
    let good = format!("OAuth {}", mock.good_token.lock().unwrap());
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(good.as_str()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "status": 401, "message": "invalid access token" }))).into_response();
    }
    Json(json!({ "client_id": "test", "login": "moi", "user_id": "1", "expires_in": 5_000_000,
                 "scopes": ["user:read:chat", "user:bot", "channel:bot", "channel:read:subscriptions", "moderator:read:followers", "chat:read", "chat:edit", "user:write:chat", "channel:read:polls"] }))
    .into_response()
}

async fn create_subscription(State((mock, _)): State<(Arc<Mock>, u16)>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    assert_eq!(headers["client-id"], "test");
    let n = {
        let mut subs = mock.subscriptions.lock().unwrap();
        subs.push(body.clone());
        subs.len()
    };
    if body["type"] == "channel.subscription.gift" {
        return (StatusCode::FORBIDDEN, Json(json!({ "message": "subscription missing proper authorization" }))).into_response();
    }
    (StatusCode::ACCEPTED, Json(json!({ "data": [{ "id": format!("sub-{n}"), "status": "enabled", "type": body["type"], "version": body["version"], "condition": body["condition"], "created_at": "2026-11-16T20:00:00Z" }] })))
        .into_response()
}

async fn start_mock() -> (Arc<Mock>, Endpoints) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock = Arc::new(Mock::default());
    *mock.good_token.lock().unwrap() = "bon-token".into();
    let app = Router::new()
        .route("/ws", get(ws))
        .route("/ws-reconnect", get(ws_reconnect))
        .route("/oauth2/validate", get(validate))
        .route("/helix/eventsub/subscriptions", post(create_subscription))
        .with_state((mock.clone(), port));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let base = format!("127.0.0.1:{port}");
    let endpoints = Endpoints {
        helix: format!("http://{base}/helix"),
        oauth: format!("http://{base}/oauth2"),
        eventsub_ws: format!("ws://{base}/ws"),
    };
    (mock, endpoints)
}

fn new_state(endpoints: Endpoints, token: &str) -> (AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store
        .save_config(&json!({ "twitch": { "CLIENT_ID": "test", "CLIENT_SECRET": "s", "BROADCASTER_ID": "1", "USER_ACCESS_TOKEN": token } }))
        .unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let assets = Assets { public_dir: repo.join("public"), templates_dir: repo.join("src").join("templates") };
    (AppState::with_external(store, assets, electrum_server::External { twitch: endpoints, ..Default::default() }), dir)
}

fn options() -> eventsub::Options {
    eventsub::Options { keepalive_grace: Duration::from_millis(300), max_backoff: Duration::from_secs(1) }
}

#[tokio::test]
async fn connexion_notifications_reconnexions() {
    let (mock, endpoints) = start_mock().await;
    let (state, _dir) = new_state(endpoints, "bon-token");
    let mut overlay = state.subscribe();
    let mut live = state.subscribe();
    tokio::spawn(eventsub::run(state.clone(), options()));

    // 1. Abonnements créés pour la session s1, avec le bon transport et les bonnes conditions.
    wait_for("connexion EventSub", || state.twitch.status().connected).await;
    // Les pages de l'app sont prévenues en direct (sans attendre leur prochaine vérification).
    let pushed: Vec<String> = std::iter::from_fn(|| live.try_recv().ok()).filter(|m| m.contains("\"twitch-status\"")).collect();
    assert!(pushed.iter().any(|m| m.contains("\"connected\":true")), "{pushed:?}");
    let created = mock.subscriptions.lock().unwrap().clone();
    assert_eq!(created.len(), 12, "7 événements de base + le chat + titre/catégorie + 3 de sondage");
    // Abonnements facultatifs : seulement ceux que le token autorise.
    assert!(created.iter().any(|s| s["type"] == "channel.poll.progress"));
    assert!(created.iter().any(|s| s["type"] == "channel.update" && s["version"] == "2"));
    assert!(!created.iter().any(|s| s["type"] == "channel.cheer" || s["type"] == "channel.goal.progress"));
    assert_eq!(state.twitch.status().missing_features, ["Bits", "Objectifs", "Prédictions", "Hype train"]);
    assert!(created.iter().all(|s| s["transport"] == json!({ "method": "websocket", "session_id": "s1" })));
    let follow = created.iter().find(|s| s["type"] == "channel.follow").unwrap();
    assert_eq!((follow["version"].clone(), follow["condition"].clone()), (json!("2"), json!({ "broadcaster_user_id": "1", "moderator_user_id": "1" })));
    let chat = created.iter().find(|s| s["type"] == "channel.chat.message").unwrap();
    assert_eq!(chat["condition"], json!({ "broadcaster_user_id": "1", "user_id": "1" }));
    let raid = created.iter().find(|s| s["type"] == "channel.raid").unwrap();
    assert_eq!(raid["condition"], json!({ "to_broadcaster_user_id": "1" }));
    assert_eq!(state.twitch.status().subscriptions.len(), 11, "le refus 403 d'un abonnement n'empêche pas les autres");

    // 2. Notifications : le doublon est ignoré, le chat arrive aux overlays.
    wait_for("follow + chat", || state.stats().chat_messages == 1).await;
    assert_eq!(state.stats().follows, 1, "notification en double ignorée");

    // 3. session_reconnect : on rejoint la nouvelle URL sans recréer les abonnements.
    wait_for("raid après reconnexion", || {
        std::iter::from_fn(|| overlay.try_recv().ok()).any(|e| e.contains("\"channel.raid\""))
    })
    .await;
    assert_eq!(mock.subscriptions.lock().unwrap().len(), 12, "pas de nouveaux abonnements après session_reconnect");

    // 4. Silence sur la nouvelle URL : keepalive dépassé → reconnexion complète + réabonnement.
    wait_for("nouvelle session après silence", || state.twitch.status().session_id.as_deref() == Some("s3")).await;
    wait_for("réabonnement", || mock.subscriptions.lock().unwrap().len() == 24).await;
    assert!(mock.subscriptions.lock().unwrap()[12..].iter().all(|s| s["transport"]["session_id"] == "s3"));
    assert_eq!(state.stats().follows, 1);
}

#[tokio::test]
async fn token_refuse_puis_reautorisation() {
    let (mock, endpoints) = start_mock().await;
    let (state, _dir) = new_state(endpoints, "token-expire");
    tokio::spawn(eventsub::run(state.clone(), options()));

    wait_for("token refusé détecté", || state.twitch.status().needs_authorization).await;
    assert!(state.twitch.status().last_error.unwrap().contains("ré-autorise"));
    assert_eq!(mock.connections.load(Ordering::SeqCst), 0, "pas de connexion avec un token refusé");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(mock.connections.load(Ordering::SeqCst), 0, "et pas de nouvelles tentatives en boucle");

    // Nouvelle autorisation (ce que fait /api/oauth-callback) : la connexion repart.
    state.store().save_config(&json!({ "twitch": { "USER_ACCESS_TOKEN": "bon-token" } })).unwrap();
    state.twitch.restart.notify_one();
    wait_for("connexion après ré-autorisation", || state.twitch.status().connected).await;
    assert!(!state.twitch.status().needs_authorization);
}

#[tokio::test]
async fn sans_autorisation_on_attend_sans_rien_tenter() {
    let (mock, endpoints) = start_mock().await;
    let (state, _dir) = new_state(endpoints, "");
    tokio::spawn(eventsub::run(state.clone(), options()));
    wait_for("statut renseigné", || state.twitch.status().last_error.is_some()).await;
    assert!(!state.twitch.status().connected);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(mock.connections.load(Ordering::SeqCst), 0);
}
