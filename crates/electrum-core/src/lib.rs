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

pub use error::{Error, Result};
pub use store::Store;
