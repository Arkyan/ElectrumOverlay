# 🔒 Sécurité — ElectrumOverlay

> English version below.

## Versions supportées

Seule la dernière version (3.x) reçoit des correctifs. Les mises à jour automatiques de l'app
l'installent toute seule.

## Signaler une vulnérabilité

**Ne crée pas d'issue publique.** Utilise un [advisory privé GitHub](../../security/advisories/new)
avec : la version de l'app, les étapes pour reproduire, l'impact possible. Réponse sous quelques
jours.

## Ce que fait l'app

- **Tout reste sur ton PC** : config, tokens Twitch/Spotify et profils sont dans
  `%APPDATA%\ElectrumOverlay`. Aucun serveur tiers, aucune télémétrie.
- **Twitch** : connexion EventSub par WebSocket sortante. Aucun port à ouvrir, pas de tunnel.
- **Serveur local** (8080/8081) : il sert les overlays à OBS. N'ouvre pas ces ports sur Internet.
- **Mises à jour signées** : l'app n'installe une mise à jour que si elle est signée avec la clé
  privée du projet (la clé publique est dans `src-tauri/tauri.conf.json`). Un compte GitHub
  compromis ne suffit pas à pousser une fausse mise à jour.
- **Fenêtre de l'app** : seules les pages du serveur local peuvent appeler les commandes de l'app ;
  les liens externes s'ouvrent dans le navigateur.
- **Aucune dépendance npm** : l'app et le plugin Stream Deck sont en Rust. Dépendances vérifiables
  avec `cargo audit` (`cargo install cargo-audit`).

## Bonnes pratiques

- Ne partage jamais `overlay-config.json` : il contient tes tokens. Pour partager un thème,
  utilise **Paramètres › Profils › Partager…**, qui n'exporte pas les identifiants.
- Si un token a fuité : révoque l'accès de l'application sur
  [twitch.tv/settings/connections](https://www.twitch.tv/settings/connections), puis ré-autorise
  dans l'app.

---

## English version

- **Supported**: latest 3.x only (installed automatically by the built-in updater).
- **Reporting**: please use a [private GitHub security advisory](../../security/advisories/new),
  not a public issue.
- **Design**: everything stays on your PC (`%APPDATA%\ElectrumOverlay`), no third-party server,
  outgoing EventSub WebSocket only, signed updates, no npm dependencies (Rust app and Stream Deck
  plugin). Never share `overlay-config.json` (it holds your tokens); share profiles with
  **Settings › Profiles › Share…** instead.
