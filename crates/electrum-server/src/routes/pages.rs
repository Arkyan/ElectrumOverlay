//! Pages de l'app (HTML) et APIs qui les accompagnent : logs, commandes de chat.

use super::{body_or_empty, ok, ApiError, ApiResult};
use crate::pages;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/app", get(app_home))
        .route("/tests", get(|| async { Html(pages::tests()) }))
        .route("/widgets", get(|axum::extract::State(state): axum::extract::State<AppState>| async move { Html(pages::widgets(state.language())) }))
        .route("/logs", get(logs_page))
        .route("/api/logs", get(logs_api))
        .route("/scene-editor", get(scene_editor))
        .route("/settings", get(settings))
        .route("/stream-stats-html", get(stream_stats))
        .route("/commands", get(commands_page))
        .route("/api/commands", post(create_command))
        .route("/api/commands/{id}", put(update_command).delete(delete_command))
        .route("/api/commands/{id}/test", post(test_command))
}

fn page(result: electrum_core::Result<String>) -> Response {
    match result {
        Ok(html) => Html(html).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Html(format!("<p>Erreur : {}</p>", pages::js::esc(&error.to_string())))).into_response(),
    }
}

async fn app_home(State(state): State<AppState>) -> Html<String> {
    let config = state.store().config().clone();
    Html(pages::app_home(&config))
}

async fn logs_page(State(state): State<AppState>) -> Html<String> {
    let ws_port = state.store().config()["server"]["WS_PORT"].clone();
    Html(pages::logs(&ws_port))
}

async fn logs_api(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "lines": state.log_lines() }))
}

async fn scene_editor(State(state): State<AppState>) -> Response {
    page(pages::scene_editor(&state.store()))
}

async fn settings(State(state): State<AppState>, Query(query): Query<HashMap<String, String>>) -> Response {
    page(pages::settings(&state.store(), query.get("profile").map(String::as_str)))
}

async fn stream_stats(State(state): State<AppState>) -> Html<String> {
    let stats = state.stats().to_json();
    Html(pages::stream_stats(&stats))
}

async fn commands_page(State(state): State<AppState>) -> Html<String> {
    let list = state.store().list_commands();
    Html(pages::commands(&list))
}

async fn create_command(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let command = state.store().create_command(&body_or_empty(&body))?;
    Ok(Json(json!({ "ok": true, "command": command })))
}

async fn update_command(State(state): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let command = state.store().update_command(&id, &body_or_empty(&body))?;
    Ok(Json(json!({ "ok": true, "command": command })))
}

async fn delete_command(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    state.store().delete_command(&id)?;
    ok()
}

async fn test_command(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let command = state.store().list_commands().into_iter().find(|c| c.get("id").and_then(Value::as_str) == Some(id.as_str()));
    let command = command.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Commande introuvable".into()))?;
    crate::commands::execute_command(&state, &command, &json!({ "chatter_user_name": "Test" }));
    ok()
}
