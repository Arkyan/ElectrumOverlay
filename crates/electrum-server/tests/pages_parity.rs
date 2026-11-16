//! Parité des pages HTML avec la version Node.
//!
//! `tests/node/pages_scenario.js` prépare une config réaliste avec la vraie version Node
//! (profils, sons, médias, scènes, commandes, caractères spéciaux) et génère les pages avec les
//! vrais handlers. Rust ouvre ensuite LE MÊME dossier de config et doit produire exactement le
//! même HTML, octet pour octet.

use axum::body::Body;
use axum::http::Request;
use electrum_core::Store;
use electrum_server::{http_router, AppState, Assets};
use http_body_util::BodyExt;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tower::ServiceExt;

fn here() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

/// Premier écart, avec un peu de contexte, pour un diagnostic lisible.
fn first_difference(a: &str, b: &str) -> String {
    let i = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
    let around = |s: &str| {
        let start = s.floor_char_boundary(i.saturating_sub(120));
        let end = s.ceil_char_boundary((i + 120).min(s.len()));
        s[start..end].to_string()
    };
    format!("à l'octet {i}\n--- Rust ---\n{}\n--- Node ---\n{}", around(a), around(b))
}

#[tokio::test]
async fn memes_pages_que_la_version_node() {
    if !Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success()) {
        eprintln!("⚠️  node introuvable : test de parité des pages ignoré");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new("node")
        .arg(here().join("tests").join("node").join("pages_scenario.js"))
        .env("ELECTRUM_CONFIG_DIR", dir.path())
        .output()
        .expect("lancement de node");
    assert!(output.status.success(), "pages_scenario.js a échoué :\n{}", String::from_utf8_lossy(&output.stderr));
    let node: Value = serde_json::from_slice(&output.stdout).unwrap();
    let other = node["other"].as_str().unwrap();

    let repo = here().join("..").join("..");
    let mut store = Store::open(dir.path()).unwrap();
    // Config Twitch complète : sinon toutes les pages redirigent vers /setup (comme côté Node).
    store.save_config(&serde_json::json!({ "twitch": { "CLIENT_ID": "test", "CLIENT_SECRET": "s", "BROADCASTER_ID": "1", "USER_ACCESS_TOKEN": "t" } })).unwrap();
    let state = AppState::new(
        store,
        Assets { public_dir: repo.join("public"), templates_dir: repo.join("src").join("templates") },
    );

    let pages = node["pages"].as_object().unwrap();
    assert_eq!(pages.len(), 8);
    for (name, expected) in pages {
        let uri = format!("/{}", name.replace("?profile=other", &format!("?profile={other}")));
        let response = http_router(state.clone()).oneshot(Request::get(&uri).body(Body::empty()).unwrap()).await.unwrap();
        assert!(response.status().is_success(), "{uri} → {}", response.status());
        let html = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        let expected = expected.as_str().unwrap();
        assert!(html == expected, "page {uri} différente {}", first_difference(&html, expected));
    }
}
