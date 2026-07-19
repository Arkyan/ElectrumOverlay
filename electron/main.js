const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Par défaut, Electron dérive app.getName() (donc app.getPath('userData')) du champ "name" du
// package.json ("twitch-overlay-server"), pas de "productName" — sans ce setName() explicite,
// le mode dev (`electron .`) ET l'app installée pointent vers le MÊME dossier AppData, ce qui
// mélange les données de dev/test avec celles d'une installation "propre".
app.setName('ElectrumOverlay');

// Doit être positionné avant tout require de server.js/store.js : c'est ce qui leur dit où
// lire/écrire la config utilisateur (dossier garanti inscriptible, contrairement à côté de
// l'exe si l'app est installée dans Program Files).
process.env.ELECTRUM_CONFIG_DIR = path.join(app.getPath('userData'), 'config');

const TwitchOverlayServer = require('../server.js');

let mainWindow = null;
let tray = null;
let server = null;
let isQuitting = false;
let updaterState = { status: 'idle' };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    function getIconPath() {
        return path.join(__dirname, '..', 'public', 'logo.png');
    }

    function createWindow() {
        mainWindow = new BrowserWindow({
            width: 980,
            height: 720,
            minWidth: 720,
            minHeight: 480,
            title: `ElectrumOverlay v${app.getVersion()}`,
            icon: getIconPath(),
            frame: false,
            backgroundColor: '#0b0d12',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js')
            }
        });

        mainWindow.loadURL(`http://localhost:${server.port}/app`);

        // Tous les liens externes (autorisation Twitch, doc ngrok, dev.twitch.tv...) doivent
        // s'ouvrir dans le navigateur système, jamais dans une fenêtre Electron.
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            shell.openExternal(url);
            return { action: 'deny' };
        });
        mainWindow.webContents.on('will-navigate', (event, url) => {
            const isOwnServer = url.startsWith(`http://localhost:${server.port}`);
            if (!isOwnServer) {
                event.preventDefault();
                shell.openExternal(url);
            }
        });

        mainWindow.on('maximize', () => mainWindow.webContents.send('window-maximized-change', true));
        mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized-change', false));

        // Filet de sécurité pour revenir en arrière (Alt+Gauche) : fonctionne même sur des pages
        // sans HTML/JS (ex: une route qui renvoie du JSON brut), contrairement à un bouton
        // injecté par script qui ne peut pas exister sur ce genre de page.
        mainWindow.webContents.on('before-input-event', (event, input) => {
            if (input.type === 'keyDown' && input.alt && input.key === 'ArrowLeft') {
                if (mainWindow.webContents.canGoBack()) {
                    mainWindow.webContents.goBack();
                }
            }
        });

        // Fermer la fenêtre la cache au lieu de quitter : le serveur (ngrok/EventSub/WebSocket)
        // doit continuer de tourner pour OBS même fenêtre fermée. Seul le tray "Quitter" quitte vraiment.
        mainWindow.on('close', (event) => {
            if (isQuitting) return;
            event.preventDefault();
            mainWindow.hide();
        });
    }

    /**
     * Reconstruit le menu du tray en fonction de l'état du serveur (Démarrer/Arrêter) — c'est le
     * seul contrôle garanti disponible même si la fenêtre affiche une page en erreur (ex: server
     * arrêté et fenêtre restée sur une page qui a besoin du HTTP local pour se recharger).
     */
    function updateTrayMenu() {
        if (!tray) return;
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Ouvrir', click: () => mainWindow.show() },
            {
                label: 'Paramètres', click: () => {
                    mainWindow.show();
                    mainWindow.loadURL(`http://localhost:${server.port}/settings`);
                }
            },
            {
                label: 'Logs', click: () => {
                    mainWindow.show();
                    mainWindow.loadURL(`http://localhost:${server.port}/logs`);
                }
            },
            {
                label: 'Tests', click: () => {
                    mainWindow.show();
                    mainWindow.loadURL(`http://localhost:${server.port}/tests`);
                }
            },
            { type: 'separator' },
            server.isRunning
                ? { label: 'Arrêter le serveur', click: () => stopServer() }
                : { label: 'Démarrer le serveur', click: () => startServer() },
            { type: 'separator' },
            updaterState.status === 'downloaded'
                ? { label: `Installer la mise à jour (v${updaterState.version})`, click: () => installUpdate() }
                : { label: 'Vérifier les mises à jour', click: () => checkForUpdates(), enabled: app.isPackaged },
            {
                label: 'Quitter', click: async () => {
                    isQuitting = true;
                    try {
                        await server.eventSubManager.cleanupSubscriptions();
                    } catch (error) {
                        // best-effort : on quitte de toute façon
                    }
                    app.quit();
                }
            }
        ]));
    }

    /**
     * Auto-updater (electron-updater) : vérifie/télécharge/installe les mises à jour depuis les
     * GitHub Releases du repo. N'a de sens qu'une fois packagée — en dev il n'y a pas de vraie
     * installation NSIS à mettre à jour.
     */
    function setUpdaterState(status, extra = {}) {
        updaterState = { status, ...extra };
        mainWindow?.webContents.send('updater-status-change', updaterState);
        updateTrayMenu();
    }

    function checkForUpdates() {
        if (!app.isPackaged) return;
        autoUpdater.checkForUpdates().catch((error) => {
            console.error('❌ Erreur de vérification de mise à jour:', error.message);
        });
    }

    function installUpdate() {
        isQuitting = true;
        autoUpdater.quitAndInstall();
    }

    function setupAutoUpdater() {
        if (!app.isPackaged) return;

        autoUpdater.autoDownload = true;
        // On garde la main sur l'installation (bouton dédié) plutôt que de l'imposer à la
        // fermeture de l'app, qui coupe le serveur pour OBS sans prévenir.
        autoUpdater.autoInstallOnAppQuit = false;

        autoUpdater.on('checking-for-update', () => {
            console.log('🔄 Recherche de mise à jour...');
            setUpdaterState('checking');
        });
        autoUpdater.on('update-available', (info) => {
            console.log(`⬇️  Mise à jour disponible : v${info.version}`);
            setUpdaterState('downloading', { version: info.version, percent: 0 });
        });
        autoUpdater.on('update-not-available', () => {
            setUpdaterState('idle');
        });
        autoUpdater.on('download-progress', (progress) => {
            setUpdaterState('downloading', { version: updaterState.version, percent: Math.round(progress.percent) });
        });
        autoUpdater.on('update-downloaded', (info) => {
            console.log(`✅ Mise à jour v${info.version} prête à installer.`);
            setUpdaterState('downloaded', { version: info.version });
        });
        autoUpdater.on('error', (error) => {
            console.error('❌ Erreur de mise à jour:', error.message);
            setUpdaterState('error', { message: error.message });
        });

        checkForUpdates();
        setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
    }

    async function startServer() {
        try {
            await server.start();
        } catch (error) {
            console.error('❌ Erreur au démarrage du serveur:', error.message);
        }
        updateTrayMenu();
        mainWindow?.webContents.send('server-status-change', server.isRunning);
    }

    async function stopServer() {
        await server.stop();
        updateTrayMenu();
        mainWindow?.webContents.send('server-status-change', server.isRunning);
    }

    function createTray() {
        const icon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
        tray = new Tray(icon);
        tray.setToolTip('ElectrumOverlay');
        updateTrayMenu();
        tray.on('click', () => {
            mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
        });
    }

    // Contrôles de la barre de titre custom (public/js/app-titlebar.js), via preload.js.
    ipcMain.on('window-minimize', () => mainWindow?.minimize());
    ipcMain.on('window-maximize', () => {
        if (!mainWindow) return;
        mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    });
    ipcMain.on('window-close', () => mainWindow?.close());
    ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

    // Démarrer/arrêter le serveur local depuis la page /app (bouton à côté du statut). Passe par
    // IPC et non une route HTTP : une fois le serveur arrêté, il n'y a plus rien pour répondre à
    // une requête HTTP qui demanderait de le redémarrer.
    ipcMain.handle('server-status', () => server?.isRunning ?? false);
    ipcMain.handle('server-start', () => startServer());
    ipcMain.handle('server-stop', () => stopServer());

    // Version affichée dans la barre de titre custom (public/js/app-titlebar.js).
    ipcMain.handle('app-version', () => app.getVersion());

    // Auto-updater : idem, IPC plutôt qu'HTTP.
    ipcMain.handle('updater-status', () => updaterState);
    ipcMain.handle('updater-check', () => { checkForUpdates(); return true; });
    ipcMain.handle('updater-install', () => installUpdate());

    app.whenReady().then(async () => {
        server = new TwitchOverlayServer();
        try {
            await server.start();
        } catch (error) {
            // Sans ça, un échec ici (ex: port déjà utilisé par une autre instance) laisse l'app
            // silencieusement sans aucune fenêtre — impossible à comprendre pour l'utilisateur.
            const { dialog } = require('electron');
            dialog.showErrorBox(
                'ElectrumOverlay ne peut pas démarrer',
                `Le serveur n'a pas pu démarrer : ${error.message}\n\nUne autre instance est peut-être déjà lancée (vérifiez l'icône dans la zone de notification).`
            );
            app.quit();
            return;
        }
        createWindow();
        createTray();
        setupAutoUpdater();
    });

    app.on('window-all-closed', () => {
        // Ne rien faire : cf. commentaire sur mainWindow.on('close', ...) plus haut.
    });

    app.on('activate', () => {
        if (mainWindow) mainWindow.show();
    });
}
