//! État partagé du serveur : config/profils (`electrum-core`), stats du stream et diffusion
//! WebSocket vers les overlays.

use crate::stats::StreamStats;
use crate::twitch::TwitchState;
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
    history: Mutex<crate::history::History>,
    interactions: Mutex<crate::interactions::Interactions>,
    events: broadcast::Sender<String>,
    logs: Mutex<VecDeque<Value>>,
    /// Dernier déclenchement de chaque commande de chat (cooldown, en mémoire seulement).
    pub(crate) command_cooldowns: Mutex<HashMap<String, Instant>>,
    pub assets: Assets,
    pub twitch: TwitchState,
    pub spotify: crate::spotify::SpotifyState,
    /// Base de l'API Trucky (`https://e.truckyapp.com/api/`).
    pub trucky_base: String,
    /// Incrémenté à chaque arrêt du serveur : les overlays connectés se ferment.
    overlays_generation: tokio::sync::watch::Sender<u64>,
    /// Valeur `state` des autorisations OAuth (Twitch, Spotify), tirée au hasard à chaque
    /// lancement : un retour d'autorisation qui ne la porte pas vient d'ailleurs et est refusé.
    pub oauth_state: String,
}

/// URLs des services externes, remplaçables par de faux serveurs dans les tests.
#[derive(Debug, Clone)]
pub struct External {
    pub twitch: crate::twitch::api::Endpoints,
    pub spotify: crate::spotify::Endpoints,
    pub trucky: String,
}

impl Default for External {
    fn default() -> Self {
        External {
            twitch: Default::default(),
            spotify: Default::default(),
            trucky: "https://e.truckyapp.com/api/".into(),
        }
    }
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
        Self::with_external(store, assets, External::default())
    }

    /// Comme `new`, avec des URLs de services externes au choix (faux serveurs dans les tests).
    pub fn with_external(store: Store, assets: Assets, external: External) -> Self {
        let (events, _) = broadcast::channel(256);
        AppState(Arc::new(Inner {
            store: Mutex::new(store),
            stats: Mutex::new(StreamStats::default()),
            history: Mutex::new(Default::default()),
            interactions: Mutex::new(Default::default()),
            events,
            logs: Mutex::new(VecDeque::new()),
            command_cooldowns: Mutex::new(HashMap::new()),
            assets,
            twitch: TwitchState::new(external.twitch),
            spotify: crate::spotify::SpotifyState::new(external.spotify),
            trucky_base: external.trucky,
            overlays_generation: tokio::sync::watch::channel(0).0,
            oauth_state: uuid::Uuid::new_v4().simple().to_string(),
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

    /// Historique des alertes (tableau de bord).
    pub fn history(&self) -> MutexGuard<'_, crate::history::History> {
        self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Objectif, sondage, prédiction, hype train en cours.
    pub fn interactions(&self) -> MutexGuard<'_, crate::interactions::Interactions> {
        self.interactions.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Envoie un message JSON à tous les overlays connectés (`broadcastEvent` côté Node).
    pub fn broadcast(&self, event: &Value) {
        // Aucun abonné = aucun overlay ouvert : pas une erreur.
        let _ = self.events.send(to_js_string(event));
    }

    /// Signal de fermeture des connexions WebSocket des overlays (arrêt du serveur).
    pub fn overlays_closing(&self) -> tokio::sync::watch::Receiver<u64> {
        self.overlays_generation.subscribe()
    }

    /// Ferme toutes les connexions WebSocket des overlays.
    pub fn close_overlays(&self) {
        self.overlays_generation.send_modify(|generation| *generation += 1);
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
