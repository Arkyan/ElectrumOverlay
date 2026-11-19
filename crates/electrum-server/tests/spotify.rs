//! Spotify contre un FAUX serveur Spotify local : connexion du compte (échange du code),
//! renouvellement d'un token expiré, morceau en cours, diffusion seulement quand il change.

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use electrum_core::Store;
use electrum_server::{http_router, spotify, AppState, Assets, External};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;

#[derive(Default)]
struct Mock {
    /// Corps des POST /api/token reçus.
    token_requests: Mutex<Vec<String>>,
    /// Numéro d'appel de currently-playing (le morceau change au 3e).
    plays: AtomicUsize,
}

async fn token(State(mock): State<Arc<Mock>>, headers: HeaderMap, body: String) -> Response {
    // Basic base64("spot-id:spot-secret")
    assert_eq!(headers["authorization"], "Basic c3BvdC1pZDpzcG90LXNlY3JldA==");
    mock.token_requests.lock().unwrap().push(body.clone());
    if body.contains("code=mauvais") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid_grant" }))).into_response();
    }
    let refresh = body.contains("grant_type=authorization_code").then_some("refresh-1");
    Json(json!({ "access_token": format!("access-{}", mock.token_requests.lock().unwrap().len()), "expires_in": 3600, "refresh_token": refresh }))
        .into_response()
}

async fn playing(State(mock): State<Arc<Mock>>, headers: HeaderMap) -> Response {
    assert!(headers["authorization"].to_str().unwrap().starts_with("Bearer access-"));
    let n = mock.plays.fetch_add(1, Ordering::SeqCst);
    let title = if n < 2 { "Titre A" } else { "Titre B" };
    Json(json!({
        "is_playing": true, "progress_ms": 1000,
        "item": { "name": title, "duration_ms": 200000, "artists": [{ "name": "X" }, { "name": "Y" }],
                  "album": { "name": "Album", "images": [{ "url": "https://img/1.jpg" }] } }
    }))
    .into_response()
}

async fn start_mock() -> (Arc<Mock>, spotify::Endpoints) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mock = Arc::new(Mock::default());
    let app = Router::new()
        .route("/api/token", post(token))
        .route("/v1/me/player/currently-playing", get(playing))
        .with_state(mock.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (mock, spotify::Endpoints { accounts: base.clone(), api: format!("{base}/v1") })
}

fn new_state(endpoints: spotify::Endpoints) -> (AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store
        .save_config(&json!({ "twitch": { "CLIENT_ID": "t", "CLIENT_SECRET": "s", "BROADCASTER_ID": "1", "USER_ACCESS_TOKEN": "t" } }))
        .unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let assets = Assets { public_dir: repo.join("public"), templates_dir: repo.join("src").join("templates") };
    (AppState::with_external(store, assets, External { spotify: endpoints, ..Default::default() }), dir)
}

async fn get_page(state: &AppState, uri: &str) -> (StatusCode, String, Option<String>) {
    let response = http_router(state.clone()).oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let location = response.headers().get("location").map(|l| l.to_str().unwrap().to_string());
    let body = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    (status, body, location)
}

async fn post_json(state: &AppState, uri: &str, body: Value) -> Value {
    let request = Request::post(uri).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
    let response = http_router(state.clone()).oneshot(request).await.unwrap();
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn connexion_renouvellement_et_morceau_en_cours() {
    let (mock, endpoints) = start_mock().await;
    let (state, _dir) = new_state(endpoints);

    // Pas encore configuré.
    assert!(get_page(&state, "/integrations").await.1.contains("Renseigne d'abord le Client ID"));
    assert_eq!(post_json(&state, "/api/spotify/credentials", json!({ "clientId": "x" })).await["error"], "Client ID et Client Secret requis");

    let saved = post_json(&state, "/api/spotify/credentials", json!({ "clientId": " spot-id ", "clientSecret": "spot-secret" })).await;
    assert_eq!(saved["redirectUri"], "http://127.0.0.1:8080/api/spotify/callback");
    let page = get_page(&state, "/integrations").await.1;
    assert!(page.contains("/authorize?response_type=code&amp;client_id=spot-id&amp;redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2Fapi%2Fspotify%2Fcallback&amp;scope=user-read-currently-playing+user-read-playback-state&amp;show_dialog=true&amp;state="));

    // Retours d'autorisation en erreur.
    let refused = get_page(&state, "/api/spotify/callback?error=access_denied").await.2.unwrap();
    assert_eq!(refused, "/integrations?error=Autorisation%20refus%C3%A9e%20sur%20Spotify.");
    // Retour d'autorisation sans le `state` de l'app (lien piégé) : refusé, rien n'est échangé.
    let forged = get_page(&state, "/api/spotify/callback?code=bon").await.2.unwrap();
    assert!(forged.starts_with("/integrations?error=Autorisation%20d"), "{forged}");
    let with_state = |code: &str| format!("/api/spotify/callback?code={code}&state={}", state.oauth_state);
    let failed = get_page(&state, &with_state("mauvais")).await.2.unwrap();
    assert_eq!(failed, "/integrations?error=%C3%89chec%20de%20la%20connexion%20%C3%A0%20Spotify.");

    // Connexion réussie : tokens enregistrés.
    assert_eq!(get_page(&state, &with_state("bon")).await.2.unwrap(), "/integrations?connected=1");
    assert!(mock.token_requests.lock().unwrap()[1].contains("grant_type=authorization_code&code=bon&redirect_uri=http%3A%2F%2F127.0.0.1"));
    assert_eq!(state.store().config()["spotify"]["REFRESH_TOKEN"], "refresh-1");
    assert!(get_page(&state, "/integrations?connected=1").await.1.contains("Compte Spotify connecté."));
    assert!(get_page(&state, "/integrations").await.1.contains("id=\"btnDisconnect\""));

    // Token expiré : renouvelé avant l'appel, sans perdre le refresh token.
    state.store().save_config(&json!({ "spotify": { "EXPIRES_AT": 0 } })).unwrap();
    let track = spotify::currently_playing(&state).await.unwrap().unwrap();
    assert!(mock.token_requests.lock().unwrap()[2].starts_with("grant_type=refresh_token&refresh_token=refresh-1"));
    assert_eq!(state.store().config()["spotify"]["REFRESH_TOKEN"], "refresh-1");
    assert_eq!(track, json!({ "isPlaying": true, "title": "Titre A", "artist": "X, Y", "album": "Album",
                              "albumArt": "https://img/1.jpg", "progressMs": 1000, "durationMs": 200000 }));

    // Polling : diffusion au premier morceau et au changement, pas entre les deux.
    let mut overlay = state.subscribe();
    tokio::spawn(spotify::poll(state.clone(), Duration::from_millis(50)));
    tokio::time::sleep(Duration::from_millis(400)).await;
    let titles: Vec<String> = std::iter::from_fn(|| overlay.try_recv().ok())
        .map(|e| serde_json::from_str::<Value>(&e).unwrap())
        .filter(|e| e["type"] == "spotify-track-updated")
        .map(|e| e["track"]["title"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(titles, ["Titre A", "Titre B"]);
    assert!(get_page(&state, "/api/spotify/now-playing").await.1.contains("Titre B"));

    // Déconnexion.
    post_json(&state, "/api/spotify/disconnect", json!({})).await;
    assert!(!spotify::is_connected(&state));
    assert_eq!(serde_json::from_str::<Value>(&get_page(&state, "/api/spotify/now-playing").await.1).unwrap(), json!({ "connected": false, "track": null }));
}
