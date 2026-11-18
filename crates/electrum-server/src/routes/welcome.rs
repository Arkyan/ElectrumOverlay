//! Premier lancement (`/welcome`) : langue, type de stream, couleurs, animations et logo, avant la
//! connexion à Twitch (/setup). Et le logo personnalisé des overlays (`/logo.png`).

use super::profiles::{read_upload, UploadRules};
use super::{body_or_empty, ok, ApiError, ApiResult};
use crate::pages;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::path::PathBuf;

const LOGO_RULES: UploadRules = UploadRules {
    max: 5 * 1024 * 1024,
    max_label: "5 Mo",
    mime: Some(("image/", "Le logo doit être une image (PNG, JPG, GIF, WebP, SVG)")),
    missing: "Image manquante",
};
const LOGO_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/welcome", get(page))
        .route("/api/welcome", post(apply))
        .route("/api/branding/logo", post(upload_logo).delete(delete_logo).layer(DefaultBodyLimit::max(6 * 1024 * 1024)))
        .route("/logo.png", get(logo))
}

/// Premier lancement déjà fait (ou app déjà configurée avant son ajout).
pub fn onboarded(config: &Value) -> bool {
    config["app"]["onboarded"].as_bool().unwrap_or(false)
}

async fn page(State(state): State<AppState>) -> Html<String> {
    let has_logo = custom_logo(&state).is_some();
    Html(pages::welcome(state.store().config(), has_logo))
}

/// Couleur assombrie (`factor` < 1) pour la couleur secondaire d'un thème personnalisé.
fn shade(hex: &str, factor: f64) -> String {
    let hex = hex.trim_start_matches('#');
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("80"), 16).unwrap_or(128);
    let scale = |c: u8| ((c as f64) * factor).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", scale(channel(0)), scale(channel(2)), scale(channel(4)))
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Applique les choix du premier lancement au profil actif.
async fn apply(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let text = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let language = text("language");
    let stream_type = text("streamType");
    let theme = text("theme");
    let color = text("color");
    let animations = text("animations");
    {
        let mut store = state.store();
        let id = store.active_profile_id().map(str::to_string).ok_or_else(|| ApiError::bad_request("Aucun profil actif"))?;

        // Couleurs : un thème prêt à l'emploi, ou une couleur au choix appliquée à toutes les pages.
        let preset = store.theme_presets().as_array().and_then(|list| list.iter().find(|p| p["name"] == theme.as_str()).cloned());
        if let Some(preset) = preset {
            store.save_profile_display(&id, &json!({ "themes": preset["themes"] }))?;
        } else if valid_color(&color) {
            let page = |c: &str| json!({ "primary": c, "secondary": shade(c, 0.82), "panelBorder": shade(c, 0.82) });
            store.save_profile_display(&id, &json!({ "themes": {
                "starting": page(&color), "index": page(&color), "pause": page(&color), "ending": page(&color)
            } }))?;
        }

        // Animations d'arrière-plan.
        let animation_settings = match animations.as_str() {
            "none" => Some(json!({ "enabled": false })),
            "light" => Some(json!({ "enabled": true, "particles": { "enabled": true, "count": 15 }, "stars": { "enabled": true, "count": 40 },
                "meteors": { "enabled": false }, "circuitLines": { "enabled": false } })),
            "full" => Some(json!({ "enabled": true, "particles": { "enabled": true }, "stars": { "enabled": true }, "meteors": { "enabled": true } })),
            _ => None,
        };
        if let Some(settings) = animation_settings {
            store.save_profile_display(&id, &json!({ "animations": settings }))?;
        }

        // Type de stream.
        match stream_type.as_str() {
            // Discussion : grand chat sur la scène En direct.
            "chatting" => store.update_profile_element_layout(&id, "index", "chatPanel", &json!({ "scale": 140 }))?,
            // Simulation de conduite : panneau Trucky (trajet, statistiques VTC) prêt à l'emploi.
            "driving" => {
                let trucky_id = text("truckyId");
                if !trucky_id.is_empty() {
                    store.save_config(&json!({ "trucky": { "enable": true, "USER_ID": trucky_id } }))?;
                    store.save_profile_display(&id, &json!({ "panels": { "left": { "enabled": true } } }))?;
                }
            }
            _ => {}
        }

        let mut app = json!({ "onboarded": true, "streamType": stream_type });
        if crate::i18n::LANGUAGES.iter().any(|(code, _)| *code == language) {
            app["language"] = json!(language);
        }
        store.save_config(&json!({ "app": app }))?;
    }
    state.broadcast_config();
    let next = if state.store().is_configured() { "/app" } else { "/setup" };
    Ok(Json(json!({ "ok": true, "next": next })))
}

// ---------------------------------------------------------------------------------------------
// Logo des overlays
// ---------------------------------------------------------------------------------------------

fn branding_dir(state: &AppState) -> PathBuf {
    state.store().paths().config_dir.join("branding")
}

/// Logo choisi par l'utilisateur (`<config>/branding/logo.<ext>`), s'il y en a un.
fn custom_logo(state: &AppState) -> Option<PathBuf> {
    let dir = branding_dir(state);
    LOGO_EXTENSIONS.iter().map(|ext| dir.join(format!("logo.{ext}"))).find(|p| p.is_file())
}

/// `/logo.png` : le logo de l'utilisateur, sinon celui de l'app.
async fn logo(State(state): State<AppState>) -> Response {
    let path = custom_logo(&state).unwrap_or_else(|| state.assets.public_dir.join("logo.png"));
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or_default() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upload_logo(State(state): State<AppState>, multipart: Multipart) -> ApiResult {
    let upload = read_upload(multipart, &LOGO_RULES).await?;
    let ext = match upload.mime_type.as_str() {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "png",
    };
    let dir = branding_dir(&state);
    for old in LOGO_EXTENSIONS {
        let _ = std::fs::remove_file(dir.join(format!("logo.{old}")));
    }
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::bad_request(e.to_string()))?;
    std::fs::write(dir.join(format!("logo.{ext}")), &upload.bytes).map_err(|e| ApiError::bad_request(e.to_string()))?;
    state.broadcast_config();
    ok()
}

async fn delete_logo(State(state): State<AppState>) -> ApiResult {
    let dir = branding_dir(&state);
    for ext in LOGO_EXTENSIONS {
        let _ = std::fs::remove_file(dir.join(format!("logo.{ext}")));
    }
    state.broadcast_config();
    ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn couleurs() {
        assert_eq!(shade("#ffffff", 0.5), "#808080");
        assert!(valid_color("#10b981") && !valid_color("vert") && !valid_color("#12345"));
    }
}
