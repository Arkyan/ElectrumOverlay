# Formats de données — référence de compatibilité

Ce document décrit tout ce qu'ElectrumOverlay **écrit sur disque** et tout ce qu'il **expose** aux
overlays, à OBS et au plugin Stream Deck. C'est le contrat à respecter pour toute réécriture du
serveur (par exemple en Rust / Tauri) : une nouvelle version doit relire sans perte les données
d'une installation existante, et produire exactement les mêmes formats.

Source de vérité au moment de la rédaction (v2.5.2) : `src/config/store.js`,
`src/config/defaults.json`, `src/routes/*.js`, `server.js`, `electron/main.js`.

---

## 1. Emplacement des données

| Contexte | Dossier |
|---|---|
| App installée (Electron) | `%APPDATA%\ElectrumOverlay\config\` |
| `node server.js` (dev) | `<racine du projet>/config/` |

- Electron force `app.setName('ElectrumOverlay')` (le `name` de `package.json` est
  `twitch-overlay-server`), puis définit `ELECTRUM_CONFIG_DIR = <userData>/config`.
- ⚠️ **Piège Tauri** : le dossier de données par défaut de Tauri dépend de l'identifiant
  (`com.electrumvtc.overlay`), pas du nom. Il faut **forcer** le chemin
  `%APPDATA%\ElectrumOverlay\config\`, sinon la nouvelle version démarre sans config.

Arborescence :

```
config/
├── overlay-config.json          # config globale (overrides uniquement)
└── profiles/
    ├── <profileId>.json         # un fichier par profil
    ├── audio/<profileId>/<alertType>.<ext>
    └── media/<profileId>/<alertType>.<ext>
```

Tous les JSON sont écrits en UTF-8, indentés sur 2 espaces (`JSON.stringify(x, null, 2)`).

---

## 2. Fichiers de référence livrés avec l'app (lecture seule)

À réutiliser **tels quels** :

- `src/config/defaults.json` — valeurs par défaut de toute la config (y compris `display`).
- `src/config/theme-presets.json` — thèmes prêts à l'emploi : tableau de
  `{ name, themes: { starting|index|pause|ending: { primary, secondary, accent, panelBorder } } }`.

Les types d'alerte valides (`ALERT_TYPES`) sont **dérivés** des clés de
`defaults.json → display.alerts.types` : `follow`, `sub`, `subs_gift`, `raid`, `bits`.

---

## 3. `overlay-config.json` — config globale

### Principe : overrides uniquement

Le fichier ne contient **que ce qui diffère des défauts**. La config effective est :

```
config = deepMerge(defaults.json, overlay-config.json)
```

Règles de `deepMerge(base, override)` (à reproduire exactement) :

- si `base` **et** `override` sont des objets simples (pas des tableaux) → fusion clé par clé, récursive ;
- sinon → `override` remplace `base` (s'il n'est pas `undefined`) ;
- **les tableaux ne sont jamais fusionnés**, ils sont remplacés en bloc (ex. `commands`, `infoTexts`).

Fichier absent ou JSON invalide → traité comme `{}` (première utilisation).

### Écriture

`saveConfig(partial)` : relit le fichier, `deepMerge(fichier, partial)`, réécrit le résultat complet.
**Toute clé inconnue présente dans le fichier doit être conservée** à la réécriture.

### Clés racine

| Clé | Contenu |
|---|---|
| `server` | `PORT` (8080), `WS_PORT` (8081), `HOST` (`localhost`) |
| `twitch` | `CLIENT_ID`, `CLIENT_SECRET`, `BROADCASTER_ID`, `BROADCASTER_LOGIN`, `USER_ACCESS_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `REDIRECT_URI`, `SCOPES` (tableau) |
| `ngrok` | `ENABLED` (bool), `AUTHTOKEN` |
| `spotify` | `CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URI`, `ACCESS_TOKEN`, `REFRESH_TOKEN`, `EXPIRES_AT` (ms epoch), `SCOPES` |
| `trucky` | `enable` (bool, minuscule !), `USER_ID` |
| `inputDisplay` | `enabled` (bool) |
| `commands` | tableau de commandes de chat (voir ci-dessous) |
| `features` | `AUTO_SUBSCRIBE_EVENTS`, `CLEANUP_ON_EXIT`, `HEARTBEAT_INTERVAL`, `MAX_RETRIES` |
| `eventTypes` | listes d'abonnements EventSub (`basic`, `chat`) : `{ type, version?, description, condition? }` |
| `activeProfileId` | id (UUID) du profil actif |
| `display` | **obsolète** à la racine (voir migration ci-dessous) |

Note : la casse des clés est hétérogène (`twitch.CLIENT_ID` mais `trucky.enable`,
`inputDisplay.enabled`). Elle doit être conservée telle quelle.

"Configuré" = `twitch.CLIENT_ID && twitch.CLIENT_SECRET && twitch.BROADCASTER_ID && twitch.USER_ACCESS_TOKEN`
tous non vides (sinon l'app redirige vers `/setup`).

### Commande de chat (`commands[]`)

```json
{
  "id": "uuid",
  "trigger": "!discord",
  "enabled": true,
  "permission": "everyone",
  "cooldownSeconds": 5,
  "chatReply": { "enabled": true, "message": "..." },
  "overlayAction": { "enabled": false, "panel": "left" },
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

- `trigger` : minuscules, commence par `!`, sans espace (`/^![^\s]+$/`), unique.
- `permission` ∈ `everyone`, `vip`, `moderator`, `broadcaster`.
- `overlayAction.panel` ∈ `left`, `bottom`.
- `cooldownSeconds` ≥ 0.

---

## 4. Profils — `profiles/<profileId>.json`

Un profil porte toute la partie visuelle (`display`) et les sons/médias d'alerte.
Un seul profil est actif (`overlay-config.json → activeProfileId`).

```json
{
  "id": "uuid",
  "name": "Défaut",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "display": { "...overrides de defaults.display..." },
  "audio": {
    "follow": { "filename": "son.mp3", "mimeType": "audio/mpeg", "ext": "mp3", "updatedAt": "ISO-8601" }
  },
  "media": {
    "raid": { "filename": "gif.gif", "mimeType": "image/gif", "ext": "gif", "updatedAt": "ISO-8601" }
  }
}
```

- Le nom de fichier est `<id>.json` ; la liste des profils = tous les `*.json` du dossier.
- `audio` / `media` peuvent être absents dans d'anciens fichiers → traiter comme `{}`.
- `display` du profil est **fusionné** sur `defaults.display` :
  `config.display = deepMerge(defaults.display, profile.display)`.
- Chaque modification met à jour `updatedAt` du profil.

### Fichiers binaires

- Son : `profiles/audio/<profileId>/<alertType>.<ext>`
- Média (image/GIF « hero » de l'alerte) : `profiles/media/<profileId>/<alertType>.<ext>`
- `ext` est stocké dans le profil ; c'est lui qui donne le chemin du fichier.
- Remplacer un son/média supprime d'abord l'ancien fichier (l'extension peut changer).

Déduction de l'extension (priorité au type MIME, sinon extension du nom d'origine, sinon `bin`) :

| Audio | ext | Média | ext |
|---|---|---|---|
| `audio/mpeg`, `audio/mp3` | `mp3` | `image/png` | `png` |
| `audio/wav`, `audio/x-wav` | `wav` | `image/jpeg` | `jpg` |
| `audio/ogg` | `ogg` | `image/webp` | `webp` |
| `audio/webm` | `weba` | `image/gif` | `gif` |
| `audio/mp4`, `audio/x-m4a` | `m4a` | | |
| `audio/aac` | `aac` | | |

### Migration au démarrage (à conserver)

Si `profiles/` ne contient aucun profil :

1. créer un profil `"Défaut"` dont `display` = le `display` effectif actuel
   (donc y compris un ancien `display` présent à la racine d'`overlay-config.json`) ;
2. retirer la clé `display` de la racine d'`overlay-config.json` et écrire `activeProfileId` ;
3. créer les profils de `theme-presets.json` absents (comparaison **par nom**).

Si `activeProfileId` est absent ou pointe vers un profil inexistant → prendre le premier profil
listé et l'enregistrer.

Contraintes : on ne peut supprimer ni le dernier profil, ni le profil actif. Supprimer un profil
supprime aussi ses dossiers `audio/<id>` et `media/<id>`.

---

## 5. Contenu de `display`

Valeurs par défaut complètes : `defaults.json → display`. Structure :

| Clé | Contenu |
|---|---|
| `alerts` | `enabled`, `duration`, `queueDelay`, `confetti*`, `soundVolume`, `types.<alertType>` = `{ icon (HTML), title, gradientStart, gradientEnd, border, animationStyle, defaultMessage }` |
| `animations` | `enabled`, `particles`, `stars`, `meteors` (`{enabled, count, duration:[min,max]}`), `circuitLines` (`{enabled, horizontal, vertical, duration}`), `dvdLogo` (`{enabled, speed, updateInterval}`) |
| `chat` | `enabled: {starting, index, ending}`, `maxMessages`, `scrollBehavior`, `defaultColor`, `badgeSize` |
| `panels` | `left` (`enabled, interval, duration, firstDelay, timerColor`), `bottom` (`enabled, interval, duration, firstDelay, content: {infoTexts[], scrollingText}`) |
| `stats` | `animationDuration`, `updateInterval`, `simulateData` |
| `pause` | `messages[]`, `progressMessages[]` (tableaux remplacés en bloc) |
| `themes` | `<page>` → `{ primary, secondary, accent, background, surface, text, mutedText, panelBg, panelBorder }` |
| `layout` | `<page>.<elementId>` → overrides de position/style (voir ci-dessous) |
| `texts` | `<page>.<textId>` → chaîne (une chaîne vide est une valeur valide) |
| `textStyles` | `<page>.<textId>` → `{ size?, font? }` |
| `customTexts` | `<page>.<elementId>` → éléments ajoutés dans l'éditeur de scène |
| `scenes` | `<sceneId>` → réglages de scène |
| `debug` | `enabled`, `logLevel`, `showWebSocketLogs`, `showAlertLogs` |

**`<page>`** = une page intégrée (`starting`, `index`, `pause`, `ending`) **ou** l'UUID d'une scène
personnalisée. Une scène personnalisée réutilise les mêmes clés (`layout`, `customTexts`, `texts`,
`themes`) indexées par son UUID.

### `layout.<page>.<elementId>`

Toutes les clés sont optionnelles ; un patch complète l'entrée existante sans l'écraser.

| Clé | Type | Bornes |
|---|---|---|
| `top`, `left` | nombre (% hauteur / largeur) | [-100, 200] |
| `hidden` | bool | |
| `removed` | bool (retiré de la page et de la liste de l'éditeur) | |
| `width`, `height` | nombre > 0 | |
| `scale` | nombre (%) | [25, 400] |
| `opacity` | nombre (% du fond) | [0, 100] |
| `z` | entier (z-index) | [-999, 9999] |
| `primary`, `secondary`, `text`, `panelBg`, `panelBorder` | couleur (chaîne) | |

### `textStyles.<page>.<textId>`

- `size` : nombre (vh), ≤ 30.
- `font` : `baron` ou `inter`.
- Une valeur `undefined` efface le réglage (disparaît du JSON).

### `customTexts.<page>.<elementId>`

Objet indexé par UUID (pas un tableau). Le nom `customTexts` est historique : les éléments ont un
`type` (absent ⇒ `text`).

Types : `text`, `image`, `box`, `clock`, `chat`, `chatTicker`, `alerts`, `spotify`, `keys`,
`statBadge`, `badge`, `rotatingText`, `infoPanel`, `bottomBar`, et (version Rust uniquement)
`goal`, `poll`, `prediction`, `hypetrain` (cartes Twitch, champs `size`, `color`, `font`,
`opacity`, `width` ; `height` ignoré). La version Electron ne les affiche pas.
`chat` et `alerts` : **un seul par page**.

Champs communs : `type`, `top`, `left` (défaut 40/40), puis selon le type :

| Champ | Type / valeurs |
|---|---|
| `text` | chaîne (multiligne pour `rotatingText` / `bottomBar` : une entrée par ligne ; `bottomBar` : préfixe `icone\|` optionnel) |
| `url` | chaîne (image) |
| `color` | couleur |
| `width`, `height` | nombre > 0 |
| `size` | nombre (vh), ≤ 30 |
| `font` | `baron` / `inter` |
| `glow`, `pulse`, `autoShow` | bool |
| `opacity` | [0, 100] |
| `radius` | [0, 200] (px) |
| `scale`, `textScale` | [25, 400] (%) |
| `speed` | [10, 400] (px/s, `chatTicker`) |
| `interval` | [1, 120] (s, `rotatingText`) |
| `layout` | `azerty` / `qwerty` (`keys`) |
| `showFunctionRow`, `showDigitRow`, `showMovement`, `showModifiers`, `showArrows`, `showMouse` | bool (`keys`) |
| `source` | `viewers`, `followers`, `subs`, `messages`, `duration`, `game`, `title` (`statBadge`) |
| `icon` | `none`, `users`, `heart`, `star`, `comments`, `clock`, `hourglass`, `pause`, `play`, `gamepad`, `truck`, `chart`, `bell`, `arrow`, `coffee`, `wrench`, `twitch`, `discord`, `youtube`, `globe`, `instagram`, `tiktok` |
| `title1`, `title2`, `title3` | chaînes (`infoPanel`) |
| `showTrip`, `showStats`, `showCompany` | bool (`infoPanel`) |
| `scrolling` | chaîne (`bottomBar`) |

Valeurs à la création (à reproduire) : `chat.text = "CHAT"`, `chatTicker.speed = 60`,
`box.color = "#a855f7"`, `spotify.color = "#1db954"`, `keys.color = "#f59e0b"` + `layout = "azerty"`
et tous les `show*` à `true`, etc. — voir `addProfileCustomText()` dans `src/config/store.js`.

### `scenes.<sceneId>`

```json
{
  "name": "Ma scène",
  "createdAt": "ISO-8601",
  "background": { "mode": "transparent", "color": "#0f172a", "color2": "#1e293b" },
  "effects": { "particles": true, "stars": false }
}
```

- `sceneId` = UUID (scène personnalisée, servie sur `/scene/<sceneId>`) **ou** clé de page intégrée
  (`starting`, `index`, `pause`, `ending`), créée à la volée au premier réglage. Les pages intégrées
  ne peuvent pas être supprimées.
- `background.mode` ∈ `theme`, `transparent`, `color`, `gradient`.
- `effects` : clés `particles`, `stars`, `meteors`, `circuitLines`, `dvdLogo` (bool).
- Supprimer une scène supprime aussi `customTexts`, `layout`, `texts`, `themes` à sa clé.

---

## 6. Export / import de profil (`*.electrumprofile.json`)

Fichiers échangés entre utilisateurs : **doivent rester compatibles dans les deux sens**.

```json
{
  "exportedFrom": "ElectrumOverlay",
  "exportVersion": 1,
  "name": "Mon profil",
  "display": { "...profile.display tel quel..." },
  "audio": {
    "follow": { "filename": "son.mp3", "mimeType": "audio/mpeg", "dataBase64": "..." }
  },
  "media": {
    "raid": { "filename": "gif.gif", "mimeType": "image/gif", "dataBase64": "..." }
  }
}
```

- Nom du fichier téléchargé : `<nom avec [^a-z0-9_-] remplacés par _>.electrumprofile.json`.
- Import (multipart, champ `file`, ≤ 20 Mo) : nouvel UUID **toujours** généré ; `name` vide ⇒
  `"Profil importé"` ; `display` non objet ⇒ `{}` ; les entrées audio/media de type inconnu ou
  sans `dataBase64` sont ignorées. `exportedFrom` / `exportVersion` ne sont pas vérifiés à l'import.

---

## 7. Configuration envoyée aux overlays

### `GET /js/config.js`

```js
globalThis.OVERLAY_CONFIG = { ... };
```

Objet produit par `toFrontendConfig()` :

```json
{
  "server": { "host": "localhost", "port": 8080, "wsPort": 8081 },
  "twitch": { "broadcasterId": "..." },
  "...": "toutes les clés de config.display (alerts, animations, chat, panels, themes, layout, ...)"
}
```

Particularité : pour chaque `alerts.types.<type>`, deux champs sont ajoutés :

- `sound` : `/api/profiles/<activeId>/audio/<type>?v=<updatedAt encodé URL>` ou `null`
- `media` : `/api/profiles/<activeId>/media/<type>?v=<updatedAt encodé URL>` ou `null`

Le même objet est envoyé dans le message WebSocket `config-updated`.

---

## 8. WebSocket vers les overlays (`ws://localhost:8081`)

Serveur → overlays (JSON) :

| `type` | Champs | Émis quand |
|---|---|---|
| `config-updated` | `config` (objet §7) | modification du profil actif |
| `message` | `username`, `message`, `color`, `badges` (`{set_id: id}`), `fragments` (tel que Twitch), `timestamp`, `userId`, `displayName` | message de chat |
| `channel.follow`, `channel.subscribe`, `channel.subscription.gift`, `channel.cheer`, `channel.raid`, `channel.update`, `stream.online`, `stream.offline` | `data` = l'objet `event` EventSub **brut** de Twitch | événement Twitch |
| `show-panel` | `panel` (`left` / `bottom`) | `/tests`, Stream Deck |
| `spotify-track-updated` | `track` = `{ isPlaying, title, artist, album, albumArt, progressMs, durationMs }` ou `null` | changement de morceau |
| `input-key` | `label`, `kind`, `state` (`down` / `up`) | affichage des touches |
| `pong` | — | réponse à `ping` |

Champs d'`event` lus par les overlays : `user_name`, `is_gift`, `cumulative_months`,
`message.text`, `total`, `bits`, `is_anonymous`, `message`, `from_broadcaster_user_name`, `viewers`.

Overlays → serveur : `{ "type": "ping" }`, `{ "type": "subscribe", "events": [...] }`.

Les messages `scene-preview-event`, `scene-center-element`, `scene-select-element` passent par
`postMessage` entre l'éditeur de scène et son aperçu (navigateur uniquement, pas par le serveur).

---

## 9. URLs et API utilisées de l'extérieur

### Sources navigateur OBS (enregistrées dans les scènes OBS des utilisateurs)

`http://localhost:8080/`, `/starting.html`, `/pause.html`, `/ending.html`, `/scene/<sceneId>`.
Le port **8080** et ces chemins ne doivent pas changer (voir aussi `ConfigOBS.json`).

### Plugin Stream Deck (`streamdeck-plugin/src/api-client.ts`)

| Route | Corps / réponse |
|---|---|
| `GET /api/profiles` | `{ activeId, profiles: [{ id, name, createdAt, updatedAt }] }` (triés par nom) |
| `POST /api/profiles/:id/activate` | — |
| `POST /api/tests/trigger` | `{ "action": "follow" \| "sub" \| "subgift" \| "raid" \| "bits" \| "chat" \| "info" }` |
| `POST /api/panels/:panel/show` | `panel` ∈ `left`, `bottom` |
| `GET /api/stream-stats` | voir ci-dessous |

### `GET /api/stream-stats` (et `/stream-stats`, `/api/stream-info`)

```json
{
  "isLive": true,
  "startTime": "ISO-8601 | null",
  "follows": 0,
  "subscribers": 0,
  "chatMessages": 0,
  "title": "",
  "game": "",
  "viewerCount": 0,
  "streamDuration": "HH:MM:SS | \"Stream hors ligne\"",
  "streamDurationMs": 0
}
```

### Autres routes appelées par les pages web

Toutes les routes de `src/routes/*.js` (profils, layout, textes, scènes, thèmes, réglages,
commandes, intégrations, setup, logs) sont appelées par les pages servies (`/settings`,
`/scene-editor`, `/setup`, `/integrations`, `/commands`, `/logs`, `/tests`). Si ces pages sont
réutilisées telles quelles, **chemins, méthodes HTTP, corps et réponses** doivent rester
identiques. Convention : succès `{ "ok": true, ... }`, erreur HTTP 400/404/500 `{ "error": "message" }`.

---

## 10. Checklist pour une réécriture

- [ ] Lire et écrire dans `%APPDATA%\ElectrumOverlay\config\`.
- [ ] Manipuler config et profils comme du JSON générique (ou avec un champ « reste »),
      pour ne **jamais** perdre une clé inconnue à la réécriture.
- [ ] Reproduire `deepMerge` (objets fusionnés, tableaux remplacés).
- [ ] Reproduire la migration de démarrage (profil « Défaut », presets, `activeProfileId`).
- [ ] Mêmes noms de fichiers pour sons et médias.
- [ ] Export/import compatibles avec l'`exportVersion: 1`.
- [ ] `/js/config.js` et `config-updated` identiques.
- [ ] Mêmes messages WebSocket, même port 8081.
- [ ] Mêmes URLs d'overlay, même port 8080.
- [ ] Mêmes routes pour le plugin Stream Deck.
- [ ] Tests de non-régression : capturer avec la version Node des exemples réels (config, profils,
      exports, réponses API, messages WebSocket) et vérifier que la nouvelle version les relit et
      les reproduit à l'identique.

## Profil partagé (`.electrumprofile.zip`, version Rust)

Zip contenant :

- `profile.json` : même contenu que l'export (`exportedFrom`, `exportVersion: 1`, `name`,
  `display`, `audio`, `media`), plus `shared` (`author`, `description`, `exportedAt`,
  `appVersion`). Dans `audio` / `media`, chaque entrée a `filename`, `mimeType` et `file`
  (chemin dans le zip) au lieu de `dataBase64` ;
- `audio/<type d'alerte>.<ext>`, `media/<type d'alerte>.<ext>` : les fichiers tels quels.

L'import accepte ce zip et l'ancien `.electrumprofile.json` (sons/vidéos en base64). La version
Electron n'importe que l'ancien format.

## Widgets personnalisés (`<config>/widgets/<id>/`, version Rust)

Un dossier par widget : `widget.json` (manifeste normalisé à l'installation : `id`, `name`,
`version`, `author`, `description`, `entry`, `size`, `settings`) et ses fichiers. Élément de scène
correspondant : `type: "widget"`, `widgetId`, `name`, `settings` (objet plat), `width`, `height`.
Inclus dans les sauvegardes et dans le `.zip` d'un profil partagé (`widgets/<id>/...`).
Documentation pour les auteurs de widgets : page Widgets de l'app
(`crates/electrum-server/templates/pages/widgets-doc-*.html`).
