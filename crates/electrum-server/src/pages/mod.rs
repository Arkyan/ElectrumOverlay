//! Pages de l'app (HTML généré côté serveur).
//!
//! Le contenu de chaque page est dans `templates/pages/*.html` (à l'origine extrait des routes
//! Node, désormais propre à la version Rust) ; chaque `{{expr:N}}` y est remplacé par une valeur
//! calculée ici, et `{{shell:open}}` / `{{shell:close}}` par la structure commune (`shell.rs`).

pub mod js;
pub mod shell;

use electrum_core::json::number_value;
use electrum_core::Store;
use js::{at, esc, esc_nn, esc_or, esc_v, fill, if_truthy, js as js_json, or, stringify, unless_false};
use serde_json::{json, Map, Value};

/// Gabarit embarqué, toujours en fins de ligne Unix : sous Windows, git peut extraire les
/// fichiers en `\r\n`, alors que les pages Node (gabarits JS) sont toujours en `\n`.
macro_rules! template {
    ($name:literal) => {
        &*crate::pages::normalize_newlines(include_str!(concat!("../../templates/pages/", $name, ".html")))
    };
}

/// `\r\n` → `\n` (sans copie si le texte n'en contient pas).
pub fn normalize_newlines(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains('\r') { std::borrow::Cow::Owned(text.replace("\r\n", "\n")) } else { std::borrow::Cow::Borrowed(text) }
}

/// Premier lancement : langue, type de stream, couleurs, animations, logo.
pub fn welcome(config: &Value, has_logo: bool) -> String {
    let language = crate::i18n::language_of(config);
    shell::wrap(
        &fill(template!("welcome"), &[language.to_string(), if has_logo { "1".into() } else { String::new() }]),
        "",
    )
}

/// Page des widgets personnalisés : import, liste, et documentation dans la langue de l'interface.
pub fn widgets(language: &str) -> String {
    let doc = if language == "en" { template!("widgets-doc-en") } else { template!("widgets-doc-fr") };
    shell::wrap(&fill(template!("widgets"), &[doc.to_string()]), "/widgets")
}

/// Page des outils de test (aucune donnée serveur).
pub fn tests() -> String {
    shell::wrap(template!("tests"), "/tests")
}

/// Pages d'overlay intégrées, dans l'ordre d'un stream.
const OBS_PAGES: [(&str, &str); 4] = [("Démarrage", "/starting.html"), ("En direct", "/"), ("Pause", "/pause.html"), ("Fin", "/ending.html")];

/// Tableau de bord : état de Twitch et du live (rafraîchis par la page), tests rapides, et URLs
/// des sources OBS (pages intégrées + scènes personnalisées du profil actif) à copier.
pub fn app_home(config: &Value) -> String {
    let port = js::string(at(config, &["server", "PORT"]));
    let row_with = |name: &str, kind: &str, path: &str| {
        let url = format!("http://localhost:{port}{path}");
        format!(
            "<tr><td>{}<div class=\"hint\" style=\"margin:2px 0 0;\">{}</div></td><td class=\"url\">{}</td><td class=\"actions\"><button type=\"button\" class=\"btn btn-sm btn-ghost\" data-copy=\"{}\">{}<span>Copier</span></button></td></tr>",
            esc(name), esc(kind), esc(&url), esc(&url), shell::icon("copy")
        )
    };
    let row = |name: &str, path: &str| row_with(name, "Scène · 1920×1080", path);
    let mut rows: String = OBS_PAGES.iter().map(|(name, path)| row(name, path)).collect();
    if let Some(scenes) = at(config, &["display", "scenes"]).and_then(Value::as_object) {
        for (id, scene) in scenes {
            if electrum_core::store::BUILTIN_PAGE_KEYS.contains(&id.as_str()) {
                continue;
            }
            rows.push_str(&row(&js::string(scene.get("name")), &format!("/scene/{id}")));
        }
    }
    let login = at(config, &["twitch", "BROADCASTER_LOGIN"]).filter(|v| electrum_core::json::is_truthy(Some(v)));
    let channel = login.map_or("—".to_string(), |l| esc(&js::string(Some(l))));
    shell::wrap(&fill(template!("app"), &[shell::icon("scene"), channel, rows]), "/app")
}

/// `/auth-url` : lien d'autorisation Twitch.
pub fn auth_url(url: &str) -> String {
    shell::wrap(&fill(template!("auth-url"), &[url.to_string()]), "/setup")
}

/// `/auth-callback` : récupère le token dans l'URL et l'envoie à `/api/oauth-callback`.
pub fn auth_callback() -> String {
    shell::wrap(template!("auth-callback"), "")
}

/// `/setup` (assistant de configuration), sans la section ngrok.
pub fn setup(config: &Value) -> String {
    let twitch = &config["twitch"];
    let empty = json!({});
    let bottom = or(at(config, &["display", "panels", "bottom", "content"]), Some(&empty)).unwrap_or(&empty);
    let login = twitch.get("BROADCASTER_LOGIN").filter(|v| electrum_core::json::is_truthy(Some(v)));
    let channel = match login {
        Some(login) => format!("@{} — ID {}", js::string(Some(login)), js::string(twitch.get("BROADCASTER_ID"))),
        None => {
            let id = twitch.get("BROADCASTER_ID");
            if electrum_core::json::is_truthy(id) { js::string(id) } else { "Aucune — autorisez d'abord".to_string() }
        }
    };
    shell::wrap(&fill(
        template!("setup"),
        &[
            js::string(at(config, &["server", "PORT"])),
            esc_v(twitch.get("CLIENT_ID")),
            if_truthy(twitch.get("CLIENT_SECRET"), "Déjà enregistré — laisser vide pour ne pas changer"),
            esc(&channel),
            esc_or(at(config, &["display", "themes", "index", "primary"]), "#a855f7"),
            esc_or(at(bottom, &["infoTexts", "0"]), ""),
            esc_or(at(bottom, &["infoTexts", "1"]), ""),
            esc_or(at(bottom, &["infoTexts", "2"]), ""),
            esc_or(bottom.get("scrollingText"), ""),
        ],
    ), "/setup")
}

/// Logs en direct : seul le port WebSocket est injecté.
pub fn logs(ws_port: &Value) -> String {
    shell::wrap(&fill(template!("logs"), &[js::string(Some(ws_port))]), "/logs")
}

/// `/stream-stats-html`.
pub fn stream_stats(stats: &Value) -> String {
    shell::wrap(&fill(template!("stream-stats"), &[user_json(stats)]), "/stream-stats-html")
}

// ---------------------------------------------------------------------------------------------
// Éditeur de scène
// ---------------------------------------------------------------------------------------------

const CANVAS_W: &str = "1920";
const CANVAS_H: &str = "1080";
const BUILTIN_SCENES: [(&str, &str, &str); 4] = [
    ("starting", "Démarrage", "/starting.html"),
    ("index", "En direct", "/"),
    ("pause", "Pause", "/pause.html"),
    ("ending", "Fin", "/ending.html"),
];
const SCENE_THEME_FIELDS: [(&str, &str, &str); 9] = [
    ("primary", "Primaire", "#a855f7"),
    ("secondary", "Secondaire", "#8b45f6"),
    ("accent", "Accent", "#7c3aed"),
    ("panelBorder", "Bordure panneaux", "#8b45f6"),
    ("background", "Fond général", "#0f172a"),
    ("surface", "Surface", "#1e293b"),
    ("panelBg", "Fond panneaux", "#0f172a"),
    ("text", "Texte", "#e2e8f0"),
    ("mutedText", "Texte atténué", "#94a3b8"),
];

/// `/scene-editor` : édite toujours le profil actif.
/// Données de l'utilisateur insérées dans un script (noms de scènes, messages de pause…) : balisées
/// pour que la traduction anglaise n'y touche pas (voir `i18n::USER_DATA_START`).
fn user_json(value: &Value) -> String {
    format!("{}{}{}", crate::i18n::USER_DATA_START, js_json(value), crate::i18n::USER_DATA_END)
}

pub fn scene_editor(store: &Store) -> electrum_core::Result<String> {
    let active_id = store.active_profile_id().map(str::to_string);
    let display = store.effective_display(active_id.as_deref().unwrap_or_default())?;
    let empty = json!({});
    let section = |key: &str| or(display.get(key), Some(&empty)).cloned().unwrap_or_else(|| json!({}));
    let anims = section("animations");
    let themes = section("themes");
    let pause = section("pause");
    let scenes = section("scenes");

    let anims_on = anims.get("enabled") != Some(&Value::Bool(false));
    let effect_on = |key: &str| anims_on && at(&anims, &[key, "enabled"]) != Some(&Value::Bool(false));
    let anim_defaults = json!({
        "particles": effect_on("particles"),
        "stars": effect_on("stars"),
        "meteors": effect_on("meteors"),
        "circuitLines": effect_on("circuitLines"),
        "dvdLogo": effect_on("dvdLogo")
    });

    let theme_fields: Vec<Value> = SCENE_THEME_FIELDS
        .iter()
        .map(|(key, label, fallback)| json!({ "key": key, "label": label, "fallback": fallback }))
        .collect();

    let builtin: Vec<Value> = BUILTIN_SCENES
        .iter()
        .map(|(key, label, url)| {
            let scene = scenes.get(*key).filter(|s| electrum_core::json::is_truthy(Some(s)));
            let background = or(scene.and_then(|s| s.get("background")), None)
                .cloned()
                .unwrap_or_else(|| json!({ "mode": "theme", "color": "#0f172a", "color2": "#1e293b" }));
            let effects = or(scene.and_then(|s| s.get("effects")), None).cloned().unwrap_or_else(|| json!({}));
            json!({ "key": key, "label": label, "url": url, "builtin": true, "background": background, "effects": effects })
        })
        .collect();
    let builtin_keys: Vec<&str> = BUILTIN_SCENES.iter().map(|(key, ..)| *key).collect();

    let list_or_empty = |key: &str| or(pause.get(key), None).cloned().unwrap_or_else(|| json!([]));
    let pause_lists = json!({ "messages": list_or_empty("messages"), "progressMessages": list_or_empty("progressMessages") });

    Ok(shell::wrap(&fill(
        template!("scene-editor"),
        &[
            CANVAS_W.into(),
            CANVAS_H.into(),
            user_json(&json!(active_id)),
            js_json(&Value::Array(theme_fields)),
            CANVAS_W.into(),
            CANVAS_H.into(),
            js_json(&anim_defaults),
            js_json(&Value::Array(builtin)),
            user_json(&scenes),
            js_json(&json!(builtin_keys)),
            user_json(&themes),
            user_json(&pause_lists),
        ],
    ), "/scene-editor"))
}

// ---------------------------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------------------------

const THEME_PAGES: [(&str, &str); 4] = [
    ("starting", "Starting (écran d'attente)"),
    ("index", "Index (overlay principal)"),
    ("pause", "Pause"),
    ("ending", "Ending (écran de fin)"),
];
const ALERT_TYPES: [(&str, &str); 5] =
    [("follow", "Follow"), ("sub", "Sub"), ("subs_gift", "Sub Gift"), ("raid", "Raid"), ("bits", "Bits")];
const ALERT_PREVIEW_ACTION: [(&str, &str); 5] =
    [("follow", "follow"), ("sub", "sub"), ("subs_gift", "subgift"), ("raid", "raid"), ("bits", "bits")];
const ANIMATION_STYLES: [(&str, &str); 4] =
    [("fade", "Fondu (défaut)"), ("slide", "Glissement"), ("zoom", "Zoom"), ("bounce", "Rebond")];
const PARTICLE_ANIMATIONS: [(&str, &str); 3] = [("particles", "Particules"), ("stars", "Étoiles"), ("meteors", "Météores")];

/// `renderTabGroup(groupName, items, renderPanelContent)`.
fn tab_group(group: &str, items: &[(&str, &str)], panel: impl Fn(&str, &str) -> String) -> String {
    let active = |i: usize| if i == 0 { " active" } else { "" };
    let buttons: String = items
        .iter()
        .enumerate()
        .map(|(i, (key, label))| {
            format!("<button type=\"button\" class=\"tab-btn{}\" data-tab=\"{}\">{}</button>", active(i), esc(key), esc(label))
        })
        .collect();
    let panels: String = items
        .iter()
        .enumerate()
        .map(|(i, (key, label))| {
            format!(
                "<div class=\"tab-panel{}\" data-tabgroup=\"{group}\" data-tab=\"{}\">{}</div>",
                active(i),
                esc(key),
                panel(key, label)
            )
        })
        .collect();
    fill(template!("settings-tabgroup"), &[group.to_string(), buttons, panels])
}

/// Contexte de la page /settings (profil consulté, pas forcément l'actif).
pub struct SettingsContext<'a> {
    pub active_id: &'a str,
    pub viewed_id: &'a str,
    pub profiles: &'a [Value],
    pub audio: &'a Map<String, Value>,
    pub media: &'a Map<String, Value>,
}

/// `/settings[?profile=<id>]`.
pub fn settings(store: &Store, requested: Option<&str>) -> electrum_core::Result<String> {
    let active_id = store.active_profile_id().unwrap_or_default().to_string();
    let profiles = store.list_profiles()?;
    let viewed_id = requested
        .filter(|id| !id.is_empty() && profiles.iter().any(|p| p["id"] == *id))
        .map(str::to_string)
        .unwrap_or_else(|| active_id.clone());
    let viewed = store.get_profile_full(&viewed_id)?;
    let empty = Map::new();
    let assets = |key: &str| viewed.get(key).and_then(Value::as_object).unwrap_or(&empty);
    let display = store.effective_display(&viewed_id)?;
    Ok(settings_page(
        &display,
        &SettingsContext {
            active_id: &active_id,
            viewed_id: &viewed_id,
            profiles: &profiles,
            audio: assets("audio"),
            media: assets("media"),
        },
    ))
}

fn settings_page(display: &Value, ctx: &SettingsContext) -> String {
    let d = |path: &[&str]| at(display, path);
    let is_active = ctx.viewed_id == ctx.active_id;

    let profile_options: String = ctx
        .profiles
        .iter()
        .map(|p| {
            let id = js::string(p.get("id"));
            format!(
                "<option value=\"{}\" {}>{}{}</option>",
                esc(&id),
                if id == ctx.viewed_id { "selected" } else { "" },
                esc_v(p.get("name")),
                if id == ctx.active_id { " (actif)" } else { "" }
            )
        })
        .collect();

    let theme_tabs = tab_group("theme", &THEME_PAGES, |key, _| {
        let empty = json!({});
        let t = or(d(&["themes", key]), Some(&empty)).unwrap_or(&empty);
        let mut v = Vec::new();
        for (field, fallback) in [
            ("primary", "#a855f7"),
            ("secondary", "#8b45f6"),
            ("accent", "#7c3aed"),
            ("panelBorder", "#8b45f6"),
            ("background", "#0f172a"),
            ("surface", "#1e293b"),
            ("panelBg", "#0f172a"),
            ("text", "#e2e8f0"),
            ("mutedText", "#94a3b8"),
        ] {
            v.extend([key.to_string(), key.to_string(), esc_or(t.get(field), fallback)]);
        }
        fill(template!("settings-theme-tab"), &v)
    });

    let alert_tabs = tab_group("alert", &ALERT_TYPES, |key, label| {
        let empty = json!({});
        let a = or(d(&["alerts", "types", key]), Some(&empty)).unwrap_or(&empty);
        let audio_meta = ctx.audio.get(key).filter(|m| electrum_core::json::is_truthy(Some(m)));
        let media_meta = ctx.media.get(key).filter(|m| electrum_core::json::is_truthy(Some(m)));
        let current = a
            .get("animationStyle")
            .and_then(Value::as_str)
            .filter(|s| ANIMATION_STYLES.iter().any(|(k, _)| k == s))
            .unwrap_or("fade");
        let options: String = ANIMATION_STYLES
            .iter()
            .map(|(k, l)| format!("<option value=\"{k}\" {}>{}</option>", if *k == current { "selected" } else { "" }, esc(l)))
            .collect();
        let border = a.get("border");
        let k = || key.to_string();
        let audio_line = audio_meta.map_or(String::new(), |m| {
            format!("<p class=\"hint\">🔊 {} <button type=\"button\" class=\"btn btn-ghost alert-sound-remove\" data-alert-type=\"{key}\">Supprimer le son</button></p>", esc_v(m.get("filename")))
        });
        let media_line = media_meta.map_or(String::new(), |m| {
            format!("<p class=\"hint\">🖼️ {} <button type=\"button\" class=\"btn btn-ghost alert-media-remove\" data-alert-type=\"{key}\">Supprimer le média</button></p>", esc_v(m.get("filename")))
        });
        let media_img = media_meta.map_or(String::new(), |m| {
            format!(
                "<img src=\"/api/profiles/{}/media/{key}?v={}\" alt=\"\" style=\"max-height:80px; border-radius:var(--radius-sm); margin-top:var(--space-2);\">",
                esc(ctx.viewed_id),
                esc_v(m.get("updatedAt"))
            )
        });
        fill(
            template!("settings-alert-tab"),
            &[
                k(), k(), esc_or(a.get("title"), ""),
                k(), k(), esc_or(a.get("defaultMessage"), ""),
                k(), k(), options,
                k(), k(), esc_or(border, "#8b45f6"),
                k(), k(), esc_or(or(a.get("gradientStart"), border), "#8b45f6"),
                k(), k(), esc_or(or(a.get("gradientEnd"), border), "#8b45f6"),
                k(), k(), k(), k(), k(), k(),
                audio_line, media_line, media_img,
                k(), esc(label),
            ],
        )
    });

    let particles: String = PARTICLE_ANIMATIONS
        .iter()
        .map(|(key, label)| {
            let empty = json!({});
            let a = or(d(&["animations", key]), Some(&empty)).unwrap_or(&empty);
            let default_duration = json!([5, 8]);
            let duration = or(a.get("duration"), Some(&default_duration)).unwrap_or(&default_duration);
            let k = || key.to_string();
            fill(
                template!("settings-particle"),
                &[
                    k(), unless_false(a.get("enabled"), "checked"), esc(label),
                    k(), k(), esc_nn(a.get("count"), "30"),
                    k(), k(), esc_v(at(duration, &["0"])),
                    k(), k(), esc_v(at(duration, &["1"])),
                ],
            )
        })
        .collect();

    let volume = at(display, &["alerts", "soundVolume"]).and_then(Value::as_f64).unwrap_or(0.8);
    let volume_percent = (volume * 100.0 + 0.5).floor();

    let preview: Map<String, Value> = ALERT_PREVIEW_ACTION.iter().map(|(k, v)| (k.to_string(), json!(v))).collect();

    shell::wrap(&fill(
        template!("settings"),
        &[
            if is_active {
                "Couleurs et textes : appliqués tout de suite aux overlays. Animations et panneaux : au prochain rafraîchissement de la source OBS.".to_string()
            } else {
                "Ce profil n'est pas actif : les changements s'appliqueront aux overlays une fois qu'il sera activé.".to_string()
            },
            profile_options,
            if is_active { "disabled".into() } else { String::new() },
            if is_active { "Déjà actif".into() } else { "Activer ce profil".into() },
            theme_tabs,
            unless_false(d(&["alerts", "enabled"]), "checked"),
            esc_nn(d(&["alerts", "duration"]), "6000"),
            esc_nn(d(&["alerts", "queueDelay"]), "500"),
            esc_v(Some(&number_value(volume_percent))),
            unless_false(d(&["alerts", "confettiEnabled"]), "checked"),
            esc_nn(d(&["alerts", "confettiParticles"]), "300"),
            esc_nn(d(&["alerts", "confettiSpread"]), "360"),
            esc_nn(d(&["alerts", "confettiVelocity"]), "50"),
            esc_nn(d(&["alerts", "confettiTicks"]), "250"),
            alert_tabs,
            if_truthy(d(&["panels", "left", "enabled"]), "checked"),
            esc_nn(d(&["panels", "left", "interval"]), "300000"),
            esc_nn(d(&["panels", "left", "duration"]), "15000"),
            esc_nn(d(&["panels", "left", "firstDelay"]), "30000"),
            esc_or(d(&["panels", "left", "timerColor"]), "#ef4444"),
            if_truthy(d(&["panels", "bottom", "enabled"]), "checked"),
            esc_or(d(&["panels", "bottom", "content", "infoTexts", "0"]), ""),
            esc_or(d(&["panels", "bottom", "content", "infoTexts", "1"]), ""),
            esc_or(d(&["panels", "bottom", "content", "infoTexts", "2"]), ""),
            esc_or(d(&["panels", "bottom", "content", "scrollingText"]), ""),
            esc_nn(d(&["panels", "bottom", "interval"]), "180000"),
            esc_nn(d(&["panels", "bottom", "duration"]), "20000"),
            esc_nn(d(&["panels", "bottom", "firstDelay"]), "10000"),
            unless_false(d(&["animations", "enabled"]), "checked"),
            particles,
            if_truthy(d(&["animations", "circuitLines", "enabled"]), "checked"),
            esc_nn(d(&["animations", "circuitLines", "horizontal"]), "10"),
            esc_nn(d(&["animations", "circuitLines", "vertical"]), "8"),
            esc_nn(d(&["animations", "circuitLines", "duration"]), "6"),
            unless_false(d(&["animations", "dvdLogo", "enabled"]), "checked"),
            esc_nn(d(&["animations", "dvdLogo", "speed"]), "2"),
            esc_nn(d(&["animations", "dvdLogo", "updateInterval"]), "16"),
            unless_false(d(&["chat", "enabled", "starting"]), "checked"),
            unless_false(d(&["chat", "enabled", "index"]), "checked"),
            unless_false(d(&["chat", "enabled", "ending"]), "checked"),
            esc_or(d(&["chat", "defaultColor"]), "#3b82f6"),
            esc_nn(d(&["chat", "maxMessages"]), "50"),
            esc_nn(d(&["stats", "animationDuration"]), "1000"),
            esc_nn(d(&["stats", "updateInterval"]), "30000"),
            if_truthy(d(&["stats", "simulateData"]), "checked"),
            stringify(&json!(THEME_PAGES.iter().map(|(k, _)| k).collect::<Vec<_>>())),
            stringify(&json!(ALERT_TYPES.iter().map(|(k, _)| k).collect::<Vec<_>>())),
            stringify(&Value::Object(preview)),
            stringify(&json!(PARTICLE_ANIMATIONS.iter().map(|(k, _)| k).collect::<Vec<_>>())),
            stringify(&json!(ctx.viewed_id)),
            stringify(&json!(ctx.active_id)),
        ],
    ), "/settings")
}

// ---------------------------------------------------------------------------------------------
// Commandes de chat
// ---------------------------------------------------------------------------------------------

const PERMISSION_LABELS: [(&str, &str); 4] = [
    ("everyone", "Tout le monde"),
    ("vip", "VIP et plus"),
    ("moderator", "Modérateurs et plus"),
    ("broadcaster", "Streamer uniquement"),
];

/// `commandCardHTML(command, openByDefault)`.
fn command_card(command: &Value, open: bool) -> String {
    let c = |path: &[&str]| at(command, path);
    let id = js::string(c(&["id"]));
    let is_new = id == "new";
    let tags = [
        if electrum_core::json::is_truthy(c(&["enabled"])) { "" } else { "<span class=\"cmd-tag\">désactivée</span>" },
        if electrum_core::json::is_truthy(c(&["chatReply", "enabled"])) { "<span class=\"cmd-tag\">chat</span>" } else { "" },
        if electrum_core::json::is_truthy(c(&["overlayAction", "enabled"])) { "<span class=\"cmd-tag\">overlay</span>" } else { "" },
    ]
    .concat();
    let title = if is_new {
        "+ Nouvelle commande".to_string()
    } else {
        let trigger = esc_v(c(&["trigger"]));
        if trigger.is_empty() { "(sans déclencheur)".to_string() } else { trigger }
    };
    let permission = c(&["permission"]).and_then(Value::as_str);
    let options: String = PERMISSION_LABELS
        .iter()
        .map(|(value, label)| {
            format!("<option value=\"{value}\" {}>{label}</option>", if permission == Some(value) { "selected" } else { "" })
        })
        .collect();
    let panel_bottom = c(&["overlayAction", "panel"]).and_then(Value::as_str) == Some("bottom");
    fill(
        template!("command-card"),
        &[
            esc(&id),
            if open { "open".into() } else { String::new() },
            title,
            tags,
            esc_v(c(&["trigger"])),
            options,
            esc_v(c(&["cooldownSeconds"])),
            if_truthy(c(&["enabled"]), "checked"),
            if_truthy(c(&["chatReply", "enabled"]), "checked"),
            esc_or(c(&["chatReply", "message"]), ""),
            if_truthy(c(&["overlayAction", "enabled"]), "checked"),
            if panel_bottom { String::new() } else { "selected".into() },
            if panel_bottom { "selected".into() } else { String::new() },
        ],
    )
}

/// `/commands`.
pub fn commands(list: &[Value]) -> String {
    let new_card = command_card(
        &json!({ "id": "new", "trigger": "", "enabled": true, "permission": "everyone", "cooldownSeconds": 5,
                 "chatReply": { "enabled": false, "message": "" }, "overlayAction": { "enabled": false, "panel": "left" } }),
        true,
    );
    let cards = if list.is_empty() {
        "<p class=\"hint\">Aucune commande pour le moment.</p>".to_string()
    } else {
        list.iter().map(|c| command_card(c, false)).collect()
    };
    shell::wrap(&fill(template!("commands"), &[new_card, cards]), "/commands")
}

// ---------------------------------------------------------------------------------------------
// Intégrations
// ---------------------------------------------------------------------------------------------

/// Données de la page /integrations (mêmes champs que `INTEGRATIONS_PAGE_HTML` côté Node).
pub struct IntegrationsContext<'a> {
    pub config: &'a Value,
    pub configured: bool,
    pub connected: bool,
    pub auth_url: Option<String>,
    pub just_connected: bool,
    pub error: Option<&'a str>,
}

/// `/integrations` : Spotify, Trucky, affichage des touches.
pub fn integrations(ctx: &IntegrationsContext) -> String {
    let spotify = &ctx.config["spotify"];
    let trucky = &ctx.config["trucky"];
    let account = if ctx.connected {
        template!("integrations-connected").to_string()
    } else if ctx.configured {
        fill(template!("integrations-configured"), &[esc(ctx.auth_url.as_deref().unwrap_or_default())])
    } else {
        template!("integrations-unconfigured").to_string()
    };
    shell::wrap(&fill(
        template!("integrations"),
        &[
            ctx.error.filter(|e| !e.is_empty()).map_or(String::new(), |e| format!("<p class=\"msg error\">{}</p>", esc(e))),
            if ctx.just_connected { "<p class=\"msg success\">Compte Spotify connecté.</p>".into() } else { String::new() },
            esc_v(spotify.get("REDIRECT_URI")),
            esc_v(spotify.get("CLIENT_ID")),
            esc_v(spotify.get("CLIENT_SECRET")),
            account,
            if_truthy(trucky.get("enable"), "checked"),
            esc_or(trucky.get("USER_ID"), ""),
            if_truthy(at(ctx.config, &["inputDisplay", "enabled"]), "checked"),
        ],
    ), "/integrations")
}
