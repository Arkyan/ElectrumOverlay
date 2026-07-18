# ElectrumOverlay Deck

Plugin Stream Deck (SDK Elgato, `@elgato/streamdeck`) pour piloter [ElectrumOverlay](../README.md) depuis un Stream Deck. Sous-projet séparé du reste du dépôt : toolchain différente (Node.js 24+, TypeScript, rollup), son propre `package.json`/`node_modules`.

## Actions

- **Alerte de test** — déclenche un événement de test (follow, sub, sub gift, raid, bits, message de chat, panneau info, stream en/hors ligne) sur ElectrumOverlay, exactement comme la page `/tests` de l'app. Un flash vert/rouge sur la touche confirme le succès ou l'échec.
- **Activer un profil** — bascule ElectrumOverlay sur un profil (couleurs/alertes/sons — voir `/settings`). Tant que la touche est visible, son icône et son titre reflètent en direct si ce profil est déjà l'actif (`✓ Nom du profil`), via un rafraîchissement toutes les ~5s.

Les deux actions ont un réglage "Avancé" (hôte/port) si le serveur ElectrumOverlay ne tourne pas sur `localhost:8080`.

**Hors scope** : démarrer/arrêter le serveur ElectrumOverlay depuis une touche. Cette action passe aujourd'hui uniquement par IPC Electron (pas par l'API HTTP) — si le serveur est arrêté, il n'y a justement plus de route HTTP à interroger pour le relancer. Nécessiterait un canal de communication séparé, pas fait ici.

## Développement

```bash
npm install
npm run build      # compile une fois (rollup)
npm run watch       # compile en continu + redémarre le plugin dans Stream Deck à chaque changement
```

Le plugin doit être lié à l'app Stream Deck avant de pouvoir le tester (une seule fois) :

```bash
streamdeck link com.electrumvtc.overlay.streamdeck.sdPlugin
```

Puis `npm run watch` (ou `streamdeck restart com.electrumvtc.overlay.streamdeck` après un `npm run build`) pour le recharger. Logs du plugin dans `com.electrumvtc.overlay.streamdeck.sdPlugin/logs/`.

ElectrumOverlay doit être démarré (`npm start` ou l'app Electron) pour que les actions aient quelque chose à joindre sur `localhost:8080`.

## Distribution

```bash
streamdeck pack com.electrumvtc.overlay.streamdeck.sdPlugin
```

Génère un fichier `.streamDeckPlugin` installable en double-clic sur une autre machine.

## Icônes

Les icônes actuelles (`com.electrumvtc.overlay.streamdeck.sdPlugin/imgs/`) sont des placeholders repris du gabarit généré par `streamdeck create` — fonctionnels mais pas spécifiques à ElectrumOverlay. Le retour visuel "profil actif" passe pour l'instant par le titre (`✓ Nom`) et le changement de `State` (0/1), pas par des icônes visuellement différentes. À remplacer si un rendu plus soigné est voulu.
