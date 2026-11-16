# Migration vers Rust (Tauri)

Branche : `migration/rust`. L'app Node/Electron continue de fonctionner normalement pendant
toute la migration : le code Rust vit à côté (`crates/`, `src-tauri/`) et n'est pas inclus dans
le build Electron.

Le contrat à respecter (fichiers sur disque, export de profil, API, WebSocket) est dans
[`FORMATS.md`](FORMATS.md).

## Organisation

```
Cargo.toml                 # workspace Rust
crates/electrum-core/      # cœur sans interface : config, profils, formats (testable partout)
src-tauri/                 # application Tauri (fenêtre, plus tard serveur HTTP/WebSocket)
```

## Lancer

```bash
cargo test
```

```bash
cargo tauri dev
```

`cargo test` lance aussi `crates/electrum-core/tests/node_parity.rs` : le même scénario est joué
par la vraie version Node (`src/config/store.js`) et par la version Rust, puis les résultats et
**tous les fichiers écrits** sont comparés octet pour octet (UUID et dates normalisés). Il faut
`node` installé, sinon ce test est ignoré.

`cargo tauri dev` ouvre la config existante (`%APPDATA%\ElectrumOverlay\config`, la même que la
version Electron) et affiche dans le terminal le dossier, le profil actif et l'état de la config.

⚠️ La version Rust lit **et écrit** dans ce dossier (migration au premier lancement, comme la
version Node). Fais une sauvegarde de `%APPDATA%\ElectrumOverlay\config` avant, ou fais pointer
la version Rust vers une copie :

```bash
$env:ELECTRUM_CONFIG_DIR = "C:\chemin\vers\une\copie\config"
```

## Avancement

| Étape | État |
|---|---|
| Config globale (`overlay-config.json`, fusion avec `defaults.json`) | ✅ porté, testé contre Node |
| Profils (création, migration, thèmes prêts à l'emploi, activation, suppression) | ✅ porté, testé contre Node |
| Éditeur de scène (layout, textes, styles, éléments, scènes) | ✅ porté, testé contre Node |
| Commandes de chat | ✅ porté, testé contre Node |
| Sons / médias d'alerte, export / import de profil | ✅ porté, testé contre Node |
| Config des overlays (`/js/config.js`, `config-updated`) | ✅ porté, testé contre Node |
| Squelette de l'app Tauri | ✅ (à valider sous Windows) |
| Serveur HTTP (overlays OBS, routes API, pages web) | ⏳ |
| WebSocket vers les overlays | ⏳ |
| Twitch : OAuth, EventSub **par WebSocket**, chat, badges, viewers | ⏳ |
| Statistiques du stream | ⏳ |
| Spotify | ⏳ |
| Trucky (contournement Cloudflare) | ⏳ |
| Capture clavier (affichage des touches) | ⏳ |
| Icône de la barre des tâches, mises à jour automatiques | ⏳ |
| Reprise de la config par l'installateur, première release Rust | ⏳ |

## Différences volontaires avec la version Node

- Les fichiers JSON sont écrits via un fichier temporaire renommé ensuite : un crash en pleine
  écriture ne laisse plus de fichier tronqué. Le contenu écrit est identique.
- Un id de profil contenant `/`, `\` ou `..` est refusé (« Profil introuvable ») : il ne peut
  plus servir à lire ou écrire en dehors du dossier `profiles/`.
- Un fichier son/média manquant sur disque est ignoré à l'export au lieu de faire échouer
  l'export entier.
