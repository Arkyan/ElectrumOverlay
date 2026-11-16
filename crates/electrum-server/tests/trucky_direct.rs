//! Trucky répond directement : aucun navigateur ne doit être lancé.

mod trucky_common;
use electrum_server::trucky::info_panel;

#[tokio::test]
async fn panneau_sans_navigateur() {
    // Un chemin de navigateur invalide : si le navigateur était lancé, l'appel échouerait.
    std::env::set_var("CHROME", "/chemin/inexistant/chrome");
    let (_mock, base) = trucky_common::start(false).await;

    let (disabled, _d1) = trucky_common::state(base.clone(), false);
    assert_eq!(info_panel(&disabled).await.unwrap_err(), (404, "Intégration Trucky désactivée".to_string()));

    let (state, _d2) = trucky_common::state(base, true);
    assert_eq!(info_panel(&state).await.unwrap(), trucky_common::expected_panel());
}
