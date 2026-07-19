const { contextBridge, ipcRenderer } = require('electron');

// Pont sûr entre les pages (HTML servi par Express, sans accès Node direct) et le process
// principal — nécessaire pour que la barre de titre custom (public/js/app-titlebar.js) puisse
// piloter la fenêtre (réduire/agrandir/fermer) sans exposer Node/Electron en entier à la page.
contextBridge.exposeInMainWorld('electronAPI', {
    getAppVersion: () => ipcRenderer.invoke('app-version'),

    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizedChange: (callback) => {
        ipcRenderer.on('window-maximized-change', (event, isMaximized) => callback(isMaximized));
    },

    // Démarrer/arrêter le serveur local (bouton sur la page d'accueil). Passe par IPC, pas par
    // une route HTTP : une fois le serveur arrêté, une requête HTTP n'aurait plus rien pour
    // répondre à une demande de redémarrage.
    getServerStatus: () => ipcRenderer.invoke('server-status'),
    startServer: () => ipcRenderer.invoke('server-start'),
    stopServer: () => ipcRenderer.invoke('server-stop'),
    onServerStatusChange: (callback) => {
        ipcRenderer.on('server-status-change', (event, isRunning) => callback(isRunning));
    },

    // Auto-updater (GitHub Releases). Idem : IPC, pas HTTP.
    getUpdaterStatus: () => ipcRenderer.invoke('updater-status'),
    checkForUpdates: () => ipcRenderer.invoke('updater-check'),
    installUpdate: () => ipcRenderer.invoke('updater-install'),
    onUpdaterStatusChange: (callback) => {
        ipcRenderer.on('updater-status-change', (event, state) => callback(state));
    }
});
