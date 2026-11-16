//! Serveur HTTP + WebSocket d'ElectrumOverlay : port de `server.js`.
//!
//! - HTTP (port `server.PORT`, 8080) : overlays OBS (`public/`), `/js/config.js`, scènes
//!   personnalisées, API des profils / de l'éditeur de scène / des réglages / des tests ;
//! - WebSocket (port `server.WS_PORT`, 8081) : diffusion des événements aux overlays.
//!
//! Indépendant de Tauri : testable seul (`cargo test -p electrum-server`).

pub mod commands;
pub mod events;
pub mod pages;
pub mod routes;
pub mod spotify;
pub mod state;
pub mod stats;
pub mod trucky;
pub mod twitch;
pub mod ws;

pub use state::{AppState, Assets, External};

use axum::Router;
use std::io;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

/// Routeur HTTP complet. Les routes passent avant les fichiers statiques, comme côté Node
/// (`/js/config.js` est généré, pas lu sur disque).
pub fn http_router(state: AppState) -> Router {
    let public = ServeDir::new(&state.assets.public_dir);
    Router::new()
        .merge(routes::overlay::router())
        .merge(routes::pages::router())
        .merge(routes::twitch::router())
        .merge(routes::setup::router())
        .merge(routes::integrations::router())
        .merge(routes::profiles::router())
        .merge(routes::settings::router())
        .merge(routes::testtools::router())
        .fallback_service(public)
        .layer(axum::middleware::from_fn_with_state(state.clone(), routes::setup::redirect_until_configured))
        .with_state(state)
}

/// Adresses effectivement écoutées.
#[derive(Debug, Clone, Copy)]
pub struct Running {
    pub http: SocketAddr,
    pub ws: SocketAddr,
}

/// Ports configurés (`server.PORT` / `server.WS_PORT`, 8080 / 8081 par défaut).
pub fn configured_ports(state: &AppState) -> (u16, u16) {
    let store = state.store();
    let server = &store.config()["server"];
    let port = |key: &str, fallback: u16| server.get(key).and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()).unwrap_or(fallback);
    (port("PORT", 8080), port("WS_PORT", 8081))
}

/// Ouvre les deux ports puis sert en tâche de fond, et lance la connexion EventSub et le suivi
/// du nombre de viewers. Renvoie une erreur claire si un port est
/// déjà pris (par exemple par la version Electron encore ouverte).
pub async fn start(state: AppState, http_port: u16, ws_port: u16) -> io::Result<Running> {
    let bind = |port: u16, label: &'static str| async move {
        TcpListener::bind(("0.0.0.0", port)).await.map_err(|error| {
            io::Error::new(error.kind(), format!("port {label} {port} indisponible ({error}) — une autre instance d'ElectrumOverlay est-elle ouverte ?"))
        })
    };
    let http_listener = bind(http_port, "HTTP").await?;
    let ws_listener = bind(ws_port, "WebSocket").await?;
    let running = Running { http: http_listener.local_addr()?, ws: ws_listener.local_addr()? };

    let http = http_router(state.clone());
    tokio::spawn(async move {
        if let Err(error) = axum::serve(http_listener, http).await {
            eprintln!("❌ Serveur HTTP arrêté : {error}");
        }
    });
    tokio::spawn(twitch::eventsub::run(state.clone(), twitch::eventsub::Options::default()));
    tokio::spawn(twitch::poll_viewer_count(state.clone()));
    tokio::spawn(spotify::poll(state.clone(), std::time::Duration::from_secs(5)));
    let ws_app = ws::router(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(ws_listener, ws_app).await {
            eprintln!("❌ Serveur WebSocket arrêté : {error}");
        }
    });
    Ok(running)
}
