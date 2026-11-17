# ElectrumOverlay Deck — plugin Stream Deck

Pilote [ElectrumOverlay](../README.md) depuis un Stream Deck :

- **Alerte de test** : follow, sub, raid, bits… (comme la page Tests) ;
- **Activer un profil** : la touche indique en direct si le profil est actif ;
- **Afficher un panneau** : panneau gauche ou bandeau bas ;
- **Statistiques en direct** : viewers, follows, abonnés ou messages.

## Organisation

- `com.electrumvtc.overlay.streamdeck.sdPlugin/` : manifeste, icônes et fenêtres de réglage
  (HTML) ;
- le programme du plugin est l'exécutable natif `electrum-deck.exe`, compilé depuis
  [`crates/electrum-deck`](../crates/electrum-deck) (Rust, aucun Node.js).

## Construire

```bash
cargo xtask plugin
```

Produit `dist-rust/com.electrumvtc.overlay.streamdeck.streamDeckPlugin` : double-clique dessus pour
l'installer dans Stream Deck. `cargo xtask release` le construit et le joint à chaque release.

Tests (faux Stream Deck + fausse API) : `cargo test -p electrum-deck`.

ElectrumOverlay doit être lancé pour que les touches aient quelque chose à joindre
(`localhost:8080` par défaut, réglable par touche).
