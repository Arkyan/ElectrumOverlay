//! Widgets personnalisés : installation, liste, suppression, fichiers servis aux overlays, et
//! contexte lu par la bibliothèque `public/js/electrum-widget.js`.

use super::profiles::{read_upload, UploadRules};
use super::{ok, ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

const MB: usize = 1024 * 1024;
const WIDGET_RULES: UploadRules = UploadRules { max: 30 * MB, max_label: "30 Mo", mime: None, missing: "Fichier de widget manquant" };

const EXAMPLE_MANIFEST: &str = include_str!("../../widget-example/widget.json");
const EXAMPLE_PAGE: &str = include_str!("../../widget-example/widget.html");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/widgets", get(list))
        .route("/api/widgets/import", post(import).layer(DefaultBodyLimit::max(31 * MB)))
        .route("/api/widgets/example.zip", get(example))
        .route("/api/widgets/{id}", axum::routing::delete(remove))
        .route("/api/widget-context", get(context))
        .route("/widgets/{id}/", get(entry))
        .route("/widgets/{id}/{*path}", get(file))
}

async fn list(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "widgets": state.store().list_widgets() }))
}

async fn import(State(state): State<AppState>, multipart: Multipart) -> ApiResult {
    let upload = read_upload(multipart, &WIDGET_RULES).await?;
    let manifest = state
        .store()
        .install_widget(&upload.bytes)
        .map_err(|e| ApiError::bad_request(format!("Widget invalide : {e}")))?;
    state.log("info", format!("🧩 Widget installé : {} ({})", manifest["name"].as_str().unwrap_or_default(), manifest["version"].as_str().unwrap_or_default()));
    // Les overlays rechargent leurs éléments (un widget mis à jour s'affiche tout de suite).
    state.broadcast_config();
    Ok(Json(json!({ "ok": true, "widget": manifest })))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    state.store().remove_widget(&id)?;
    state.log("info", format!("🧩 Widget supprimé : {id}"));
    ok()
}

/// Widget d'exemple à télécharger (point de départ documenté).
async fn example() -> Response {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let mut add = |name: &str, content: &str| -> zip::result::ZipResult<()> {
        zip.start_file(format!("exemple-dernier-follow/{name}"), options)?;
        zip.write_all(content.as_bytes())?;
        Ok(())
    };
    if add("widget.json", EXAMPLE_MANIFEST).and_then(|_| add("widget.html", EXAMPLE_PAGE)).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let Ok(cursor) = zip.finish() else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    (
        [
            (header::CONTENT_TYPE, "application/zip"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"exemple-dernier-follow.zip\""),
        ],
        cursor.into_inner(),
    )
        .into_response()
}

/// Contexte d'un widget : couleurs du thème de la page, langue, ports, chaîne, profil actif.
async fn context(State(state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    let page = params.get("page").map(String::as_str).unwrap_or("index");
    let store = state.store();
    let frontend = store.to_frontend_config();
    let themes = frontend["themes"].clone();
    let theme = themes.get(page).or_else(|| themes.get("index")).cloned().unwrap_or_else(|| json!({}));
    let config = store.config();
    let profile = store.active_profile_id().and_then(|id| {
        store.list_profiles().ok()?.into_iter().find(|p| p["id"] == id).map(|p| json!({ "id": p["id"], "name": p["name"] }))
    });
    Json(json!({
        "page": page,
        "theme": theme,
        "themes": themes,
        "language": crate::i18n::language_of(config),
        "channel": { "login": config["twitch"]["BROADCASTER_LOGIN"], "id": config["twitch"]["BROADCASTER_ID"] },
        "profile": profile,
        "server": { "port": config["server"]["PORT"], "wsPort": config["server"]["WS_PORT"] },
    }))
}

/// Type MIME d'un fichier de widget selon son extension.
fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn serve(state: &AppState, id: &str, path: &str) -> Response {
    let file = state.store().widget_file(id, path);
    let Some(file) = file else {
        return (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "Widget introuvable").into_response();
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime_for(&file))], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Page d'entrée du widget (`/widgets/<id>/`) : les chemins relatifs du widget partent d'ici.
async fn entry(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let manifest = state.store().widget_manifest(&id);
    let Some(manifest) = manifest else {
        return (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], "Widget introuvable").into_response();
    };
    serve(&state, &id, manifest["entry"].as_str().unwrap_or("widget.html")).await
}

async fn file(State(state): State<AppState>, Path((id, path)): Path<(String, String)>) -> Response {
    serve(&state, &id, &path).await
}

/// Champs à ajouter à un nouvel élément `widget` (nom, réglages par défaut, taille conseillée).
pub fn new_element_args(state: &AppState, widget_id: &str) -> Result<serde_json::Map<String, Value>, ApiError> {
    let manifest = state
        .store()
        .widget_manifest(widget_id)
        .ok_or_else(|| ApiError::bad_request("Widget introuvable"))?;
    let mut args = serde_json::Map::new();
    args.insert("widgetId".into(), json!(widget_id));
    args.insert("name".into(), manifest["name"].clone());
    args.insert("settings".into(), electrum_core::widgets::default_settings(&manifest));
    args.insert("width".into(), manifest["size"]["width"].clone());
    args.insert("height".into(), manifest["size"]["height"].clone());
    Ok(args)
}
