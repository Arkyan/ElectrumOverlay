//! Config globale et profils : port de `src/config/store.js` (partie config + profils).
//! Les autres parties de store.js sont dans `scene.rs`, `commands.rs`, `assets.rs` et
//! `frontend.rs` (toutes des `impl Store`).
//!
//! Comportement à préserver (docs/FORMATS.md) :
//! - `overlay-config.json` ne contient que les overrides, fusionnés sur `defaults.json` ;
//! - un profil actif dont le `display` est fusionné sur `defaults.display` ;
//! - toute clé inconnue est conservée à la réécriture.

use crate::error::{Error, Result};
use crate::json::{self, merge, to_js_pretty_string};
use crate::paths::ConfigPaths;
use crate::time::now_iso;
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

/// `src/config/defaults.json`, embarqué tel quel : même fichier que la version Node.
pub const DEFAULTS_JSON: &str = include_str!("../../../src/config/defaults.json");
/// `src/config/theme-presets.json`, embarqué tel quel.
pub const THEME_PRESETS_JSON: &str = include_str!("../../../src/config/theme-presets.json");

/// Pages intégrées (clés de `display.themes`, `display.scenes`...).
pub const BUILTIN_PAGE_KEYS: [&str; 4] = ["starting", "index", "pause", "ending"];

/// Résumé d'un profil tel que renvoyé par `GET /api/profiles` : `{ id, name, createdAt, updatedAt }`.
pub type ProfileSummary = Value;

pub struct Store {
    pub(crate) paths: ConfigPaths,
    pub(crate) defaults: Value,
    pub(crate) theme_presets: Value,
    pub(crate) alert_types: Vec<String>,
    /// Config effective (`deepMerge(defaults, overrides)`, avec `display` recalculé depuis le
    /// profil actif) — l'équivalent de l'objet `config` exporté par store.js.
    pub(crate) config: Value,
    /// Cache du profil actif (`activeProfile` dans store.js).
    pub(crate) active_profile: Option<Map<String, Value>>,
}

impl Store {
    /// Ouvre (et migre si besoin) la config située dans `config_dir`.
    /// Équivalent du chargement du module store.js au démarrage.
    pub fn open(config_dir: impl AsRef<Path>) -> Result<Self> {
        let defaults: Value = serde_json::from_str(DEFAULTS_JSON).expect("defaults.json embarqué invalide");
        let theme_presets: Value =
            serde_json::from_str(THEME_PRESETS_JSON).expect("theme-presets.json embarqué invalide");
        let alert_types = defaults["display"]["alerts"]["types"]
            .as_object()
            .map(|types| types.keys().cloned().collect())
            .unwrap_or_default();

        let mut store = Store {
            paths: ConfigPaths::new(config_dir),
            defaults,
            theme_presets,
            alert_types,
            config: Value::Null,
            active_profile: None,
        };
        store.config = merge(&store.defaults, &store.load_overrides());
        store.load_active_profile()?;
        Ok(store)
    }

    /// Ouvre la config à son emplacement standard (voir `paths::default_config_dir`).
    pub fn open_default() -> Result<Self> {
        let dir = crate::paths::default_config_dir()
            .ok_or_else(|| Error::msg("Impossible de déterminer le dossier de configuration"))?;
        Self::open(dir)
    }

    // ------------------------------------------------------------------------------------------
    // Accès
    // ------------------------------------------------------------------------------------------

    /// Config effective complète.
    pub fn config(&self) -> &Value {
        &self.config
    }

    pub fn paths(&self) -> &ConfigPaths {
        &self.paths
    }

    pub fn defaults(&self) -> &Value {
        &self.defaults
    }

    pub fn theme_presets(&self) -> &Value {
        &self.theme_presets
    }

    /// Types d'alerte valides, dérivés de `defaults.display.alerts.types`.
    pub fn alert_types(&self) -> &[String] {
        &self.alert_types
    }

    pub(crate) fn is_alert_type(&self, alert_type: &str) -> bool {
        self.alert_types.iter().any(|t| t == alert_type)
    }

    /// `CLIENT_ID`, `CLIENT_SECRET`, `BROADCASTER_ID` et `USER_ACCESS_TOKEN` tous renseignés.
    pub fn is_configured(&self) -> bool {
        let twitch = &self.config["twitch"];
        ["CLIENT_ID", "CLIENT_SECRET", "BROADCASTER_ID", "USER_ACCESS_TOKEN"]
            .iter()
            .all(|key| json::is_truthy(twitch.get(*key)))
    }

    // ------------------------------------------------------------------------------------------
    // overlay-config.json
    // ------------------------------------------------------------------------------------------

    /// Fichier absent, illisible ou JSON invalide = `{}` (comme le `catch` de loadOverrides).
    pub(crate) fn load_overrides(&self) -> Value {
        match fs::read_to_string(&self.paths.config_file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(value @ Value::Object(_)) => value,
            _ => Value::Object(Map::new()),
        }
    }

    pub(crate) fn write_overrides(&self, overrides: &Value) -> Result<()> {
        write_json_file(&self.paths.config_file, overrides)
    }

    /// Fusionne `partial` dans les overrides sur disque et dans la config en mémoire.
    /// Comme côté Node, ne concerne pas `display` (géré par les profils).
    pub fn save_config(&mut self, partial: &Value) -> Result<()> {
        let overrides = merge(&self.load_overrides(), partial);
        self.write_overrides(&overrides)?;
        self.config = merge(&self.config, partial);
        Ok(())
    }

    // ------------------------------------------------------------------------------------------
    // Profils : fichiers
    // ------------------------------------------------------------------------------------------

    pub(crate) fn profile_file(&self, id: &str) -> Result<PathBuf> {
        check_id(id, "Profil introuvable")?;
        Ok(self.paths.profile_file(id))
    }

    /// Ids de tous les profils (`*.json` de `profiles/`), triés pour un résultat déterministe
    /// (NTFS les renvoie déjà dans cet ordre côté Node).
    pub(crate) fn list_profile_ids(&self) -> Result<Vec<String>> {
        let dir = &self.paths.profiles_dir;
        fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        let mut ids: Vec<String> = fs::read_dir(dir)
            .map_err(|e| Error::io(dir, e))?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
            .collect();
        ids.sort();
        Ok(ids)
    }

    pub(crate) fn read_profile_file(&self, id: &str) -> Result<Map<String, Value>> {
        let path = self.profile_file(id)?;
        let text = fs::read_to_string(&path).map_err(|e| Error::io(&path, e))?;
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Err(Error::msg("Profil invalide")),
            Err(source) => Err(Error::Json { path, source }),
        }
    }

    pub(crate) fn write_profile_file(&self, profile: &Map<String, Value>) -> Result<()> {
        let id = profile.get("id").and_then(Value::as_str).unwrap_or_default();
        let path = self.profile_file(id)?;
        write_json_file(&path, &Value::Object(profile.clone()))
    }

    /// Profil complet (display + audio + media). Le profil actif est lu depuis le cache.
    pub fn get_profile_full(&self, id: &str) -> Result<Map<String, Value>> {
        match &self.active_profile {
            Some(active) if self.active_profile_id() == Some(id) => Ok(active.clone()),
            _ => self.read_profile_file(id),
        }
    }

    /// Applique une modification à un profil, met à jour `updatedAt`, l'écrit sur disque et, si
    /// c'est le profil actif, met à jour le cache et `config.display` (toutes les fonctions
    /// `saveProfile*` / `setProfile*` de store.js suivent ce schéma).
    pub(crate) fn update_profile<T>(
        &mut self,
        id: &str,
        change: impl FnOnce(&mut Map<String, Value>) -> Result<T>,
    ) -> Result<T> {
        let mut profile = self.get_profile_full(id)?;
        let result = change(&mut profile)?;
        profile.insert("updatedAt".into(), Value::String(now_iso()));
        self.write_profile_file(&profile)?;
        if self.active_profile_id() == Some(id) {
            self.active_profile = Some(profile);
            self.recompute_display();
        }
        Ok(result)
    }

    /// Liste des profils triée par nom (`GET /api/profiles`). Un fichier illisible est ignoré.
    pub fn list_profiles(&self) -> Result<Vec<ProfileSummary>> {
        let mut profiles: Vec<Value> = self
            .list_profile_ids()?
            .iter()
            .filter_map(|id| self.read_profile_file(id).ok())
            .map(|profile| summary(&profile))
            .collect();
        profiles.sort_by(|a, b| {
            locale_compare(
                a["name"].as_str().unwrap_or_default(),
                b["name"].as_str().unwrap_or_default(),
            )
        });
        Ok(profiles)
    }

    // ------------------------------------------------------------------------------------------
    // Profil actif
    // ------------------------------------------------------------------------------------------

    pub fn active_profile_id(&self) -> Option<&str> {
        self.active_profile.as_ref().and_then(|p| p.get("id")).and_then(Value::as_str)
    }

    pub(crate) fn recompute_display(&mut self) {
        let profile_display = self
            .active_profile
            .as_ref()
            .and_then(|p| p.get("display"))
            .filter(|d| json::is_truthy(Some(d)))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let display = merge(&self.defaults["display"], &profile_display);
        if let Value::Object(config) = &mut self.config {
            config.insert("display".into(), display);
        }
    }

    /// Chargement (ou migration) du profil actif au démarrage — `loadActiveProfile()`.
    fn load_active_profile(&mut self) -> Result<()> {
        let mut overrides = self.load_overrides();
        let ids = self.list_profile_ids()?;
        let mut id = overrides.get("activeProfileId").and_then(Value::as_str).map(str::to_string);

        if ids.is_empty() {
            // Install neuve, ou mise à jour depuis une version sans profils : le display déjà
            // chargé (défauts + éventuel ancien `display` à la racine) devient le profil "Défaut".
            let now = now_iso();
            let initial_id = new_uuid();
            let mut initial = Map::new();
            initial.insert("id".into(), Value::String(initial_id.clone()));
            initial.insert("name".into(), json!("Défaut"));
            initial.insert("createdAt".into(), Value::String(now.clone()));
            initial.insert("updatedAt".into(), Value::String(now));
            initial.insert("display".into(), self.config["display"].clone());
            initial.insert("audio".into(), json!({}));
            initial.insert("media".into(), json!({}));
            self.write_profile_file(&initial)?;

            if let Value::Object(map) = &mut overrides {
                map.shift_remove("display");
                map.insert("activeProfileId".into(), Value::String(initial_id.clone()));
            }
            self.write_overrides(&overrides)?;
            id = Some(initial_id);

            self.ensure_theme_preset_profiles()?;
        } else if id.as_ref().is_none_or(|id| !ids.contains(id)) {
            let first = ids[0].clone();
            if let Value::Object(map) = &mut overrides {
                map.insert("activeProfileId".into(), Value::String(first.clone()));
            }
            self.write_overrides(&overrides)?;
            id = Some(first);
        }

        let id = id.expect("id de profil actif toujours défini à ce stade");
        self.active_profile = Some(with_assets_maps(self.read_profile_file(&id)?));
        self.recompute_display();
        Ok(())
    }

    pub fn set_active_profile(&mut self, id: &str) -> Result<()> {
        if !self.list_profile_ids()?.iter().any(|p| p == id) {
            return Err(Error::msg("Profil introuvable"));
        }
        let mut overrides = self.load_overrides();
        if let Value::Object(map) = &mut overrides {
            map.insert("activeProfileId".into(), Value::String(id.to_string()));
        }
        self.write_overrides(&overrides)?;
        self.active_profile = Some(with_assets_maps(self.read_profile_file(id)?));
        self.recompute_display();
        Ok(())
    }

    // ------------------------------------------------------------------------------------------
    // Profils : création / renommage / suppression
    // ------------------------------------------------------------------------------------------

    /// Nouveau profil copié du display de `based_on` (ou de l'actif).
    pub fn create_profile(&mut self, name: Option<&Value>, based_on: Option<&str>) -> Result<ProfileSummary> {
        let base_id = based_on
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .or_else(|| self.active_profile_id().map(str::to_string))
            .unwrap_or_default();
        let base = self.get_profile_full(&base_id)?;
        let display = base
            .get("display")
            .filter(|d| json::is_truthy(Some(d)))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let name = non_empty_or(json::js_string_or_empty(name).trim(), "Nouveau profil");
        self.create_profile_with(name, display)
    }

    /// Profil créé depuis un thème de `theme-presets.json` (seul `display.themes` est rempli).
    pub fn create_profile_from_theme_preset(&mut self, preset_name: &str) -> Result<ProfileSummary> {
        let preset = self
            .theme_presets
            .as_array()
            .and_then(|presets| presets.iter().find(|p| p["name"] == preset_name))
            .cloned()
            .ok_or_else(|| Error::msg("Thème inconnu"))?;
        let display = json!({ "themes": preset["themes"].clone() });
        self.create_profile_with(preset_name.to_string(), display)
    }

    /// Crée les profils de thème manquants (comparaison par nom).
    pub fn ensure_theme_preset_profiles(&mut self) -> Result<Vec<ProfileSummary>> {
        let existing: Vec<String> = self
            .list_profiles()?
            .iter()
            .filter_map(|p| p["name"].as_str().map(str::to_string))
            .collect();
        let names: Vec<String> = self
            .theme_presets
            .as_array()
            .map(|presets| presets.iter().filter_map(|p| p["name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let mut created = Vec::new();
        for name in names {
            if !existing.contains(&name) {
                created.push(self.create_profile_from_theme_preset(&name)?);
            }
        }
        Ok(created)
    }

    pub(crate) fn create_profile_with(&mut self, name: String, display: Value) -> Result<ProfileSummary> {
        let now = now_iso();
        let mut profile = Map::new();
        profile.insert("id".into(), Value::String(new_uuid()));
        profile.insert("name".into(), Value::String(name));
        profile.insert("createdAt".into(), Value::String(now.clone()));
        profile.insert("updatedAt".into(), Value::String(now));
        profile.insert("display".into(), display);
        profile.insert("audio".into(), json!({}));
        profile.insert("media".into(), json!({}));
        self.write_profile_file(&profile)?;
        Ok(summary(&profile))
    }

    pub fn rename_profile(&mut self, id: &str, name: Option<&Value>) -> Result<ProfileSummary> {
        let mut profile = self.read_profile_file(id)?;
        let current = profile.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let new_name = non_empty_or(json::js_string_or_empty(name).trim(), &current);
        profile.insert("name".into(), Value::String(new_name.clone()));
        profile.insert("updatedAt".into(), Value::String(now_iso()));
        self.write_profile_file(&profile)?;
        if self.active_profile_id() == Some(id) {
            if let Some(active) = &mut self.active_profile {
                active.insert("name".into(), Value::String(new_name));
            }
        }
        Ok(summary(&profile))
    }

    pub fn delete_profile(&mut self, id: &str) -> Result<()> {
        let ids = self.list_profile_ids()?;
        if ids.len() <= 1 {
            return Err(Error::msg("Impossible de supprimer le dernier profil restant"));
        }
        if self.active_profile_id() == Some(id) {
            return Err(Error::msg(
                "Impossible de supprimer le profil actif — activez-en un autre d'abord",
            ));
        }
        if !ids.iter().any(|p| p == id) {
            return Err(Error::msg("Profil introuvable"));
        }
        remove_file_if_exists(&self.profile_file(id)?)?;
        remove_dir_if_exists(&self.paths.profile_audio_dir(id))?;
        remove_dir_if_exists(&self.paths.profile_media_dir(id))?;
        Ok(())
    }

    // ------------------------------------------------------------------------------------------
    // Display
    // ------------------------------------------------------------------------------------------

    /// Display effectif (défauts + overrides) d'un profil quelconque, actif ou non.
    pub fn effective_display(&self, id: &str) -> Result<Value> {
        let profile = self.get_profile_full(id)?;
        let display = profile
            .get("display")
            .filter(|d| json::is_truthy(Some(d)))
            .cloned()
            .unwrap_or_else(|| json!({}));
        Ok(merge(&self.defaults["display"], &display))
    }

    /// Fusionne `partial` dans le display d'un profil (`saveProfileDisplay`).
    pub fn save_profile_display(&mut self, id: &str, partial: &Value) -> Result<()> {
        self.update_profile(id, |profile| {
            let merged = json::deep_merge(profile.get("display"), Some(partial));
            profile.insert("display".into(), merged);
            Ok(())
        })
    }
}

// ----------------------------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------------------------

pub(crate) fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `{ id, name, createdAt, updatedAt }` (une clé absente reste absente, comme `undefined` en JS).
pub(crate) fn summary(profile: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for key in ["id", "name", "createdAt", "updatedAt"] {
        if let Some(value) = profile.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

/// `audio` / `media` absents ou falsy → `{}` (fait au chargement du profil actif côté Node).
fn with_assets_maps(mut profile: Map<String, Value>) -> Map<String, Value> {
    for key in ["audio", "media"] {
        if !json::is_truthy(profile.get(key)) {
            profile.insert(key.into(), json!({}));
        }
    }
    profile
}

pub(crate) fn non_empty_or(value: &str, fallback: &str) -> String {
    if value.is_empty() { fallback.to_string() } else { value.to_string() }
}

/// Un id issu d'une URL ne doit jamais permettre de sortir du dossier `profiles/`.
/// (La version Node ne le vérifiait pas ; un id légitime est toujours un UUID.)
pub(crate) fn check_id(id: &str, not_found: &str) -> Result<()> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', '\0']) {
        return Err(Error::msg(not_found));
    }
    Ok(())
}

/// Écriture JSON au format `JSON.stringify(x, null, 2)`, via un fichier temporaire renommé
/// ensuite : un crash en pleine écriture ne laisse jamais un fichier de config tronqué.
pub(crate) fn write_json_file(path: &Path, value: &Value) -> Result<()> {
    write_bytes_file(path, to_js_pretty_string(value).as_bytes())
}

pub(crate) fn write_bytes_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(|e| Error::io(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| Error::io(path, e))
}

pub(crate) fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::io(path, e)),
        _ => Ok(()),
    }
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::io(path, e)),
        _ => Ok(()),
    }
}

/// Approximation de `String.prototype.localeCompare` (tri des profils par nom) : on compare
/// d'abord sans accents ni casse, puis avec les accents, puis avec la casse — comme l'ICU.
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    let base = |s: &str| s.chars().map(|c| fold_accent(c).to_lowercase().collect::<String>()).collect::<String>();
    let accents = |s: &str| s.to_lowercase();
    base(a)
        .cmp(&base(b))
        .then_with(|| accents(a).cmp(&accents(b)))
        .then_with(|| b.cmp(a)) // à base égale, l'ICU place la minuscule avant la majuscule
}

fn fold_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'A',
        'ç' => 'c',
        'Ç' => 'C',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' => 'E',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' => 'I',
        'ñ' => 'n',
        'Ñ' => 'N',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'O',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' => 'U',
        'ý' | 'ÿ' => 'y',
        'Ý' => 'Y',
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tri_des_noms_comme_locale_compare() {
        let mut names = vec!["Vert Émeraude", "défaut", "Bleu Cyber", "Écran", "Défaut", "Rouge Braise"];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(names, ["Bleu Cyber", "défaut", "Défaut", "Écran", "Rouge Braise", "Vert Émeraude"]);
    }

    #[test]
    fn ids_dangereux_refuses() {
        for id in ["", "..", "../x", "a/b", "a\\b"] {
            assert!(check_id(id, "Profil introuvable").is_err(), "{id}");
        }
        assert!(check_id("0b6f2d1e-8c1a-4a3e-9d1f-2b3c4d5e6f70", "x").is_ok());
    }
}
