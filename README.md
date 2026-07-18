# 🎮 Electrum Overlay — application desktop pour overlay Twitch

Application Windows (Electron) qui gère vos overlays de stream Twitch : alertes en temps réel (follow, sub, raid, bits...), statistiques live, chat, et intégration EventSub — le tout piloté depuis une interface graphique, sans toucher à un seul fichier de config à la main.

> This readme is also available in [English](README-EN.md).

## 📋 Table des matières

- [🚀 Fonctionnalités](#-fonctionnalités)
- [📥 Installation](#-installation)
- [🧙 Premier lancement (assistant de configuration)](#-premier-lancement-assistant-de-configuration)
- [🖥️ Utilisation au quotidien](#️-utilisation-au-quotidien)
- [📹 Overlays OBS](#-overlays-obs)
- [🧪 Simuler des événements](#-simuler-des-événements)
- [🔄 Mises à jour automatiques](#-mises-à-jour-automatiques)
- [📷 Aperçu](#-aperçu)
- [🎨 Personnalisation](#-personnalisation)
- [🚛 Intégration TruckyApp](#-intégration-truckyapp)
- [🎛️ Plugin Stream Deck](#️-plugin-stream-deck)
- [🛠️ Développement (depuis les sources)](#️-développement-depuis-les-sources)
- [❗ Dépannage](#-dépannage)

## 🚀 Fonctionnalités

### ✨ Alertes en temps réel
- Nouveaux followers, abonnés et renouvellements, sub gifts, raids, bits — avec confettis
- File d'attente pour éviter les chevauchements
- Design, durée, couleurs et intensité des confettis réglables depuis l'app

### 🎭 Overlays animés
- **Démarrage** : compte à rebours avant stream
- **Overlay principal** : statistiques en temps réel + alertes + chat
- **Pause** et **Fin de stream** : écrans dédiés
- Thèmes de couleur, panneaux d'info et bandeau défilant configurables

### 📊 Statistiques en temps réel
Followers, abonnés, spectateurs actuels — mis à jour automatiquement via WebSocket.

### 🖥️ Une vraie application desktop
- Fenêtre native avec barre de titre personnalisée, icône dans la zone de notification
- Le serveur continue de tourner (pour OBS) même fenêtre fermée — seul "Quitter" depuis le tray l'arrête vraiment
- Bouton démarrer/arrêter le serveur directement dans l'app
- Assistant de configuration graphique, aucun fichier JSON à éditer à la main
- Visionneuse de logs et outils de simulation d'événements intégrés
- Mises à jour automatiques

## 📥 Installation

1. Téléchargez le dernier installeur (`ElectrumOverlay Setup x.x.x.exe`) depuis la page [Releases](https://github.com/Arkyan/ElectrumOverlay/releases) du projet.
2. Lancez l'installeur et suivez les étapes (vous pouvez choisir le dossier d'installation).
3. Au premier lancement, l'application vous guide dans l'assistant de configuration — voir section suivante.

> 🎛️ Vous avez un Stream Deck ? Le fichier `com.electrumvtc.overlay.streamdeck.streamDeckPlugin` est disponible sur la même page de [Releases](https://github.com/Arkyan/ElectrumOverlay/releases) — voir la section [Plugin Stream Deck](#️-plugin-stream-deck).

**Prérequis :**
- Windows 10/11
- Un compte Twitch (celui qui streame)
- Pour les stats ETS2/ATS (optionnel) : Google Chrome ou Microsoft Edge installés

## 🧙 Premier lancement (assistant de configuration)

L'assistant (`/setup` dans l'app) comporte trois sections indépendantes — vous pouvez en modifier une seule sans redonner les autres.

### 1. Application Twitch
1. Créez une application sur [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. Renseignez :
   - **URL de redirection OAuth** : `http://localhost:8080/auth-callback`
   - **Catégorie** : `Application Integration`
   - **Type de client** : `Confidential`
3. Copiez le **Client ID** et le **Client Secret** générés dans l'assistant.

### 2. Autorisation Twitch
Cliquez sur "Autoriser" — ça ouvre votre navigateur habituel (jamais une fenêtre de l'app) pour l'autorisation OAuth. Revenez ensuite dans l'app : la chaîne autorisée (pseudo + ID) s'affiche automatiquement, en lecture seule.

### 3. Branding et intégrations
- Couleur principale de l'overlay
- Lignes d'info et texte défilant du bandeau du bas
- **ngrok** (tunnel HTTPS nécessaire aux webhooks EventSub) : cochez pour l'activer et collez votre authtoken gratuit depuis [dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken)
- **TruckyApp** (optionnel, pour les streameurs ETS2/ATS) : voir plus bas

Une fois validé, l'application redémarre automatiquement avec la nouvelle configuration.

> ℹ️ En version gratuite, l'URL ngrok change à chaque redémarrage — l'app le gère toute seule (elle rafraîchit automatiquement les abonnements webhook au démarrage), vous n'avez rien à faire.

## 🖥️ Utilisation au quotidien

- L'app se lance dans la zone de notification (tray) et garde le serveur actif même fenêtre fermée.
- Depuis la page d'accueil de l'app (`/app`) : statut du serveur, bouton démarrer/arrêter, accès rapide aux Paramètres, Logs, Tests, Statistiques, et aux pages Twitch.
- Depuis le menu du tray : Ouvrir, Paramètres, Logs, Tests, Démarrer/Arrêter le serveur, Vérifier les mises à jour, Quitter.
- **Paramètres** (`/settings`) : thèmes, alertes, panneaux, animations, chat, statistiques — tout s'applique en direct sur les overlays déjà ouverts dans OBS, sans redémarrage.
- **Logs** (`/logs`) : suivi en direct des logs serveur, utile pour diagnostiquer un souci Twitch/ngrok.

## 📹 Overlays OBS

Ajoutez ces pages comme sources navigateur dans OBS (le serveur doit être démarré) :

| Page | URL |
|---|---|
| Démarrage | `http://localhost:8080/starting.html` |
| Overlay principal | `http://localhost:8080/` |
| Pause | `http://localhost:8080/pause.html` |
| Fin de stream | `http://localhost:8080/ending.html` |

Le fichier `ConfigOBS.json` à la racine contient des scènes OBS préconfigurées (Starting, Game, Pause, Fin) avec leurs sources, prêtes à importer.

## 🧪 Simuler des événements

La page **Tests** (`/tests`) permet de déclencher une alerte (follow, sub, sub gift, raid, bits), un message de chat, ou un événement stream online/offline sans attendre un vrai événement Twitch — pratique pour régler le rendu des overlays avant d'être en live.

Pour tester avec de vrais événements Twitch simulés côté plateforme, la [Twitch CLI](https://dev.twitch.tv/docs/cli/) reste utilisable :
```bash
twitch event trigger channel.follow --to-user-id=VOTRE_ID --from-user-id=123456
```

## 🔄 Mises à jour automatiques

L'application vérifie les nouvelles versions au démarrage puis toutes les 4h. Quand une mise à jour est disponible, elle se télécharge automatiquement en arrière-plan et une bannière apparaît sur la page d'accueil (ainsi qu'une entrée dans le menu du tray) pour l'installer en un clic.

## 📷 Aperçu

> Écran de démarrage

![Starting](./readme/starting.gif)

> Écran de pause

![Pause](./readme/pause.gif)

> Écran de fin

![Ending](./readme/ending.gif)

## 🎨 Personnalisation

Tout se règle depuis la page **Paramètres** (`/settings`) de l'app : couleurs des thèmes par page, contenu et style des alertes, animations (particules, étoiles, météores, logo DVD), panneaux d'info, apparence du chat, statistiques. Les changements s'appliquent immédiatement aux overlays déjà ouverts dans OBS.

Pour aller plus loin (mise en page, animations CSS personnalisées), les fichiers sources restent modifiables :
- `public/css/overlay-common.css` — styles partagés par tous les overlays
- `public/css/*.css` — styles spécifiques à chaque page
- `public/js/overlay-common.js` — logique commune (alertes, chat, thèmes)

## 🚛 Intégration TruckyApp

Pour les streameurs ETS2/ATS : activez l'intégration depuis l'assistant de configuration ou les Paramètres, en renseignant votre ID utilisateur TruckyApp (visible dans l'URL de votre profil sur [truckyapp.com](https://truckyapp.com/) : `truckyapp.com/user/VOTRE_ID`). L'app récupère alors automatiquement votre dernier trajet et vos statistiques de compagnie. Nécessite Google Chrome ou Microsoft Edge installés sur la machine.

## 🎛️ Plugin Stream Deck

Un plugin Stream Deck dédié (« ElectrumOverlay Deck ») permet de piloter l'app directement depuis vos touches :
- **Alerte de test** — déclenche un follow/sub/raid/bits... de test, comme la page `/tests`
- **Activer un profil** — bascule sur un profil, avec une icône qui reflète en direct s'il est déjà actif
- **Afficher un panneau** — affiche le panneau gauche ou le bandeau bas immédiatement (même désactivé dans les réglages)
- **Statistiques en direct** — affiche viewers, follows, abonnés ou messages de chat sur une touche, mis à jour automatiquement

### Installation
1. Téléchargez `com.electrumvtc.overlay.streamdeck.streamDeckPlugin` depuis la page [Releases](https://github.com/Arkyan/ElectrumOverlay/releases) (même page que l'installeur de l'app).
2. Double-cliquez dessus : l'app Stream Deck l'installe automatiquement.
3. Glissez les actions « ElectrumOverlay Deck » sur vos touches. Le serveur ElectrumOverlay doit être démarré pour qu'elles fonctionnent (il tourne par défaut sur `localhost:8080`, réglable par touche si besoin).

Pour développer ou modifier le plugin, voir `streamdeck-plugin/README.md`.

## 🛠️ Développement (depuis les sources)

### Structure du projet

```
Ma version/
├── electron/               # Process principal Electron (fenêtre, tray, IPC, auto-updater)
│   ├── main.js
│   └── preload.js
├── src/
│   ├── config/
│   │   ├── defaults.json   # Config par défaut
│   │   └── store.js        # Singleton de config (lecture/écriture live)
│   ├── routes/              # Routes Express (API + pages admin)
│   │   ├── api.js
│   │   ├── setup.js
│   │   ├── settings.js
│   │   ├── logs.js
│   │   └── testtools.js
│   └── services/
│       ├── EventSubManager.js
│       ├── TwitchAuth.js
│       ├── WebhookHandler.js
│       ├── NgrokManager.js
│       ├── StreamStatsManager.js
│       ├── TruckyApi.js
│       └── LogBuffer.js
├── public/                  # Overlays + pages admin (HTML/CSS/JS statiques)
├── streamdeck-plugin/       # Plugin Stream Deck (sous-projet séparé, voir son propre README)
├── server.js                 # Classe TwitchOverlayServer (start/stop, routes, WebSocket)
├── ConfigOBS.json
└── package.json
```

### Lancer en mode développement

```bash
git clone https://github.com/Arkyan/ElectrumOverlay.git
cd "Ma version"
npm install
npm run electron     # app Electron complète
# ou
npm start             # serveur seul (sans fenêtre Electron), pour tester overlays/API
npm run dev           # serveur seul avec rechargement automatique (nodemon)
```

En développement, la configuration est stockée dans `config/overlay-config.json` à la racine du projet (ignoré par git). Une fois installée, l'app la stocke dans `%APPDATA%\ElectrumOverlay\config\`.

### Construire l'installeur

```bash
npm run package:win        # build local, dist/ElectrumOverlay Setup x.x.x.exe
npm run package:streamdeck # build local du plugin, dist/com.electrumvtc.overlay.streamdeck.streamDeckPlugin
npm run publish:win        # build + publication de l'app ET du plugin Stream Deck sur GitHub Releases
                            # (nécessite GH_TOKEN pour electron-builder, et le CLI "gh" authentifié pour l'upload du plugin)
```

### Autres commandes

```bash
npm run clean     # supprime tous les abonnements EventSub actifs
```

## ❗ Dépannage

#### Le port 8080 est déjà utilisé
Une autre instance de l'app tourne probablement déjà (regardez la zone de notification). Fermez-la avant d'en relancer une.

#### Les webhooks/alertes ne fonctionnent pas
1. Vérifiez sur la page d'accueil de l'app que le bandeau "ngrok non connecté" n'est pas affiché.
2. Vérifiez dans **Logs** (`/logs`) l'absence d'erreur au démarrage.
3. Si vous utilisez votre propre authtoken ngrok, vérifiez qu'il est bien renseigné dans l'assistant (pas la valeur d'exemple `$YOUR_AUTHTOKEN`).

#### "Token expired" / 401 Unauthorized
Retournez dans l'assistant de configuration (`/setup`) et cliquez sur "Autoriser à nouveau" pour régénérer l'autorisation.

#### Repartir de zéro sur les abonnements EventSub
```bash
npm run clean
```
ou, app lancée, ouvrez `http://localhost:8080/clear-subscriptions` dans votre navigateur.

---

## 📄 Licence

MIT License — voir le fichier `LICENSE`.

## 🤝 Contribution

Les contributions sont les bienvenues ! Voir `CONTRIBUTING.md` pour le détail. En résumé : forkez, créez une branche, commitez, ouvrez une Pull Request.

---

**🎮 Bon streaming ! 🚀**
