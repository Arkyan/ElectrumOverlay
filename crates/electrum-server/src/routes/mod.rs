//! Routes HTTP, regroupées comme les fichiers de `src/routes/` côté Node.

pub mod app;
pub mod backups;
pub mod guard;
pub mod integrations;
pub mod overlay;
pub mod pages;
pub mod profiles;
pub mod settings;
pub mod setup;
pub mod testtools;
pub mod twitch;
pub mod welcome;
pub mod widgets;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

/// Erreur d'API : `{ "error": "..." }` avec le code HTTP (400 par défaut, comme les
/// `catch (error) { res.status(400).json({ error: error.message }) }` côté Node).
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError(StatusCode::BAD_REQUEST, message.into())
    }
}

impl From<electrum_core::Error> for ApiError {
    fn from(error: electrum_core::Error) -> Self {
        ApiError::bad_request(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

pub type ApiResult = Result<Json<Value>, ApiError>;

/// `{ "ok": true }`.
pub fn ok() -> ApiResult {
    Ok(Json(json!({ "ok": true })))
}

/// Corps JSON tolérant : absent ou invalide ⇒ `{}` (équivalent de `req.body || {}`).
pub fn body_or_empty(bytes: &[u8]) -> Value {
    serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object).unwrap_or_else(|| json!({}))
}
