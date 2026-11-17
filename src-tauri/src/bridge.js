// Pont window.electronAPI pour la version Tauri : les pages de l'app (barre de titre, bouton
// « Arrêter le serveur », bannière de mise à jour) ont été écrites pour Electron et appellent
// window.electronAPI (voir electron/preload.js). On recrée exactement la même API au-dessus des
// commandes Tauri, sans toucher aux pages. Injecté avant tout script de la page.
(function () {
    if (window.electronAPI || !window.__TAURI_INTERNALS__) return;

    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args || {});

    // Les notifications « ça a changé » d'Electron deviennent une interrogation périodique :
    // le rappel n'est appelé que quand la valeur change.
    function watch(command, callback, periodMs) {
        let last;
        setInterval(() => {
            invoke(command).then((value) => {
                const key = JSON.stringify(value);
                if (last !== undefined && key !== last) callback(value);
                last = key;
            }).catch(() => {});
        }, periodMs);
    }

    window.electronAPI = {
        getAppVersion: () => invoke('app_version'),

        // Propre à la version Tauri : démarrage avec Windows.
        getAutostart: () => invoke('autostart_status'),
        setAutostart: (enabled, minimized) => invoke('autostart_set', { enabled, minimized }),
        // Partage de profil : fenêtre « Enregistrer sous », renvoie le chemin (null si annulé).
        saveSharedProfile: (id, params) => invoke('profile_share_save', { id, params }),
        // Menu de l'icône de notification reconstruit (langue changée).
        refreshTray: () => invoke('tray_refresh'),

        minimize: () => invoke('window_minimize'),
        maximize: () => invoke('window_toggle_maximize'),
        close: () => invoke('window_close'),
        isMaximized: () => invoke('window_is_maximized'),
        onMaximizedChange: (callback) => watch('window_is_maximized', callback, 500),

        getServerStatus: () => invoke('server_status'),
        startServer: () => invoke('server_start'),
        stopServer: () => invoke('server_stop'),
        onServerStatusChange: (callback) => watch('server_status', callback, 1000),

        getUpdaterStatus: () => invoke('updater_status'),
        checkForUpdates: () => invoke('updater_check'),
        installUpdate: () => invoke('updater_install'),
        onUpdaterStatusChange: (callback) => watch('updater_status', callback, 2000)
    };

    // Barre de titre maison (public/js/app-titlebar.js) : sous Electron, le déplacement passait
    // par le CSS -webkit-app-region ; sous Tauri, par l'attribut data-tauri-drag-region.
    function markDragRegion() {
        const bar = document.querySelector('.app-titlebar');
        if (!bar || bar.hasAttribute('data-tauri-drag-region')) return;
        bar.setAttribute('data-tauri-drag-region', '');
        bar.querySelectorAll(':scope > img, :scope > span').forEach((el) => el.setAttribute('data-tauri-drag-region', ''));
    }
    new MutationObserver(markDragRegion).observe(document, { childList: true, subtree: true });

    // Alt + ← : page précédente, comme la version Electron.
    window.addEventListener('keydown', (event) => {
        if (event.altKey && event.key === 'ArrowLeft' && history.length > 1) history.back();
    });
})();
