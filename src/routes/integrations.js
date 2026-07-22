const express = require('express');
const config = require('../config/store');

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Intégrations tierces optionnelles (Spotify, Trucky) : page d'admin dédiée (à l'image de /tests,
 * /logs...) plutôt qu'une section de /setup ou /settings — contrairement à Twitch, ni l'une ni
 * l'autre ne gate jamais l'app, et contrairement au reste de /settings (un seul gros formulaire
 * sauvegardé d'un bloc), Spotify passe par un aller-retour OAuth avec Spotify lui-même.
 * Regroupées sur une seule page (plutôt qu'une page par intégration) car ce sont, à terme, les
 * mêmes genre de réglages : un "brancher/débrancher" optionnel, sans redémarrage requis —
 * contrairement à ngrok, dont la configuration reste dans /setup (nécessaire à EventSub, donc
 * pas vraiment "optionnelle", et qui ne se recharge qu'au lancement du process).
 *
 * `spotifyAuth` : instance partagée de SpotifyAuth (voir src/services/SpotifyAuth.js), la même
 * que celle utilisée par le polling dans server.js — get/set du token doivent rester cohérents
 * entre les deux.
 */
function createIntegrationsRoutes(spotifyAuth) {
    const router = express.Router();

    router.get('/integrations', (req, res) => {
        res.send(INTEGRATIONS_PAGE_HTML({
            clientId: config.spotify.CLIENT_ID,
            clientSecret: config.spotify.CLIENT_SECRET,
            redirectUri: config.spotify.REDIRECT_URI,
            configured: spotifyAuth.isConfigured(),
            // L'URL d'autorisation est calculée ICI et posée TELLE QUELLE comme href du bouton
            // (voir plus bas) plutôt que derrière une redirection locale : sous Electron, seul un
            // lien qui pointe DIRECTEMENT vers un domaine externe déclenche l'ouverture dans le
            // vrai navigateur système (will-navigate dans electron/main.js, même mécanisme que le
            // bouton "Autoriser l'application Twitch" sur /auth-url) — un clic qui passe d'abord
            // par une redirection 302 côté SERVEUR LOCAL avant d'atteindre Spotify n'est lui
            // jamais intercepté, et la page Spotify s'ouvrait donc dans la fenêtre Electron
            // elle-même au lieu du navigateur.
            authUrl: spotifyAuth.isConfigured() ? spotifyAuth.generateAuthUrl() : null,
            connected: spotifyAuth.isConnected(),
            justConnected: req.query.connected === '1',
            error: req.query.error || null,
            truckyEnabled: config.trucky.enable,
            truckyUserId: config.trucky.USER_ID
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
            return res.redirect('/integrations?error=' + encodeURIComponent('Autorisation refusée sur Spotify.'));
        }
        if (!code) {
            return res.redirect('/integrations?error=' + encodeURIComponent('Code d\'autorisation manquant.'));
        }
        try {
            await spotifyAuth.exchangeCodeForTokens(code);
            res.redirect('/integrations?connected=1');
        } catch (error) {
            console.error('❌ Erreur lors de l\'échange du code Spotify:', error.response?.data || error.message);
            res.redirect('/integrations?error=' + encodeURIComponent('Échec de la connexion à Spotify.'));
        }
    });

    router.post('/api/spotify/disconnect', (req, res) => {
        spotifyAuth.disconnect();
        res.json({ ok: true });
    });

    // Dernier morceau connu (best-effort, alimenté par le polling de server.js) — utilisé pour
    // l'aperçu en direct de cette page ET pour l'état initial du widget d'overlay au chargement
    // d'une page (avant le premier message WebSocket 'spotify-track-updated').
    router.get('/api/spotify/now-playing', (req, res) => {
        res.json({ connected: spotifyAuth.isConnected(), track: spotifyAuth.lastTrack });
    });

    // Trucky : contrairement à ngrok, TruckyApi relit config.trucky à chaque appel (une instance
    // par requête dans /api/info-panel) — pas de redémarrage nécessaire, la sauvegarde prend
    // effet immédiatement.
    router.post('/api/integrations/trucky', (req, res) => {
        try {
            const body = req.body || {};
            config.saveConfig({
                trucky: { enable: Boolean(body.enabled), USER_ID: String(body.userId || '').trim() }
            });
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    return router;
}

const INTEGRATIONS_PAGE_HTML = ({
    clientId, clientSecret, redirectUri, configured, authUrl, connected, justConnected, error,
    truckyEnabled, truckyUserId
}) => `
<html>
<head>
    <title>Intégrations - ElectrumOverlay</title>
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
        .page.wide { max-width: 980px; }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app wide">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Intégrations</h1>
        <p>Réglages tiers optionnels — n'affectent rien d'autre dans l'app et se sauvegardent sans redémarrer le serveur.</p>

        ${error ? `<p class="msg error">${esc(error)}</p>` : ''}
        ${justConnected ? `<p class="msg success">Compte Spotify connecté.</p>` : ''}

        <div class="settings-layout">
            <nav class="settings-nav" id="integrationsNav">
                <button type="button" class="settings-nav-btn active" data-target="section-spotify">Spotify</button>
                <button type="button" class="settings-nav-btn" data-target="section-trucky">Trucky</button>
            </nav>
            <div class="settings-content">

                <div class="settings-section active" id="section-spotify">
                    <h2>Spotify</h2>
                    <p class="hint">Affiche le morceau en cours de lecture comme élément de scène (voir l'éditeur de scène — menu "+").</p>

                    <div class="card">
                        <h2 class="card-title">Application Spotify</h2>
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
                        <h2 class="card-title">Connexion Spotify</h2>
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

                <div class="settings-section" id="section-trucky">
                    <h2>Trucky</h2>
                    <p class="hint">Statistiques de trajet/société ETS2/ATS pour le panneau d'informations (voir /settings — panneau gauche). Nécessite Google Chrome ou Microsoft Edge installé sur cette machine.</p>

                    <div class="card">
                        <h2 class="card-title">Trucky</h2>
                        <label class="checkbox-row"><input type="checkbox" id="truckyEnabled" ${truckyEnabled ? 'checked' : ''}> Activer les statistiques Trucky</label>
                        <div class="field" style="margin-top:var(--space-3);">
                            <label for="truckyUserId">ID utilisateur Trucky</label>
                            <input type="text" id="truckyUserId" value="${esc(truckyUserId || '')}">
                        </div>
                        <button type="button" class="btn btn-primary" id="btnSaveTrucky">Enregistrer</button>
                        <span class="msg" id="truckyMsg"></span>
                    </div>
                </div>

            </div>
        </div>
    </div>

    <script>
        // ---------- Navigation entre sections (Spotify / Trucky) ----------
        // Même pattern que /settings : une seule section affichée à la fois (sidebar bascule
        // .settings-section.active), le reste reste dans le DOM. Section active mémorisée en
        // sessionStorage (clé distincte de /settings) pour ne pas revenir sur Spotify après un
        // location.reload() (ex: après avoir sauvegardé Trucky) si l'utilisateur consultait
        // cette section-là.
        function selectSection(sectionId) {
            document.querySelectorAll('.settings-nav-btn').forEach((b) => {
                b.classList.toggle('active', b.dataset.target === sectionId);
            });
            document.querySelectorAll('.settings-section').forEach((section) => {
                section.classList.toggle('active', section.id === sectionId);
            });
            sessionStorage.setItem('integrationsActiveSection', sectionId);
        }

        document.querySelectorAll('.settings-nav-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                selectSection(btn.dataset.target);
                document.querySelector('.settings-content').scrollTop = 0;
            });
        });

        const savedIntegrationsSection = sessionStorage.getItem('integrationsActiveSection');
        if (savedIntegrationsSection && document.getElementById(savedIntegrationsSection)) {
            selectSection(savedIntegrationsSection);
        }

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

        document.getElementById('btnSaveTrucky').addEventListener('click', async () => {
            const enabled = document.getElementById('truckyEnabled').checked;
            const userId = document.getElementById('truckyUserId').value.trim();
            const msg = document.getElementById('truckyMsg');
            try {
                const res = await fetch('/api/integrations/trucky', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled, userId })
                });
                const data = await res.json();
                msg.textContent = data.ok ? 'Enregistré.' : (data.error || 'Erreur');
                msg.className = 'msg ' + (data.ok ? 'success' : 'error');
            } catch (err) {
                msg.textContent = 'Impossible de contacter le serveur.';
                msg.className = 'msg error';
            }
        });
    </script>
</body>
</html>
`;

module.exports = createIntegrationsRoutes;
