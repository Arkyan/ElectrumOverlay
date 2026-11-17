# 🤝 Contribuer à ElectrumOverlay

> English version below.

Merci de ton intérêt ! Les contributions (bugs, idées, code, traductions) sont les bienvenues.

## Signaler un bug / proposer une idée

Ouvre une issue avec : la version de l'app (barre de titre), Windows 10 ou 11, ce que tu as fait,
ce qui s'est passé, ce qui était attendu, et si possible un extrait des **Logs** de l'app.

## Développer

Prérequis : [Rust](https://rustup.rs/) et la CLI Tauri (une seule fois) :

```bash
cargo install tauri-cli --version "^2" --locked
```

| Commande | Rôle |
|---|---|
| `cargo tauri dev` | lance l'app |
| `cargo test` | tests (cœur, serveur, plugin Stream Deck) |
| `cargo clippy --all-targets` | vérifications |
| `cargo xtask plugin` | construit le plugin Stream Deck dans `dist-rust/` |
| `cargo xtask release` | release (voir [docs/RELEASE-RUST.md](docs/RELEASE-RUST.md)) |

Aucun Node ni npm : tout est en Rust, les pages et overlays sont du HTML/CSS/JS sans dépendance.

### Organisation

```
crates/electrum-core/    config, profils, éditeur de scène, sauvegardes (sans interface)
crates/electrum-server/  serveur HTTP/WebSocket, Twitch, Spotify, Trucky, pages de l'app, traductions
crates/electrum-deck/    plugin Stream Deck (exécutable natif)
src-tauri/               application Windows (fenêtre, icône, mises à jour)
xtask/                   tâches : release, plugin
public/                  overlays OBS
src/config/              valeurs par défaut et thèmes prêts à l'emploi
```

Formats de fichiers : [docs/FORMATS.md](docs/FORMATS.md). Textes de l'interface : en français dans
le code, traduits par `crates/electrum-server/i18n/*.json`.

### Proposer une modification

1. Forke le dépôt et crée une branche.
2. Vérifie `cargo test` et `cargo clippy --all-targets`.
3. Ouvre une Pull Request en expliquant le pourquoi du changement.

---

## English version

Bug reports, ideas and code are welcome. Requirements: Rust and the Tauri CLI
(`cargo install tauri-cli --version "^2" --locked`). Run the app with `cargo tauri dev`, tests with
`cargo test`, lint with `cargo clippy --all-targets`. No Node/npm: everything is Rust; pages and
overlays are plain HTML/CSS/JS. Fork, branch, make sure tests and clippy pass, then open a PR.
