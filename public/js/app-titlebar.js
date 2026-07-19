/**
 * Barre de titre custom pour les pages d'administration affichées dans la fenêtre Electron
 * (accueil, /setup, /settings). N'a aucun effet si la page est ouverte dans un navigateur
 * normal (window.electronAPI n'existe alors pas — exposé uniquement par electron/preload.js).
 */
(function () {
    if (typeof window === 'undefined' || !window.electronAPI) return;

    const bar = document.createElement('div');
    bar.className = 'app-titlebar';
    bar.innerHTML = `
        <img src="/logo.png" alt="">
        <span class="app-titlebar-title">ElectrumOverlay</span>
        <div class="app-titlebar-controls">
            <button type="button" class="app-titlebar-minimize" aria-label="Réduire" title="Réduire">&#8211;</button>
            <button type="button" class="app-titlebar-maximize" aria-label="Agrandir" title="Agrandir">&#9633;</button>
            <button type="button" class="app-titlebar-close" aria-label="Fermer" title="Fermer">&#215;</button>
        </div>
    `;
    document.body.prepend(bar);

    const minimizeBtn = bar.querySelector('.app-titlebar-minimize');
    const maximizeBtn = bar.querySelector('.app-titlebar-maximize');
    const closeBtn = bar.querySelector('.app-titlebar-close');

    minimizeBtn.addEventListener('click', () => window.electronAPI.minimize());
    maximizeBtn.addEventListener('click', () => window.electronAPI.maximize());
    closeBtn.addEventListener('click', () => window.electronAPI.close());

    const titleEl = bar.querySelector('.app-titlebar-title');
    window.electronAPI.getAppVersion().then((version) => {
        if (version) titleEl.textContent = `ElectrumOverlay | v${version}`;
    });

    function setMaximized(isMaximized) {
        maximizeBtn.setAttribute('aria-label', isMaximized ? 'Restaurer' : 'Agrandir');
        maximizeBtn.title = isMaximized ? 'Restaurer' : 'Agrandir';
        maximizeBtn.innerHTML = isMaximized ? '&#10064;' : '&#9633;';
    }

    window.electronAPI.isMaximized().then(setMaximized);
    window.electronAPI.onMaximizedChange(setMaximized);
})();
