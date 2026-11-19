//! Serveur HTTP + WebSocket d'ElectrumOverlay : port de `server.js`.
//!
//! - HTTP (port `server.PORT`, 8080) : overlays OBS (`public/`), `/js/config.js`, scènes
//!   personnalisées, API des profils / de l'éditeur de scène / des réglages / des tests ;
//! - WebSocket (port `server.WS_PORT`, 8081) : diffusion des événements aux overlays.
//!
//! Indépendant de Tauri : testable seul (`cargo test -p electrum-server`).

pub mod commands;
pub mod events;
pub mod game_profiles;
pub mod history;
pub mod i18n;
pub mod input;
pub mod interactions;
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
use tower_http::set_header::SetResponseHeaderLayer;

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
        .merge(routes::backups::router())
        .merge(routes::app::router())
        .merge(routes::widgets::router())
        .merge(routes::welcome::router())
        .fallback_service(public)
        .layer(axum::middleware::from_fn_with_state(state.clone(), routes::app::translate_responses))
        .layer(axum::middleware::from_fn_with_state(state.clone(), routes::setup::redirect_until_configured))
        // Toujours revérifier auprès du serveur (réponse 304 si rien n'a changé) : sans ça, la
        // fenêtre de l'app et OBS gardaient d'anciens JS/CSS après une mise à jour, et l'éditeur
        // de scène ne connaissait pas les nouveaux types d'éléments.
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-cache"),
        ))
        .layer(axum::middleware::from_fn(routes::guard::protect))
        .with_state(state)
}

/// Serveur démarré : adresses écoutées, et de quoi l'arrêter proprement.
pub struct Running {
    pub http: SocketAddr,
    pub ws: SocketAddr,
    state: AppState,
    shutdown: tokio::sync::watch::Sender<bool>,
    servers: Vec<tokio::task::JoinHandle<()>>,
    background: Vec<tokio::task::JoinHandle<()>>,
}

impl Running {
    /// Arrête le serveur : plus de nouvelles connexions, connexions inactives et overlays
    /// connectés fermés, EventSub et suivis (viewers, Spotify) coupés. Les ports sont libérés à
    /// la fin de l'appel, l'état (config, stats) est conservé pour un redémarrage.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        self.state.close_overlays();
        for task in &self.background {
            task.abort();
        }
        for task in self.servers {
            let abort = task.abort_handle();
            if tokio::time::timeout(std::time::Duration::from_secs(3), task).await.is_err() {
                abort.abort();
            }
        }
        self.state.twitch.set_status(|s| *s = Default::default());
    }
}

/// Ports configurés (`server.PORT` / `server.WS_PORT`, 8080 / 8081 par défaut).
pub fn configured_ports(state: &AppState) -> (u16, u16) {
    let store = state.store();
    let server = &store.config()["server"];
    let port = |key: &str, fallback: u16| server.get(key).and_then(|v| v.as_u64()).and_then(|v| u16::try_from(v).ok()).unwrap_or(fallback);
    (port("PORT", 8080), port("WS_PORT", 8081))
}

/// Ouvre les deux ports puis sert en tâche de fond, et lance la connexion EventSub et les suivis
/// (viewers, Spotify). Renvoie une erreur claire si un port est déjà pris (par exemple par la
/// version Electron encore ouverte).
pub async fn start(state: AppState, http_port: u16, ws_port: u16) -> io::Result<Running> {
    let bind = |port: u16, label: &'static str| async move {
        TcpListener::bind(("0.0.0.0", port)).await.map_err(|error| {
            io::Error::new(error.kind(), format!("port {label} {port} indisponible ({error}) — une autre instance d'ElectrumOverlay est-elle ouverte ?"))
        })
    };
    let http_listener = bind(http_port, "HTTP").await?;
    let ws_listener = bind(ws_port, "WebSocket").await?;
    let (http, ws) = (http_listener.local_addr()?, ws_listener.local_addr()?);

    let (shutdown, _) = tokio::sync::watch::channel(false);
    let signal = |shutdown: &tokio::sync::watch::Sender<bool>| {
        let mut rx = shutdown.subscribe();
        async move {
            let _ = rx.wait_for(|stop| *stop).await;
        }
    };
    let http_app = http_router(state.clone());
    let http_signal = signal(&shutdown);
    let ws_app = ws::router(state.clone());
    let ws_signal = signal(&shutdown);
    let servers = vec![
        tokio::spawn(async move {
            if let Err(error) = axum::serve(http_listener, http_app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(http_signal).await {
                eprintln!("❌ Serveur HTTP arrêté : {error}");
            }
        }),
        tokio::spawn(async move {
            if let Err(error) = axum::serve(ws_listener, ws_app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(ws_signal).await {
                eprintln!("❌ Serveur WebSocket arrêté : {error}");
            }
        }),
    ];
    let background = vec![
        tokio::spawn(twitch::eventsub::run(state.clone(), twitch::eventsub::Options::default())),
        tokio::spawn(twitch::poll_viewer_count(state.clone())),
        tokio::spawn(spotify::poll(state.clone(), std::time::Duration::from_secs(5))),
    ];
    Ok(Running { http, ws, state, shutdown, servers, background })
}
