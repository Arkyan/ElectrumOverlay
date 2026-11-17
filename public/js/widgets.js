/**
 * Base commune des overlays « widgets » (chat.html, goal.html, interactions.html) : sources
 * navigateur indépendantes, fond transparent, à placer où on veut dans OBS.
 *
 * - couleurs du profil actif (thème `index` par défaut, `?theme=pause` pour un autre) ;
 * - `?scale=1.5` agrandit tout ;
 * - connexion WebSocket au serveur, reconnectée automatiquement (l'app peut redémarrer).
 */
(function () {
    const params = new URLSearchParams(location.search);

    function cfg() {
        return globalThis.OVERLAY_CONFIG || {};
    }

    function rgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    }

    function applyTheme() {
        const themes = cfg().themes || {};
        const theme = themes[params.get('theme') || 'index'] || themes.index || {};
        const root = document.documentElement.style;
        for (const [name, value] of [['primary', theme.primary], ['secondary', theme.secondary], ['panel', theme.panelBg]]) {
            if (!value) continue;
            root.setProperty(`--w-${name}`, value);
            const triplet = rgb(value);
            if (triplet) root.setProperty(`--w-${name}-rgb`, triplet);
        }
        const scale = parseFloat(params.get('scale'));
        if (scale > 0) root.setProperty('--w-scale', String(scale));
    }

    const handlers = [];

    function connect() {
        const server = cfg().server || {};
        const ws = new WebSocket(`ws://${server.host || location.hostname || 'localhost'}:${server.wsPort || 8081}`);
        ws.onmessage = (event) => {
            let data;
            try { data = JSON.parse(event.data); } catch { return; }
            if (data.type === 'config-updated') {
                globalThis.OVERLAY_CONFIG = data.config;
                applyTheme();
            }
            handlers.forEach((handler) => handler(data));
        };
        ws.onclose = () => setTimeout(connect, 3000);
    }

    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function formatNumber(n) {
        return Number(n || 0).toLocaleString('fr-FR');
    }

    /** Secondes restantes avant une date ISO (0 si passée ou absente). */
    function secondsUntil(iso) {
        if (!iso) return 0;
        return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
    }

    function formatCountdown(seconds) {
        const m = Math.floor(seconds / 60);
        const s = String(seconds % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    globalThis.Widgets = {
        params,
        escapeHtml,
        formatNumber,
        secondsUntil,
        formatCountdown,
        /** Appelle `handler(message)` pour chaque message du serveur. */
        on(handler) { handlers.push(handler); },
        start() {
            applyTheme();
            connect();
        },
    };
})();
