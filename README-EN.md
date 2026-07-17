# 🎮 Electrum Overlay — Twitch overlay desktop app

A Windows desktop app (Electron) that runs your Twitch stream overlays: real-time alerts (follow, sub, raid, bits...), live stats, chat, and EventSub integration — all managed through a graphical interface, no config file editing required.

> Ce readme est également disponible en [français](README.md).

## 📋 Table of Contents

- [🚀 Features](#-features)
- [📥 Installation](#-installation)
- [🧙 First launch (setup wizard)](#-first-launch-setup-wizard)
- [🖥️ Day-to-day use](#️-day-to-day-use)
- [📹 OBS overlays](#-obs-overlays)
- [🧪 Simulating events](#-simulating-events)
- [🔄 Automatic updates](#-automatic-updates)
- [📷 Preview](#-preview)
- [🎨 Customization](#-customization)
- [🚛 TruckyApp integration](#-truckyapp-integration)
- [🛠️ Development (from source)](#️-development-from-source)
- [❗ Troubleshooting](#-troubleshooting)

## 🚀 Features

### ✨ Real-time alerts
- New followers, subs and resubs, sub gifts, raids, bits — with confetti
- Queueing to avoid overlapping alerts
- Design, duration, colors and confetti intensity all configurable from the app

### 🎭 Animated overlays
- **Starting**: countdown before the stream
- **Main overlay**: real-time stats + alerts + chat
- **Pause** and **Ending** screens
- Configurable color themes, info panels, and scrolling ticker

### 📊 Real-time statistics
Followers, subscribers, current viewers — auto-updated over WebSocket.

### 🖥️ An actual desktop app
- Native window with a custom titlebar, system tray icon
- The server keeps running for OBS even when the window is closed — only "Quit" from the tray actually stops it
- Start/stop server button right inside the app
- Graphical setup wizard, no JSON file to hand-edit
- Built-in live log viewer and event simulation tools
- Automatic updates

## 📥 Installation

1. Download the latest installer (`ElectrumOverlay Setup x.x.x.exe`) from the project's [Releases](https://github.com/Arkyan/ElectrumOverlay/releases) page.
2. Run the installer and follow the steps (you can choose the install folder).
3. On first launch, the app walks you through the setup wizard — see next section.

**Requirements:**
- Windows 10/11
- A Twitch account (the one that streams)
- For ETS2/ATS stats (optional): Google Chrome or Microsoft Edge installed

## 🧙 First launch (setup wizard)

The wizard (`/setup` inside the app) has three independent sections — you can edit just one without re-entering the others.

### 1. Twitch application
1. Create an application at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. Fill in:
   - **OAuth Redirect URL**: `http://localhost:8080/auth-callback`
   - **Category**: `Application Integration`
   - **Client Type**: `Confidential`
3. Copy the generated **Client ID** and **Client Secret** into the wizard.

### 2. Twitch authorization
Click "Authorize" — this opens your default browser (never an app window) for the OAuth flow. Come back to the app afterward: the authorized channel (username + ID) shows up automatically, read-only.

### 3. Branding and integrations
- Overlay's main accent color
- Info lines and scrolling text for the bottom bar
- **ngrok** (HTTPS tunnel required for EventSub webhooks): check to enable it and paste your free authtoken from [dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken)
- **TruckyApp** (optional, for ETS2/ATS streamers): see below

Once saved, the app restarts automatically with the new configuration.

> ℹ️ On the free tier, the ngrok URL changes on every restart — the app handles this on its own (it automatically refreshes webhook subscriptions on startup), nothing to do on your end.

## 🖥️ Day-to-day use

- The app launches into the system tray and keeps the server running for OBS even when the window is closed.
- From the app's home page (`/app`): server status, start/stop button, quick links to Settings, Logs, Tests, Statistics, and the Twitch pages.
- From the tray menu: Open, Settings, Logs, Tests, Start/Stop server, Check for updates, Quit.
- **Settings** (`/settings`): themes, alerts, panels, animations, chat, statistics — everything applies live to overlays already open in OBS, no restart needed.
- **Logs** (`/logs`): live tail of server logs, useful for diagnosing Twitch/ngrok issues.

## 📹 OBS overlays

Add these pages as browser sources in OBS (the server must be running):

| Page | URL |
|---|---|
| Starting | `http://localhost:8080/starting.html` |
| Main overlay | `http://localhost:8080/` |
| Pause | `http://localhost:8080/pause.html` |
| Ending | `http://localhost:8080/ending.html` |

The `ConfigOBS.json` file at the project root contains ready-to-import OBS scenes (Starting, Game, Pause, Ending) with their sources preconfigured.

## 🧪 Simulating events

The **Tests** page (`/tests`) lets you trigger an alert (follow, sub, sub gift, raid, bits), a chat message, or a stream online/offline event without waiting for a real Twitch event — handy for tuning overlay visuals before going live.

For simulating real platform-side Twitch events, the [Twitch CLI](https://dev.twitch.tv/docs/cli/) still works:
```bash
twitch event trigger channel.follow --to-user-id=YOUR_ID --from-user-id=123456
```

## 🔄 Automatic updates

The app checks for new versions on launch and every 4 hours afterward. When an update is available, it downloads in the background and a banner appears on the home page (plus a tray menu entry) to install it with one click.

## 📷 Preview

> Starting screen

![Starting](./readme/starting.gif)

> Pause screen

![Pause](./readme/pause.gif)

> Ending screen

![Ending](./readme/ending.gif)

## 🎨 Customization

Everything is configurable from the app's **Settings** page (`/settings`): per-page theme colors, alert content and style, animations (particles, stars, meteors, DVD logo), info panels, chat appearance, statistics. Changes apply immediately to overlays already open in OBS.

For deeper customization (layout, custom CSS animations), the source files remain editable:
- `public/css/overlay-common.css` — styles shared across overlays
- `public/css/*.css` — per-page styles
- `public/js/overlay-common.js` — shared logic (alerts, chat, theming)

## 🚛 TruckyApp integration

For ETS2/ATS streamers: enable the integration from the setup wizard or Settings, entering your TruckyApp user ID (visible in your profile URL on [truckyapp.com](https://truckyapp.com/): `truckyapp.com/user/YOUR_ID`). The app then automatically fetches your latest job and company statistics. Requires Google Chrome or Microsoft Edge installed on the machine.

## 🛠️ Development (from source)

### Project structure

```
Ma version/
├── electron/               # Electron main process (window, tray, IPC, auto-updater)
│   ├── main.js
│   └── preload.js
├── src/
│   ├── config/
│   │   ├── defaults.json   # Default config
│   │   └── store.js        # Config singleton (live read/write)
│   ├── routes/              # Express routes (API + admin pages)
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
├── public/                  # Overlays + admin pages (static HTML/CSS/JS)
├── server.js                 # TwitchOverlayServer class (start/stop, routes, WebSocket)
├── ConfigOBS.json
└── package.json
```

### Running in development

```bash
git clone https://github.com/Arkyan/ElectrumOverlay.git
cd "Ma version"
npm install
npm run electron     # full Electron app
# or
npm start             # server only (no Electron window), for testing overlays/API
npm run dev           # server only with auto-reload (nodemon)
```

In development, config is stored in `config/overlay-config.json` at the project root (git-ignored). Once installed, the app stores it in `%APPDATA%\ElectrumOverlay\config\`.

### Building the installer

```bash
npm run package:win     # local build, dist/ElectrumOverlay Setup x.x.x.exe
npm run publish:win     # build + publish to GitHub Releases (requires GH_TOKEN)
```

### Other commands

```bash
npm run clean     # removes all active EventSub subscriptions
```

## ❗ Troubleshooting

#### Port 8080 already in use
Another instance of the app is probably already running (check the system tray). Close it before launching another one.

#### Webhooks/alerts not working
1. Check the app's home page for a "ngrok not connected" banner.
2. Check **Logs** (`/logs`) for startup errors.
3. If using your own ngrok authtoken, make sure it's actually set in the wizard (not the placeholder value `$YOUR_AUTHTOKEN`).

#### "Token expired" / 401 Unauthorized
Go back to the setup wizard (`/setup`) and click "Authorize again" to regenerate the authorization.

#### Starting fresh on EventSub subscriptions
```bash
npm run clean
```
or, with the app running, open `http://localhost:8080/clear-subscriptions` in your browser.

---

## 📄 License

MIT License — see the `LICENSE` file.

## 🤝 Contributing

Contributions are welcome! See `CONTRIBUTING.md` for details. In short: fork, create a branch, commit, open a Pull Request.

---

**🎮 Happy streaming! 🚀**
