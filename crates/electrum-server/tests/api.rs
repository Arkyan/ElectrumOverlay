//! Tests d'intégration du serveur : vraies requêtes HTTP sur le routeur, et un vrai client
//! WebSocket sur des ports éphémères.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use electrum_core::Store;
use electrum_server::{http_router, AppState, Assets};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn new_state() -> (AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    // Config Twitch complète : sinon toutes les pages redirigent vers /setup (comme côté Node).
    store.save_config(&serde_json::json!({ "twitch": { "CLIENT_ID": "test", "CLIENT_SECRET": "s", "BROADCASTER_ID": "1", "USER_ACCESS_TOKEN": "t" } })).unwrap();
    let assets = Assets { public_dir: repo().join("public"), templates_dir: repo().join("src").join("templates") };
    (AppState::new(store, assets), dir)
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("JSON attendu : {}", String::from_utf8_lossy(&self.body)))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }
}

async fn send(state: &AppState, method: &str, uri: &str, body: Option<Value>) -> Reply {
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(value) => {
            request = request.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    reply(state, request.body(body).unwrap()).await
}

async fn reply(state: &AppState, request: Request<Body>) -> Reply {
    let response = http_router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    Reply { status, headers, body }
}

async fn upload(state: &AppState, uri: &str, filename: &str, mime: &str, bytes: &[u8]) -> Reply {
    let boundary = "----electrum-test";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .unwrap();
    reply(state, request).await
}

fn active_id(state: &AppState) -> String {
    state.store().active_profile_id().unwrap().to_string()
}

fn next_event(rx: &mut Receiver<String>) -> Value {
    serde_json::from_str(&rx.try_recv().expect("un événement diffusé était attendu")).unwrap()
}

#[tokio::test]
async fn sert_les_overlays_et_la_config() {
    let (state, _dir) = new_state();

    let index = send(&state, "GET", "/", None).await;
    assert_eq!(index.status, StatusCode::OK);
    assert!(index.text().contains("js/config.js") && index.text().contains("js/index.js"), "public/index.html attendu");

    let css = send(&state, "GET", "/css/overlay-common.css", None).await;
    assert_eq!(css.status, StatusCode::OK);

    let script = send(&state, "GET", "/js/config.js", None).await;
    assert!(script.headers["content-type"].to_str().unwrap().starts_with("application/javascript"));
    let text = script.text();
    let json_part = text.strip_prefix("globalThis.OVERLAY_CONFIG = ").unwrap().strip_suffix(';').unwrap();
    let config: Value = serde_json::from_str(json_part).unwrap();
    assert_eq!(config["server"], json!({ "host": "localhost", "port": 8080, "wsPort": 8081 }));
    assert!(config["alerts"]["types"]["follow"]["sound"].is_null());
}

#[tokio::test]
async fn redirige_vers_setup_tant_que_twitch_n_est_pas_configure() {
    let dir = tempfile::tempdir().unwrap();
    let assets = Assets { public_dir: repo().join("public"), templates_dir: repo().join("src").join("templates") };
    let state = AppState::new(Store::open(dir.path()).unwrap(), assets);
    for path in ["/", "/app", "/settings", "/starting.html"] {
        let r = send(&state, "GET", path, None).await;
        assert_eq!(r.headers["location"], "/setup", "{path}");
    }
    for path in ["/setup", "/css/app-ui.css", "/js/config.js", "/api/profiles", "/logs", "/auth-callback"] {
        assert_eq!(send(&state, "GET", path, None).await.status, StatusCode::OK, "{path}");
    }
    let setup = send(&state, "GET", "/setup", None).await.text();
    assert!(!setup.to_lowercase().contains("ngrok"));
    assert_eq!(send(&state, "POST", "/api/setup/credentials", Some(json!({ "clientId": " abc " }))).await.json()["error"], "Client Secret requis");
    send(&state, "POST", "/api/setup/credentials", Some(json!({ "clientId": " abc ", "clientSecret": "s" }))).await;
    let url = send(&state, "GET", "/api/setup/auth-url", None).await.json();
    assert!(url["url"].as_str().unwrap().contains("client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fauth-callback&scope=user%3Aread%3Achat+"));
    assert_eq!(send(&state, "POST", "/api/setup/finish", Some(json!({}))).await.json()["error"], "Autorisation Twitch requise avant d'enregistrer");
}

#[tokio::test]
async fn profils_activation_et_diffusion() {
    let (state, _dir) = new_state();
    let mut events = state.subscribe();

    let list = send(&state, "GET", "/api/profiles", None).await.json();
    assert_eq!(list["profiles"].as_array().unwrap().len(), 4, "Défaut + 3 thèmes");

    let created = send(&state, "POST", "/api/profiles", Some(json!({ "name": "Stream" }))).await.json();
    let id = created["profile"]["id"].as_str().unwrap().to_string();
    assert!(events.try_recv().is_err(), "créer un profil ne change rien en direct");

    assert_eq!(send(&state, "POST", &format!("/api/profiles/{id}/activate"), None).await.json(), json!({ "ok": true }));
    assert_eq!(next_event(&mut events)["type"], "config-updated");

    let error = send(&state, "DELETE", &format!("/api/profiles/{id}"), None).await;
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert_eq!(error.json()["error"], "Impossible de supprimer le profil actif — activez-en un autre d'abord");

    let renamed = send(&state, "PUT", &format!("/api/profiles/{id}"), Some(json!({ "name": " Live " }))).await.json();
    assert_eq!(renamed["profile"]["name"], "Live");
}

#[tokio::test]
async fn editeur_de_scene_bornes_et_scenes() {
    let (state, _dir) = new_state();
    let id = active_id(&state);
    let mut events = state.subscribe();

    let r = send(&state, "POST", &format!("/api/profiles/{id}/layout/index/chatContainer"),
        Some(json!({ "top": 500, "left": -300, "z": 3.5, "scale": 1000, "opacity": 50, "primary": "#fff", "inconnu": 1 }))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(next_event(&mut events)["type"], "config-updated");
    let layout = state.store().config()["display"]["layout"]["index"]["chatContainer"].clone();
    assert_eq!(layout, json!({ "top": 200, "left": -100, "scale": 400, "opacity": 50, "z": 4, "primary": "#fff" }));

    send(&state, "POST", &format!("/api/profiles/{id}/text-style/index/title"), Some(json!({ "size": 50, "font": "inter" }))).await;
    send(&state, "POST", &format!("/api/profiles/{id}/text-style/index/title"), Some(json!({ "size": 0 }))).await;
    assert_eq!(state.store().config()["display"]["textStyles"]["index"]["title"], json!({ "font": "inter" }));

    let added = send(&state, "POST", &format!("/api/profiles/{id}/custom-text/index"), Some(json!({ "type": "keys" }))).await.json();
    let element = added["elementId"].as_str().unwrap().to_string();
    send(&state, "PATCH", &format!("/api/profiles/{id}/custom-text/index/{element}"),
        Some(json!({ "layout": "dvorak", "speed": 1, "icon": "heart", "source": "nope" }))).await;
    let entry = state.store().config()["display"]["customTexts"]["index"][&element].clone();
    assert_eq!(entry["layout"], "azerty", "disposition inconnue ignorée");
    assert_eq!(entry["speed"], 10);
    assert_eq!(entry["icon"], "heart");
    assert!(entry.get("source").is_none());

    let scene = send(&state, "POST", &format!("/api/profiles/{id}/scenes"), Some(json!({ "name": "<b>Jeu</b>" }))).await.json();
    let scene_id = scene["sceneId"].as_str().unwrap().to_string();
    let page = send(&state, "GET", &format!("/scene/{scene_id}"), None).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text().contains("<title>&lt;b&gt;Jeu&lt;/b&gt; - ElectrumOverlay</title>"));
    assert_eq!(send(&state, "GET", "/scene/index", None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(send(&state, "GET", "/scene/inconnue", None).await.status, StatusCode::NOT_FOUND);

    send(&state, "PATCH", &format!("/api/profiles/{id}/pause-messages"), Some(json!({ "messages": [" a ", "", 3, "b"] }))).await;
    assert_eq!(state.store().config()["display"]["pause"]["messages"], json!(["a", "b"]));
}

#[tokio::test]
async fn sons_export_et_import() {
    let (state, _dir) = new_state();
    let id = active_id(&state);

    let refused = upload(&state, &format!("/api/profiles/{id}/audio/follow"), "a.png", "image/png", b"x").await;
    assert_eq!(refused.json()["error"], "Le fichier doit être un son (audio/*)");

    let too_big = upload(&state, &format!("/api/profiles/{id}/audio/follow"), "a.mp3", "audio/mpeg", &vec![0u8; 5 * 1024 * 1024 + 1]).await;
    assert_eq!(too_big.json()["error"], "Fichier trop volumineux (max 5 Mo)");

    let ok = upload(&state, &format!("/api/profiles/{id}/audio/follow"), "ding.mp3", "audio/mpeg", b"ID3").await;
    assert_eq!(ok.json(), json!({ "ok": true }));

    let served = send(&state, "GET", &format!("/api/profiles/{id}/audio/follow"), None).await;
    assert_eq!(served.headers["content-type"], "audio/mpeg");
    assert_eq!(served.body, b"ID3");
    assert_eq!(send(&state, "GET", &format!("/api/profiles/{id}/audio/sub"), None).await.status, StatusCode::NOT_FOUND);

    let config = state.store().to_frontend_config();
    assert!(config["alerts"]["types"]["follow"]["sound"].as_str().unwrap().starts_with(&format!("/api/profiles/{id}/audio/follow?v=")));

    let exported = send(&state, "GET", &format!("/api/profiles/{id}/export"), None).await;
    assert_eq!(exported.headers["content-disposition"], "attachment; filename=\"D_faut.electrumprofile.json\"");
    assert_eq!(exported.json()["audio"]["follow"]["dataBase64"], "SUQz");

    let imported = upload(&state, "/api/profiles/import", "p.json", "application/json", &exported.body).await.json();
    assert_eq!(imported["profile"]["name"], "Défaut");
    let new_id = imported["profile"]["id"].as_str().unwrap();
    assert_eq!(send(&state, "GET", &format!("/api/profiles/{new_id}/audio/follow"), None).await.body, b"ID3");

    let invalid = upload(&state, "/api/profiles/import", "p.json", "application/json", b"pas du json").await;
    assert!(invalid.json()["error"].as_str().unwrap().starts_with("Fichier de profil invalide : "));
}

#[tokio::test]
async fn reglages_tests_et_stats() {
    let (state, _dir) = new_state();
    let mut events = state.subscribe();

    send(&state, "POST", "/api/settings", Some(json!({
        "themes": { "index": { "primary": "#123456" } },
        "alerts": { "follow": { "title": "MERCI", "animationStyle": "explosion" } },
        "soundVolume": "50", "alertsDuration": "abc", "infoTexts": ["a", 1], "chatEnabledIndex": true
    }))).await;
    assert_eq!(next_event(&mut events)["type"], "config-updated");
    let display = state.store().config()["display"].clone();
    assert_eq!(display["themes"]["index"]["primary"], "#123456");
    assert_eq!(display["themes"]["index"]["secondary"], "#8b45f6", "fusion avec les défauts");
    assert_eq!(display["alerts"]["types"]["follow"]["animationStyle"], "fade");
    assert_eq!(display["alerts"]["soundVolume"], 0.5);
    assert_eq!(display["alerts"]["duration"], 6000);
    assert_eq!(display["panels"]["bottom"]["content"]["infoTexts"], json!(["a"]));
    assert_eq!(display["chat"]["enabled"], json!({ "starting": false, "index": true, "ending": false }));

    assert_eq!(send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "nope" }))).await.json()["error"], "Action de test inconnue");
    send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "streamOnline" }))).await;
    send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "follow" }))).await;
    send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "subgift" }))).await;
    send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "chat" }))).await;
    assert_eq!(next_event(&mut events)["type"], "stream.online");
    let follow = next_event(&mut events);
    assert_eq!((follow["type"].as_str(), follow["data"]["user_name"].as_str()), (Some("channel.follow"), Some("TestViewer")));
    assert_eq!(next_event(&mut events)["data"]["total"], 5);
    let chat = next_event(&mut events);
    assert_eq!(chat["type"], "message");
    assert_eq!(chat["fragments"][1]["emote"]["id"], "25");

    let stats = send(&state, "GET", "/api/stream-stats", None).await.json();
    assert_eq!((stats["isLive"].clone(), stats["follows"].clone(), stats["subscribers"].clone(), stats["chatMessages"].clone()),
        (json!(true), json!(1), json!(5), json!(1)));

    assert_eq!(send(&state, "POST", "/api/panels/top/show", None).await.status, StatusCode::BAD_REQUEST);
    send(&state, "POST", "/api/panels/left/show", None).await;
    assert_eq!(next_event(&mut events), json!({ "type": "show-panel", "panel": "left" }));
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_json(socket: &mut Socket) -> Value {
    loop {
        if let tokio_tungstenite::tungstenite::Message::Text(text) = socket.next().await.unwrap().unwrap() {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

/// Requête HTTP brute (sans client HTTP en dépendance) sur le vrai port ouvert.
async fn raw_post(port: u16, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn websocket_de_bout_en_bout() {
    let (state, _dir) = new_state();
    let running = electrum_server::start(state.clone(), 0, 0).await.unwrap();
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", running.ws.port())).await.unwrap();

    assert_eq!(next_json(&mut socket).await["type"], "connected");

    socket.send(tokio_tungstenite::tungstenite::Message::Text(r#"{"type":"ping"}"#.into())).await.unwrap();
    assert_eq!(next_json(&mut socket).await, json!({ "type": "pong" }));

    // Comme le plugin Stream Deck : requête HTTP réelle → l'overlay connecté reçoit l'événement.
    let response = raw_post(running.http.port(), "/api/panels/bottom/show").await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(next_json(&mut socket).await, json!({ "type": "show-panel", "panel": "bottom" }));
}

#[tokio::test]
async fn arret_puis_redemarrage_du_serveur() {
    let (state, _dir) = new_state();
    let running = electrum_server::start(state.clone(), 0, 0).await.unwrap();
    let (http_port, ws_port) = (running.http.port(), running.ws.port());
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{ws_port}")).await.unwrap();
    assert_eq!(next_json(&mut socket).await["type"], "connected");

    running.stop().await;

    // L'overlay connecté est déconnecté, et plus rien n'écoute sur les ports.
    let closed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            match socket.next().await {
                None | Some(Err(_)) | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => return,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "l'overlay aurait dû être déconnecté");
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", http_port)).await.is_err(), "le port HTTP devrait être libéré");

    // Redémarrage sur les mêmes ports, avec le même état.
    let running = electrum_server::start(state.clone(), http_port, ws_port).await.unwrap();
    assert!(raw_post(http_port, "/api/panels/left/show").await.starts_with("HTTP/1.1 200"));
    running.stop().await;
}

#[tokio::test]
async fn toutes_les_pages_de_l_app_utilisent_la_nouvelle_interface() {
    let (state, _dir) = new_state();
    let pages = [
        ("/app", "/app"),
        ("/settings", "/settings"),
        ("/scene-editor", "/scene-editor"),
        ("/commands", "/commands"),
        ("/integrations", "/integrations"),
        ("/setup", "/setup"),
        ("/tests", "/tests"),
        ("/logs", "/logs"),
        ("/stream-stats-html", "/stream-stats-html"),
        ("/auth-url", "/setup"),
    ];
    for (path, active) in pages {
        let page = send(&state, "GET", path, None).await;
        assert_eq!(page.status, StatusCode::OK, "{path}");
        let html = page.text();
        assert!(html.contains("/css/app-v3.css") && !html.contains("app-ui.css"), "{path} : feuille de style");
        assert!(html.contains("<nav class=\"sidebar\">"), "{path} : barre latérale");
        assert!(html.contains(&format!("class=\"nav-item active\" href=\"{active}\"")), "{path} : entrée active");
        assert!(!html.contains("{{"), "{path} : repère non rempli");
        assert!(!html.to_lowercase().contains("ngrok"), "{path} : mention de ngrok");
        assert!(!html.contains("app-titlebar.js") && !html.contains("← Retour"), "{path} : ancienne structure");
    }
    // Retour d'autorisation (ouvert dans le navigateur) : sans navigation.
    let callback = send(&state, "GET", "/auth-callback", None).await.text();
    assert!(callback.contains("class=\"standalone\"") && !callback.contains("sidebar"));
    // Tableau de bord : URLs des sources OBS prêtes à copier.
    let home = send(&state, "GET", "/app", None).await.text();
    assert!(home.contains("data-copy=\"http://localhost:8080/starting.html\""));
    assert!(home.contains("href=\"/css/accent.css\""));

    // La couleur de l'app suit la couleur principale des overlays du profil actif.
    let id = state.store().active_profile_id().unwrap().to_string();
    send(&state, "PATCH", &format!("/api/profiles/{id}/theme/index"), Some(json!({ "primary": "#10b981" }))).await;
    let accent = send(&state, "GET", "/css/accent.css", None).await;
    assert_eq!(accent.headers["cache-control"], "no-store");
    assert!(accent.text().contains("--accent: #10b981; --accent-rgb: 16, 185, 129;"));

    // Idem en activant un thème prêt à l'emploi.
    send(&state, "POST", "/api/profiles/seed-theme-presets", None).await;
    let profiles = state.store().list_profiles().unwrap();
    let id = profiles.iter().find(|p| p["name"] == "Rouge Braise").unwrap()["id"].as_str().unwrap().to_string();
    send(&state, "POST", &format!("/api/profiles/{id}/activate"), None).await;
    let accent = send(&state, "GET", "/css/accent.css", None).await.text();
    assert!(accent.contains("--accent: #ef4444;"), "{accent}");
}

#[tokio::test]
async fn historique_des_alertes_et_rejouer() {
    let (state, _dir) = new_state();
    let mut rx = state.subscribe();

    send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "raid" }))).await;
    send(&state, "POST", "/api/tests/trigger", Some(json!({ "action": "chat" }))).await;
    electrum_server::events::route_event(&state, "channel.subscription.message", &json!({ "user_name": "Bob", "tier": "1000", "cumulative_months": 3 }));
    while rx.try_recv().is_ok() {}

    // Le message de chat n'est pas une alerte ; le resub est diffusé comme un sub.
    let events = send(&state, "GET", "/api/events/history", None).await.json()["events"].clone();
    assert_eq!(events.as_array().unwrap().len(), 2);
    assert_eq!((events[0]["type"].as_str(), events[0]["detail"].as_str(), events[0]["test"].as_bool()), (Some("channel.subscribe"), Some("Resub 3 mois"), Some(false)));
    assert_eq!((events[1]["user"].as_str(), events[1]["test"].as_bool()), (Some("TestRaider"), Some(true)));

    // Rejouer rediffuse exactement le même événement, sans recompter les stats.
    let subs = state.stats().subscribers;
    let id = events[0]["id"].as_u64().unwrap();
    assert_eq!(send(&state, "POST", &format!("/api/events/{id}/replay"), None).await.status, StatusCode::OK);
    let replayed = next_event(&mut rx);
    assert_eq!(replayed["type"], "channel.subscribe");
    assert_eq!(replayed["data"]["cumulative_months"], 3);
    assert_eq!(state.stats().subscribers, subs);
    assert_eq!(send(&state, "GET", "/api/events/history", None).await.json()["events"].as_array().unwrap().len(), 2);

    assert_eq!(send(&state, "POST", "/api/events/999/replay", None).await.status, StatusCode::NOT_FOUND);
    send(&state, "DELETE", "/api/events/history", None).await;
    assert!(send(&state, "GET", "/api/events/history", None).await.json()["events"].as_array().unwrap().is_empty());
}
