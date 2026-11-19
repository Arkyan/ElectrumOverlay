//! Profils, sons/médias, éditeur de scène, export/import : port de `src/routes/profiles.js`.
//! Les validations et bornes sont recopiées à l'identique : la config stockée doit rester saine
//! quoi que le client envoie.

use super::{body_or_empty, ok, ApiError, ApiResult};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use electrum_core::assets::{AssetKind, AssetUpload, ShareOptions};
use electrum_core::json::{is_truthy, number_value, to_js_pretty_string};
use electrum_core::scene::{SCENE_ICON_KEYS, STAT_SOURCES};
use electrum_core::Store;
use serde_json::{json, Map, Value};

const MB: usize = 1024 * 1024;
const AUDIO_MAX: usize = 5 * MB;
const MEDIA_MAX: usize = 10 * MB;
/// Un profil partagé embarque ses sons et vidéos en base64 (+33 %) : jusqu'à ~100 Mo pour un
/// profil complet (la version Node limitait à 20 Mo).
const IMPORT_MAX: usize = 150 * MB;

pub fn router() -> Router<AppState> {
    // Marge au-dessus de la taille de fichier pour l'enveloppe multipart : c'est la limite du
    // fichier lui-même qui produit le message « Fichier trop volumineux ».
    let upload_limit = |max: usize| DefaultBodyLimit::max(max + MB);
    Router::new()
        .route("/api/profiles", get(list).post(create))
        .route("/api/profiles/seed-theme-presets", post(seed_theme_presets))
        .route("/api/profiles/import", post(import).layer(upload_limit(IMPORT_MAX)))
        .route("/api/profiles/import-preview", post(import_preview).layer(upload_limit(IMPORT_MAX)))
        .route("/api/profiles/{id}", put(rename).delete(remove))
        .route("/api/profiles/{id}/activate", post(activate))
        .route(
            "/api/profiles/{id}/audio/{alert_type}",
            get(get_audio).post(upload_audio).delete(delete_audio).layer(upload_limit(AUDIO_MAX)),
        )
        .route(
            "/api/profiles/{id}/media/{alert_type}",
            get(get_media).post(upload_media).delete(delete_media).layer(upload_limit(MEDIA_MAX)),
        )
        .route("/api/profiles/{id}/layout/{page}/{element_id}", post(update_layout).delete(reset_layout))
        .route("/api/profiles/{id}/text/{page}/{text_id}", post(set_text).delete(reset_text))
        .route("/api/profiles/{id}/text-style/{page}/{text_id}", post(set_text_style))
        .route("/api/profiles/{id}/custom-text/{page}", post(add_custom_text))
        .route(
            "/api/profiles/{id}/custom-text/{page}/{element_id}",
            patch(update_custom_text).delete(remove_custom_text),
        )
        .route("/api/profiles/{id}/scenes", post(add_scene))
        .route("/api/profiles/{id}/scenes/{scene_id}", patch(update_scene).delete(remove_scene))
        .route("/api/profiles/{id}/theme/{page}", patch(update_theme))
        .route("/api/profiles/{id}/pause-messages", patch(update_pause_messages))
        .route("/api/profiles/{id}/export", get(export))
        .route("/api/profiles/{id}/share-info", get(share_info))
        .route("/api/profiles/{id}/share", get(share))
}

/// Exécute une modification du profil `id`, puis diffuse `config-updated` si c'est l'actif.
fn modify<T>(state: &AppState, id: &str, change: impl FnOnce(&mut Store) -> electrum_core::Result<T>) -> Result<T, ApiError> {
    let result = change(&mut state.store())?;
    state.broadcast_config_if_active(id);
    Ok(result)
}

// ---------------------------------------------------------------------------------------------
// Profils
// ---------------------------------------------------------------------------------------------

async fn list(State(state): State<AppState>) -> ApiResult {
    let store = state.store();
    Ok(Json(json!({ "activeId": store.active_profile_id(), "profiles": store.list_profiles()? })))
}

async fn create(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let based_on = body.get("basedOn").and_then(Value::as_str);
    let profile = state.store().create_profile(body.get("name"), based_on)?;
    Ok(Json(json!({ "ok": true, "profile": profile })))
}

async fn seed_theme_presets(State(state): State<AppState>) -> ApiResult {
    let created = state.store().ensure_theme_preset_profiles()?;
    Ok(Json(json!({ "ok": true, "created": created })))
}

async fn activate(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    state.store().set_active_profile(&id)?;
    state.broadcast_config();
    ok()
}

async fn rename(State(state): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let profile = state.store().rename_profile(&id, body.get("name"))?;
    Ok(Json(json!({ "ok": true, "profile": profile })))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    state.store().delete_profile(&id)?;
    ok()
}

// ---------------------------------------------------------------------------------------------
// Sons et médias
// ---------------------------------------------------------------------------------------------

pub(crate) struct UploadRules {
    pub(crate) max: usize,
    pub(crate) max_label: &'static str,
    /// Préfixe MIME exigé + message d'erreur sinon (`None` = tout type accepté).
    pub(crate) mime: Option<(&'static str, &'static str)>,
    pub(crate) missing: &'static str,
}

pub(crate) struct Upload {
    pub(crate) filename: String,
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
}

/// Lit le champ `file` d'un formulaire multipart (équivalent de `multer.single('file')`).
pub(crate) async fn read_upload(mut multipart: Multipart, rules: &UploadRules) -> Result<Upload, ApiError> {
    let too_big = || ApiError::bad_request(format!("Fichier trop volumineux (max {})", rules.max_label));
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => return Err(ApiError::bad_request(rules.missing)),
            Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => return Err(too_big()),
            Err(error) => return Err(ApiError::bad_request(error.body_text())),
        };
        if field.name() != Some("file") || field.file_name().is_none() {
            continue;
        }
        let filename = field.file_name().unwrap_or_default().to_string();
        let mime_type = field.content_type().unwrap_or("application/octet-stream").to_string();
        if let Some((prefix, message)) = rules.mime {
            if !mime_type.starts_with(prefix) {
                return Err(ApiError::bad_request(message));
            }
        }
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(error) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => return Err(too_big()),
            Err(error) => return Err(ApiError::bad_request(error.body_text())),
        };
        if bytes.len() > rules.max {
            return Err(too_big());
        }
        return Ok(Upload { filename, mime_type, bytes: bytes.to_vec() });
    }
}

const AUDIO_RULES: UploadRules = UploadRules {
    max: AUDIO_MAX,
    max_label: "5 Mo",
    mime: Some(("audio/", "Le fichier doit être un son (audio/*)")),
    missing: "Fichier audio manquant",
};

const MEDIA_RULES: UploadRules = UploadRules {
    max: MEDIA_MAX,
    max_label: "10 Mo",
    mime: Some(("image/", "Le fichier doit être une image ou un GIF (image/*)")),
    missing: "Fichier image/GIF manquant",
};

const IMPORT_RULES: UploadRules = UploadRules {
    max: IMPORT_MAX,
    max_label: "150 Mo",
    mime: None,
    missing: "Fichier de profil manquant",
};

async fn upload_asset(state: AppState, kind: AssetKind, id: String, alert_type: String, multipart: Multipart) -> ApiResult {
    let rules = if kind == AssetKind::Audio { &AUDIO_RULES } else { &MEDIA_RULES };
    let upload = read_upload(multipart, rules).await?;
    modify(&state, &id, |store| {
        store.set_profile_asset(kind, &id, &alert_type, AssetUpload {
            filename: &upload.filename,
            mime_type: &upload.mime_type,
            bytes: &upload.bytes,
        })
    })?;
    ok()
}

async fn serve_asset(state: AppState, kind: AssetKind, id: String, alert_type: String) -> Response {
    let file = state.store().profile_asset_file(kind, &id, &alert_type);
    let Some(file) = file else { return StatusCode::NOT_FOUND.into_response() };
    match tokio::fs::read(&file.path).await {
        Ok(bytes) => {
            // Seulement des sons, images ou vidéos : un « média » HTML venu d'un profil partagé ne
            // doit jamais être servi comme une page (il s'exécuterait avec les droits de l'app).
            let playable = ["audio/", "video/", "image/png", "image/jpeg", "image/gif", "image/webp"]
                .iter()
                .any(|prefix| file.mime_type.starts_with(prefix));
            let mime = if playable { file.mime_type } else { "application/octet-stream".to_string() };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upload_audio(State(state): State<AppState>, Path((id, alert_type)): Path<(String, String)>, multipart: Multipart) -> ApiResult {
    upload_asset(state, AssetKind::Audio, id, alert_type, multipart).await
}

async fn upload_media(State(state): State<AppState>, Path((id, alert_type)): Path<(String, String)>, multipart: Multipart) -> ApiResult {
    upload_asset(state, AssetKind::Media, id, alert_type, multipart).await
}

async fn get_audio(State(state): State<AppState>, Path((id, alert_type)): Path<(String, String)>) -> Response {
    serve_asset(state, AssetKind::Audio, id, alert_type).await
}

async fn get_media(State(state): State<AppState>, Path((id, alert_type)): Path<(String, String)>) -> Response {
    serve_asset(state, AssetKind::Media, id, alert_type).await
}

async fn delete_audio(State(state): State<AppState>, Path((id, alert_type)): Path<(String, String)>) -> ApiResult {
    modify(&state, &id, |store| store.delete_profile_asset(AssetKind::Audio, &id, &alert_type))?;
    ok()
}

async fn delete_media(State(state): State<AppState>, Path((id, alert_type)): Path<(String, String)>) -> ApiResult {
    modify(&state, &id, |store| store.delete_profile_asset(AssetKind::Media, &id, &alert_type))?;
    ok()
}

// ---------------------------------------------------------------------------------------------
// Éditeur de scène
// ---------------------------------------------------------------------------------------------

/// Bornes des positions (% d'écran) : de quoi sortir un élément par n'importe quel bord.
fn clamp_percent(v: f64) -> f64 {
    v.clamp(-100.0, 200.0)
}

fn number(body: &Value, key: &str) -> Option<f64> {
    body.get(key).and_then(Value::as_f64)
}

fn boolean(body: &Value, key: &str) -> Option<bool> {
    body.get(key).and_then(Value::as_bool)
}

fn string(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(Value::as_str).map(str::to_string)
}

const ELEMENT_STYLE_COLOR_KEYS: [&str; 5] = ["primary", "secondary", "text", "panelBg", "panelBorder"];

async fn update_layout(
    State(state): State<AppState>,
    Path((id, page, element_id)): Path<(String, String, String)>,
    body: Bytes,
) -> ApiResult {
    let body = body_or_empty(&body);
    let mut p = Map::new();
    if let Some(v) = number(&body, "top") {
        p.insert("top".into(), number_value(clamp_percent(v)));
    }
    if let Some(v) = number(&body, "left") {
        p.insert("left".into(), number_value(clamp_percent(v)));
    }
    if let Some(v) = boolean(&body, "hidden") {
        p.insert("hidden".into(), json!(v));
    }
    if let Some(v) = boolean(&body, "removed") {
        p.insert("removed".into(), json!(v));
    }
    for key in ["width", "height"] {
        if let Some(v) = number(&body, key).filter(|v| *v > 0.0) {
            p.insert(key.into(), number_value(v));
        }
    }
    if let Some(v) = number(&body, "scale") {
        p.insert("scale".into(), number_value(v.clamp(25.0, 400.0)));
    }
    if let Some(v) = number(&body, "opacity") {
        p.insert("opacity".into(), number_value(v.clamp(0.0, 100.0)));
    }
    if let Some(v) = number(&body, "z") {
        p.insert("z".into(), number_value(js_round(v.clamp(-999.0, 9999.0))));
    }
    for key in ELEMENT_STYLE_COLOR_KEYS {
        if let Some(v) = string(&body, key) {
            p.insert(key.into(), json!(v));
        }
    }
    let patch = Value::Object(p);
    modify(&state, &id, |store| store.update_profile_element_layout(&id, &page, &element_id, &patch))?;
    ok()
}

/// `Math.round` (arrondi vers +∞ pour les .5, contrairement à `f64::round`).
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

async fn reset_layout(State(state): State<AppState>, Path((id, page, element_id)): Path<(String, String, String)>) -> ApiResult {
    modify(&state, &id, |store| store.reset_profile_element_layout(&id, &page, &element_id))?;
    ok()
}

async fn set_text(State(state): State<AppState>, Path((id, page, text_id)): Path<(String, String, String)>, body: Bytes) -> ApiResult {
    let value = string(&body_or_empty(&body), "value").unwrap_or_default();
    modify(&state, &id, |store| store.set_profile_text(&id, &page, &text_id, &value))?;
    ok()
}

/// Remet contenu ET style d'origine (un seul bouton ↺ dans l'éditeur).
async fn reset_text(State(state): State<AppState>, Path((id, page, text_id)): Path<(String, String, String)>) -> ApiResult {
    modify(&state, &id, |store| {
        store.reset_profile_text(&id, &page, &text_id)?;
        store.reset_profile_text_style(&id, &page, &text_id)
    })?;
    ok()
}

/// `size: 0` / `font: ""` effacent le réglage (valeur `null` = `undefined` côté JS).
async fn set_text_style(State(state): State<AppState>, Path((id, page, text_id)): Path<(String, String, String)>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let mut p = Map::new();
    if let Some(size) = number(&body, "size") {
        p.insert("size".into(), if size > 0.0 { number_value(size.min(30.0)) } else { Value::Null });
    }
    if let Some(font) = string(&body, "font") {
        p.insert("font".into(), if font == "baron" || font == "inter" { json!(font) } else { Value::Null });
    }
    let patch = Value::Object(p);
    modify(&state, &id, |store| store.set_profile_text_style(&id, &page, &text_id, &patch))?;
    ok()
}

async fn add_custom_text(State(state): State<AppState>, Path((id, page)): Path<(String, String)>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let mut args = Map::new();
    for key in ["type", "text", "url", "color", "top", "left"] {
        if let Some(v) = body.get(key) {
            args.insert(key.into(), v.clone());
        }
    }
    // Widget personnalisé : nom, réglages par défaut et taille conseillée lus dans son widget.json.
    if body.get("type").and_then(Value::as_str) == Some("widget") {
        let widget_id = body.get("widgetId").and_then(Value::as_str).unwrap_or_default();
        args.extend(super::widgets::new_element_args(&state, widget_id)?);
    }
    let element_id = modify(&state, &id, |store| store.add_profile_custom_text(&id, &page, &Value::Object(args)))?;
    Ok(Json(json!({ "ok": true, "elementId": element_id })))
}

/// Liste blanche + bornes des propriétés d'un élément (`sanitizeCustomTextPatch`).
pub fn sanitize_custom_text_patch(body: &Value) -> Value {
    let mut p = Map::new();
    let mut put = |key: &str, value: Value| {
        p.insert(key.into(), value);
    };
    for key in ["text", "url", "color"] {
        if let Some(v) = string(body, key) {
            put(key, json!(v));
        }
    }
    if let Some(v) = number(body, "top") {
        put("top", number_value(clamp_percent(v)));
    }
    if let Some(v) = number(body, "left") {
        put("left", number_value(clamp_percent(v)));
    }
    for key in ["width", "height"] {
        if let Some(v) = number(body, key).filter(|v| *v > 0.0) {
            put(key, number_value(v));
        }
    }
    if let Some(v) = number(body, "size").filter(|v| *v > 0.0) {
        put("size", number_value(v.min(30.0)));
    }
    if let Some(font) = string(body, "font").filter(|f| f == "baron" || f == "inter") {
        put("font", json!(font));
    }
    if let Some(v) = boolean(body, "glow") {
        put("glow", json!(v));
    }
    if let Some(v) = number(body, "opacity") {
        put("opacity", number_value(v.clamp(0.0, 100.0)));
    }
    // Réglages d'un widget personnalisé : objet plat de valeurs simples (texte, nombre, booléen).
    if let Some(Value::Object(settings)) = body.get("settings") {
        let clean: Map<String, Value> = settings
            .iter()
            .take(60)
            .filter(|(key, _)| key.len() <= 40)
            .filter_map(|(key, value)| match value {
                Value::String(s) => Some((key.clone(), json!(s.chars().take(5000).collect::<String>()))),
                Value::Number(_) | Value::Bool(_) => Some((key.clone(), value.clone())),
                _ => None,
            })
            .collect();
        put("settings", Value::Object(clean));
    }
    if let Some(v) = number(body, "radius") {
        put("radius", number_value(v.clamp(0.0, 200.0)));
    }
    if let Some(v) = number(body, "scale") {
        put("scale", number_value(v.clamp(25.0, 400.0)));
    }
    if let Some(v) = number(body, "textScale") {
        put("textScale", number_value(v.clamp(25.0, 400.0)));
    }
    if let Some(v) = number(body, "speed") {
        put("speed", number_value(v.clamp(10.0, 400.0)));
    }
    if let Some(layout) = string(body, "layout").filter(|l| l == "qwerty" || l == "azerty") {
        put("layout", json!(layout));
    }
    for key in ["showFunctionRow", "showDigitRow", "showMovement", "showModifiers", "showArrows", "showMouse"] {
        if let Some(v) = boolean(body, key) {
            put(key, json!(v));
        }
    }
    if let Some(source) = string(body, "source").filter(|s| STAT_SOURCES.contains(&s.as_str())) {
        put("source", json!(source));
    }
    if let Some(icon) = string(body, "icon").filter(|i| SCENE_ICON_KEYS.contains(&i.as_str())) {
        put("icon", json!(icon));
    }
    if let Some(v) = boolean(body, "pulse") {
        put("pulse", json!(v));
    }
    if let Some(v) = number(body, "interval") {
        put("interval", number_value(v.clamp(1.0, 120.0)));
    }
    for key in ["title1", "title2", "title3"] {
        if let Some(v) = string(body, key) {
            put(key, json!(v));
        }
    }
    for key in ["showTrip", "showStats", "showCompany", "autoShow"] {
        if let Some(v) = boolean(body, key) {
            put(key, json!(v));
        }
    }
    if let Some(v) = string(body, "scrolling") {
        put("scrolling", json!(v));
    }
    Value::Object(p)
}

async fn update_custom_text(
    State(state): State<AppState>,
    Path((id, page, element_id)): Path<(String, String, String)>,
    body: Bytes,
) -> ApiResult {
    let patch = sanitize_custom_text_patch(&body_or_empty(&body));
    modify(&state, &id, |store| store.update_profile_custom_text(&id, &page, &element_id, &patch))?;
    ok()
}

async fn remove_custom_text(State(state): State<AppState>, Path((id, page, element_id)): Path<(String, String, String)>) -> ApiResult {
    modify(&state, &id, |store| store.remove_profile_custom_text(&id, &page, &element_id))?;
    ok()
}

async fn add_scene(State(state): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let scene_id = modify(&state, &id, |store| store.add_profile_scene(&id, body.get("name")))?;
    Ok(Json(json!({ "ok": true, "sceneId": scene_id })))
}

const SCENE_BG_MODES: [&str; 4] = ["theme", "transparent", "color", "gradient"];
const SCENE_EFFECTS: [&str; 5] = ["particles", "stars", "meteors", "circuitLines", "dvdLogo"];

async fn update_scene(State(state): State<AppState>, Path((id, scene_id)): Path<(String, String)>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let mut p = Map::new();
    if let Some(name) = string(&body, "name") {
        p.insert("name".into(), json!(name));
    }
    // `typeof x === 'object'` est vrai pour un tableau aussi : on garde ce comportement.
    if let Some(bg) = body.get("background").filter(|v| v.is_object() || v.is_array()) {
        let mut b = Map::new();
        if let Some(mode) = string(bg, "mode").filter(|m| SCENE_BG_MODES.contains(&m.as_str())) {
            b.insert("mode".into(), json!(mode));
        }
        for key in ["color", "color2"] {
            if let Some(v) = string(bg, key) {
                b.insert(key.into(), json!(v));
            }
        }
        p.insert("background".into(), Value::Object(b));
    }
    if let Some(fx) = body.get("effects").filter(|v| v.is_object() || v.is_array()) {
        let mut e = Map::new();
        for key in SCENE_EFFECTS {
            if let Some(v) = boolean(fx, key) {
                e.insert(key.into(), json!(v));
            }
        }
        p.insert("effects".into(), Value::Object(e));
    }
    let patch = Value::Object(p);
    modify(&state, &id, |store| store.update_profile_scene(&id, &scene_id, &patch))?;
    ok()
}

async fn remove_scene(State(state): State<AppState>, Path((id, scene_id)): Path<(String, String)>) -> ApiResult {
    modify(&state, &id, |store| store.remove_profile_scene(&id, &scene_id))?;
    ok()
}

const THEME_FIELDS: [&str; 9] = ["primary", "secondary", "accent", "background", "surface", "text", "mutedText", "panelBg", "panelBorder"];

async fn update_theme(State(state): State<AppState>, Path((id, page)): Path<(String, String)>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let mut theme = Map::new();
    for key in THEME_FIELDS {
        if let Some(v) = string(&body, key) {
            theme.insert(key.into(), json!(v));
        }
    }
    let mut themes = Map::new();
    themes.insert(page, Value::Object(theme));
    let partial = json!({ "themes": themes });
    modify(&state, &id, |store| store.save_profile_display(&id, &partial))?;
    ok()
}

/// Chaque tableau remplace entièrement le précédent (vide = messages par défaut côté overlay).
async fn update_pause_messages(State(state): State<AppState>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    let clean = |key: &str| -> Option<Value> {
        body.get(key).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(Value::from)
                .collect()
        })
    };
    let mut pause = Map::new();
    for key in ["messages", "progressMessages"] {
        if let Some(list) = clean(key) {
            pause.insert(key.into(), list);
        }
    }
    let partial = json!({ "pause": pause });
    modify(&state, &id, |store| store.save_profile_display(&id, &partial))?;
    ok()
}

// ---------------------------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------------------------

async fn export(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let exported = state.store().export_profile(&id);
    match exported {
        Ok(payload) => {
            let name = payload.get("name").map(|n| electrum_core::json::js_string_or_empty(Some(n))).unwrap_or_default();
            let disposition = format!("attachment; filename=\"{}\"", Store::export_filename(&name));
            (
                [(header::CONTENT_TYPE, "application/json; charset=utf-8".to_string()), (header::CONTENT_DISPOSITION, disposition)],
                to_js_pretty_string(&payload),
            )
                .into_response()
        }
        Err(_) => ApiError(StatusCode::NOT_FOUND, "Profil introuvable".into()).into_response(),
    }
}

/// Valeurs proposées dans la fenêtre de partage : nom, auteur (la chaîne Twitch), poids des
/// sons/vidéos.
async fn share_info(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let store = state.store();
    let profile = store.get_profile_full(&id).map_err(|_| ApiError(StatusCode::NOT_FOUND, "Profil introuvable".into()))?;
    let (assets_count, assets_size) = store.profile_assets_summary(&id)?;
    Ok(Json(json!({
        "name": profile.get("name"),
        "author": store.config()["twitch"]["BROADCASTER_LOGIN"].as_str().unwrap_or_default(),
        "assetsCount": assets_count,
        "assetsSize": assets_size,
    })))
}

/// Contenu d'un profil partagé (`Store::share_profile`) à partir des paramètres d'URL `name`,
/// `author`, `description`, `assets` (`0` = sans sons ni vidéos).
pub fn shared_profile(state: &AppState, id: &str, params: &std::collections::HashMap<String, String>) -> Result<(String, Vec<u8>), ApiError> {
    let text = |key: &str| params.get(key).map(String::as_str).unwrap_or_default();
    let options = ShareOptions {
        name: params.get("name").map(String::as_str),
        author: text("author"),
        description: text("description"),
        include_assets: text("assets") != "0",
        app_version: env!("CARGO_PKG_VERSION"),
    };
    let store = state.store();
    let profile = store.get_profile_full(id).map_err(|_| ApiError(StatusCode::NOT_FOUND, "Profil introuvable".into()))?;
    let package = store.share_profile_package(id, &options)?;
    let name = options.name.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string)
        .unwrap_or_else(|| electrum_core::json::js_string_or_empty(profile.get("name")));
    Ok((share_filename(&name), package))
}

/// Nom de fichier d'un profil partagé, accents gardés (`Néon violet.electrumprofile.json`) :
/// seuls les caractères interdits dans un nom de fichier Windows sont remplacés.
pub fn share_filename(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    format!("{}.electrumprofile.zip", if cleaned.is_empty() { "profil" } else { cleaned })
}

/// `Content-Disposition` avec un nom non ASCII (RFC 6266) : repli ASCII + `filename*` encodé.
fn attachment_header(filename: &str) -> String {
    let encoded: String = filename
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("attachment; filename=\"{}\"; filename*=UTF-8''{encoded}", Store::export_filename(filename.trim_end_matches(".electrumprofile.zip")).replace(".electrumprofile.json", ".electrumprofile.zip"))
}

async fn share(State(state): State<AppState>, Path(id): Path<String>, Query(params): Query<std::collections::HashMap<String, String>>) -> Response {
    match shared_profile(&state, &id, &params) {
        Ok((filename, content)) => (
            [
                (header::CONTENT_TYPE, "application/zip".to_string()),
                (header::CONTENT_DISPOSITION, attachment_header(&filename)),
            ],
            content,
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

/// Contenu d'un fichier de profil envoyé (zip ou ancien JSON), au format de l'export.
async fn read_profile_upload(multipart: Multipart) -> Result<(Value, usize, Vec<u8>), ApiError> {
    let upload = read_upload(multipart, &IMPORT_RULES).await?;
    let invalid = |message: String| ApiError::bad_request(format!("Fichier de profil invalide : {message}"));
    let payload = Store::read_profile_package(&upload.bytes).map_err(|e| invalid(e.to_string()))?;
    if !is_truthy(Some(&payload)) || !payload.is_object() {
        return Err(invalid("contenu vide".into()));
    }
    Ok((payload, upload.bytes.len(), upload.bytes))
}

async fn import(State(state): State<AppState>, multipart: Multipart) -> ApiResult {
    let (payload, _, bytes) = read_profile_upload(multipart).await?;
    // Widgets personnalisés embarqués dans le profil : installés avant le profil.
    let widgets = state
        .store()
        .install_package_widgets(&bytes)
        .map_err(|e| ApiError::bad_request(format!("Fichier de profil invalide : {e}")))?;
    if !widgets.is_empty() {
        state.log("info", format!("🧩 {} widget(s) installé(s) avec le profil", widgets.len()));
    }
    let profile = state
        .store()
        .import_profile(&payload)
        .map_err(|e| ApiError::bad_request(format!("Fichier de profil invalide : {e}")))?;
    Ok(Json(json!({ "ok": true, "profile": profile })))
}

/// Aperçu d'un fichier de profil avant import : nom, infos de partage, réglages, nombre et
/// poids des sons/vidéos (sans leur contenu).
async fn import_preview(multipart: Multipart) -> ApiResult {
    let (mut payload, size, bytes) = read_profile_upload(multipart).await?;
    let widgets: Vec<Value> = Store::package_widgets(&bytes).iter().map(|w| json!({ "id": w["id"], "name": w["name"], "version": w["version"] })).collect();
    let mut assets = 0;
    for key in [AssetKind::Audio.key(), AssetKind::Media.key()] {
        if let Some(Value::Object(entries)) = payload.get_mut(key) {
            for entry in entries.values_mut() {
                if let Value::Object(entry) = entry {
                    entry.remove("dataBase64");
                    assets += 1;
                }
            }
        }
    }
    Ok(Json(json!({ "ok": true, "profile": payload, "assets": assets, "size": size, "widgets": widgets })))
}
