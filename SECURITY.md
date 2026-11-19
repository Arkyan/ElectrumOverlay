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
  - Depuis un autre appareil du réseau, seuls les overlays sont lisibles ; l'app, ses réglages et
    ses API ne répondent qu'au PC où elle tourne.
  - Un site web ouvert dans ton navigateur ne peut ni modifier la config (origine vérifiée, JSON
    exigé), ni écouter le WebSocket, ni afficher l'app dans un cadre (clickjacking). Les noms de
    domaine qui pointeraient vers ton PC (DNS rebinding) sont refusés.
  - Les autorisations Twitch et Spotify portent un `state` aléatoire : un lien piégé ne peut pas
    connecter le compte de quelqu'un d'autre.
- **Profils partagés et widgets** (fichiers venant d'autres personnes) :
  - les widgets tournent isolés : ils lisent les données des overlays mais ne peuvent ni modifier
    les réglages ni lire les identifiants ;
  - un profil ne peut pas injecter de HTML dans les overlays, ni changer l'adresse du serveur ;
    ses sons et images ne sont jamais servis comme des pages ;
  - les zips sont limités en taille une fois décompressés (« zip bombs ») et ne peuvent rien écrire
    hors de leur dossier.
- **Mises à jour signées** : l'app n'installe une mise à jour que si elle est signée avec la clé
  privée du projet (la clé publique est dans `src-tauri/tauri.conf.json`). Un compte GitHub
  compromis ne suffit pas à pousser une fausse mise à jour.
- **Fenêtre de l'app** : seules les pages du serveur local peuvent appeler les commandes de l'app ;
  les liens externes s'ouvrent dans le navigateur, et seulement s'il s'agit de pages web (jamais un
  fichier local ni un autre programme).
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
  plugin). Other devices on the network can only read the overlays; websites open in your browser
  cannot change the config, listen to the WebSocket or frame the app; DNS rebinding is refused;
  OAuth uses a random `state`. Shared profiles and widgets are untrusted: widgets run sandboxed,
  profiles cannot inject HTML or redirect the overlays, media is never served as a page, and zips
  are size-capped once decompressed. External links only open web pages. Never share `overlay-config.json` (it holds your tokens); share profiles with
  **Settings › Profiles › Share…** instead.
