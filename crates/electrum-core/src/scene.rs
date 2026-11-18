//! Éditeur de scène : positions, textes, éléments ajoutés et scènes personnalisées.
//! Port des fonctions `*ProfileElementLayout`, `*ProfileText*`, `*ProfileCustomText`,
//! `*ProfileScene` de `src/config/store.js` (voir docs/FORMATS.md §5).
//!
//! Les patchs reçus ici sont supposés déjà validés/bornés par la couche HTTP (comme côté Node,
//! où la validation est dans `src/routes/profiles.js`).

use crate::error::{Error, Result};
use crate::json::{ensure_object, is_plain_object, is_truthy};
use crate::store::{new_uuid, Store, BUILTIN_PAGE_KEYS};
use crate::time::now_iso;
use serde_json::{json, Map, Value};

/// Types d'éléments ajoutables depuis l'éditeur (`type` absent ou inconnu ⇒ `text`).
/// Cartes Twitch (goal, poll, prediction, hypetrain) et widgets personnalisés (`widget`) : propres à
/// la version Rust.
pub const CUSTOM_ELEMENT_TYPES: [&str; 19] = [
    "text", "image", "box", "clock", "chat", "chatTicker", "alerts", "spotify", "keys",
    "statBadge", "badge", "rotatingText", "infoPanel", "bottomBar",
    "goal", "poll", "prediction", "hypetrain", "widget",
];

/// Données live affichables par un `statBadge`.
pub const STAT_SOURCES: [&str; 7] = ["viewers", "followers", "subs", "messages", "duration", "game", "title"];

/// Icônes disponibles pour les widgets de scène.
pub const SCENE_ICON_KEYS: [&str; 22] = [
    "none", "users", "heart", "star", "comments", "clock", "hourglass", "pause", "play",
    "gamepad", "truck", "chart", "bell", "arrow", "coffee", "wrench",
    "twitch", "discord", "youtube", "globe", "instagram", "tiktok",
];

/// Types limités à une instance par page (id DOM unique côté overlay).
pub const SINGLETON_ELEMENT_TYPES: [&str; 2] = ["chat", "alerts"];

/// Accès `profile.display[section][page]`, en créant les objets intermédiaires.
fn page_section<'a>(profile: &'a mut Map<String, Value>, section: &str, page: &str) -> &'a mut Map<String, Value> {
    let display = ensure_object(profile, "display");
    let section = ensure_object(display, section);
    ensure_object(section, page)
}

/// `profile.display[section][page]` s'il existe déjà, sans rien créer.
fn page_section_mut<'a>(
    profile: &'a mut Map<String, Value>,
    section: &str,
    page: &str,
) -> Option<&'a mut Map<String, Value>> {
    profile
        .get_mut("display")?
        .as_object_mut()?
        .get_mut(section)?
        .as_object_mut()?
        .get_mut(page)?
        .as_object_mut()
}

/// `{ ...existing, ...patch }` sur un objet. Une valeur `null` dans le patch **retire** la clé :
/// c'est l'équivalent de la valeur `undefined` côté JS, qui disparaît à la sérialisation.
fn shallow_patch(target: &mut Map<String, Value>, patch: &Value) {
    if let Value::Object(patch) = patch {
        for (key, value) in patch {
            if value.is_null() {
                target.shift_remove(key);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

impl Store {
    // --- layout -------------------------------------------------------------------------------

    /// Position / visibilité / style d'un élément (`display.layout[page][elementId]`).
    /// Le patch complète l'entrée existante sans jamais la recréer de zéro.
    pub fn update_profile_element_layout(&mut self, id: &str, page: &str, element_id: &str, patch: &Value) -> Result<()> {
        self.update_profile(id, |profile| {
            let layout = page_section(profile, "layout", page);
            let entry = ensure_object(layout, element_id);
            shallow_patch(entry, patch);
            Ok(())
        })
    }

    /// Retire tout override d'un élément (retour à son état CSS par défaut).
    pub fn reset_profile_element_layout(&mut self, id: &str, page: &str, element_id: &str) -> Result<()> {
        self.update_profile(id, |profile| {
            if let Some(layout) = page_section_mut(profile, "layout", page) {
                layout.shift_remove(element_id);
            }
            Ok(())
        })
    }

    // --- textes -------------------------------------------------------------------------------

    /// Override de texte (une chaîne vide est une valeur légitime, pas un reset).
    pub fn set_profile_text(&mut self, id: &str, page: &str, text_id: &str, value: &str) -> Result<()> {
        self.update_profile(id, |profile| {
            page_section(profile, "texts", page).insert(text_id.into(), Value::String(value.into()));
            Ok(())
        })
    }

    pub fn reset_profile_text(&mut self, id: &str, page: &str, text_id: &str) -> Result<()> {
        self.update_profile(id, |profile| {
            if let Some(texts) = page_section_mut(profile, "texts", page) {
                texts.shift_remove(text_id);
            }
            Ok(())
        })
    }

    /// Style `{ size?, font? }` d'un texte. Une valeur `null` dans le patch efface le réglage.
    pub fn set_profile_text_style(&mut self, id: &str, page: &str, text_id: &str, patch: &Value) -> Result<()> {
        self.update_profile(id, |profile| {
            let styles = page_section(profile, "textStyles", page);
            let entry = ensure_object(styles, text_id);
            shallow_patch(entry, patch);
            Ok(())
        })
    }

    pub fn reset_profile_text_style(&mut self, id: &str, page: &str, text_id: &str) -> Result<()> {
        self.update_profile(id, |profile| {
            if let Some(styles) = page_section_mut(profile, "textStyles", page) {
                styles.shift_remove(text_id);
            }
            Ok(())
        })
    }

    // --- éléments ajoutés (customTexts) -------------------------------------------------------

    /// Ajoute un élément à une page. `args` = `{ type?, text?, url?, color?, top?, left? }`.
    /// Renvoie l'id généré. Valeurs par défaut identiques à `addProfileCustomText()`.
    pub fn add_profile_custom_text(&mut self, id: &str, page: &str, args: &Value) -> Result<String> {
        let element_id = new_uuid();
        let entry = new_custom_element(args);
        let element_type = entry["type"].as_str().unwrap_or("text").to_string();

        self.update_profile(id, |profile| {
            let elements = page_section(profile, "customTexts", page);
            if SINGLETON_ELEMENT_TYPES.contains(&element_type.as_str())
                && elements.values().any(|e| e.get("type").and_then(Value::as_str) == Some(&element_type))
            {
                return Err(Error::msg("Un seul élément de ce type par scène"));
            }
            elements.insert(element_id.clone(), entry);
            Ok(())
        })?;
        Ok(element_id)
    }

    /// `Object.assign(entry, patch)` sur un élément existant.
    pub fn update_profile_custom_text(&mut self, id: &str, page: &str, element_id: &str, patch: &Value) -> Result<()> {
        self.update_profile(id, |profile| {
            let entry = page_section_mut(profile, "customTexts", page)
                .and_then(|elements| elements.get_mut(element_id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| Error::msg("Élément introuvable"))?;
            shallow_patch(entry, patch);
            Ok(())
        })
    }

    pub fn remove_profile_custom_text(&mut self, id: &str, page: &str, element_id: &str) -> Result<()> {
        self.update_profile(id, |profile| {
            if let Some(elements) = page_section_mut(profile, "customTexts", page) {
                elements.shift_remove(element_id);
            }
            Ok(())
        })
    }

    // --- scènes -------------------------------------------------------------------------------

    /// Nouvelle scène personnalisée (servie sur `/scene/<sceneId>`). Renvoie son id.
    pub fn add_profile_scene(&mut self, id: &str, name: Option<&Value>) -> Result<String> {
        let scene_id = new_uuid();
        let name = crate::store::non_empty_or(crate::json::js_string_or_empty(name).trim(), "Nouvelle scène");
        let scene = json!({
            "name": name,
            "createdAt": now_iso(),
            "background": { "mode": "transparent", "color": "#0f172a", "color2": "#1e293b" },
            "effects": {}
        });
        self.update_profile(id, |profile| {
            let display = ensure_object(profile, "display");
            ensure_object(display, "scenes").insert(scene_id.clone(), scene);
            Ok(())
        })?;
        Ok(scene_id)
    }

    /// Patch `{ name?, background?, effects? }` ; `background` et `effects` fusionnés clé par clé.
    /// Les pages intégrées obtiennent leur entrée à la volée au premier réglage.
    pub fn update_profile_scene(&mut self, id: &str, scene_id: &str, patch: &Value) -> Result<()> {
        self.update_profile(id, |profile| {
            let display = ensure_object(profile, "display");
            let scenes = ensure_object(display, "scenes");
            if !scenes.contains_key(scene_id) {
                if !BUILTIN_PAGE_KEYS.contains(&scene_id) {
                    return Err(Error::msg("Scène introuvable"));
                }
                scenes.insert(scene_id.into(), json!({}));
            }
            let scene = ensure_object(scenes, scene_id);

            if let Some(name) = patch.get("name").and_then(Value::as_str).map(str::trim) {
                if !name.is_empty() {
                    scene.insert("name".into(), Value::String(name.into()));
                }
            }
            for key in ["background", "effects"] {
                if let Some(value) = patch.get(key).filter(|v| is_plain_object(v)) {
                    let mut merged = scene.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
                    for (k, v) in value.as_object().expect("objet vérifié") {
                        merged.insert(k.clone(), v.clone());
                    }
                    scene.insert(key.into(), Value::Object(merged));
                }
            }
            Ok(())
        })
    }

    /// Supprime une scène personnalisée et tout ce qui lui est rattaché.
    pub fn remove_profile_scene(&mut self, id: &str, scene_id: &str) -> Result<()> {
        if BUILTIN_PAGE_KEYS.contains(&scene_id) {
            return Err(Error::msg("Les scènes intégrées ne peuvent pas être supprimées"));
        }
        self.update_profile(id, |profile| {
            let display = profile.get_mut("display").and_then(Value::as_object_mut);
            let Some(display) = display.filter(|d| {
                d.get("scenes").and_then(|s| s.get(scene_id)).is_some()
            }) else {
                return Err(Error::msg("Scène introuvable"));
            };
            for section in ["scenes", "customTexts", "layout", "texts", "themes"] {
                if let Some(map) = display.get_mut(section).and_then(Value::as_object_mut) {
                    map.shift_remove(scene_id);
                }
            }
            Ok(())
        })
    }
}

/// Construit un nouvel élément avec les mêmes valeurs par défaut (et le même ordre de clés)
/// que `addProfileCustomText()`.
fn new_custom_element(args: &Value) -> Value {
    let arg = |key: &str| args.get(key);
    let string_arg = |key: &str| arg(key).and_then(Value::as_str).map(str::to_string);
    let truthy_or = |key: &str, fallback: &str| -> Value {
        match arg(key) {
            Some(v) if is_truthy(Some(v)) => v.clone(),
            _ => Value::String(fallback.into()),
        }
    };
    let color_or = |fallback: &str| Value::String(string_arg("color").unwrap_or_else(|| fallback.into()));
    let number_or = |key: &str, fallback: f64| -> Value {
        arg(key).filter(|v| v.is_number()).cloned().unwrap_or_else(|| json!(fallback as i64))
    };

    let element_type = arg("type")
        .and_then(Value::as_str)
        .filter(|t| CUSTOM_ELEMENT_TYPES.contains(t))
        .unwrap_or("text");

    let mut e = Map::new();
    e.insert("type".into(), json!(element_type));
    e.insert("top".into(), number_or("top", 40.0));
    e.insert("left".into(), number_or("left", 40.0));

    match element_type {
        "text" => {
            e.insert("text".into(), truthy_or("text", "Nouveau texte"));
        }
        "chat" => {
            e.insert("text".into(), truthy_or("text", "CHAT"));
        }
        "chatTicker" => {
            e.insert("speed".into(), json!(60));
        }
        "image" => {
            e.insert("url".into(), json!(string_arg("url").unwrap_or_default()));
        }
        "box" => {
            e.insert("color".into(), color_or("#a855f7"));
        }
        "spotify" => {
            e.insert("color".into(), color_or("#1db954"));
        }
        "statBadge" => {
            e.insert("source".into(), json!("viewers"));
            e.insert("text".into(), json!("en attente"));
            e.insert("icon".into(), json!("users"));
            e.insert("size".into(), json!(2.6));
            e.insert("color".into(), color_or("#a855f7"));
        }
        "badge" => {
            e.insert("text".into(), truthy_or("text", "PAUSE"));
            e.insert("icon".into(), json!("pause"));
            e.insert("size".into(), json!(2.6));
            e.insert("color".into(), color_or("#a855f7"));
            e.insert("pulse".into(), json!(true));
        }
        "rotatingText" => {
            e.insert(
                "text".into(),
                truthy_or(
                    "text",
                    "🎮 Pause technique - On revient tout de suite !\n☕ Petite pause café - Restez connectés !",
                ),
            );
            e.insert("interval".into(), json!(4));
            e.insert("size".into(), json!(2.2));
            e.insert("color".into(), color_or("#ffffff"));
        }
        "infoPanel" => {
            e.insert("title1".into(), json!("TRAJET ACTUEL"));
            e.insert("title2".into(), json!("STATS"));
            e.insert("title3".into(), json!("VTC"));
            e.insert("showTrip".into(), json!(true));
            e.insert("showStats".into(), json!(true));
            e.insert("showCompany".into(), json!(true));
            e.insert("size".into(), json!(1.5));
            e.insert("autoShow".into(), json!(true));
        }
        "bottomBar" => {
            e.insert("text".into(), json!("twitch|Twitch\ndiscord|Discord\nglobe|Site web"));
            e.insert("scrolling".into(), json!(""));
            e.insert("size".into(), json!(1.6));
            e.insert("autoShow".into(), json!(true));
        }
        // Cartes Twitch : taille par la police ; sans couleur, celle du thème de la page.
        "goal" | "poll" | "prediction" | "hypetrain" => {
            e.insert("size".into(), json!(2));
        }
        // Widget personnalisé : identifiant, nom affiché dans l'éditeur, réglages par défaut et
        // taille conseillée du widget (fournis par la couche HTTP depuis son widget.json).
        "widget" => {
            e.insert("widgetId".into(), json!(string_arg("widgetId").unwrap_or_default()));
            e.insert("name".into(), json!(string_arg("name").unwrap_or_default()));
            e.insert("settings".into(), arg("settings").filter(|s| s.is_object()).cloned().unwrap_or_else(|| json!({})));
            for key in ["width", "height"] {
                if let Some(v) = arg(key).filter(|v| v.is_number()) {
                    e.insert(key.into(), v.clone());
                }
            }
        }
        "keys" => {
            e.insert("color".into(), color_or("#f59e0b"));
            e.insert("layout".into(), json!("azerty"));
            for key in ["showFunctionRow", "showDigitRow", "showMovement", "showModifiers", "showArrows", "showMouse"] {
                e.insert(key.into(), json!(true));
            }
        }
        _ => {}
    }
    Value::Object(e)
}
