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
- les pages de l'app (HTML) ne sont plus comparées à Node depuis la refonte de l'interface
  (voir plus bas) : elles appartiennent désormais à la version Rust.

`crates/electrum-server/tests/eventsub.rs` fait tourner la connexion EventSub contre un faux
serveur Twitch local qui joue le protocole officiel : création des abonnements, notification en
double, `session_reconnect`, keepalive dépassé, token refusé puis ré-autorisation.

### Interface de l'app

Depuis la refonte (style « outil pro », façon OBS), les pages de l'app appartiennent à la version
Rust : `crates/electrum-server/templates/pages/*.html` (contenu), `src/pages/shell.rs` (barre de
titre, barre latérale, icônes) et `public/css/app-v3.css` (styles). La version Electron garde son
ancienne interface (`app-ui.css`) jusqu'à la bascule. Les overlays OBS ne changent pas.

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
| Pages de l'app | ✅ nouvelle interface (barre latérale, tableau de bord) |
| Journal `/api/logs` + logs en direct | ✅ |
| Commandes de chat : API, permissions, cooldown, action overlay | ✅ |
| Commandes de chat : réponse dans le chat Twitch (écho ignoré) | ✅ (à valider avec un vrai compte) |
| **EventSub par WebSocket** : plus de ngrok ni de webhooks | ✅ testé contre un faux Twitch (à valider avec un vrai compte) |
| Assistant `/setup` (sans ngrok), `/auth-url`, `/auth-callback`, `/api/oauth-callback` | ✅ |
| Redirection vers `/setup` tant que Twitch n'est pas configuré | ✅ |
| `/status`, `/subscriptions`, badges, nombre de viewers | ✅ |
| Liens externes (Twitch, Spotify...) ouverts dans le navigateur | ✅ |
| Spotify : connexion du compte, renouvellement du token, morceau en cours | ✅ testé contre un faux Spotify (à valider avec un vrai compte) |
| Page `/integrations` (Spotify, Trucky, affichage des touches) | ✅ |
| Trucky `/api/info-panel` : HTTP direct, navigateur invisible si Cloudflare bloque | ✅ testé (faux Trucky + Chromium) |
| Affichage des touches : capture clavier/souris (Windows) | ✅ logique testée, compile pour Windows (à valider en jeu) |
| Instance unique, fenêtre sans bordure + barre de titre maison | ✅ |
| Pont `window.electronAPI` (barre de titre, bouton « Arrêter le serveur », bannière de mise à jour) | ✅ testé dans Chromium sur les vraies pages |
| Fermer = cacher ; icône de la zone de notification avec menu | ✅ |
| Arrêt / redémarrage du serveur (ports libérés, overlays déconnectés) | ✅ testé |
| Mises à jour automatiques (signées), entrée « Installer la mise à jour » dans le menu | ✅ (clé de signature à générer, voir RELEASE-RUST.md) |
| Installateur : désinstalle l'ancienne version Electron, reprend la config | ✅ testé sous Wine |
| Script de release (installateur, `latest.json`, `latest.yml` pour la bascule Electron) | ✅ `latest.yml` vérifié avec electron-updater |
| Première pré-version Rust, test réel de la bascule 2.5.2 → 3.0 | ⏳ voir [RELEASE-RUST.md](RELEASE-RUST.md) |

## Différences volontaires avec la version Node

- **Twitch par EventSub WebSocket** au lieu des webhooks : ngrok, son authtoken et le secret de
  webhook ne servent plus. Leurs valeurs restent dans `overlay-config.json` (ignorées) pour
  pouvoir revenir à la version Electron pendant la transition. Les pages Rust n'en parlent plus
  (liste des changements dans `crates/electrum-server/src/pages/changes.rs`, vérifiée par les tests).
- Au démarrage, le token Twitch est vérifié : message clair s'il est expiré, s'il vient d'une
  autre application Twitch, ou s'il manque des autorisations (scopes).
- L'assistant `/setup` ne redémarre plus l'app : la connexion Twitch est simplement relancée.
- Trucky : un appel HTTP direct est tenté d'abord ; le Chrome/Edge installé n'est lancé (une
  seule fois par mise à jour du panneau, au lieu d'une fois par appel) que si Cloudflare bloque.
- Affichage des touches : une fois activée, la capture du clavier ne peut plus être retirée
  sans quitter l'app (limite de la bibliothèque `rdev`) ; quand l'affichage est désactivé ou le
  serveur arrêté, plus rien n'est transmis aux overlays.
- L'image de marque saisie dans `/setup` est enregistrée dans le profil actif (côté Node, elle
  partait à la racine de la config et était perdue au redémarrage dès qu'un profil existait).

- Fermer la fenêtre la détruit (la version Electron la cachait) : l'app réduite dans la zone de
  notification ne garde que le serveur (~10 Mo) au lieu du moteur web complet.
- Nouvelle interface de l'app (tableau de bord avec URLs OBS à copier, navigation latérale).
- Les fichiers JSON sont écrits via un fichier temporaire renommé ensuite : un crash en pleine
  écriture ne laisse plus de fichier tronqué. Le contenu écrit est identique.
- Un id de profil contenant `/`, `\` ou `..` est refusé (« Profil introuvable ») : il ne peut
  plus servir à lire ou écrire en dehors du dossier `profiles/`.
- Un fichier son/média manquant sur disque est ignoré à l'export au lieu de faire échouer
  l'export entier.
