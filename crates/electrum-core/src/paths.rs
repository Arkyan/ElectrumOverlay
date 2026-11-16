//! Emplacement des données utilisateur (voir docs/FORMATS.md §1).

use std::path::{Path, PathBuf};

/// Nom forcé par la version Electron (`app.setName('ElectrumOverlay')`) : c'est lui qui fixe le
/// dossier `userData`. Tauri, lui, se baserait sur l'identifiant de l'app — à ne pas utiliser,
/// sinon la version Rust ne retrouverait pas la config des utilisateurs existants.
pub const APP_DIR_NAME: &str = "ElectrumOverlay";

/// Variable d'environnement déjà utilisée par la version Node pour surcharger le dossier.
pub const CONFIG_DIR_ENV: &str = "ELECTRUM_CONFIG_DIR";

/// Dossier de config par défaut : `ELECTRUM_CONFIG_DIR` s'il est défini, sinon
/// `<dossier de config système>/ElectrumOverlay/config`, soit `%APPDATA%\ElectrumOverlay\config`
/// sous Windows — exactement `app.getPath('userData')/config` côté Electron.
pub fn default_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(CONFIG_DIR_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    dirs::config_dir().map(|base| base.join(APP_DIR_NAME).join("config"))
}

/// Chemins dérivés d'un dossier de config.
#[derive(Debug, Clone)]
pub struct ConfigPaths {
    pub config_dir: PathBuf,
    pub config_file: PathBuf,
    pub profiles_dir: PathBuf,
}

impl ConfigPaths {
    pub fn new(config_dir: impl AsRef<Path>) -> Self {
        let config_dir = config_dir.as_ref().to_path_buf();
        Self {
            config_file: config_dir.join("overlay-config.json"),
            profiles_dir: config_dir.join("profiles"),
            config_dir,
        }
    }

    pub fn profile_file(&self, id: &str) -> PathBuf {
        self.profiles_dir.join(format!("{id}.json"))
    }

    pub fn profile_audio_dir(&self, id: &str) -> PathBuf {
        self.profiles_dir.join("audio").join(id)
    }

    pub fn profile_media_dir(&self, id: &str) -> PathBuf {
        self.profiles_dir.join("media").join(id)
    }
}
