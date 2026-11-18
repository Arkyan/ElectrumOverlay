/**
 * Bibliothèque des widgets personnalisés d'ElectrumOverlay (documentation : page « Widgets » de
 * l'app). À inclure dans la page du widget :
 *
 *   <script src="/js/electrum-widget.js"></script>
 *   <script>
 *     Electrum.ready(() => {
 *       Electrum.on('follow', (e) => console.log('Nouveau follow :', e.user));
 *     });
 *   </script>
 *
 * Le widget est affiché dans un cadre isolé (iframe) de la scène : ses unités vw/vh se rapportent
 * à ce cadre. Il peut aussi être ouvert seul dans un navigateur pour le développer :
 * http://localhost:8080/widgets/<id>/
 */
(function () {
    const params = new URLSearchParams(location.search);
    const listeners = {};
    const readyCallbacks = [];
    let isReady = false;

    function parseSettings() {
        try {
            const raw = decodeURIComponent(location.hash.slice(1));
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function emit(type, data) {
        (listeners[type] || []).forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } });
        if (type !== '*') (listeners['*'] || []).forEach((cb) => { try { cb({ type, ...data }); } catch (e) { console.error(e); } });
    }

    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /** Message de chat en HTML, emotes Twitch en images. */
    function chatHtml(text, fragments) {
        if (!Array.isArray(fragments) || fragments.length === 0) return escapeHtml(text);
        return fragments.map((f) => f.type === 'emote' && f.emote && f.emote.id
            ? `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(f.emote.id)}/default/dark/2.0" alt="${escapeHtml(f.text)}">`
            : escapeHtml(f.text)).join('');
    }

    const TIERS = { 1000: 1, 2000: 2, 3000: 3 };

    /** Messages du serveur → événements simples des widgets. */
    function dispatch(message) {
        const d = message.data || {};
        switch (message.type) {
            case 'channel.follow':
                return emit('follow', { user: d.user_name, userId: d.user_id });
            case 'channel.subscribe':
                return emit('sub', {
                    user: d.user_name, userId: d.user_id, tier: TIERS[d.tier] || 1,
                    months: d.cumulative_months || 1, gifted: !!d.is_gift, message: d.message ? (d.message.text || '') : ''
                });
            case 'channel.subscription.gift':
                return emit('subgift', { user: d.is_anonymous ? null : d.user_name, count: d.total || 1, tier: TIERS[d.tier] || 1, anonymous: !!d.is_anonymous });
            case 'channel.cheer':
                return emit('bits', { user: d.is_anonymous ? null : d.user_name, amount: d.bits || 0, message: d.message || '', anonymous: !!d.is_anonymous });
            case 'channel.raid':
                return emit('raid', { user: d.from_broadcaster_user_name, viewers: d.viewers || 0 });
            case 'message':
                return emit('chat', {
                    user: message.displayName || message.username, userId: message.userId, color: message.color,
                    text: message.message || '', html: chatHtml(message.message, message.fragments), badges: message.badges || {},
                    command: String(message.message || '').startsWith('!')
                });
            case 'stream.online':
                return emit('stream', { live: true, title: d.title || '', game: d.category_name || '' });
            case 'stream.offline':
                return emit('stream', { live: false });
            case 'channel.update':
                return emit('channel', { title: d.title || '', game: d.category_name || '' });
            case 'interaction':
                return emit(message.kind, { phase: message.phase, ...message.data });
            case 'spotify-track-updated':
                return emit('music', message.track || null);
            case 'input-key':
                return emit('key', { key: message.label, kind: message.kind, down: message.state === 'down' });
            case 'config-updated':
            case 'language-changed':
                return loadContext().then(() => emit('theme', Electrum.theme));
            default:
                return undefined;
        }
    }

    function applyThemeVariables() {
        const t = Electrum.theme || {};
        const root = document.documentElement.style;
        const vars = { primary: t.primary, secondary: t.secondary, accent: t.accent, text: t.text, 'muted-text': t.mutedText, panel: t.panelBg, border: t.panelBorder };
        for (const [name, value] of Object.entries(vars)) {
            if (value) root.setProperty('--electrum-' + name, value);
        }
    }

    async function loadContext() {
        try {
            const ctx = await fetch('/api/widget-context?page=' + encodeURIComponent(Electrum.page)).then((r) => r.json());
            Electrum.theme = ctx.theme || {};
            Electrum.themes = ctx.themes || {};
            Electrum.language = ctx.language || 'fr';
            Electrum.channel = ctx.channel || {};
            Electrum.profile = ctx.profile || null;
            Electrum.server = ctx.server || {};
            applyThemeVariables();
        } catch (e) {
            console.warn('ElectrumOverlay injoignable', e);
        }
    }

    function connect() {
        const port = Electrum.server.wsPort || 8081;
        const ws = new WebSocket(`ws://${location.hostname || 'localhost'}:${port}`);
        ws.onmessage = (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch (e) { return; }
            dispatch(message);
            emit('raw', message);
        };
        // L'app peut être redémarrée : on se reconnecte.
        ws.onclose = () => setTimeout(connect, 3000);
    }

    const getJson = (url) => fetch(url).then((r) => r.json());

    const Electrum = {
        /** Réglages de cet élément, choisis dans l'éditeur de scène (clés du widget.json). */
        settings: parseSettings(),
        /** Clé de la scène (starting, index, pause, ending, ou id d'une scène personnalisée). */
        page: params.get('page') || 'index',
        /** Identifiant de l'élément dans la scène. */
        element: params.get('element') || null,
        /** true dans l'aperçu de l'éditeur de scène : afficher un exemple pour aider au placement. */
        preview: params.get('preview') === '1',
        /** Couleurs du thème de la scène (primary, secondary, accent, text, mutedText, panelBg...). */
        theme: {},
        themes: {},
        language: 'fr',
        channel: {},
        profile: null,
        server: {},

        /** Appelle `callback(données)` à chaque événement `type` ('*' : tous). */
        on(type, callback) {
            (listeners[type] = listeners[type] || []).push(callback);
            return () => Electrum.off(type, callback);
        },
        off(type, callback) {
            listeners[type] = (listeners[type] || []).filter((cb) => cb !== callback);
        },
        /** Appelle `callback` une fois le contexte chargé (thème, langue...). */
        ready(callback) {
            if (isReady) callback(); else readyCallbacks.push(callback);
        },

        /** Statistiques du live : isLive, viewerCount, follows, subscribers, chatMessages, title, game, streamDuration. */
        getStats: () => getJson('/api/stream-stats'),
        /** Dernières alertes (du plus récent au plus ancien) : { id, type, user, detail, time, data }. */
        getHistory: () => getJson('/api/events/history').then((r) => (r.events || []).map((e) => ({ ...e, type: e.type.replace('channel.', '').replace('subscription.gift', 'subgift').replace('subscribe', 'sub').replace('cheer', 'bits') }))),
        /** Objectif, sondage, prédiction et hype train en cours (null si rien). */
        getInteractions: () => getJson('/api/interactions'),
        /** Morceau Spotify en cours (null si rien). */
        getMusic: () => getJson('/api/spotify/now-playing').catch(() => null),

        /** Échappe un texte pour l'insérer en HTML. */
        escapeHtml,
    };
    globalThis.Electrum = Electrum;

    loadContext().then(() => {
        connect();
        isReady = true;
        readyCallbacks.splice(0).forEach((cb) => { try { cb(); } catch (e) { console.error(e); } });
    });
})();
