//! État partagé du serveur : config/profils (`electrum-core`), stats du stream et diffusion
//! WebSocket vers les overlays.

use crate::stats::StreamStats;
use electrum_core::json::to_js_string;
use electrum_core::Store;
use serde_json::{json, Value};
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::broadcast;

/// Emplacement des fichiers servis.
#[derive(Debug, Clone)]
pub struct Assets {
    /// Dossier `public/` (overlays OBS, CSS, JS, polices).
    pub public_dir: PathBuf,
    /// Dossier `src/templates/` (modèles HTML partagés avec la version Node).
    pub templates_dir: PathBuf,
}

pub struct Inner {
    store: Mutex<Store>,
    stats: Mutex<StreamStats>,
    events: broadcast::Sender<String>,
    pub assets: Assets,
}

/// Poignée clonable vers l'état (une par requête).
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(store: Store, assets: Assets) -> Self {
        let (events, _) = broadcast::channel(256);
        AppState(Arc::new(Inner {
            store: Mutex::new(store),
            stats: Mutex::new(StreamStats::default()),
            events,
            assets,
        }))
    }

    /// Accès à la config. Un verrou « empoisonné » (panique pendant une écriture) est récupéré
    /// plutôt que de rendre tout le serveur inutilisable.
    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn stats(&self) -> MutexGuard<'_, StreamStats> {
        self.stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Envoie un message JSON à tous les overlays connectés (`broadcastEvent` côté Node).
    pub fn broadcast(&self, event: &Value) {
        // Aucun abonné = aucun overlay ouvert : pas une erreur.
        let _ = self.events.send(to_js_string(event));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    /// `config-updated` avec la config du profil actif.
    pub fn broadcast_config(&self) {
        let config = self.store().to_frontend_config();
        self.broadcast(&json!({ "type": "config-updated", "config": config }));
    }

    /// `config-updated` seulement si `profile_id` est le profil actif : modifier un profil qu'on
    /// ne fait que consulter ne doit rien changer en direct.
    pub fn broadcast_config_if_active(&self, profile_id: &str) {
        let is_active = self.store().active_profile_id() == Some(profile_id);
        if is_active {
            self.broadcast_config();
        }
    }
}
