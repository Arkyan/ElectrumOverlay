//! Affichage des touches (widget « keys ») : logique de `electron/inputCapture.js`, sans la
//! capture elle-même (qui dépend du système, voir `src-tauri/src/input.rs`).
//!
//! - Seule une liste blanche de touches « jeu » est transmise (jamais les lettres/ponctuation en
//!   général) : rien de ce qui est tapé ailleurs (chat, mots de passe) ne peut fuiter.
//! - Plusieurs touches physiques peuvent partager un libellé (Shift gauche/droit) : le libellé
//!   reste allumé tant qu'au moins une est maintenue.
//! - La répétition automatique du clavier (appuis répétés sans relâchement) est ignorée.

use crate::state::AppState;
use serde_json::json;
use std::collections::{HashMap, HashSet};

/// Touches autorisées : identifiant de touche (indépendant du système) → libellé affiché.
/// W/A et Z/Q sont tous écoutés : la disposition (AZERTY/QWERTY) ne fait que choisir lesquels
/// l'overlay affiche.
pub const ALLOWED_KEYS: &[(&str, &str)] = &[
    ("W", "W"), ("A", "A"), ("Z", "Z"), ("Q", "Q"), ("E", "E"), ("S", "S"), ("D", "D"),
    ("ArrowUp", "↑"), ("ArrowDown", "↓"), ("ArrowLeft", "←"), ("ArrowRight", "→"),
    ("Space", "Espace"),
    ("ShiftLeft", "Shift"), ("ShiftRight", "Shift"),
    ("ControlLeft", "Ctrl"), ("ControlRight", "Ctrl"),
    ("AltLeft", "Alt"), ("AltRight", "Alt"),
    ("Tab", "Tab"), ("Escape", "Échap"), ("Enter", "Entrée"),
    ("F1", "F1"), ("F2", "F2"), ("F3", "F3"), ("F4", "F4"), ("F5", "F5"), ("F6", "F6"),
    ("F7", "F7"), ("F8", "F8"), ("F9", "F9"), ("F10", "F10"), ("F11", "F11"), ("F12", "F12"),
    ("0", "0"), ("1", "1"), ("2", "2"), ("3", "3"), ("4", "4"),
    ("5", "5"), ("6", "6"), ("7", "7"), ("8", "8"), ("9", "9"),
];

/// Boutons de souris (numérotation de uiohook : 1 gauche, 2 droit, 3 molette, 4/5 latéraux).
pub const MOUSE_BUTTONS: &[(u8, &str)] =
    &[(1, "Clic gauche"), (2, "Clic droit"), (3, "Clic molette"), (4, "Bouton arrière"), (5, "Bouton avant")];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Input {
    Key(&'static str),
    Mouse(u8),
}

impl Input {
    fn label(self) -> Option<(&'static str, &'static str)> {
        match self {
            Input::Key(id) => ALLOWED_KEYS.iter().find(|(k, _)| *k == id).map(|(_, label)| (*label, "keyboard")),
            Input::Mouse(button) => MOUSE_BUTTONS.iter().find(|(b, _)| *b == button).map(|(_, label)| (*label, "mouse")),
        }
    }
}

/// Événement à diffuser : `{ type: 'input-key', label, kind, state: 'down' | 'up' }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEvent {
    pub label: &'static str,
    pub kind: &'static str,
    pub down: bool,
}

/// Suivi des touches maintenues.
#[derive(Debug, Default)]
pub struct Tracker {
    held: HashSet<Input>,
    counts: HashMap<&'static str, (u32, &'static str)>,
}

impl Tracker {
    pub fn press(&mut self, input: Input) -> Option<KeyEvent> {
        if !self.held.insert(input) {
            return None; // répétition automatique
        }
        let (label, kind) = input.label()?;
        let entry = self.counts.entry(label).or_insert((0, kind));
        entry.0 += 1;
        (entry.0 == 1).then_some(KeyEvent { label, kind, down: true })
    }

    pub fn release(&mut self, input: Input) -> Option<KeyEvent> {
        self.held.remove(&input);
        let (label, kind) = input.label()?;
        let count = self.counts.get_mut(label)?;
        count.0 = count.0.saturating_sub(1);
        if count.0 > 0 {
            return None;
        }
        self.counts.remove(label);
        Some(KeyEvent { label, kind, down: false })
    }

    /// Tout relâcher (arrêt de la capture) : rien ne doit rester allumé sur l'overlay.
    pub fn release_all(&mut self) -> Vec<KeyEvent> {
        self.held.clear();
        let mut released: Vec<KeyEvent> =
            self.counts.drain().map(|(label, (_, kind))| KeyEvent { label, kind, down: false }).collect();
        released.sort_by_key(|e| e.label);
        released
    }
}

/// Diffuse l'événement aux overlays.
pub fn broadcast(state: &AppState, event: &KeyEvent) {
    let key_state = if event.down { "down" } else { "up" };
    state.broadcast(&json!({ "type": "input-key", "label": event.label, "kind": event.kind, "state": key_state }));
}

/// L'utilisateur a activé l'affichage des touches dans /integrations.
pub fn is_enabled(state: &AppState) -> bool {
    electrum_core::json::is_truthy(state.store().config()["inputDisplay"].get("enabled"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down(label: &'static str, kind: &'static str) -> Option<KeyEvent> {
        Some(KeyEvent { label, kind, down: true })
    }

    fn up(label: &'static str, kind: &'static str) -> Option<KeyEvent> {
        Some(KeyEvent { label, kind, down: false })
    }

    #[test]
    fn appui_maintenu_et_repetition() {
        let mut t = Tracker::default();
        assert_eq!(t.press(Input::Key("W")), down("W", "keyboard"));
        assert_eq!(t.press(Input::Key("W")), None, "répétition automatique ignorée");
        assert_eq!(t.release(Input::Key("W")), up("W", "keyboard"));
        assert_eq!(t.release(Input::Key("W")), None);
    }

    #[test]
    fn deux_touches_un_libelle() {
        let mut t = Tracker::default();
        assert_eq!(t.press(Input::Key("ShiftLeft")), down("Shift", "keyboard"));
        assert_eq!(t.press(Input::Key("ShiftRight")), None, "déjà allumé");
        assert_eq!(t.release(Input::Key("ShiftLeft")), None, "l'autre Shift est encore maintenu");
        assert_eq!(t.release(Input::Key("ShiftRight")), up("Shift", "keyboard"));
    }

    #[test]
    fn touches_hors_liste_jamais_transmises() {
        let mut t = Tracker::default();
        assert_eq!(t.press(Input::Key("P")), None);
        assert_eq!(t.release(Input::Key("P")), None);
        assert_eq!(t.press(Input::Mouse(9)), None);
    }

    #[test]
    fn souris_et_arret() {
        let mut t = Tracker::default();
        assert_eq!(t.press(Input::Mouse(1)), down("Clic gauche", "mouse"));
        t.press(Input::Key("Space"));
        assert_eq!(
            t.release_all(),
            vec![
                KeyEvent { label: "Clic gauche", kind: "mouse", down: false },
                KeyEvent { label: "Espace", kind: "keyboard", down: false }
            ]
        );
        assert_eq!(t.press(Input::Key("Space")), down("Espace", "keyboard"), "repart de zéro après l'arrêt");
    }
}
