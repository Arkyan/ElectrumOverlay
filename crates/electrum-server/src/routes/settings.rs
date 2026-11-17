//! `POST /api/settings` (formulaire de la page /settings) : port de `src/routes/settings.js`.

use super::{body_or_empty, ok, ApiResult};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::State;
use axum::routing::post;
use axum::Router;
use electrum_core::json::{is_truthy, js_number, number_value};
use electrum_core::store::BUILTIN_PAGE_KEYS;
use serde_json::{json, Map, Value};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/settings", post(save))
}

const ALERT_TYPES: [&str; 5] = ["follow", "sub", "subs_gift", "raid", "bits"];
const ANIMATION_STYLE_KEYS: [&str; 4] = ["fade", "slide", "zoom", "bounce"];
const PARTICLE_ANIMATIONS: [&str; 3] = ["particles", "stars", "meteors"];
const THEME_FIELDS: [&str; 9] = ["primary", "secondary", "accent", "background", "surface", "text", "mutedText", "panelBg", "panelBorder"];

/// `Number(value)` si fini, sinon `fallback` (`num()` côté Node).
fn num(body: &Value, key: &str, fallback: f64) -> f64 {
    let n = js_number(body.get(key));
    if n.is_finite() { n } else { fallback }
}

fn numv(body: &Value, key: &str, fallback: f64) -> Value {
    number_value(num(body, key, fallback))
}

fn flag(body: &Value, key: &str) -> Value {
    Value::Bool(is_truthy(body.get(key)))
}

/// Recopie `source[key]` s'il est présent (une clé `undefined` côté JS disparaît du JSON).
fn copy(target: &mut Map<String, Value>, source: &Value, from: &str, to: &str) {
    if let Some(v) = source.get(from) {
        target.insert(to.into(), v.clone());
    }
}

/// Construit le patch de display exactement comme le handler Node.
pub fn settings_patch(body: &Value) -> Value {
    let mut themes = Map::new();
    for page in BUILTIN_PAGE_KEYS {
        let Some(t) = body.get("themes").and_then(|t| t.get(page)).filter(|t| is_truthy(Some(t))) else { continue };
        let mut theme = Map::new();
        for field in THEME_FIELDS {
            copy(&mut theme, t, field, field);
        }
        themes.insert(page.into(), Value::Object(theme));
    }

    let mut alert_types = Map::new();
    for alert in ALERT_TYPES {
        let Some(a) = body.get("alerts").and_then(|a| a.get(alert)).filter(|a| is_truthy(Some(a))) else { continue };
        let mut entry = Map::new();
        for field in ["title", "defaultMessage", "border", "gradientStart", "gradientEnd"] {
            copy(&mut entry, a, field, field);
        }
        let style = a.get("animationStyle").and_then(Value::as_str).filter(|s| ANIMATION_STYLE_KEYS.contains(s)).unwrap_or("fade");
        entry.insert("animationStyle".into(), json!(style));
        alert_types.insert(alert.into(), Value::Object(entry));
    }

    let info_texts = body
        .get("infoTexts")
        .and_then(Value::as_array)
        .map(|items| Value::Array(items.iter().filter(|v| v.is_string()).cloned().collect()));

    let mut animations = Map::new();
    animations.insert("enabled".into(), flag(body, "animationsEnabled"));
    animations.insert(
        "circuitLines".into(),
        json!({
            "enabled": flag(body, "circuitLinesEnabled"),
            "horizontal": numv(body, "circuitLinesHorizontal", 10.0),
            "vertical": numv(body, "circuitLinesVertical", 8.0),
            "duration": numv(body, "circuitLinesDuration", 6.0)
        }),
    );
    animations.insert(
        "dvdLogo".into(),
        json!({
            "enabled": flag(body, "dvdLogoEnabled"),
            "speed": numv(body, "dvdLogoSpeed", 2.0),
            "updateInterval": numv(body, "dvdLogoUpdateInterval", 16.0)
        }),
    );
    for key in PARTICLE_ANIMATIONS {
        animations.insert(
            key.into(),
            json!({
                "enabled": flag(body, &format!("{key}Enabled")),
                "count": numv(body, &format!("{key}Count"), 30.0),
                "duration": [numv(body, &format!("{key}DurationMin"), 5.0), numv(body, &format!("{key}DurationMax"), 8.0)]
            }),
        );
    }

    let mut left = Map::new();
    left.insert("enabled".into(), flag(body, "leftPanelEnabled"));
    left.insert("interval".into(), numv(body, "leftPanelInterval", 300000.0));
    left.insert("duration".into(), numv(body, "leftPanelDuration", 15000.0));
    left.insert("firstDelay".into(), numv(body, "leftPanelFirstDelay", 30000.0));
    copy(&mut left, body, "leftPanelTimerColor", "timerColor");

    let mut content = Map::new();
    if let Some(texts) = info_texts {
        content.insert("infoTexts".into(), texts);
    }
    if let Some(text) = body.get("scrollingText").filter(|v| v.is_string()) {
        content.insert("scrollingText".into(), text.clone());
    }

    let mut chat = Map::new();
    chat.insert(
        "enabled".into(),
        json!({
            "starting": flag(body, "chatEnabledStarting"),
            "index": flag(body, "chatEnabledIndex"),
            "ending": flag(body, "chatEnabledEnding")
        }),
    );
    copy(&mut chat, body, "chatColor", "defaultColor");
    chat.insert("maxMessages".into(), numv(body, "chatMaxMessages", 50.0));

    json!({
        "themes": themes,
        "alerts": {
            "enabled": flag(body, "alertsEnabled"),
            "duration": numv(body, "alertsDuration", 6000.0),
            "queueDelay": numv(body, "alertsQueueDelay", 500.0),
            "confettiEnabled": flag(body, "confettiEnabled"),
            "confettiParticles": numv(body, "confettiParticles", 300.0),
            "confettiSpread": numv(body, "confettiSpread", 360.0),
            "confettiVelocity": numv(body, "confettiVelocity", 50.0),
            "confettiTicks": numv(body, "confettiTicks", 250.0),
            "soundVolume": number_value(num(body, "soundVolume", 80.0) / 100.0),
            "types": alert_types
        },
        "panels": {
            "left": left,
            "bottom": {
                "enabled": flag(body, "bottomBarEnabled"),
                "interval": numv(body, "bottomBarInterval", 180000.0),
                "duration": numv(body, "bottomBarDuration", 20000.0),
                "firstDelay": numv(body, "bottomBarFirstDelay", 10000.0),
                "content": content
            }
        },
        "animations": animations,
        "chat": chat,
        "stats": {
            "animationDuration": numv(body, "statsAnimationDuration", 1000.0),
            "updateInterval": numv(body, "statsUpdateInterval", 30000.0),
            "simulateData": flag(body, "statsSimulateData")
        }
    })
}

async fn save(State(state): State<AppState>, body: Bytes) -> ApiResult {
    let body = body_or_empty(&body);
    // Profil affiché à l'écran au moment de l'enregistrement (repli sur l'actif).
    let profile_id = match body.get("profileId").filter(|v| is_truthy(Some(v))) {
        Some(id) => electrum_core::json::js_string_or_empty(Some(id)),
        None => state.store().active_profile_id().unwrap_or_default().to_string(),
    };
    let patch = settings_patch(&body);
    state.store().save_profile_display(&profile_id, &patch)?;
    state.broadcast_config_if_active(&profile_id);
    ok()
}
