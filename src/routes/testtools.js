const express = require('express');
const config = require('../config/store');

/**
 * Fausses données d'événement Twitch, au même format que ce que renvoie réellement l'API
 * EventSub. Passées à WebhookHandler.routeEvent() directement — même chemin que les vrais
 * webhooks (mise à jour des stats, diffusion WebSocket), rien n'est dupliqué ici.
 */
function fakeBroadcaster() {
    return {
        broadcaster_user_id: config.twitch.BROADCASTER_ID || 'test',
        broadcaster_user_login: config.twitch.BROADCASTER_LOGIN || 'broadcaster',
        broadcaster_user_name: config.twitch.BROADCASTER_LOGIN || 'broadcaster'
    };
}

const TEST_ACTIONS = {
    follow: () => ['channel.follow', {
        ...fakeBroadcaster(),
        user_id: '1', user_login: 'test_viewer', user_name: 'TestViewer',
        followed_at: new Date().toISOString()
    }],
    sub: () => ['channel.subscribe', {
        ...fakeBroadcaster(),
        user_id: '1', user_login: 'test_viewer', user_name: 'TestViewer',
        tier: '1000', is_gift: false
    }],
    subgift: () => ['channel.subscription.gift', {
        ...fakeBroadcaster(),
        user_id: '1', user_login: 'test_viewer', user_name: 'TestViewer',
        total: 5, tier: '1000'
    }],
    raid: () => ['channel.raid', {
        from_broadcaster_user_id: '1', from_broadcaster_user_login: 'test_raider', from_broadcaster_user_name: 'TestRaider',
        to_broadcaster_user_id: config.twitch.BROADCASTER_ID || 'test',
        to_broadcaster_user_name: config.twitch.BROADCASTER_LOGIN || 'broadcaster',
        viewers: 42
    }],
    bits: () => ['channel.cheer', {
        ...fakeBroadcaster(),
        is_anonymous: false, user_id: '1', user_login: 'test_viewer', user_name: 'TestViewer',
        message: 'Super stream !', bits: 100
    }],
    chat: () => ['channel.chat.message', {
        ...fakeBroadcaster(),
        chatter_user_id: '1', chatter_user_login: 'test_viewer', chatter_user_name: 'TestViewer',
        // Un fragment "emote" (Kappa, un emote global Twitch) en plus du texte — pratique pour
        // vérifier le rendu des emotes dans le chat sans attendre un vrai message qui en contient.
        message: {
            text: 'Ceci est un message de test dans le chat ! Kappa',
            fragments: [
                { type: 'text', text: 'Ceci est un message de test dans le chat ! ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } }
            ]
        },
        color: '#9146FF', badges: []
    }],
    info: () => ['channel.chat.message', {
        ...fakeBroadcaster(),
        chatter_user_id: '1', chatter_user_login: 'test_viewer', chatter_user_name: 'TestViewer',
        message: { text: '!info', fragments: [{ type: 'text', text: '!info' }] },
        color: '#9146FF', badges: []
    }],
    streamOnline: () => ['stream.online', {
        ...fakeBroadcaster(),
        id: 'test', type: 'live', started_at: new Date().toISOString()
    }],
    streamOffline: () => ['stream.offline', { ...fakeBroadcaster() }]
};

/**
 * Page de simulation d'événements — pour tester les alertes/animations/panneaux sans attendre
 * un vrai follow/sub/raid sur Twitch.
 */
function createTestToolsRoutes(webhookHandler) {
    const router = express.Router();

    router.get('/tests', (req, res) => {
        res.send(TESTS_PAGE_HTML());
    });

    router.post('/api/tests/trigger', (req, res) => {
        const { action } = req.body || {};
        const build = TEST_ACTIONS[action];
        if (!build) {
            return res.status(400).json({ error: 'Action de test inconnue' });
        }

        const [eventType, event] = build();
        webhookHandler.routeEvent(eventType, event);
        res.json({ ok: true });
    });

    // Affiche le panneau gauche ou le bandeau bas immédiatement, sans attendre leur cycle
    // automatique (voir showInfoPanel/showBottomBar dans public/js/index.js) ni passer par le
    // détour du message de chat "!info" — utilisé par /tests et par le plugin Stream Deck.
    router.post('/api/panels/:panel/show', (req, res) => {
        const { panel } = req.params;
        if (panel !== 'left' && panel !== 'bottom') {
            return res.status(400).json({ error: 'Panneau inconnu (left ou bottom)' });
        }
        if (webhookHandler.broadcastEvent) {
            webhookHandler.broadcastEvent({ type: 'show-panel', panel });
        }
        res.json({ ok: true });
    });

    return router;
}

const TESTS_PAGE_HTML = () => `
<html>
<head>
    <title>Tests - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Tests</h1>
        <p>Simule de faux événements Twitch pour vérifier les overlays sans attendre un vrai follow/sub/raid. Ouvre <code>index.html</code> dans un navigateur (ou regarde OBS) pour voir le résultat.</p>

        <div class="card">
            <h2 class="card-title">Alertes</h2>
            <div class="field-row">
                <button type="button" class="btn" data-action="follow">Follow</button>
                <button type="button" class="btn" data-action="sub">Sub</button>
                <button type="button" class="btn" data-action="subgift">Sub Gift (x5)</button>
                <button type="button" class="btn" data-action="raid">Raid (42 viewers)</button>
                <button type="button" class="btn" data-action="bits">Bits (100)</button>
            </div>
        </div>

        <div class="card">
            <h2 class="card-title">Chat et panneaux</h2>
            <div class="field-row">
                <button type="button" class="btn" data-action="chat">Message de chat</button>
                <button type="button" class="btn" data-action="info">Afficher le panneau info (!info)</button>
                <button type="button" class="btn" id="btnShowLeftPanel">Panneau gauche (direct)</button>
                <button type="button" class="btn" id="btnShowBottomBar">Bandeau bas (direct)</button>
            </div>
            <p class="hint">Les deux premiers boutons simulent un vrai événement Twitch (utile pour tester le chemin complet) ; les deux derniers déclenchent l'affichage directement, sans passer par un faux message — et s'affichent même si le panneau concerné est désactivé dans les réglages.</p>
        </div>

        <div class="card">
            <h2 class="card-title">Stream</h2>
            <div class="field-row">
                <button type="button" class="btn" data-action="streamOnline">Stream en ligne</button>
                <button type="button" class="btn" data-action="streamOffline">Stream hors ligne</button>
            </div>
        </div>

        <div class="msg" id="msg" role="status"></div>
    </div>

    <script>
        const msg = document.getElementById('msg');

        async function callTestApi(url, btn) {
            btn.disabled = true;
            try {
                const res = await fetch(url, { method: 'POST' });
                const data = await res.json();
                msg.textContent = data.ok ? 'Envoyé : ' + btn.textContent : (data.error || 'Erreur');
                msg.className = 'msg ' + (data.ok ? 'success' : 'error');
            } catch (e) {
                msg.textContent = 'Impossible de contacter le serveur.';
                msg.className = 'msg error';
            }
            btn.disabled = false;
        }

        document.querySelectorAll('button[data-action]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const res = await fetch('/api/tests/trigger', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: btn.dataset.action })
                    });
                    const data = await res.json();
                    msg.textContent = data.ok ? 'Envoyé : ' + btn.textContent : (data.error || 'Erreur');
                    msg.className = 'msg ' + (data.ok ? 'success' : 'error');
                } catch (e) {
                    msg.textContent = 'Impossible de contacter le serveur.';
                    msg.className = 'msg error';
                }
                btn.disabled = false;
            });
        });

        document.getElementById('btnShowLeftPanel').addEventListener('click', (e) => callTestApi('/api/panels/left/show', e.target));
        document.getElementById('btnShowBottomBar').addEventListener('click', (e) => callTestApi('/api/panels/bottom/show', e.target));
    </script>
</body>
</html>
`;

module.exports = createTestToolsRoutes;
