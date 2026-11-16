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
crates/electrum-server/    # serveur HTTP + WebSocket des overlays (axum, testable partout)
src-tauri/                 # application Tauri : lance le serveur et ouvre la fenêtre
src/templates/             # modèles HTML partagés par les versions Node et Rust
```

## Lancer

```bash
cargo test
```

```bash
cargo tauri dev
```

`cargo test` lance aussi deux tests de parité avec la version Node (il faut `node` installé,
sinon ils sont ignorés) :

- `crates/electrum-core/tests/node_parity.rs` : le même scénario est joué par
  `src/config/store.js` et par la version Rust, puis les résultats et **tous les fichiers écrits**
  sont comparés octet pour octet (UUID et dates normalisés) ;
- `crates/electrum-server/tests/routes_parity.rs` : les appels de `tests/node/calls.json` sont
  joués sur les vrais handlers de `src/routes/profiles.js` / `settings.js` et sur le serveur Rust ;
  réponses, diffusions WebSocket et config obtenue doivent être identiques ;
- `crates/electrum-server/tests/pages_parity.rs` : la version Node prépare une config réaliste et
  génère les pages ; Rust ouvre le même dossier et doit produire le même HTML, octet pour octet.

### Pages HTML

Le HTML des pages vient des routes Node : `crates/electrum-server/templates/extract.js` l'extrait
dans `templates/pages/*.html`, chaque valeur calculée par le serveur devenant un repère
`{{expr:N}}` rempli par `src/pages/mod.rs`. **Après toute modification d'une page côté Node**,
relance l'extraction puis `cargo test` (le test de parité signale tout écart) :

```bash
node crates/electrum-server/templates/extract.js
```

`cargo tauri dev` ouvre la config existante (`%APPDATA%\ElectrumOverlay\config`, la même que la
version Electron), démarre le serveur sur les ports configurés (8080 / 8081 par défaut) et ouvre
la fenêtre dessus. **Ferme la version Electron avant** : les deux ne peuvent pas utiliser les
mêmes ports en même temps (un message l'indique si c'est le cas).

Les sources OBS existantes (`http://localhost:8080/...`) fonctionnent telles quelles avec la
version Rust.

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
| App Tauri : lance le serveur, ouvre la fenêtre, message clair si un port est pris | ✅ |
| Serveur HTTP : overlays OBS (`public/`), `/js/config.js`, scènes personnalisées | ✅ testé |
| WebSocket vers les overlays (`connected`, `ping`/`pong`, diffusion) | ✅ testé |
| API profils / sons / médias / export / import / éditeur de scène | ✅ testé contre Node |
| API réglages (`POST /api/settings`) | ✅ testé contre Node |
| Outils de test (`/api/tests/trigger`, `/api/panels/:panel/show`), stats du stream | ✅ testé |
| Pages `/app`, `/settings`, `/scene-editor`, `/commands`, `/tests`, `/logs`, `/stream-stats-html` | ✅ HTML identique à Node (testé) |
| Journal `/api/logs` + logs en direct | ✅ |
| Commandes de chat : API, permissions, cooldown, action overlay | ✅ |
| Commandes de chat : réponse dans le chat Twitch | ⏳ (avec Twitch) |
| Pages `/setup`, `/integrations`, autorisation Twitch | ⏳ (avec Twitch / Spotify) |
| Barre de titre de l'app, bouton « Arrêter le serveur » (API `window.electronAPI`) | ⏳ |
| Twitch : OAuth, EventSub **par WebSocket**, chat, badges, viewers | ⏳ |
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
