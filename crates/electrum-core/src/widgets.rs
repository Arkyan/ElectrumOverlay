//! Widgets personnalisés : éléments de scène créés par les utilisateurs (HTML/CSS/JS), installés
//! depuis un `.zip` et rangés dans `<config>/widgets/<id>/`.
//!
//! Contenu d'un widget (voir la page Widgets de l'app pour la documentation complète) :
//! - `widget.json` : `id`, `name`, `version`, `author`, `description`, `entry` (défaut
//!   `widget.html`), `size` (`{ width, height }` en % d'écran), `settings` (réglages proposés dans
//!   l'éditeur de scène : `key`, `label`, `type` = text | textarea | number | color | checkbox |
//!   select, `default`, `options`, `min`, `max`, `step`) ;
//! - la page d'entrée et ses fichiers (images, sons, polices...).

use crate::paths::ConfigPaths;
use crate::store::write_bytes_file;
use crate::{Error, Result, Store};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = "widget.json";
/// Taille maximale d'un widget décompressé.
pub const MAX_SIZE: u64 = 25 * 1024 * 1024;
const MAX_FILES: usize = 300;
const SETTING_TYPES: [&str; 6] = ["text", "textarea", "number", "color", "checkbox", "select"];

pub fn widgets_dir(paths: &ConfigPaths) -> PathBuf {
    paths.config_dir.join("widgets")
}

/// Identifiant valide : minuscules, chiffres et tirets (sert de nom de dossier et d'URL).
pub fn valid_id(id: &str) -> bool {
    (1..=48).contains(&id.len()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !id.starts_with('-')
}

/// Chemin relatif sûr dans le widget (pas de `..`, pas de chemin absolu).
fn safe_relative(path: &str) -> Option<PathBuf> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in path.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            part => out.push(part),
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Vérifie et complète un manifeste (valeurs par défaut, réglages valides uniquement).
pub fn normalize_manifest(raw: &Value) -> Result<Value> {
    let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let id = text("id");
    if !valid_id(&id) {
        return Err(Error::msg("widget.json : « id » obligatoire (minuscules, chiffres et tirets, ex. « mon-widget »)"));
    }
    let name = text("name");
    if name.is_empty() {
        return Err(Error::msg("widget.json : « name » obligatoire"));
    }
    let entry = if text("entry").is_empty() { "widget.html".to_string() } else { text("entry") };
    if safe_relative(&entry).is_none() {
        return Err(Error::msg("widget.json : « entry » invalide"));
    }
    let size = |key: &str, fallback: f64| raw["size"][key].as_f64().filter(|v| *v > 0.0 && *v <= 100.0).unwrap_or(fallback);
    let mut settings = Vec::new();
    for setting in raw.get("settings").and_then(Value::as_array).into_iter().flatten() {
        let key = setting["key"].as_str().unwrap_or_default();
        let kind = setting["type"].as_str().unwrap_or("text");
        if key.is_empty() || key.len() > 40 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || !SETTING_TYPES.contains(&kind) {
            continue;
        }
        let mut s = Map::new();
        s.insert("key".into(), json!(key));
        s.insert("label".into(), json!(setting["label"].as_str().unwrap_or(key)));
        s.insert("type".into(), json!(kind));
        for extra in ["default", "min", "max", "step", "placeholder"] {
            if let Some(v) = setting.get(extra).filter(|v| !v.is_null()) {
                s.insert(extra.into(), v.clone());
            }
        }
        if kind == "select" {
            let options: Vec<Value> = setting["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| match o {
                    Value::String(v) => Some(json!({ "value": v, "label": v })),
                    Value::Object(_) => Some(json!({ "value": o["value"], "label": o.get("label").unwrap_or(&o["value"]) })),
                    _ => None,
                })
                .collect();
            s.insert("options".into(), Value::Array(options));
        }
        settings.push(Value::Object(s));
    }
    Ok(json!({
        "id": id,
        "name": name,
        "version": if text("version").is_empty() { "1.0.0".to_string() } else { text("version") },
        "author": text("author"),
        "description": text("description"),
        "entry": entry,
        "size": { "width": size("width", 25.0), "height": size("height", 20.0) },
        "settings": settings,
    }))
}

/// Valeurs par défaut des réglages d'un widget (pour un nouvel élément de scène).
pub fn default_settings(manifest: &Value) -> Value {
    let mut out = Map::new();
    for setting in manifest["settings"].as_array().into_iter().flatten() {
        let key = setting["key"].as_str().unwrap_or_default();
        let value = setting.get("default").cloned().unwrap_or_else(|| match setting["type"].as_str() {
            Some("number") => json!(0),
            Some("checkbox") => json!(false),
            Some("color") => json!("#a855f7"),
            Some("select") => setting["options"][0]["value"].clone(),
            _ => json!(""),
        });
        out.insert(key.into(), value);
    }
    Value::Object(out)
}

/// Fichiers d'un widget à installer, lus depuis un zip : soit à la racine, soit dans un unique
/// dossier (zip créé en compressant le dossier du widget), soit sous `prefix` (profil partagé).
/// Widget lu dans un zip : manifeste normalisé + fichiers (chemin relatif, contenu).
type WidgetFiles = (Value, Vec<(PathBuf, Vec<u8>)>);

fn read_widget_zip(bytes: &[u8], prefix: Option<&str>) -> Result<Vec<WidgetFiles>> {
    let invalid = |e: zip::result::ZipError| Error::msg(format!("zip illisible ({e})"));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(invalid)?;
    let names: Vec<String> = archive.file_names().collect::<std::result::Result<Vec<_>, _>>().map_err(invalid)?.into_iter().map(|n| n.to_string()).collect();
    // Dossiers contenant un widget.json.
    let roots: Vec<String> = names
        .iter()
        .filter(|n| n.ends_with(MANIFEST))
        .map(|n| n[..n.len() - MANIFEST.len()].to_string())
        .filter(|root| match prefix {
            Some(prefix) => root.starts_with(prefix) && root[prefix.len()..].trim_end_matches('/').split('/').count() == 1,
            None => root.matches('/').count() <= 1,
        })
        .collect();
    if roots.is_empty() {
        return Err(Error::msg(format!("{MANIFEST} introuvable dans le zip")));
    }
    let mut widgets = Vec::new();
    for root in roots {
        let manifest_bytes = crate::read_capped(archive.by_name(&format!("{root}{MANIFEST}")).map_err(invalid)?, 1024 * 1024, MANIFEST)?;
        let manifest_text = String::from_utf8_lossy(&manifest_bytes).to_string();
        let raw: Value = serde_json::from_str(&manifest_text).map_err(|e| Error::msg(format!("{MANIFEST} : {e}")))?;
        let manifest = normalize_manifest(&raw)?;
        let mut files = Vec::new();
        let mut total = 0u64;
        for name in names.iter().filter(|n| n.starts_with(&root) && !n.ends_with('/')) {
            let relative = safe_relative(&name[root.len()..]).ok_or_else(|| Error::msg(format!("chemin refusé dans le zip : {name}")))?;
            let file = archive.by_name(name).map_err(invalid)?;
            if files.len() >= MAX_FILES {
                return Err(Error::msg("widget trop volumineux (25 Mo et 300 fichiers au maximum)"));
            }
            // Taille réelle une fois décompressé (celle annoncée par le zip peut mentir).
            let data = crate::read_capped(file, MAX_SIZE - total, "widget (25 Mo au maximum)")?;
            total += data.len() as u64;
            files.push((relative, data));
        }
        let entry = safe_relative(manifest["entry"].as_str().unwrap_or_default()).unwrap_or_default();
        if !files.iter().any(|(path, _)| *path == entry) {
            return Err(Error::msg(format!("page d'entrée « {} » absente du widget", entry.display())));
        }
        widgets.push((manifest, files));
    }
    Ok(widgets)
}

fn install(dir: &Path, manifest: &Value, files: &[(PathBuf, Vec<u8>)]) -> Result<()> {
    // Remplace une version précédente du même widget.
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    }
    for (relative, data) in files {
        if relative.as_os_str() == MANIFEST {
            continue;
        }
        write_bytes_file(&dir.join(relative), data)?;
    }
    write_bytes_file(&dir.join(MANIFEST), serde_json::to_string_pretty(manifest).unwrap_or_default().as_bytes())
}

impl Store {
    pub fn widgets_dir(&self) -> PathBuf {
        widgets_dir(self.paths())
    }

    /// Widgets installés (manifestes), triés par nom.
    pub fn list_widgets(&self) -> Vec<Value> {
        let Ok(entries) = fs::read_dir(self.widgets_dir()) else { return Vec::new() };
        let mut widgets: Vec<Value> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| self.widget_manifest(&e.file_name().to_string_lossy()))
            .collect();
        widgets.sort_by_key(|w| w["name"].as_str().unwrap_or_default().to_lowercase());
        widgets
    }

    pub fn widget_manifest(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        let text = fs::read_to_string(self.widgets_dir().join(id).join(MANIFEST)).ok()?;
        normalize_manifest(&serde_json::from_str(&text).ok()?).ok()
    }

    /// Fichier d'un widget installé (`None` si le chemin sort du dossier du widget).
    pub fn widget_file(&self, id: &str, path: &str) -> Option<PathBuf> {
        if !valid_id(id) {
            return None;
        }
        let relative = safe_relative(path)?;
        let file = self.widgets_dir().join(id).join(relative);
        file.is_file().then_some(file)
    }

    /// Installe (ou met à jour) un widget depuis un zip. Renvoie son manifeste.
    pub fn install_widget(&mut self, zip_bytes: &[u8]) -> Result<Value> {
        let mut widgets = read_widget_zip(zip_bytes, None)?;
        if widgets.len() != 1 {
            return Err(Error::msg("le zip doit contenir un seul widget"));
        }
        let (manifest, files) = widgets.remove(0);
        install(&self.widgets_dir().join(manifest["id"].as_str().unwrap_or_default()), &manifest, &files)?;
        Ok(manifest)
    }

    pub fn remove_widget(&mut self, id: &str) -> Result<()> {
        if self.widget_manifest(id).is_none() {
            return Err(Error::msg("Widget introuvable"));
        }
        let dir = self.widgets_dir().join(id);
        fs::remove_dir_all(&dir).map_err(|e| Error::io(&dir, e))
    }

    /// Widgets utilisés par un profil (éléments de scène de type `widget`).
    pub fn widgets_used_by(display: &Value) -> Vec<String> {
        let mut ids: Vec<String> = display["customTexts"]
            .as_object()
            .into_iter()
            .flat_map(|pages| pages.values())
            .filter_map(Value::as_object)
            .flat_map(|items| items.values())
            .filter(|item| item["type"] == "widget")
            .filter_map(|item| item["widgetId"].as_str().map(str::to_string))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Ajoute au zip d'un profil partagé les widgets qu'il utilise (`widgets/<id>/...`).
    pub(crate) fn add_widgets_to_package(&self, zip: &mut zip::ZipWriter<std::io::Cursor<Vec<u8>>>, display: &Value) -> Result<()> {
        use std::io::Write;
        let error = |e: &dyn std::fmt::Display| Error::msg(format!("Création du zip impossible : {e}"));
        for id in Self::widgets_used_by(display) {
            let dir = self.widgets_dir().join(&id);
            if !dir.join(MANIFEST).is_file() {
                continue;
            }
            let mut files = Vec::new();
            fn walk(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
                for entry in fs::read_dir(dir)? {
                    let path = entry?.path();
                    if path.is_dir() { walk(&path, files)? } else { files.push(path) }
                }
                Ok(())
            }
            walk(&dir, &mut files).map_err(|e| error(&e))?;
            files.sort();
            for path in files {
                let relative = path.strip_prefix(&dir).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                zip.start_file(format!("widgets/{id}/{relative}"), zip::write::SimpleFileOptions::default()).map_err(|e| error(&e))?;
                zip.write_all(&fs::read(&path).map_err(|e| error(&e))?).map_err(|e| error(&e))?;
            }
        }
        Ok(())
    }

    /// Widgets contenus dans un zip de profil partagé (manifestes), sans les installer.
    pub fn package_widgets(bytes: &[u8]) -> Vec<Value> {
        if !bytes.starts_with(b"PK\x03\x04") {
            return Vec::new();
        }
        read_widget_zip(bytes, Some("widgets/")).map(|w| w.into_iter().map(|(m, _)| m).collect()).unwrap_or_default()
    }

    /// Installe les widgets d'un zip de profil partagé (avant d'importer le profil).
    pub fn install_package_widgets(&mut self, bytes: &[u8]) -> Result<Vec<Value>> {
        if !bytes.starts_with(b"PK\x03\x04") {
            return Ok(Vec::new());
        }
        let widgets = match read_widget_zip(bytes, Some("widgets/")) {
            Ok(widgets) => widgets,
            Err(_) => return Ok(Vec::new()),
        };
        let mut installed = Vec::new();
        for (manifest, files) in widgets {
            install(&self.widgets_dir().join(manifest["id"].as_str().unwrap_or_default()), &manifest, &files)?;
            installed.push(manifest);
        }
        Ok(installed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    pub(crate) fn widget_zip(id: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        let manifest = json!({
            "id": id, "name": "Mon widget", "size": { "width": 30, "height": 10 },
            "settings": [
                { "key": "titre", "label": "Titre", "type": "text", "default": "Salut" },
                { "key": "couleur", "type": "color" },
                { "key": "mode", "type": "select", "options": ["a", { "value": "b", "label": "B" }] },
                { "key": "../hack", "type": "text" },
                { "key": "x", "type": "inconnu" }
            ]
        });
        zip.start_file(format!("{id}/widget.json"), options).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file(format!("{id}/widget.html"), options).unwrap();
        zip.write_all(b"<p>ok</p>").unwrap();
        for (name, data) in extra {
            zip.start_file(format!("{id}/{name}"), options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn installation_liste_suppression() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let manifest = store.install_widget(&widget_zip("compteur", &[("img/logo.png", b"PNG")])).unwrap();
        assert_eq!((manifest["id"].as_str(), manifest["entry"].as_str()), (Some("compteur"), Some("widget.html")));
        assert_eq!(manifest["size"], json!({ "width": 30.0, "height": 10.0 }));
        // Réglages invalides ignorés.
        assert_eq!(manifest["settings"].as_array().unwrap().len(), 3);
        assert_eq!(manifest["settings"][2]["options"][1], json!({ "value": "b", "label": "B" }));
        assert_eq!(default_settings(&manifest), json!({ "titre": "Salut", "couleur": "#a855f7", "mode": "a" }));

        assert_eq!(store.list_widgets().len(), 1);
        assert!(store.widget_file("compteur", "img/logo.png").is_some());
        assert!(store.widget_file("compteur", "../../overlay-config.json").is_none());
        assert!(store.widget_file("../x", "widget.html").is_none());

        // Mise à jour : même id, remplace les fichiers.
        store.install_widget(&widget_zip("compteur", &[])).unwrap();
        assert!(store.widget_file("compteur", "img/logo.png").is_none());

        store.remove_widget("compteur").unwrap();
        assert!(store.list_widgets().is_empty());
        assert!(store.remove_widget("compteur").is_err());
    }

    #[test]
    fn partage_et_sauvegarde_avec_un_widget() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let mut store = Store::open(&config).unwrap();
        store.install_widget(&widget_zip("compteur", &[])).unwrap();
        let id = store.active_profile_id().unwrap().to_string();
        store
            .add_profile_custom_text(&id, "index", &json!({ "type": "widget", "widgetId": "compteur", "name": "Mon widget", "settings": { "titre": "Yo" }, "width": 30 }))
            .unwrap();
        let display = store.effective_display(&id).unwrap();
        assert_eq!(Store::widgets_used_by(&display), ["compteur"]);
        let item = display["customTexts"]["index"].as_object().unwrap().values().next().unwrap().clone();
        assert_eq!((item["widgetId"].as_str(), item["settings"]["titre"].as_str(), item["width"].as_f64()), (Some("compteur"), Some("Yo"), Some(30.0)));

        // Le zip du profil partagé embarque le widget ; un autre PC l'installe à l'import.
        let options = crate::assets::ShareOptions { include_assets: false, ..Default::default() };
        let package = store.share_profile_package(&id, &options).unwrap();
        assert_eq!(Store::package_widgets(&package)[0]["id"], "compteur");
        let other = tempfile::tempdir().unwrap();
        let mut other_store = Store::open(other.path()).unwrap();
        assert_eq!(other_store.install_package_widgets(&package).unwrap().len(), 1);
        assert!(other_store.widget_manifest("compteur").is_some());

        // Sauvegarde / restauration : le widget revient.
        let backups = crate::backup::Backups::new(store.paths());
        let backup = backups.create(crate::backup::Reason::Manual, false).unwrap().unwrap();
        store.remove_widget("compteur").unwrap();
        backups.restore(backup["id"].as_str().unwrap()).unwrap();
        assert!(Store::open(&config).unwrap().widget_manifest("compteur").is_some());
    }

    #[test]
    fn zips_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert!(store.install_widget(b"pas un zip").is_err());
        assert!(store.install_widget(&widget_zip("Majuscules", &[])).is_err());
        let traversal = widget_zip("ok", &[("../../evil.txt", b"x")]);
        assert!(store.install_widget(&traversal).is_err());
        assert!(!dir.path().join("evil.txt").exists());
        // « Zip bomb » : 30 Mo de zéros, quelques Ko une fois compressés.
        let zeros = vec![0u8; 30 * 1024 * 1024];
        let bomb = widget_zip("bombe", &[("gros.bin", &zeros)]);
        assert!(bomb.len() < 1024 * 1024);
        assert!(store.install_widget(&bomb).unwrap_err().to_string().contains("volumineux"));
    }
}
