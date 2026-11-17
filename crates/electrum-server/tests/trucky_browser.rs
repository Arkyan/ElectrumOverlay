//! Trucky derrière une vérification « à la Cloudflare » : le navigateur invisible prend le relais.
//! Utilise `CHROME`, sinon un Chromium de test (/opt/pw-browsers), sinon le Chrome ou l'Edge
//! installé. Ignoré si aucun n'est trouvé.

mod trucky_common;
use electrum_server::trucky::info_panel;
use std::sync::atomic::Ordering;

fn test_browser() -> Option<String> {
    if let Ok(path) = std::env::var("CHROME") {
        return Some(path);
    }
    let playwright = std::fs::read_dir("/opt/pw-browsers").ok().and_then(|dir| {
        dir.filter_map(|e| e.ok()).map(|e| e.path().join("chrome-linux64").join("chrome")).find(|p| p.is_file())
    });
    playwright
        .or_else(|| chromiumoxide::detection::default_executable(Default::default()).ok())
        .map(|p| p.display().to_string())
}

#[tokio::test]
async fn panneau_via_navigateur_quand_cloudflare_bloque() {
    let Some(chrome) = test_browser() else {
        eprintln!("⚠️  aucun Chromium de test : test ignoré");
        return;
    };
    std::env::set_var("CHROME", chrome);
    let (mock, base) = trucky_common::start(true).await;
    let (state, _dir) = trucky_common::state(base, true);
    let panel = info_panel(&state).await.unwrap_or_else(|e| panic!("{e:?}"));
    assert_eq!(panel, trucky_common::expected_panel());
    assert_eq!(mock.refused.load(Ordering::SeqCst), 4, "chaque appel direct a bien été bloqué avant le passage au navigateur");
}
