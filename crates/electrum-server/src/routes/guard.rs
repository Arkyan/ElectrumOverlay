//! Protection du serveur HTTP, qui n'a pas d'authentification :
//! - depuis un autre appareil du réseau (OBS sur un second PC), seuls les overlays sont
//!   accessibles, en lecture : pas de pages de gestion ni d'API qui modifient quoi que ce soit ;
//! - un site web ouvert dans le navigateur ne peut rien modifier (en-tête `Origin` vérifié, corps
//!   JSON ou fichier exigé), et un
//!   nom de domaine qui pointerait vers 127.0.0.1 (« DNS rebinding ») est refusé (`Host` vérifié).

use axum::extract::{ConnectInfo, Request};
use axum::http::{header, HeaderValue, Method, StatusCode};
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
    if let Some(refused) = check(&request) {
        return refused;
    }
    let path = request.uri().path().to_string();
    let null_origin = request.headers().get(header::ORIGIN).is_some_and(|o| o == "null");
    let mut response = next.run(request).await;
    harden(&mut response, &path, null_origin);
    response
}

/// En-têtes de sécurité ajoutés à toutes les réponses.
fn harden(response: &mut Response, path: &str, null_origin: bool) {
    let headers = response.headers_mut();
    // Type annoncé respecté (un fichier ne peut pas se faire passer pour une page) et pages
    // impossibles à afficher dans le cadre d'un autre site (« clickjacking »).
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    let is_svg = headers.get(header::CONTENT_TYPE).is_some_and(|t| t.as_bytes().starts_with(b"image/svg"));
    let is_widget_file = path.starts_with("/widgets/") && path.len() > "/widgets/".len();
    if is_widget_file {
        // Widget (code tiers) : isolé dans une origine à part. Il lit les données des overlays
        // mais ne peut ni modifier les réglages ni lire les identifiants.
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox allow-scripts"));
    } else if is_svg {
        // Une image SVG ouverte directement ne doit pas pouvoir exécuter de script.
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    }
    // Les widgets isolés (origine `null`) lisent ce que lisent les overlays (données, polices…).
    if null_origin && allowed_from_network(&Method::GET, path) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("null"));
    }
}

fn check(request: &Request) -> Option<Response> {
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
            return Some(forbidden("Accessible uniquement depuis le PC où tourne ElectrumOverlay"));
        }
        return None;
    }

    // En local : seul un nom local est accepté (protège du DNS rebinding).
    if host.as_deref().is_some_and(|h| !is_local_host(h)) {
        return Some(forbidden("Adresse non autorisée : utilise http://localhost"));
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
            return Some(forbidden("Requête refusée : elle ne vient pas d'ElectrumOverlay"));
        }
        // Un corps doit être du JSON (ou un fichier envoyé) : un formulaire ou du texte brut, que
        // n'importe quel site peut envoyer sans autorisation du navigateur, est refusé.
        let has_body = header(header::CONTENT_LENGTH).is_some_and(|len| len.trim() != "0") || headers.contains_key(header::TRANSFER_ENCODING);
        let content_type = header(header::CONTENT_TYPE).unwrap_or_default().to_ascii_lowercase();
        if has_body && !content_type.starts_with("application/json") && !content_type.starts_with("multipart/form-data") {
            return Some(
                (StatusCode::UNSUPPORTED_MEDIA_TYPE, axum::Json(serde_json::json!({ "error": "Format de requête non pris en charge (JSON attendu)" })))
                    .into_response(),
            );
        }
    }
    None
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
