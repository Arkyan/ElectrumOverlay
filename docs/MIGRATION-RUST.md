# Migration vers Rust (Tauri)

Historique de la migration de la version 2.x (Node/Electron) vers la 3.0 (Rust/Tauri), fusionnée
dans `main`. **L'ancien code Node/Electron a été retiré du dépôt** après la migration ; le dépôt
n'a plus aucune dépendance npm (le plugin Stream Deck est lui aussi en Rust).

Pendant la migration, des tests de parité comparaient la version Rust à l'ancien code Node
(mêmes fichiers écrits octet pour octet, mêmes réponses de l'API). Ils ont été retirés avec le
code Node : les tests Rust (`cargo test`) couvrent désormais le comportement directement.

Le contrat des fichiers sur disque (config, profils, export) est dans [`FORMATS.md`](FORMATS.md).

## Organisation

```
Cargo.toml                 # workspace Rust
crates/electrum-core/      # cœur sans interface : config, profils, formats, sauvegardes
crates/electrum-server/    # serveur HTTP + WebSocket, Twitch, pages de l'app, traductions
crates/electrum-deck/      # plugin Stream Deck (exécutable natif)
src-tauri/                 # application Tauri : lance le serveur et ouvre la fenêtre
xtask/                     # cargo xtask release / plugin
src/config/                # defaults.json, theme-presets.json (intégrés à la compilation)
src/templates/             # modèle HTML des scènes personnalisées
```

## Lancer

```bash
cargo test
```

```bash
cargo tauri dev
```

L'app lit **et écrit** `%APPDATA%\ElectrumOverlay\config`. Pour travailler sur une copie :

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
| Release (`cargo xtask release` : installateur, `latest.json`, `latest.yml` pour la bascule Electron, plugin Stream Deck) | ✅ `latest.yml` vérifié avec electron-updater |
| Plugin Stream Deck en Rust (exécutable natif, sans Node) | ✅ testé contre un faux Stream Deck (à valider sur un vrai) |
| Retrait du code Node/Electron et de npm | ✅ |
| Widgets personnalisés (page Widgets, `public/js/electrum-widget.js`, élément `widget`) | ✅ testé |
| Couleur de l'app = couleur principale des overlays du profil actif (`/css/accent.css`) | ✅ testé |
| Tableau de bord : derniers événements (follow, sub, bits, raid) avec « Rejouer » | ✅ testé |
| Objectifs, sondages, prédictions, hype train (EventSub, scopes facultatifs) + éléments de l'éditeur de scène | ✅ testé contre un faux Twitch (à valider avec un vrai compte) |
| Démarrage avec Windows (réduit ou non), Paramètres › Application | ✅ compile pour Windows (à valider) |
| Sauvegardes automatiques quotidiennes + manuelles, restauration, Paramètres › Sauvegardes | ✅ testé |
| Partage de profil en `.zip` (auteur, description, sons en option, aperçu avant import ; ancien `.json` accepté) | ✅ testé |
| Interface en anglais (Paramètres › Application), langue de Windows au premier lancement | ✅ testé |
| Profil automatique selon le jeu (Paramètres › Profil par jeu) | ✅ testé (à valider avec une vraie catégorie Twitch) |
| Premier lancement guidé (`/welcome` : langue, type de stream, couleurs, animations, logo `/logo.png`) | ✅ testé |
| Aide intégrée : carte « Premiers pas » (`/api/app/getting-started`) et bulles « ? » | ✅ testé |
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
- Abonnements EventSub en plus (propres à Rust, hors de `eventTypes` qui est partagé avec la
  version Electron) : bits, titre/catégorie, objectifs, sondages, prédictions, hype train (v2).
  Ils ne sont créés que si le token a le scope correspondant : un token obtenu avant reste
  valable, le tableau de bord indique ce qui est inactif et propose de ré-autoriser.
- Éléments de scène en plus (propres à Rust) : Objectif Twitch, Sondage, Prédiction, Hype train
  (rendu dans `public/js/twitch-widgets.js`). Tout passe par l'éditeur de scène : pas de page
  d'overlay séparée.
- Fichiers statiques servis avec `Cache-Control: no-cache` : l'app et OBS revérifient chaque
  fichier, une mise à jour de l'app est donc prise en compte sans vider de cache.
- Sauvegardes dans `%APPDATA%\ElectrumOverlay\backups` (à côté de `config`) : JSON copiés,
  sons/vidéos stockés une seule fois par contenu (`backups/files`). Une restauration garde les
  sections `twitch` et `spotify` actuelles et sauvegarde l'état d'avant.
- Profil par jeu : `app.gameProfiles` (`enabled`, `rules: [{ game, profileId }]`,
  `fallbackProfileId`) dans `overlay-config.json`. Appliqué sur `channel.update`, `stream.online`
  et à la connexion à Twitch (catégorie actuelle lue via Helix).
- Langue : `app.language` (`fr`/`en`) dans `overlay-config.json`. Le français reste le texte de
  référence ; en anglais, `crates/electrum-server/i18n/en.json` est appliqué aux pages de l'app et
  aux erreurs de l'API, et `i18n/en-overlay.json` aux textes intégrés des overlays (via
  `/js/i18n.js`). Les textes personnalisés ne sont pas traduits ; les logs restent en français.
- Démarrage avec Windows : entrée `Run` du registre (`ElectrumOverlay … --autostart`), retirée
  par le désinstalleur (pas lors d'une mise à jour). Réglage « réduit » : `desktop.startMinimized`
  dans `overlay-config.json`.
