//! Cœur d'ElectrumOverlay en Rust : port fidèle de `src/config/store.js`.
//!
//! Le contrat de compatibilité (fichiers sur disque, export de profil, config envoyée aux
//! overlays) est décrit dans `docs/FORMATS.md`. Ce crate n'a aucune dépendance à Tauri ni au
//! serveur HTTP : il se teste seul (`cargo test -p electrum-core`).

pub mod assets;
pub mod backup;
pub mod commands;
pub mod error;
pub mod frontend;
pub mod json;
pub mod paths;
pub mod scene;
pub mod store;
pub mod time;
pub mod widgets;

/// Lit au plus `cap` octets (fichier d'un zip) : un zip piégé peut annoncer une petite taille et
/// se décompresser en plusieurs Go (« zip bomb »).
pub(crate) fn read_capped(reader: impl std::io::Read, cap: u64, what: &str) -> Result<Vec<u8>> {
    use std::io::Read as _;
    let mut data = Vec::new();
    reader.take(cap.saturating_add(1)).read_to_end(&mut data).map_err(|e| Error::msg(e.to_string()))?;
    if data.len() as u64 > cap {
        return Err(Error::msg(format!("{what} trop volumineux une fois décompressé")));
    }
    Ok(data)
}

pub use error::{Error, Result};
pub use store::Store;
