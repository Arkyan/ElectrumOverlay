//! Sons et médias d'alerte par profil, export et import de profil.
//! Port de `setProfileAudio`, `setProfileMedia`, `importProfile`... de `src/config/store.js`
//! et de la route d'export de `src/routes/profiles.js` (voir docs/FORMATS.md §4 et §6).

use crate::error::{Error, Result};
use crate::json::{is_plain_object, is_truthy, js_string_or_empty};
use crate::store::{non_empty_or, remove_file_if_exists, write_bytes_file, ProfileSummary, Store};
use crate::time::now_iso;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

/// Les deux familles de fichiers binaires rattachées à un profil.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    /// Son d'alerte : `profiles/audio/<id>/<type>.<ext>`, clé `audio` du profil.
    Audio,
    /// Image / GIF d'alerte : `profiles/media/<id>/<type>.<ext>`, clé `media` du profil.
    Media,
}

impl AssetKind {
    pub fn key(self) -> &'static str {
        match self {
            AssetKind::Audio => "audio",
            AssetKind::Media => "media",
        }
    }

    fn ext_for_mime(self, mime: &str) -> Option<&'static str> {
        match self {
            AssetKind::Audio => match mime {
                "audio/mpeg" | "audio/mp3" => Some("mp3"),
                "audio/wav" | "audio/x-wav" => Some("wav"),
                "audio/ogg" => Some("ogg"),
                "audio/webm" => Some("weba"),
                "audio/mp4" | "audio/x-m4a" => Some("m4a"),
                "audio/aac" => Some("aac"),
                _ => None,
            },
            AssetKind::Media => match mime {
                "image/png" => Some("png"),
                "image/jpeg" => Some("jpg"),
                "image/webp" => Some("webp"),
                "image/gif" => Some("gif"),
                _ => None,
            },
        }
    }
}

/// Fichier reçu (upload ou import).
pub struct AssetUpload<'a> {
    /// Nom d'origine (peut être vide).
    pub filename: &'a str,
    /// Type MIME (peut être vide).
    pub mime_type: &'a str,
    pub bytes: &'a [u8],
}

/// Métadonnées d'un fichier stocké (`getProfileAudioFilePath` / `getProfileMediaFilePath`).
#[derive(Debug, Clone)]
pub struct AssetFile {
    pub path: PathBuf,
    pub mime_type: String,
    pub filename: String,
    pub updated_at: String,
}

/// Équivalent de `extFor()` : type MIME connu, sinon extension du nom d'origine
/// (`path.extname`), sinon `bin`.
pub fn ext_for(kind: AssetKind, original_name: &str, mime_type: &str) -> String {
    if let Some(ext) = kind.ext_for_mime(mime_type) {
        return ext.to_string();
    }
    let base = original_name.rsplit(['/', '\\']).next().unwrap_or_default();
    match base.rfind('.') {
        Some(0) | None => "bin".to_string(),
        Some(dot) => {
            let ext = base[dot + 1..].to_lowercase();
            if ext.is_empty() { "bin".to_string() } else { ext }
        }
    }
}

/// Décodage base64 aussi tolérant que `Buffer.from(str, 'base64')` : ignore les caractères
/// invalides et les espaces, accepte la variante URL (`-`, `_`), le padding est facultatif.
pub fn decode_base64_lenient(input: &str) -> Vec<u8> {
    let mut cleaned: String = input
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop(); // un caractère isolé ne porte aucun octet complet : Node l'ignore aussi
    }
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(cleaned).unwrap_or_default()
}

/// Fichier de réglages à la racine d'un profil partagé en zip.
pub const PACKAGE_PROFILE_FILE: &str = "profile.json";

/// Options d'un export partagé (`Store::share_profile`).
#[derive(Debug, Clone, Default)]
pub struct ShareOptions<'a> {
    /// Nom donné au profil partagé (`None` ou vide : son nom actuel).
    pub name: Option<&'a str>,
    pub author: &'a str,
    pub description: &'a str,
    /// Inclure les sons et vidéos d'alerte (fichier bien plus lourd).
    pub include_assets: bool,
    pub app_version: &'a str,
}

impl Store {
    fn asset_dir(&self, kind: AssetKind, id: &str) -> PathBuf {
        match kind {
            AssetKind::Audio => self.paths.profile_audio_dir(id),
            AssetKind::Media => self.paths.profile_media_dir(id),
        }
    }

    /// Enregistre (ou remplace) le son / média d'un type d'alerte pour un profil.
    pub fn set_profile_asset(&mut self, kind: AssetKind, id: &str, alert_type: &str, upload: AssetUpload) -> Result<()> {
        if !self.is_alert_type(alert_type) {
            return Err(Error::msg("Type d'alerte inconnu"));
        }
        let dir = self.asset_dir(kind, id);
        let ext = ext_for(kind, upload.filename, upload.mime_type);

        self.update_profile(id, |profile| {
            // Un remplacement peut changer d'extension : supprimer l'ancien fichier.
            if let Some(previous) = profile
                .get(kind.key())
                .and_then(|m| m.get(alert_type))
                .and_then(|e| e.get("ext"))
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                remove_file_if_exists(&dir.join(format!("{alert_type}.{previous}")))?;
            }
            write_bytes_file(&dir.join(format!("{alert_type}.{ext}")), upload.bytes)?;

            let filename = non_empty_or(upload.filename, &format!("{alert_type}.{ext}"));
            let mime_type = non_empty_or(upload.mime_type, "application/octet-stream");
            let entries = crate::json::ensure_object(profile, kind.key());
            entries.insert(
                alert_type.into(),
                json!({ "filename": filename, "mimeType": mime_type, "ext": ext, "updatedAt": now_iso() }),
            );
            Ok(())
        })
    }

    pub fn delete_profile_asset(&mut self, kind: AssetKind, id: &str, alert_type: &str) -> Result<()> {
        let profile = self.get_profile_full(id)?;
        let Some(ext) = profile
            .get(kind.key())
            .and_then(|m| m.get(alert_type))
            .map(|e| js_string_or_empty(e.get("ext")))
        else {
            return Ok(()); // rien à supprimer
        };
        let path = self.asset_dir(kind, id).join(format!("{alert_type}.{ext}"));
        self.update_profile(id, |profile| {
            remove_file_if_exists(&path)?;
            if let Some(entries) = profile.get_mut(kind.key()).and_then(Value::as_object_mut) {
                entries.shift_remove(alert_type);
            }
            Ok(())
        })
    }

    /// Chemin + métadonnées du fichier, ou `None` si aucun n'est configuré (ou profil illisible).
    pub fn profile_asset_file(&self, kind: AssetKind, id: &str, alert_type: &str) -> Option<AssetFile> {
        let profile = self.get_profile_full(id).ok()?;
        let entry = profile.get(kind.key())?.get(alert_type)?;
        let ext = js_string_or_empty(entry.get("ext"));
        Some(AssetFile {
            path: self.asset_dir(kind, id).join(format!("{alert_type}.{ext}")),
            mime_type: js_string_or_empty(entry.get("mimeType")),
            filename: js_string_or_empty(entry.get("filename")),
            updated_at: js_string_or_empty(entry.get("updatedAt")),
        })
    }

    /// Contenu du fichier. Un fichier manquant sur disque est traité comme « pas de fichier ».
    pub fn read_profile_asset(&self, kind: AssetKind, id: &str, alert_type: &str) -> Option<(AssetFile, Vec<u8>)> {
        let info = self.profile_asset_file(kind, id, alert_type)?;
        let bytes = fs::read(&info.path).ok()?;
        Some((info, bytes))
    }

    // ------------------------------------------------------------------------------------------
    // Export / import (*.electrumprofile.json)
    // ------------------------------------------------------------------------------------------

    /// Contenu d'un export de profil (`GET /api/profiles/:id/export`), format `exportVersion: 1`.
    pub fn export_profile(&self, id: &str) -> Result<Value> {
        let profile = self.get_profile_full(id).map_err(|_| Error::msg("Profil introuvable"))?;

        let mut out = Map::new();
        out.insert("exportedFrom".into(), json!("ElectrumOverlay"));
        out.insert("exportVersion".into(), json!(1));
        if let Some(name) = profile.get("name") {
            out.insert("name".into(), name.clone());
        }
        if let Some(display) = profile.get("display") {
            out.insert("display".into(), display.clone());
        }
        for kind in [AssetKind::Audio, AssetKind::Media] {
            let mut entries = Map::new();
            for alert_type in &self.alert_types {
                let Some(entry) = profile.get(kind.key()).and_then(|m| m.get(alert_type)) else { continue };
                let Some((_, bytes)) = self.read_profile_asset(kind, id, alert_type) else { continue };
                let mut exported = Map::new();
                if let Some(v) = entry.get("filename") {
                    exported.insert("filename".into(), v.clone());
                }
                if let Some(v) = entry.get("mimeType") {
                    exported.insert("mimeType".into(), v.clone());
                }
                exported.insert(
                    "dataBase64".into(),
                    json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
                );
                entries.insert(alert_type.clone(), Value::Object(exported));
            }
            out.insert(kind.key().into(), Value::Object(entries));
        }
        Ok(Value::Object(out))
    }

    /// Export destiné à être partagé avec d'autres streamers : même format que `export_profile`
    /// (importable aussi par la version Electron, qui ignore les champs en plus), avec un nom
    /// au choix, l'auteur, une description, et les sons/vidéos en option.
    pub fn share_profile(&self, id: &str, options: &ShareOptions) -> Result<Value> {
        let mut out = self.export_profile(id)?;
        let Value::Object(map) = &mut out else { return Ok(out) };
        if let Some(name) = options.name.map(str::trim).filter(|n| !n.is_empty()) {
            map.insert("name".into(), json!(name));
        }
        if !options.include_assets {
            map.insert(AssetKind::Audio.key().into(), json!({}));
            map.insert(AssetKind::Media.key().into(), json!({}));
        }
        let mut shared = Map::new();
        shared.insert("author".into(), json!(options.author.trim()));
        shared.insert("description".into(), json!(options.description.trim()));
        shared.insert("exportedAt".into(), json!(crate::time::now_iso()));
        shared.insert("appVersion".into(), json!(options.app_version));
        map.insert("shared".into(), Value::Object(shared));
        Ok(out)
    }

    /// Profil partagé sous forme de **zip** (`<nom>.electrumprofile.zip`) : `profile.json` (même
    /// contenu que `share_profile`, sans base64) et les sons/vidéos tels quels dans `audio/` et
    /// `media/`, référencés par `"file"`. Plus léger qu'un JSON (pas de base64), et ouvrable avec
    /// l'explorateur de fichiers.
    pub fn share_profile_package(&self, id: &str, options: &ShareOptions) -> Result<Vec<u8>> {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut payload = self.share_profile(id, &ShareOptions { include_assets: false, ..options.clone() })?;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let zip_error = |e: zip::result::ZipError| Error::msg(format!("Création du zip impossible : {e}"));
        let io_error = |e: std::io::Error| Error::msg(format!("Création du zip impossible : {e}"));
        if options.include_assets {
            let profile = self.get_profile_full(id).map_err(|_| Error::msg("Profil introuvable"))?;
            for kind in [AssetKind::Audio, AssetKind::Media] {
                let mut entries = Map::new();
                for alert_type in &self.alert_types {
                    let Some(entry) = profile.get(kind.key()).and_then(|m| m.get(alert_type)) else { continue };
                    let Some((file, bytes)) = self.read_profile_asset(kind, id, alert_type) else { continue };
                    let ext = file.path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
                    let path = format!("{}/{alert_type}.{ext}", kind.key());
                    // Sons et images sont déjà compressés : stockés tels quels.
                    zip.start_file(&path, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))
                        .map_err(zip_error)?;
                    zip.write_all(&bytes).map_err(io_error)?;
                    let mut exported = Map::new();
                    for key in ["filename", "mimeType"] {
                        if let Some(v) = entry.get(key) {
                            exported.insert(key.into(), v.clone());
                        }
                    }
                    exported.insert("file".into(), json!(path));
                    entries.insert(alert_type.clone(), Value::Object(exported));
                }
                payload[kind.key()] = Value::Object(entries);
            }
        }
        // Widgets personnalisés utilisés par le profil : indispensables à son affichage.
        self.add_widgets_to_package(&mut zip, &payload["display"])?;
        zip.start_file(PACKAGE_PROFILE_FILE, SimpleFileOptions::default()).map_err(zip_error)?;
        zip.write_all(crate::json::to_js_pretty_string(&payload).as_bytes()).map_err(io_error)?;
        Ok(zip.finish().map_err(zip_error)?.into_inner())
    }

    /// Contenu d'un fichier de profil à importer, au format de `export_profile` (sons/vidéos en
    /// base64) : zip (`.electrumprofile.zip`) ou ancien JSON (`.electrumprofile.json`).
    pub fn read_profile_package(bytes: &[u8]) -> Result<Value> {
        if !bytes.starts_with(b"PK\x03\x04") {
            let text = String::from_utf8_lossy(bytes);
            return serde_json::from_str(&text).map_err(|e| Error::msg(e.to_string()));
        }
        let invalid = |e: zip::result::ZipError| Error::msg(format!("zip illisible ({e})"));
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(invalid)?;
        // Plafonds une fois décompressé (un zip piégé peut annoncer une petite taille).
        const SETTINGS_MAX: u64 = 20 * 1024 * 1024;
        const FILES_MAX: u64 = 300 * 1024 * 1024;
        let settings = archive
            .by_name(PACKAGE_PROFILE_FILE)
            .map_err(|_| Error::msg(format!("{PACKAGE_PROFILE_FILE} absent du zip")))?;
        let text = String::from_utf8_lossy(&crate::read_capped(settings, SETTINGS_MAX, PACKAGE_PROFILE_FILE)?).to_string();
        let mut budget = FILES_MAX;
        let mut payload: Value = serde_json::from_str(&text).map_err(|e| Error::msg(e.to_string()))?;
        for kind in [AssetKind::Audio, AssetKind::Media] {
            let Some(Value::Object(entries)) = payload.get_mut(kind.key()) else { continue };
            for entry in entries.values_mut() {
                let Some(path) = entry.get("file").and_then(Value::as_str).map(str::to_string) else { continue };
                let file = archive.by_name(&path).map_err(|_| Error::msg(format!("{path} absent du zip")))?;
                let data = crate::read_capped(file, budget, "profil (sons et vidéos)")?;
                budget -= data.len() as u64;
                if let Value::Object(entry) = entry {
                    entry.remove("file");
                    entry.insert("dataBase64".into(), json!(base64::engine::general_purpose::STANDARD.encode(&data)));
                }
            }
        }
        Ok(payload)
    }

    /// Taille et nombre des sons/vidéos d'un profil (pour la fenêtre de partage).
    pub fn profile_assets_summary(&self, id: &str) -> Result<(usize, u64)> {
        let profile = self.get_profile_full(id).map_err(|_| Error::msg("Profil introuvable"))?;
        let (mut count, mut size) = (0, 0);
        for kind in [AssetKind::Audio, AssetKind::Media] {
            for alert_type in &self.alert_types {
                if profile.get(kind.key()).and_then(|m| m.get(alert_type)).is_none() {
                    continue;
                }
                if let Some(file) = self.profile_asset_file(kind, id, alert_type) {
                    if let Ok(meta) = std::fs::metadata(&file.path) {
                        count += 1;
                        size += meta.len();
                    }
                }
            }
        }
        Ok((count, size))
    }

    /// Nom de fichier proposé au téléchargement : `<nom>.electrumprofile.json`.
    pub fn export_filename(profile_name: &str) -> String {
        let name = if profile_name.is_empty() { "profil" } else { profile_name };
        let mut safe = String::new();
        let mut in_run = false;
        for c in name.chars() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                safe.push(c);
                in_run = false;
            } else if !in_run {
                safe.push('_');
                in_run = true;
            }
        }
        format!("{safe}.electrumprofile.json")
    }

    /// Crée un nouveau profil à partir d'un export (toujours avec un nouvel id).
    pub fn import_profile(&mut self, payload: &Value) -> Result<ProfileSummary> {
        let name = non_empty_or(js_string_or_empty(payload.get("name")).trim(), "Profil importé");
        let display = payload.get("display").filter(|d| is_plain_object(d)).cloned().unwrap_or_else(|| json!({}));
        let created = self.create_profile_with(name, display)?;
        let id = created["id"].as_str().unwrap_or_default().to_string();

        for kind in [AssetKind::Audio, AssetKind::Media] {
            let Some(entries) = payload.get(kind.key()).and_then(Value::as_object) else { continue };
            for (alert_type, entry) in entries {
                if !self.is_alert_type(alert_type) || !is_truthy(Some(entry)) || !is_truthy(entry.get("dataBase64")) {
                    continue;
                }
                let bytes = decode_base64_lenient(entry["dataBase64"].as_str().unwrap_or_default());
                let filename = js_string_or_empty(entry.get("filename"));
                let mime_type = js_string_or_empty(entry.get("mimeType"));
                self.set_profile_asset(kind, &id, alert_type, AssetUpload {
                    filename: &filename,
                    mime_type: &mime_type,
                    bytes: &bytes,
                })?;
            }
        }
        Ok(created)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions() {
        assert_eq!(ext_for(AssetKind::Audio, "x.wav", "audio/mpeg"), "mp3");
        assert_eq!(ext_for(AssetKind::Audio, "Son.FLAC", ""), "flac");
        assert_eq!(ext_for(AssetKind::Audio, ".bashrc", ""), "bin");
        assert_eq!(ext_for(AssetKind::Audio, "sans_extension", ""), "bin");
        assert_eq!(ext_for(AssetKind::Audio, "fin.", ""), "bin");
        assert_eq!(ext_for(AssetKind::Media, "a.png", "image/jpeg"), "jpg");
    }

    #[test]
    fn base64_tolerant() {
        assert_eq!(decode_base64_lenient("aGVsbG8="), b"hello");
        assert_eq!(decode_base64_lenient("aGVs\nbG8"), b"hello");
        assert_eq!(decode_base64_lenient("-_-_"), base64::engine::general_purpose::STANDARD.decode("+/+/").unwrap());
    }

    #[test]
    fn partage_de_profil() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let id = store.active_profile_id().unwrap().to_string();
        store
            .set_profile_asset(AssetKind::Audio, &id, "follow", AssetUpload { filename: "f.mp3", mime_type: "audio/mpeg", bytes: &[1, 2, 3] })
            .unwrap();
        assert_eq!(store.profile_assets_summary(&id).unwrap(), (1, 3));

        let options = ShareOptions { name: Some(" Néon "), author: "arkyan", description: "Thème violet", include_assets: true, app_version: "3.0.0" };
        let shared = store.share_profile(&id, &options).unwrap();
        assert_eq!((shared["name"].as_str(), shared["shared"]["author"].as_str()), (Some("Néon"), Some("arkyan")));
        assert!(shared["audio"]["follow"]["dataBase64"].is_string());
        assert!(shared["display"].is_object());

        let light = store.share_profile(&id, &ShareOptions { include_assets: false, ..options.clone() }).unwrap();
        assert_eq!(light["audio"], json!({}));

        // Réimportable tel quel.
        let imported = store.import_profile(&shared).unwrap();
        assert_eq!(imported["name"], "Néon");

        // Zip : profile.json + le son tel quel, réimportable ; l'ancien JSON reste lisible.
        let package = store.share_profile_package(&id, &options).unwrap();
        assert!(package.starts_with(b"PK"));
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&package)).unwrap();
        assert_eq!(archive.by_name("audio/follow.mp3").unwrap().size(), 3);
        let read = Store::read_profile_package(&package).unwrap();
        assert_eq!(read["audio"]["follow"]["dataBase64"], shared["audio"]["follow"]["dataBase64"]);
        assert!(read["audio"]["follow"].get("file").is_none());
        let imported = store.import_profile(&read).unwrap();
        assert_eq!(store.profile_assets_summary(imported["id"].as_str().unwrap()).unwrap(), (1, 3));
        let legacy = Store::read_profile_package(shared.to_string().as_bytes()).unwrap();
        assert_eq!(legacy["name"], "Néon");
        assert!(Store::read_profile_package(b"PK\x03\x04 pas un zip").is_err());
    }

    #[test]
    fn nom_export() {
        assert_eq!(Store::export_filename("Mon profil été !"), "Mon_profil_t_.electrumprofile.json");
        assert_eq!(Store::export_filename(""), "profil.electrumprofile.json");
    }
}
