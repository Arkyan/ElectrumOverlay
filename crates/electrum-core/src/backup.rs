//! Sauvegardes de la config (version Rust) : `overlay-config.json` + tous les profils, avec
//! leurs sons et vidéos d'alerte.
//!
//! Emplacement : dossier `backups` à côté du dossier de config
//! (`%APPDATA%\ElectrumOverlay\backups`). Chaque sauvegarde est un dossier daté qui contient une
//! copie des fichiers JSON et un `manifest.json`. Les sons et vidéos, souvent lourds et rarement
//! modifiés, sont rangés une seule fois dans `backups/files/` sous un nom tiré de leur contenu :
//! dix sauvegardes d'un profil avec une vidéo de 50 Mo n'occupent que 50 Mo.
//!
//! Restaurer remplace les profils et les réglages, mais garde les identifiants Twitch et
//! Spotify actuels (un ancien token est souvent expiré ou révoqué). Une sauvegarde « avant
//! restauration » est faite d'abord : une restauration peut toujours être annulée.

use crate::paths::ConfigPaths;
use crate::store::write_bytes_file;
use crate::{Error, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Sauvegardes automatiques gardées (les plus anciennes sont supprimées).
pub const KEEP_AUTO: usize = 10;
/// Sauvegardes manuelles et « avant restauration » gardées.
pub const KEEP_OTHER: usize = 20;
/// Clés de `overlay-config.json` conservées telles quelles lors d'une restauration.
const KEPT_ON_RESTORE: [&str; 2] = ["twitch", "spotify"];

const MANIFEST: &str = "manifest.json";
const POOL: &str = "files";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Auto,
    Manual,
    BeforeRestore,
}

impl Reason {
    fn key(self) -> &'static str {
        match self {
            Reason::Auto => "auto",
            Reason::Manual => "manual",
            Reason::BeforeRestore => "before-restore",
        }
    }
}

/// Dossier des sauvegardes pour une config donnée.
pub fn backups_dir(paths: &ConfigPaths) -> PathBuf {
    match paths.config_dir.parent() {
        Some(parent) => parent.join("backups"),
        None => paths.config_dir.join("backups"),
    }
}

/// Empreinte FNV-1a 64 bits (suffisante, avec la taille, pour reconnaître un fichier identique).
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}-{}", bytes.len())
}

fn io<T>(path: &Path, result: std::io::Result<T>) -> Result<T> {
    result.map_err(|e| Error::io(path, e))
}

/// Tous les fichiers à sauvegarder, en chemins relatifs au dossier de config (séparateur `/`).
fn collect(paths: &ConfigPaths) -> Result<Vec<String>> {
    let mut files = Vec::new();
    if paths.config_file.is_file() {
        files.push("overlay-config.json".to_string());
    }
    fn walk(dir: &Path, prefix: &str, files: &mut Vec<String>) -> Result<()> {
        if !dir.is_dir() {
            return Ok(());
        }
        let mut entries: Vec<_> = io(dir, fs::read_dir(dir))?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            // Fichiers temporaires d'une écriture en cours.
            if name.ends_with(".tmp") {
                continue;
            }
            let relative = format!("{prefix}/{name}");
            let path = entry.path();
            if path.is_dir() {
                walk(&path, &relative, files)?;
            } else {
                files.push(relative);
            }
        }
        Ok(())
    }
    walk(&paths.profiles_dir, "profiles", &mut files)?;
    walk(&crate::widgets::widgets_dir(paths), "widgets", &mut files)?;
    walk(&paths.config_dir.join("branding"), "branding", &mut files)?;
    Ok(files)
}

fn is_json(relative: &str) -> bool {
    relative.ends_with(".json")
}

/// Résumé d'une sauvegarde pour l'interface.
fn summary(id: &str, manifest: &Value) -> Value {
    json!({
        "id": id,
        "createdAt": manifest["createdAt"],
        "reason": manifest["reason"],
        "profiles": manifest["profiles"],
        "files": manifest["files"].as_object().map_or(0, Map::len),
        "size": manifest["size"],
    })
}

pub struct Backups {
    paths: ConfigPaths,
    dir: PathBuf,
}

impl Backups {
    pub fn new(paths: &ConfigPaths) -> Self {
        Backups { paths: paths.clone(), dir: backups_dir(paths) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn read_manifest(&self, id: &str) -> Option<Value> {
        let text = fs::read_to_string(self.dir.join(id).join(MANIFEST)).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Sauvegardes, de la plus récente à la plus ancienne.
    pub fn list(&self) -> Vec<Value> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        let ids: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name != POOL)
            .collect();
        let mut backups: Vec<Value> = ids.iter().filter_map(|id| self.read_manifest(id).map(|m| summary(id, &m))).collect();
        // Date ISO UTC à la milliseconde : l'ordre alphabétique est l'ordre chronologique.
        backups.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
        backups
    }

    /// Empreinte de l'état actuel (pour ne pas refaire une sauvegarde identique).
    fn current_state(&self) -> Result<(Vec<String>, Map<String, Value>, u64)> {
        let files = collect(&self.paths)?;
        let mut prints = Map::new();
        let mut size = 0;
        for relative in &files {
            let path = self.paths.config_dir.join(relative);
            let bytes = io(&path, fs::read(&path))?;
            size += bytes.len() as u64;
            prints.insert(relative.clone(), Value::String(fingerprint(&bytes)));
        }
        Ok((files, prints, size))
    }

    /// Crée une sauvegarde. `None` si `skip_if_unchanged` et que rien n'a changé depuis la
    /// dernière.
    pub fn create(&self, reason: Reason, skip_if_unchanged: bool) -> Result<Option<Value>> {
        let created = self.create_without_pruning(reason, skip_if_unchanged)?;
        if created.is_some() {
            self.prune()?;
        }
        Ok(created)
    }

    fn create_without_pruning(&self, reason: Reason, skip_if_unchanged: bool) -> Result<Option<Value>> {
        let (files, prints, size) = self.current_state()?;
        if files.is_empty() {
            return Ok(None);
        }
        if skip_if_unchanged {
            if let Some(latest) = self.list().first().and_then(|s| self.read_manifest(s["id"].as_str()?)) {
                if latest["files"] == Value::Object(prints.clone()) {
                    return Ok(None);
                }
            }
        }

        let now = chrono::Local::now();
        let mut id = now.format("%Y-%m-%d_%H-%M-%S").to_string();
        let mut n = 1;
        while self.dir.join(&id).exists() {
            n += 1;
            id = format!("{}-{n}", now.format("%Y-%m-%d_%H-%M-%S"));
        }
        let target = self.dir.join(&id);
        let pool = self.dir.join(POOL);
        for relative in &files {
            let source = self.paths.config_dir.join(relative);
            let bytes = io(&source, fs::read(&source))?;
            if is_json(relative) {
                write_bytes_file(&target.join(relative), &bytes)?;
            } else {
                let stored = pool.join(prints[relative].as_str().unwrap_or_default());
                if !stored.exists() {
                    write_bytes_file(&stored, &bytes)?;
                }
            }
        }
        let profiles: Vec<Value> = files
            .iter()
            .filter(|f| f.starts_with("profiles/") && f.matches('/').count() == 1 && is_json(f))
            .filter_map(|f| {
                let text = fs::read_to_string(target.join(f)).ok()?;
                let profile: Value = serde_json::from_str(&text).ok()?;
                profile.get("name").cloned()
            })
            .collect();
        let manifest = json!({
            "version": 1,
            "createdAt": crate::time::now_iso(),
            "reason": reason.key(),
            "profiles": profiles,
            "size": size,
            "files": prints,
        });
        // Le manifeste en dernier : une sauvegarde interrompue n'apparaît pas dans la liste.
        write_bytes_file(&target.join(MANIFEST), serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes())?;
        Ok(Some(summary(&id, &manifest)))
    }

    /// Supprime une sauvegarde.
    pub fn delete(&self, id: &str) -> Result<()> {
        let dir = self.checked(id)?;
        io(&dir, fs::remove_dir_all(&dir))?;
        self.collect_garbage()
    }

    fn checked(&self, id: &str) -> Result<PathBuf> {
        let valid = !id.is_empty() && id != POOL && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let dir = self.dir.join(id);
        if !valid || !dir.join(MANIFEST).is_file() {
            return Err(Error::msg("Sauvegarde introuvable"));
        }
        Ok(dir)
    }

    /// Remet la config dans l'état d'une sauvegarde (après en avoir fait une de l'état actuel).
    /// Les identifiants Twitch/Spotify actuels sont gardés. Il faut ensuite rouvrir le `Store`.
    pub fn restore(&self, id: &str) -> Result<()> {
        let source = self.checked(id)?;
        let manifest = self.read_manifest(id).ok_or_else(|| Error::msg("Sauvegarde illisible"))?;
        let files = manifest["files"].as_object().cloned().unwrap_or_default();
        // Tout vérifier avant de toucher à quoi que ce soit.
        let pool = self.dir.join(POOL);
        for (relative, print) in &files {
            let path = if is_json(relative) { source.join(relative) } else { pool.join(print.as_str().unwrap_or_default()) };
            if !path.is_file() || relative.contains("..") {
                return Err(Error::msg(format!("Sauvegarde incomplète : {relative} manquant")));
            }
        }

        // Sans rotation tout de suite : elle pourrait supprimer la sauvegarde qu'on restaure.
        self.create_without_pruning(Reason::BeforeRestore, false)?;

        // overlay-config.json : réglages de la sauvegarde, identifiants actuels.
        let current: Value = fs::read_to_string(&self.paths.config_file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));
        let mut restored: Value = match files.get("overlay-config.json") {
            Some(_) => {
                let path = source.join("overlay-config.json");
                serde_json::from_str(&io(&path, fs::read_to_string(&path))?).unwrap_or_else(|_| json!({}))
            }
            None => json!({}),
        };
        if let (Value::Object(restored), Value::Object(current)) = (&mut restored, &current) {
            for key in KEPT_ON_RESTORE {
                match current.get(key) {
                    Some(value) => restored.insert(key.to_string(), value.clone()),
                    None => restored.remove(key),
                };
            }
        }

        // Profils : on repart de zéro (un profil créé depuis disparaît, il est dans la
        // sauvegarde « avant restauration »).
        if self.paths.profiles_dir.exists() {
            io(&self.paths.profiles_dir, fs::remove_dir_all(&self.paths.profiles_dir))?;
        }
        // Widgets personnalisés et logo : remis comme dans la sauvegarde.
        for dir in [crate::widgets::widgets_dir(&self.paths), self.paths.config_dir.join("branding")] {
            if dir.exists() {
                io(&dir, fs::remove_dir_all(&dir))?;
            }
        }
        for (relative, print) in &files {
            if relative == "overlay-config.json" {
                continue;
            }
            let from = if is_json(relative) { source.join(relative) } else { pool.join(print.as_str().unwrap_or_default()) };
            let bytes = io(&from, fs::read(&from))?;
            write_bytes_file(&self.paths.config_dir.join(relative), &bytes)?;
        }
        write_bytes_file(&self.paths.config_file, crate::json::to_js_pretty_string(&restored).as_bytes())?;
        self.prune()
    }

    /// Garde les `KEEP_AUTO` dernières sauvegardes automatiques et les `KEEP_OTHER` dernières
    /// autres, puis supprime les sons/vidéos qui ne servent plus à aucune sauvegarde.
    fn prune(&self) -> Result<()> {
        let (mut auto, mut other) = (0, 0);
        for backup in self.list() {
            let counter = if backup["reason"] == "auto" { &mut auto } else { &mut other };
            *counter += 1;
            let limit = if backup["reason"] == "auto" { KEEP_AUTO } else { KEEP_OTHER };
            if *counter > limit {
                let dir = self.dir.join(backup["id"].as_str().unwrap_or_default());
                io(&dir, fs::remove_dir_all(&dir))?;
            }
        }
        self.collect_garbage()
    }

    fn collect_garbage(&self) -> Result<()> {
        let pool = self.dir.join(POOL);
        let Ok(entries) = fs::read_dir(&pool) else { return Ok(()) };
        let used: std::collections::HashSet<String> = self
            .list()
            .iter()
            .filter_map(|b| self.read_manifest(b["id"].as_str()?))
            .flat_map(|m| m["files"].as_object().cloned().unwrap_or_default().into_values())
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        for entry in entries.filter_map(|e| e.ok()) {
            if !used.contains(&*entry.file_name().to_string_lossy()) {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    /// Date de la dernière sauvegarde automatique (pour savoir s'il en faut une nouvelle).
    pub fn last_auto(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        self.list()
            .iter()
            .find(|b| b["reason"] == "auto")
            .and_then(|b| b["createdAt"].as_str().and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok()))
            .map(|d| d.with_timezone(&chrono::Utc))
    }

    /// Sauvegarde automatique si la dernière date de plus de `every` et que quelque chose a
    /// changé depuis.
    pub fn auto_if_due(&self, every: chrono::Duration) -> Result<Option<Value>> {
        if self.last_auto().is_some_and(|last| chrono::Utc::now() - last < every) {
            return Ok(None);
        }
        self.create(Reason::Auto, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    #[test]
    fn sauvegarde_dedoublonnage_restauration() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("config");
        let mut store = Store::open(&config_dir).unwrap();
        store.save_config(&json!({ "twitch": { "USER_ACCESS_TOKEN": "ancien" }, "chat": { "x": 1 } })).unwrap();
        let paths = store.paths().clone();
        let video = paths.profile_media_dir("p1").join("follow.mp4");
        write_bytes_file(&video, &[7u8; 5000]).unwrap();

        let backups = Backups::new(&paths);
        assert_eq!(backups.dir(), root.path().join("backups"));
        let first = backups.create(Reason::Manual, false).unwrap().unwrap();
        assert_eq!(first["reason"], "manual");
        assert!(!first["profiles"].as_array().unwrap().is_empty());
        // Rien n'a changé : pas de deuxième sauvegarde automatique identique.
        assert!(backups.create(Reason::Auto, true).unwrap().is_none());

        // Deuxième sauvegarde : la vidéo n'est stockée qu'une fois.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        store.save_config(&json!({ "chat": { "x": 2 } })).unwrap();
        backups.create(Reason::Auto, true).unwrap().unwrap();
        assert_eq!(fs::read_dir(backups.dir().join(POOL)).unwrap().count(), 1);
        assert_eq!(backups.list().len(), 2);

        // Changements, puis restauration de la première : réglages et vidéo reviennent, le
        // token actuel est gardé, et l'état d'avant est sauvegardé.
        store.save_config(&json!({ "twitch": { "USER_ACCESS_TOKEN": "nouveau" }, "chat": { "x": 3 } })).unwrap();
        fs::remove_file(&video).unwrap();
        let profile = store.create_profile(Some(&json!("Créé après")), None).unwrap();
        backups.restore(first["id"].as_str().unwrap()).unwrap();
        let store = Store::open(&config_dir).unwrap();
        assert_eq!(store.config()["chat"]["x"], 1);
        assert_eq!(store.config()["twitch"]["USER_ACCESS_TOKEN"], "nouveau");
        assert_eq!(fs::read(&video).unwrap().len(), 5000);
        assert!(!store.list_profiles().unwrap().iter().any(|p| p["id"] == profile["id"]));
        assert_eq!(backups.list()[0]["reason"], "before-restore");

        assert!(backups.restore("../config").is_err());
        assert!(backups.restore("files").is_err());
        backups.delete(first["id"].as_str().unwrap()).unwrap();
        assert_eq!(backups.list().len(), 2);
    }

    #[test]
    fn rotation_des_sauvegardes_automatiques() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path().join("config")).unwrap();
        let backups = Backups::new(store.paths());
        for i in 0..(KEEP_AUTO + 3) {
            store.save_config(&json!({ "n": i })).unwrap();
            // Noms datés à la seconde : on force des dossiers distincts.
            backups.create(Reason::Auto, true).unwrap().unwrap();
        }
        assert_eq!(backups.list().len(), KEEP_AUTO);
        assert!(backups.auto_if_due(chrono::Duration::hours(24)).unwrap().is_none(), "dernière sauvegarde trop récente");
    }
}
