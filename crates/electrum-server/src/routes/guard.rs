//! Protection du serveur HTTP, qui n'a pas d'authentification :
//! - depuis un autre appareil du réseau (OBS sur un second PC), seuls les overlays sont
//!   accessibles, en lecture : pas de pages de gestion ni d'API qui modifient quoi que ce soit ;
//! - un site web ouvert dans le navigateur ne peut rien modifier (en-tête `Origin` vérifié), et un
//!   nom de domaine qui pointerait vers 127.0.0.1 (« DNS rebinding ») est refusé (`Host` vérifié).

use axum::extract::{ConnectInfo, Request};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;

/// Pages de l'app (gestion), interdites depuis le réseau.
const APP_PAGES: [&str; 18] = [
    "/app", "/tests", "/widgets", "/logs", "/scene-editor", "/settings", "/stream-stats-html", "/commands", "/setup",
    "/welcome", "/integrations", "/auth-url", "/auth-callback", "/auth/status", "/auth/callback", "/status",
    "/subscriptions", "/clear-subscriptions",
];

/// API lues par les overlays et les widgets, permises depuis le réseau.
const OVERLAY_APIS: [&str; 7] = [
    "/api/stream-stats", "/api/stream-info", "/api/spotify/now-playing", "/api/info-panel", "/api/widget-context",
    "/api/interactions", "/api/events/history",
];

fn is_local_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        // `[::1]:8080`, `localhost:8080` ; `::1` seul n'a pas de crochets dans un en-tête Host valide.
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(name.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

/// Ce qu'un appareil du réseau peut demander : lire les overlays.
pub fn allowed_from_network(method: &Method, path: &str) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    if path.starts_with("/api/") {
        return OVERLAY_APIS.contains(&path);
    }
    let path = path.trim_end_matches('/');
    !APP_PAGES.contains(&path)
}

fn forbidden(message: &str) -> Response {
    (StatusCode::FORBIDDEN, axum::Json(serde_json::json!({ "error": message }))).into_response()
}

pub async fn protect(request: Request, next: Next) -> Response {
    // Sans adresse (tests, appels internes), la requête est considérée comme locale.
    let local = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_none_or(|ConnectInfo(peer)| peer.ip().is_loopback());
    let headers = request.headers();
    let header = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let host = header(header::HOST);

    if !local {
        if !allowed_from_network(request.method(), request.uri().path()) {
            return forbidden("Accessible uniquement depuis le PC où tourne ElectrumOverlay");
        }
        return next.run(request).await;
    }

    // En local : seul un nom local est accepté (protège du DNS rebinding).
    if host.as_deref().is_some_and(|h| !is_local_host(h)) {
        return forbidden("Adresse non autorisée : utilise http://localhost");
    }
    // Requêtes qui modifient : refusées si elles viennent d'un autre site.
    if !matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        let cross_site = match header(header::ORIGIN) {
            Some(origin) => {
                let origin_host = origin.split_once("://").map(|(_, rest)| rest).unwrap_or(&origin);
                Some(origin_host) != host.as_deref()
            }
            None => header(header::HeaderName::from_static("sec-fetch-site")).is_some_and(|site| site == "cross-site"),
        };
        if cross_site {
            return forbidden("Requête refusée : elle ne vient pas d'ElectrumOverlay");
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reseau() {
        assert!(allowed_from_network(&Method::GET, "/"));
        assert!(allowed_from_network(&Method::GET, "/starting.html"));
        assert!(allowed_from_network(&Method::GET, "/js/config.js"));
        assert!(allowed_from_network(&Method::GET, "/scene/abc"));
        assert!(allowed_from_network(&Method::GET, "/widgets/compteur/"));
        assert!(allowed_from_network(&Method::GET, "/api/info-panel"));
        assert!(!allowed_from_network(&Method::POST, "/api/tests/trigger"));
        assert!(!allowed_from_network(&Method::GET, "/api/profiles"));
        assert!(!allowed_from_network(&Method::GET, "/settings"));
        assert!(!allowed_from_network(&Method::GET, "/widgets/"));
        assert!(!allowed_from_network(&Method::GET, "/clear-subscriptions"));
    }

    #[test]
    fn hotes_locaux() {
        assert!(is_local_host("localhost:8080") && is_local_host("127.0.0.1:8080") && is_local_host("[::1]:8080") && is_local_host("LOCALHOST"));
        assert!(!is_local_host("evil.example:8080") && !is_local_host("192.168.1.10:8080"));
    }
}
