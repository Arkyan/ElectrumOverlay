// Pas de console noire derrière la fenêtre en version release sous Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    electrum_overlay_lib::run()
}
