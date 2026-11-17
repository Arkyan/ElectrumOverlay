//! Test de parité avec la version Node.
//!
//! Le même scénario (`tests/node/scenario.js`) est joué :
//! - par la VRAIE version Node (`src/config/store.js`) ;
//! - par `electrum-core`.
//!
//! Les deux partent du même `overlay-config.json` « ancienne version » (avec un `display` à la
//! racine, à migrer). On compare ensuite les résultats renvoyés ET tous les fichiers écrits sur
//! disque, octet pour octet, après avoir remplacé les UUID et horodatages (aléatoires) par des
//! jetons stables.
//!
//! Le test est ignoré (avec un message) si `node` n'est pas installé.

use electrum_core::assets::{AssetKind, AssetUpload};
use electrum_core::Store;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LEGACY_CONFIG: &str = r##"{
  "twitch": {
    "CLIENT_ID": "abc",
    "CLIENT_SECRET": "secret",
    "BROADCASTER_ID": "123",
    "USER_ACCESS_TOKEN": "token"
  },
  "ngrok": { "ENABLED": false },
  "display": {
    "themes": { "index": { "primary": "#ff0000" } },
    "chat": { "maxMessages": 20 },
    "alerts": { "volumeInconnu": 3 }
  },
  "cleFuture": { "x": 1, "liste": [1, 2] }
}"##;

fn node_available() -> bool {
    Command::new("node").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

/// Chemin du script, construit sans `canonicalize()` : sous Windows, celui-ci renvoie un chemin
/// `\\?\C:\...` que Node ne sait pas ouvrir.
fn scenario_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("node").join("scenario.js")
}

/// Remplace UUID et horodatages par des jetons numérotés dans l'ordre d'apparition.
struct Normalizer {
    uuid: Regex,
    ts: Regex,
    ids: HashMap<String, String>,
}

impl Normalizer {
    fn new() -> Self {
        Self {
            uuid: Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").unwrap(),
            ts: Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}(:|%3A)\d{2}(:|%3A)\d{2}\.\d{3}Z").unwrap(),
            ids: HashMap::new(),
        }
    }

    fn apply(&mut self, text: &str) -> String {
        let text = self.ts.replace_all(text, "<horodatage>").to_string();
        let mut out = String::new();
        let mut last = 0;
        for m in self.uuid.find_iter(&text) {
            out.push_str(&text[last..m.start()]);
            let next = self.ids.len() + 1;
            let token = self.ids.entry(m.as_str().to_string()).or_insert_with(|| format!("<id-{next}>"));
            out.push_str(token);
            last = m.end();
        }
        out.push_str(&text[last..]);
        out
    }
}

/// Tous les fichiers du dossier de config : chemin relatif → contenu (texte).
fn snapshot_files(dir: &Path, normalizer: &mut Normalizer) -> Vec<(String, String)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                out.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    let mut raw = Vec::new();
    walk(dir, dir, &mut raw);
    let mut files: Vec<(String, String)> = raw
        .into_iter()
        .map(|(rel, bytes)| (normalizer.apply(&rel), normalizer.apply(&String::from_utf8_lossy(&bytes))))
        .collect();
    files.sort();
    files
}

fn run_node(dir: &Path) -> Value {
    let script = scenario_script();
    let output = Command::new("node")
        .arg(&script)
        .env("ELECTRUM_CONFIG_DIR", dir)
        .output()
        .expect("lancement de node");
    assert!(output.status.success(), "scenario.js a échoué :\n{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).expect("sortie JSON de scenario.js")
}

/// Exactement les mêmes étapes que `scenario.js`.
fn run_rust(dir: &Path) -> Value {
    let mut errors: Vec<String> = Vec::new();
    let mut attempt = |label: &str, result: electrum_core::Result<()>| {
        if let Err(error) = result {
            errors.push(format!("{label}: {error}"));
        }
    };

    let mut config = Store::open(dir).unwrap();

    let discord = config
        .create_command(&json!({ "trigger": "  !Discord ", "chatReply": { "enabled": true, "message": " rejoins " }, "cooldownSeconds": "10" }))
        .unwrap();
    let discord_id = discord["id"].as_str().unwrap().to_string();
    config
        .update_command(&discord_id, &json!({ "enabled": false, "overlayAction": { "enabled": true, "panel": "bottom" } }))
        .unwrap();
    let tmp = config.create_command(&json!({ "trigger": "!tmp", "enabled": false, "permission": "vip" })).unwrap();
    attempt("doublon", config.create_command(&json!({ "trigger": "!discord" })).map(|_| ()));
    attempt("trigger", config.create_command(&json!({ "trigger": "sans-point" })).map(|_| ()));
    config.delete_command(tmp["id"].as_str().unwrap()).unwrap();

    let default_id = config.active_profile_id().unwrap().to_string();
    let p = config.create_profile(Some(&json!("Mon profil")), None).unwrap()["id"].as_str().unwrap().to_string();
    config.set_active_profile(&p).unwrap();

    config.update_profile_element_layout(&p, "index", "chatContainer", &json!({ "top": 10, "left": 20, "hidden": true })).unwrap();
    config.update_profile_element_layout(&p, "index", "chatContainer", &json!({ "left": 30 })).unwrap();
    config.update_profile_element_layout(&p, "index", "gone", &json!({ "top": 1 })).unwrap();
    config.reset_profile_element_layout(&p, "index", "gone").unwrap();

    config.set_profile_text(&p, "index", "title", "Salut").unwrap();
    config.set_profile_text(&p, "index", "vide", "").unwrap();
    config.set_profile_text_style(&p, "index", "title", &json!({ "size": 3, "font": "baron" })).unwrap();
    config.set_profile_text_style(&p, "index", "title", &json!({ "size": null })).unwrap();

    config.add_profile_custom_text(&p, "index", &json!({})).unwrap();
    let keys = config.add_profile_custom_text(&p, "index", &json!({ "type": "keys", "top": 5 })).unwrap();
    config.add_profile_custom_text(&p, "index", &json!({ "type": "statBadge", "color": "#123456" })).unwrap();
    config.add_profile_custom_text(&p, "index", &json!({ "type": "chat" })).unwrap();
    attempt("singleton", config.add_profile_custom_text(&p, "index", &json!({ "type": "chat" })).map(|_| ()));
    config.add_profile_custom_text(&p, "index", &json!({ "type": "inconnu", "text": "Bonjour" })).unwrap();
    config.update_profile_custom_text(&p, "index", &keys, &json!({ "layout": "qwerty", "scale": 150 })).unwrap();
    attempt("element", config.update_profile_custom_text(&p, "index", "nope", &json!({ "text": "x" })));

    let scene = config.add_profile_scene(&p, Some(&json!("Ma scène"))).unwrap();
    config
        .update_profile_scene(&p, &scene, &json!({ "name": " Renommée ", "background": { "mode": "color" }, "effects": { "stars": true } }))
        .unwrap();
    config.update_profile_scene(&p, "pause", &json!({ "effects": { "particles": false } })).unwrap();
    attempt("scene", config.update_profile_scene(&p, "nope", &json!({ "name": "x" })));
    let doomed = config.add_profile_scene(&p, Some(&json!(""))).unwrap();
    config.add_profile_custom_text(&p, &doomed, &json!({ "type": "clock" })).unwrap();
    config.remove_profile_scene(&p, &doomed).unwrap();
    attempt("builtin", config.remove_profile_scene(&p, "index"));

    config
        .save_profile_display(&p, &json!({ "pause": { "messages": ["a", "b"] }, "themes": { "index": { "primary": "#00ff00" } } }))
        .unwrap();

    let upload = |filename: &'static str, mime: &'static str, bytes: &'static [u8]| AssetUpload { filename, mime_type: mime, bytes };
    config.set_profile_asset(AssetKind::Audio, &p, "follow", upload("Son.MP3", "audio/mpeg", b"abc")).unwrap();
    config.set_profile_asset(AssetKind::Audio, &p, "follow", upload("son.wav", "audio/wav", b"wave")).unwrap();
    config.set_profile_asset(AssetKind::Audio, &p, "sub", upload("", "", b"x")).unwrap();
    config.set_profile_asset(AssetKind::Media, &p, "raid", upload("raid.gif", "image/gif", b"GIF89a")).unwrap();
    config.delete_profile_asset(AssetKind::Audio, &p, "sub").unwrap();
    attempt("alerte", config.set_profile_asset(AssetKind::Audio, &p, "nope", upload("a", "", b"a")));

    let exported = config.export_profile(&p).unwrap();
    let mut copy = exported.clone();
    copy["name"] = json!("Copie");
    config.import_profile(&copy).unwrap();

    config.rename_profile(&default_id, Some(&json!("  Base  "))).unwrap();
    let created_presets = config.ensure_theme_preset_profiles().unwrap();
    let rouge = config
        .list_profiles()
        .unwrap()
        .into_iter()
        .find(|x| x["name"] == "Rouge Braise")
        .unwrap();
    config.delete_profile(rouge["id"].as_str().unwrap()).unwrap();
    attempt("actif", config.delete_profile(&p));

    json!({
        "frontend": config.to_frontend_config(),
        "profiles": config.list_profiles().unwrap(),
        "commands": config.list_commands(),
        "effective": config.effective_display(&default_id).unwrap(),
        "configured": config.is_configured(),
        "createdPresets": created_presets,
        "exported": exported,
        "errors": errors
    })
}

#[test]
fn meme_resultat_et_memes_fichiers_que_la_version_node() {
    if !node_available() {
        eprintln!("⚠️  node introuvable : test de parité ignoré");
        return;
    }

    let node_dir = tempfile::tempdir().unwrap();
    let rust_dir = tempfile::tempdir().unwrap();
    for dir in [&node_dir, &rust_dir] {
        fs::write(dir.path().join("overlay-config.json"), LEGACY_CONFIG).unwrap();
    }

    let node_result = run_node(node_dir.path());
    let rust_result = run_rust(rust_dir.path());

    let mut node_norm = Normalizer::new();
    let mut rust_norm = Normalizer::new();
    let node_text = node_norm.apply(&serde_json::to_string_pretty(&node_result).unwrap());
    let rust_text = rust_norm.apply(&serde_json::to_string_pretty(&rust_result).unwrap());
    assert_eq!(rust_text, node_text, "résultats différents de la version Node");

    let node_files = snapshot_files(node_dir.path(), &mut node_norm);
    let rust_files = snapshot_files(rust_dir.path(), &mut rust_norm);
    let names = |files: &[(String, String)]| files.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
    assert_eq!(names(&rust_files), names(&node_files), "arborescence différente");
    eprintln!("{} fichiers comparés : {:#?}", node_files.len(), names(&node_files));
    for ((path, rust_content), (_, node_content)) in rust_files.iter().zip(&node_files) {
        assert_eq!(rust_content, node_content, "contenu différent pour {path}");
    }

    // Garde-fous sur le scénario lui-même : la migration a bien eu lieu, la clé inconnue a
    // survécu, et les erreurs attendues ont bien été levées des deux côtés.
    let overrides: Value =
        serde_json::from_str(&fs::read_to_string(rust_dir.path().join("overlay-config.json")).unwrap()).unwrap();
    assert!(overrides.get("display").is_none());
    assert_eq!(overrides["cleFuture"], json!({ "x": 1, "liste": [1, 2] }));
    assert_eq!(rust_result["errors"].as_array().unwrap().len(), 8);
}
