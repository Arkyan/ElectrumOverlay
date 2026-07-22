const express = require('express');
const config = require('../config/store');

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Intégration Spotify : page d'admin dédiée (à l'image de /tests, /logs...) plutôt qu'une section
 * de /setup ou /settings — contrairement à Twitch, Spotify est entièrement optionnel et ne gate
 * jamais l'app, et contrairement au reste de /settings (un seul gros formulaire sauvegardé d'un
 * bloc), la connexion passe par un aller-retour OAuth avec Spotify lui-même.
 *
 * `auth` : instance partagée de SpotifyAuth (voir src/services/SpotifyAuth.js), la même que celle
 * utilisée par le polling dans server.js — get/set du token doivent rester cohérents entre les
 * deux. `broadcastEvent` n'est pas utilisé ici (la diffusion du morceau en cours vit dans le
 * polling de server.js) : cette route ne fait que lire/écrire les identifiants et déclencher la
 * connexion.
 */
function createSpotifyRoutes(auth) {
    const router = express.Router();

    router.get('/spotify', (req, res) => {
        res.send(SPOTIFY_PAGE_HTML({
            clientId: config.spotify.CLIENT_ID,
            clientSecret: config.spotify.CLIENT_SECRET,
            redirectUri: config.spotify.REDIRECT_URI,
            configured: auth.isConfigured(),
            // L'URL d'autorisation est calculée ICI et posée TELLE QUELLE comme href du bouton
            // (voir plus bas) plutôt que derrière une redirection locale (/api/spotify/connect) :
            // sous Electron, seul un lien qui pointe DIRECTEMENT vers un domaine externe déclenche
            // l'ouverture dans le vrai navigateur système (will-navigate dans electron/main.js,
            // même mécanisme que le bouton "Autoriser l'application Twitch" sur /auth-url) — un
            // clic qui passe d'abord par une redirection 302 côté SERVEUR LOCAL avant d'atteindre
            // Spotify n'est lui jamais intercepté, et la page Spotify s'ouvrait donc dans la
            // fenêtre Electron elle-même au lieu du navigateur.
            authUrl: auth.isConfigured() ? auth.generateAuthUrl() : null,
            connected: auth.isConnected(),
            justConnected: req.query.connected === '1',
            error: req.query.error || null
        }));
    });

    router.post('/api/spotify/credentials', (req, res) => {
        try {
            const body = req.body || {};
            const clientId = String(body.clientId || '').trim();
            const clientSecret = String(body.clientSecret || '').trim();
            if (!clientId || !clientSecret) {
                return res.status(400).json({ error: 'Client ID et Client Secret requis' });
            }
            // Recalculée à chaque sauvegarde à partir du port réel du serveur : reste toujours
            // exacte même si l'utilisateur a changé le port dans l'assistant de configuration.
            // 127.0.0.1, jamais config.server.HOST ("localhost") : Spotify rejette désormais tout
            // redirect_uri en http:// qui n'est pas une IP loopback littérale — "localhost" est un
            // nom résolu par DNS/hosts, pas une IP littérale, et n'est plus accepté même s'il
            // pointe en pratique vers la même machine (voir leur doc "redirect_uri is not secure").
            const redirectUri = `http://127.0.0.1:${config.server.PORT}/api/spotify/callback`;
            config.saveConfig({ spotify: { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret, REDIRECT_URI: redirectUri } });
            res.json({ ok: true, redirectUri });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Callback OAuth (Authorization Code, pas implicit grant comme Twitch) : Spotify renvoie le
    // code en query string directement exploitable côté serveur, pas besoin de la page-relais en
    // JavaScript qu'utilise /auth-callback pour extraire un token du fragment d'URL.
    router.get('/api/spotify/callback', async (req, res) => {
        const { code, error: oauthError } = req.query;
        if (oauthError) {
            return res.redirect('/spotify?error=' + encodeURIComponent('Autorisation refusée sur Spotify.'));
        }
        if (!code) {
            return res.redirect('/spotify?error=' + encodeURIComponent('Code d\'autorisation manquant.'));
        }
        try {
            await auth.exchangeCodeForTokens(code);
            res.redirect('/spotify?connected=1');
        } catch (error) {
            console.error('❌ Erreur lors de l\'échange du code Spotify:', error.response?.data || error.message);
            res.redirect('/spotify?error=' + encodeURIComponent('Échec de la connexion à Spotify.'));
        }
    });

    router.post('/api/spotify/disconnect', (req, res) => {
        auth.disconnect();
        res.json({ ok: true });
    });

    // Dernier morceau connu (best-effort, alimenté par le polling de server.js) — utilisé pour
    // l'aperçu en direct de cette page ET pour l'état initial du widget d'overlay au chargement
    // d'une page (avant le premier message WebSocket 'spotify-track-updated').
    router.get('/api/spotify/now-playing', (req, res) => {
        res.json({ connected: auth.isConnected(), track: auth.lastTrack });
    });

    return router;
}

const SPOTIFY_PAGE_HTML = ({ clientId, clientSecret, redirectUri, configured, authUrl, connected, justConnected, error }) => `
<html>
<head>
    <title>Spotify - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        .spotify-now-playing {
            display: flex; align-items: center; gap: var(--space-3);
            background: var(--surface-elevated); border: 1px solid var(--border);
            border-radius: var(--radius-sm); padding: var(--space-3);
        }
        .spotify-now-playing img { width: 56px; height: 56px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
        .spotify-now-playing .np-title { font-weight: 600; font-size: 14px; }
        .spotify-now-playing .np-artist { font-size: 12px; color: var(--text-muted); }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Intégration Spotify</h1>
        <p>Affiche le morceau en cours de lecture comme élément de scène (voir l'éditeur de scène — menu "+"). Optionnel : n'affecte rien d'autre dans l'app.</p>

        ${error ? `<p class="msg error">${esc(error)}</p>` : ''}
        ${justConnected ? `<p class="msg success">Compte Spotify connecté.</p>` : ''}

        <div class="card">
            <h2 class="card-title">1. Application Spotify</h2>
            <p class="hint">Crée une application sur le <a href="https://developer.spotify.com/dashboard" target="_blank">tableau de bord développeur Spotify</a>, puis ajoute l'URI de redirection ci-dessous dans ses paramètres.</p>

            <div class="field">
                <label>URI de redirection à enregistrer sur Spotify</label>
                <input type="text" readonly value="${esc(redirectUri)}" onclick="this.select()">
            </div>

            <div class="field">
                <label for="clientId">Client ID</label>
                <input type="text" id="clientId" value="${esc(clientId)}">
            </div>
            <div class="field">
                <label for="clientSecret">Client Secret</label>
                <input type="password" id="clientSecret" value="${esc(clientSecret)}">
            </div>
            <button type="button" class="btn btn-primary" id="btnSaveCreds">Enregistrer</button>
            <span class="msg" id="credsMsg"></span>
        </div>

        <div class="card">
            <h2 class="card-title">2. Connexion</h2>
            ${connected ? `
                <div class="status-pill" style="margin-bottom: var(--space-3);"><span class="dot"></span> Connecté</div>
                <div class="spotify-now-playing" id="nowPlaying" style="display:none;">
                    <img id="npArt" alt="">
                    <div>
                        <div class="np-title" id="npTitle"></div>
                        <div class="np-artist" id="npArtist"></div>
                    </div>
                </div>
                <p class="hint" id="npHint">Rien en cours de lecture pour le moment.</p>
                <button type="button" class="btn btn-danger" id="btnDisconnect" style="margin-top: var(--space-3);">Déconnecter</button>
            ` : configured ? `
                <p class="hint">Application enregistrée — connecte ton compte Spotify.</p>
                <a href="${esc(authUrl)}" class="btn btn-primary">Se connecter à Spotify</a>
            ` : `
                <p class="hint">Renseigne d'abord le Client ID et le Client Secret ci-dessus.</p>
                <button type="button" class="btn" disabled>Se connecter à Spotify</button>
            `}
        </div>
    </div>

    <script>
        document.getElementById('btnSaveCreds').addEventListener('click', async () => {
            const clientId = document.getElementById('clientId').value.trim();
            const clientSecret = document.getElementById('clientSecret').value.trim();
            const msg = document.getElementById('credsMsg');
            try {
                const res = await fetch('/api/spotify/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId, clientSecret })
                });
                const data = await res.json();
                if (data.ok) {
                    msg.textContent = 'Enregistré.';
                    msg.className = 'msg success';
                    setTimeout(() => window.location.reload(), 600);
                } else {
                    msg.textContent = data.error || 'Erreur';
                    msg.className = 'msg error';
                }
            } catch (err) {
                msg.textContent = 'Impossible de contacter le serveur.';
                msg.className = 'msg error';
            }
        });

        const btnDisconnect = document.getElementById('btnDisconnect');
        if (btnDisconnect) {
            btnDisconnect.addEventListener('click', async () => {
                btnDisconnect.disabled = true;
                await fetch('/api/spotify/disconnect', { method: 'POST' });
                window.location.reload();
            });
        }

        // Aperçu en direct du morceau en cours (best-effort, purement informatif sur cette page —
        // le vrai overlay se met à jour via WebSocket, voir overlay-common.js).
        async function pollNowPlaying() {
            try {
                const res = await fetch('/api/spotify/now-playing');
                const data = await res.json();
                const box = document.getElementById('nowPlaying');
                const hint = document.getElementById('npHint');
                if (!box) return;
                if (data.track) {
                    document.getElementById('npTitle').textContent = data.track.title;
                    document.getElementById('npArtist').textContent = data.track.artist;
                    const art = document.getElementById('npArt');
                    if (data.track.albumArt) { art.src = data.track.albumArt; art.style.display = ''; } else { art.style.display = 'none'; }
                    box.style.display = 'flex';
                    hint.style.display = 'none';
                } else {
                    box.style.display = 'none';
                    hint.style.display = '';
                }
            } catch (err) { /* best-effort */ }
        }
        if (document.getElementById('nowPlaying')) {
            pollNowPlaying();
            setInterval(pollNowPlaying, 5000);
        }
    </script>
</body>
</html>
`;

module.exports = createSpotifyRoutes;
