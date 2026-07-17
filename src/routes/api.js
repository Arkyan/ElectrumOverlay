const express = require('express');
const config = require('../config/store');
const TruckyApi = require('../services/TruckyApi');

/**
 * Créer les routes pour l'API
 */
function createRoutes(eventSubManager, streamStats, auth, getNgrokManager) {
    const router = express.Router();

    // Route pour favicon (éviter les erreurs 404)
    router.get('/favicon.ico', (req, res) => {
        res.status(204).send(); // No Content
    });

    // Route pour supprimer tous les abonnements
    router.get('/clear-subscriptions', async (req, res) => {
        try {
            await eventSubManager.cleanupSubscriptions();
            res.json({ message: 'Tous les abonnements ont été supprimés' });
        } catch (error) {
            console.error('❌ Erreur lors de la suppression des abonnements:', error);
            res.status(500).json({ error: 'Erreur lors de la suppression' });
        }
    });

    router.get('/api/info-panel', async (req, res) => {
        if (!config.trucky.enable) {
            return res.status(404).json({ error: 'Intégration Trucky désactivée' });
        }

        try {
            const truckyapi = new TruckyApi();
            console.log('🔌 Initialisation de l\'API Trucky...');
            const userData = await truckyapi.getUserData();
            if (!userData) {
                console.log('⚠️ Aucun utilisateur trouvé pour l\'API Trucky.');
                return res.status(404).json({ error: 'Aucun utilisateur trouvé pour l\'API Trucky' });
            }
            const lastJobData = await truckyapi.getUserLastJob();
            if (!lastJobData) {
                console.log('⚠️ Aucun job trouvé pour l\'utilisateur Trucky.');
                return res.status(404).json({ error: 'Aucun job trouvé pour l\'utilisateur Trucky' });
            }

            var companyStats;
            var companyDetails;
            if (!userData.company_id) {
                console.log('⚠️ L\'utilisateur Trucky n\'a pas de société associée.');
                companyStats = null;
            } else {
                companyStats = await truckyapi.getCompanyStats(userData.company_id);
                companyDetails = await truckyapi.getCompanyDetails(userData.company_id);
            }
            return res.json({
                userData: userData,
                lastJob: lastJobData,
                companyStats: companyStats,
                companyDetails: companyDetails
            });
        } catch (error) {
            console.error('❌ Erreur lors de la récupération des données du panneau d\'information:', error.message);
            return res.status(500).json({ error: 'Erreur lors de la récupération des données' });
        }
    });

    // Route pour lister tous les abonnements
    router.get('/subscriptions', async (req, res) => {
        try {
            const subscriptions = eventSubManager.getActiveSubscriptions();

            res.json({
                total: subscriptions.length,
                subscriptions: subscriptions.map(sub => ({
                    id: sub.id,
                    type: sub.type,
                    status: sub.status,
                    condition: sub.condition,
                    created_at: sub.created_at
                }))
            });
        } catch (error) {
            console.error('❌ Erreur lors de la récupération des abonnements:', error);
            res.status(500).json({ error: 'Erreur lors de la récupération' });
        }
    });

    // Route pour obtenir l'URL d'autorisation
    router.get('/auth-url', (req, res) => {
        const authUrl = auth.generateAuthUrl();

        res.send(`
            <html>
                <head>
                    <title>Autorisation Twitch - ElectrumOverlay</title>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <link rel="stylesheet" href="/css/app-ui.css">
                </head>
                <body>
                    <script src="/js/app-titlebar.js"></script>
                    <div class="page in-app">
                        <a class="back-link" href="/app">← Retour</a>
                        <h1>Autorisation Twitch requise</h1>
                        <p>Pour utiliser EventSub avec les messages de chat, l'application doit être autorisée avec les bons scopes.</p>

                        <div class="card">
                            <h2 class="card-title">Scopes requis</h2>
                            <ul class="requirements">
                                <li><code>user:read:chat</code> — lire les messages de chat</li>
                                <li><code>user:bot</code> — agir en tant que bot utilisateur</li>
                                <li><code>channel:bot</code> — agir en tant que bot sur la chaîne</li>
                            </ul>
                        </div>

                        <a href="${authUrl}" class="btn btn-primary" style="margin: var(--space-4) 0;">Autoriser l'application Twitch</a>

                        <p class="hint">Vous serez redirigé vers Twitch, puis automatiquement ramené ici — le token est enregistré tout seul, rien à copier-coller.</p>
                    </div>
                </body>
            </html>
        `);
    });

    // Route alternative pour le callback (compatibilité)
    router.get('/auth/callback', (req, res) => {
        res.redirect('/auth-callback' + (req.url.includes('#') ? req.url.split('#')[1] : ''));
    });

    // Route de callback pour récupérer le token
    router.get('/auth-callback', (req, res) => {
        res.send(`
            <html>
                <head>
                    <title>Autorisation - ElectrumOverlay</title>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <link rel="stylesheet" href="/css/app-ui.css">
                </head>
                <body>
                    <script src="/js/app-titlebar.js"></script>
                    <div class="page in-app">
                        <a class="back-link" href="/app">← Retour</a>
                        <h1>Autorisation Twitch</h1>
                        <div class="card" id="token-container">
                            <p>Traitement en cours…</p>
                        </div>
                    </div>
                    <script>
                        const hash = window.location.hash.substring(1);
                        const params = new URLSearchParams(hash);
                        const token = params.get('access_token');
                        const container = document.getElementById('token-container');

                        if (token) {
                            fetch('/api/oauth-callback', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ token })
                            })
                                .then(r => r.json())
                                .then(data => {
                                    if (data.ok) {
                                        container.innerHTML = '<p class="msg success">Autorisation réussie pour <strong>' + data.login + '</strong> (ID ' + data.broadcasterId + ').</p><p class="hint">Vous pouvez fermer cet onglet et revenir à ElectrumOverlay.</p>';
                                    } else {
                                        container.innerHTML = '<p class="msg error">' + (data.error || 'Erreur inconnue') + '</p>';
                                    }
                                })
                                .catch(() => {
                                    container.innerHTML = '<p class="msg error">Impossible de contacter le serveur pour enregistrer le token.</p>';
                                });
                        } else {
                            container.innerHTML = '<p class="msg error">Aucun token trouvé dans l\\'URL. Vérifiez que l\\'autorisation s\\'est bien déroulée.</p>';
                        }
                    </script>
                </body>
            </html>
        `);
    });

    // Reçoit le token depuis /auth-callback, le valide et persiste userAccessToken + broadcasterId
    router.post('/api/oauth-callback', async (req, res) => {
        try {
            const { token } = req.body || {};
            if (!token) {
                return res.status(400).json({ error: 'Token manquant' });
            }

            const tokenInfo = await auth.validateUserToken(token);
            if (!tokenInfo) {
                return res.status(400).json({ error: 'Token invalide' });
            }

            auth.setUserAccessToken(token);
            config.saveConfig({
                twitch: {
                    USER_ACCESS_TOKEN: token,
                    BROADCASTER_ID: tokenInfo.user_id,
                    BROADCASTER_LOGIN: tokenInfo.login
                }
            });

            res.json({ ok: true, broadcasterId: tokenInfo.user_id, login: tokenInfo.login });
        } catch (error) {
            console.error('❌ Erreur lors du traitement du callback OAuth:', error.message);
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    // Route pour obtenir les statistiques du stream
    router.get('/stream-stats', (req, res) => {
        res.json(streamStats.getStats());
    });

    // Route pour obtenir les statistiques formatées en HTML
    router.get('/stream-stats-html', (req, res) => {
        res.send(streamStats.generateHTMLStats());
    });

    // Route pour obtenir le statut du serveur
    router.get('/status', async (req, res) => {
        try {
            const twitchAuthenticated = auth.isAuthenticated();
            const subscriptions = eventSubManager.getActiveSubscriptions();
            const ngrokManager = getNgrokManager ? getNgrokManager() : null;

            res.json({
                status: 'online',
                twitchAuthenticated,
                subscriptionsCount: subscriptions.length,
                serverTime: new Date().toISOString(),
                ngrok: {
                    enabled: config.ngrok.ENABLED,
                    connected: Boolean(ngrokManager?.isConnected)
                }
            });
        } catch (error) {
            res.status(500).json({ error: 'Erreur serveur' });
        }
    });

    router.get('/auth/status', (req, res) => {
        res.json({ authenticated: auth.isAuthenticated() });
    })

    // Routes pour les badges Twitch
    router.get('/badges/:broadcasterId', async (req, res) => {
        try {
            const broadcasterId = req.params.broadcasterId;

            // Essayer d'abord avec le User Token, sinon App Token
            let accessToken;
            try {
                // Vérifier si on a un User Token valide
                if (await auth.isAuthenticated()) {
                    accessToken = auth.userAccessToken;
                } else {
                    accessToken = await auth.getAppAccessToken();
                }
            } catch (error) {
                accessToken = await auth.getAppAccessToken();
            }

            const response = await require('axios').get(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID
                }
            });

            res.json(response.data);
        } catch (error) {
            console.error('❌ Erreur récupération badges broadcaster:', error.message);
            res.status(500).json({ error: 'Erreur récupération badges', data: { data: [] } });
        }
    });
    router.get('/badgesglobal', async (req, res) => {
        try {
            // Essayer d'abord avec le User Token, sinon App Token
            let accessToken;
            try {
                // Vérifier si on a un User Token valide
                if (await auth.isAuthenticated()) {
                    accessToken = auth.userAccessToken;
                } else {
                    accessToken = await auth.getAppAccessToken();
                }
            } catch (authError) {
                accessToken = await auth.getAppAccessToken();
            }

            const response = await require('axios').get('https://api.twitch.tv/helix/chat/badges/global', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID
                }
            });

            res.json(response.data);
        } catch (error) {
            console.log('🌍 [DEBUG] Erreur récupération badges globaux:', error);
            console.error('❌ Erreur récupération badges globaux:', error.response?.data || error.message);
            res.status(500).json({ error: 'Erreur récupération badges', data: { data: [] } });
        }
    });

    return router;
}

module.exports = createRoutes;
