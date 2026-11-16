//! État partagé du serveur : config/profils (`electrum-core`), stats du stream et diffusion
//! WebSocket vers les overlays.

use crate::stats::StreamStats;
use electrum_core::json::to_js_string;
use electrum_core::Store;
use serde_json::{json, Value};
use std::ops::Deref;
use std::path::PathBuf;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
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
    logs: Mutex<VecDeque<Value>>,
    /// Dernier déclenchement de chaque commande de chat (cooldown, en mémoire seulement).
    pub(crate) command_cooldowns: Mutex<HashMap<String, Instant>>,
    pub assets: Assets,
}

/// Nombre de lignes de logs conservées pour /logs (comme LogBuffer côté Node).
const MAX_LOG_LINES: usize = 500;

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
            logs: Mutex::new(VecDeque::new()),
            command_cooldowns: Mutex::new(HashMap::new()),
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

    /// Écrit une ligne de log : console, historique de /logs et diffusion en direct
    /// (`{ type: 'log', level, text, time }`, comme LogBuffer côté Node).
    /// `level` : `info`, `warn` ou `error`.
    pub fn log(&self, level: &str, text: impl Into<String>) {
        let text = text.into();
        if level == "info" { println!("{text}") } else { eprintln!("{text}") }
        let entry = json!({ "level": level, "text": text, "time": electrum_core::time::now_iso() });
        {
            let mut logs = self.logs.lock().unwrap_or_else(|p| p.into_inner());
            logs.push_back(entry.clone());
            while logs.len() > MAX_LOG_LINES {
                logs.pop_front();
            }
        }
        let mut event = json!({ "type": "log" });
        if let (Value::Object(target), Value::Object(fields)) = (&mut event, entry) {
            target.extend(fields);
        }
        self.broadcast(&event);
    }

    /// Historique des logs (`GET /api/logs`).
    pub fn log_lines(&self) -> Vec<Value> {
        self.logs.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
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
