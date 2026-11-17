//! Capture globale clavier/souris pour l'affichage des touches (widget « keys »).
//! Windows uniquement, comme la version Electron. La logique (liste blanche, touches maintenues)
//! est dans `electrum_server::input` ; ici, seulement la capture et son activation.
//!
//! La capture n'est installée qu'à la première activation dans /integrations. Une fois installée,
//! elle ne peut pas être retirée sans quitter l'app (limite de la bibliothèque) : quand
//! l'affichage est désactivé ou le serveur arrêté, plus rien n'est transmis.

use crate::Desktop;
use electrum_server::input::{self as keys, Tracker};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Default)]
struct Shared {
    forwarding: AtomicBool,
    tracker: Mutex<Tracker>,
}

/// Vérifie toutes les 3 s si l'affichage des touches doit être actif (réglage modifiable dans
/// /integrations sans redémarrage), comme `pollInputDisplay()` côté Electron.
pub fn spawn(app: AppHandle) {
    let shared = Arc::new(Shared::default());
    tauri::async_runtime::spawn(async move {
        let (mut hook_started, mut hook_attempted) = (false, false);
        loop {
            let desktop = app.state::<Desktop>();
            let state = desktop.state.clone();
            let should_run = desktop.server_running().await && keys::is_enabled(&state);
            if should_run && !hook_attempted {
                hook_attempted = true;
                hook_started = platform::start(state.clone(), shared.clone());
            }
            let was = shared.forwarding.swap(should_run && hook_started, Ordering::SeqCst);
            if was && !should_run {
                let released = shared.tracker.lock().unwrap_or_else(|p| p.into_inner()).release_all();
                for event in released {
                    keys::broadcast(&state, &event);
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[cfg(windows)]
mod platform {
    use super::Shared;
    use electrum_server::input::{self as keys, Input};
    use electrum_server::AppState;
    use rdev::{Button, EventType, Key};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn key_id(key: Key) -> Option<&'static str> {
        Some(match key {
            Key::KeyW => "W", Key::KeyA => "A", Key::KeyZ => "Z", Key::KeyQ => "Q",
            Key::KeyE => "E", Key::KeyS => "S", Key::KeyD => "D",
            Key::UpArrow => "ArrowUp", Key::DownArrow => "ArrowDown",
            Key::LeftArrow => "ArrowLeft", Key::RightArrow => "ArrowRight",
            Key::Space => "Space",
            Key::ShiftLeft => "ShiftLeft", Key::ShiftRight => "ShiftRight",
            Key::ControlLeft => "ControlLeft", Key::ControlRight => "ControlRight",
            Key::Alt => "AltLeft", Key::AltGr => "AltRight",
            Key::Tab => "Tab", Key::Escape => "Escape", Key::Return => "Enter",
            Key::F1 => "F1", Key::F2 => "F2", Key::F3 => "F3", Key::F4 => "F4",
            Key::F5 => "F5", Key::F6 => "F6", Key::F7 => "F7", Key::F8 => "F8",
            Key::F9 => "F9", Key::F10 => "F10", Key::F11 => "F11", Key::F12 => "F12",
            Key::Num0 => "0", Key::Num1 => "1", Key::Num2 => "2", Key::Num3 => "3", Key::Num4 => "4",
            Key::Num5 => "5", Key::Num6 => "6", Key::Num7 => "7", Key::Num8 => "8", Key::Num9 => "9",
            _ => return None,
        })
    }

    /// Numérotation de uiohook (celle de `MOUSE_BUTTONS`) ; XBUTTON1 = arrière, XBUTTON2 = avant.
    fn mouse_id(button: Button) -> Option<u8> {
        match button {
            Button::Left => Some(1),
            Button::Right => Some(2),
            Button::Middle => Some(3),
            Button::Unknown(1) => Some(4),
            Button::Unknown(2) => Some(5),
            Button::Unknown(_) => None,
        }
    }

    /// Installe la capture sur un fil dédié. `false` si elle n'a pas pu démarrer.
    pub fn start(state: AppState, shared: Arc<Shared>) -> bool {
        let thread = std::thread::Builder::new().name("capture-touches".into()).spawn(move || {
            let callback = move |event: rdev::Event| {
                // Appelé pour CHAQUE événement du système (mouvements de souris compris) : rester
                // le plus léger possible.
                if !shared.forwarding.load(Ordering::Relaxed) {
                    return;
                }
                let (input, down) = match event.event_type {
                    EventType::KeyPress(key) => match key_id(key) { Some(id) => (Input::Key(id), true), None => return },
                    EventType::KeyRelease(key) => match key_id(key) { Some(id) => (Input::Key(id), false), None => return },
                    EventType::ButtonPress(b) => match mouse_id(b) { Some(id) => (Input::Mouse(id), true), None => return },
                    EventType::ButtonRelease(b) => match mouse_id(b) { Some(id) => (Input::Mouse(id), false), None => return },
                    _ => return,
                };
                let change = {
                    let mut tracker = shared.tracker.lock().unwrap_or_else(|p| p.into_inner());
                    if down { tracker.press(input) } else { tracker.release(input) }
                };
                if let Some(change) = change {
                    keys::broadcast(&state, &change);
                }
            };
            if let Err(error) = rdev::listen(callback) {
                eprintln!("❌ Impossible de démarrer la capture clavier/souris : {error:?}");
            }
        });
        thread.is_ok()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Shared;
    use electrum_server::AppState;
    use std::sync::Arc;

    /// Pas de capture hors Windows (comme la version Electron, distribuée pour Windows).
    pub fn start(state: AppState, _shared: Arc<Shared>) -> bool {
        state.log("warn", "⚠️ L'affichage des touches n'est disponible que sous Windows");
        false
    }
}
