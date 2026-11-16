//! Faux serveur Trucky partagé par `trucky_direct.rs` et `trucky_browser.rs`.

use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use electrum_core::Store;
use electrum_server::{AppState, Assets, External};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct Mock {
    /// Imiter Cloudflare : refuser ce qui ne ressemble pas à une navigation de navigateur.
    pub cloudflare: bool,
    pub refused: AtomicUsize,
}

fn reply(mock: &Mock, headers: &HeaderMap, body: Value) -> Response {
    // Un vrai navigateur envoie toujours sec-fetch-mode ; un client HTTP simple, jamais.
    if mock.cloudflare && !headers.contains_key("sec-fetch-mode") {
        mock.refused.fetch_add(1, Ordering::SeqCst);
        return (StatusCode::FORBIDDEN, Html("<html><title>Just a moment...</title></html>")).into_response();
    }
    Json(body).into_response()
}

async fn user(State(m): State<Arc<Mock>>, h: HeaderMap, UrlPath(id): UrlPath<String>) -> Response {
    reply(&m, &h, json!({ "id": id, "name": "Routier", "company_id": 77 }))
}
async fn jobs(State(m): State<Arc<Mock>>, h: HeaderMap) -> Response {
    reply(&m, &h, json!({ "data": [{ "id": 1, "source_city_name": "Paris", "destination_city_name": "Lyon" }, { "id": 0 }] }))
}
async fn stats(State(m): State<Arc<Mock>>, h: HeaderMap) -> Response {
    reply(&m, &h, json!({ "total_km": 1234 }))
}
async fn company(State(m): State<Arc<Mock>>, h: HeaderMap) -> Response {
    reply(&m, &h, json!({ "name": "Électrum VTC" }))
}

pub async fn start(cloudflare: bool) -> (Arc<Mock>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/api/", listener.local_addr().unwrap());
    let mock = Arc::new(Mock { cloudflare, ..Default::default() });
    let app = Router::new()
        .route("/api/v1/user/{id}", get(user))
        .route("/api/v1/user/{id}/jobs", get(jobs))
        .route("/api/v1/company/{id}/stats/aggregated", get(stats))
        .route("/api/v1/company/{id}", get(company))
        .with_state(mock.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (mock, base)
}

pub fn state(trucky: String, enabled: bool) -> (AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.save_config(&json!({ "trucky": { "enable": enabled, "USER_ID": "42" } })).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let assets = Assets { public_dir: repo.join("public"), templates_dir: repo.join("src").join("templates") };
    (AppState::with_external(store, assets, External { trucky, ..Default::default() }), dir)
}

pub fn expected_panel() -> Value {
    json!({
        "userData": { "id": "42", "name": "Routier", "company_id": 77 },
        "lastJob": { "id": 1, "source_city_name": "Paris", "destination_city_name": "Lyon" },
        "companyStats": { "total_km": 1234 },
        "companyDetails": { "name": "Électrum VTC" }
    })
}
