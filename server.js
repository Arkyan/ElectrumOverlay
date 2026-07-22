const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const config = require('./src/config/store');
const TwitchAuth = require('./src/services/TwitchAuth');
const SpotifyAuth = require('./src/services/SpotifyAuth');
const EventSubManager = require('./src/services/EventSubManager');
const StreamStatsManager = require('./src/services/StreamStatsManager');
const WebhookHandler = require('./src/services/WebhookHandler');
const createRoutes = require('./src/routes/api');
const createSetupRoutes = require('./src/routes/setup');
const createSettingsRoutes = require('./src/routes/settings');
const createProfilesRoutes = require('./src/routes/profiles');
const createLogsRoutes = require('./src/routes/logs');
const createTestToolsRoutes = require('./src/routes/testtools');
const createSceneEditorRoutes = require('./src/routes/sceneEditor');
const createSpotifyRoutes = require('./src/routes/spotify');
const LogBuffer = require('./src/services/LogBuffer');

// Deux morceaux sont "les mêmes" pour décider s'il faut redéfusser 'spotify-track-updated' — on
// ignore volontairement progressMs (change à chaque poll même pour un morceau inchangé, ce qui
// spammerait une mise à jour de l'overlay toutes les 5s pour rien).
function sameSpotifyTrack(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.title === b.title && a.artist === b.artist && a.isPlaying === b.isPlaying;
}

/**
 * Classe principale de l'application
 */
class TwitchOverlayServer {
    constructor() {
        this.app = express();
        this.port = config.server.PORT;

        // Capture console.log/warn/error dès le tout début pour ne rater aucun log dans /logs —
        // utile une fois l'app packagée, où il n'y a plus de terminal visible.
        LogBuffer.init(this.broadcastEvent.bind(this));

        // Initialisation des services
        this.auth = new TwitchAuth();
        this.spotifyAuth = new SpotifyAuth();
        this.streamStats = new StreamStatsManager();
        this.eventSubManager = new EventSubManager(this.auth);
        this.webhookHandler = new WebhookHandler(this.streamStats, this.broadcastEvent.bind(this));

        this.isRunning = false;

        this.setupMiddleware();
        this.setupRoutes();
        this.setupGracefulShutdown();
    }

    /**
     * Configuration des middlewares
     */
    setupMiddleware() {
        // Tant que l'assistant n'est pas terminé, rediriger toute page (overlays inclus, servis
        // statiquement plus bas et qui court-circuiteraient sinon ce contrôle) vers /setup.
        const SETUP_ALLOWED_PREFIXES = [
            '/setup', '/api/', '/auth-url', '/auth-callback', '/auth/callback', '/favicon.ico',
            // Utile pour diagnostiquer un souci (ex: ngrok) avant même d'avoir fini l'assistant.
            '/logs',
            // Assets statiques : toujours servables, y compris avant la fin de l'assistant
            // (sinon /setup lui-même se retrouve sans CSS/JS/icône).
            '/css/', '/js/', '/fonts/', '/logo.png'
        ];
        this.app.use((req, res, next) => {
            if (config.isConfigured() || req.method !== 'GET') return next();
            const isAllowed = SETUP_ALLOWED_PREFIXES.some(p => req.path === p || req.path.startsWith(p));
            return isAllowed ? next() : res.redirect('/setup');
        });

        // Génère js/config.js dynamiquement à partir de la config centralisée (config/overlay-config.json).
        // Enregistré avant express.static pour intercepter la requête en priorité.
        this.app.get('/js/config.js', (req, res) => {
            res.type('application/javascript');
            res.send(`globalThis.OVERLAY_CONFIG = ${JSON.stringify(config.toFrontendConfig())};`);
        });

        // Middleware pour servir les fichiers statiques. `/` sert directement public/index.html
        // (comportement par défaut d'express.static) : c'est l'URL que les sources navigateur
        // OBS utilisent pour l'overlay — elle ne doit jamais afficher autre chose. Le panneau
        // d'administration de l'app vit sur /app, un chemin séparé (voir setupRoutes()).
        this.app.use(express.static(path.join(config.appRoot(), 'public')));

        // Middleware JSON standard pour les routes API
        this.app.use(express.json());
    }

    /**
     * Configuration des routes
     */    setupRoutes() {
        // Route principale pour les webhooks EventSub
        this.app.post('/eventsub', express.raw({ type: 'application/json' }), (req, res) => {
            this.webhookHandler.handleWebhook(req, res);
        });

        // Routes API. this.ngrokManager change à chaque start()/stop() : on passe un accesseur
        // plutôt que la valeur (capturée une seule fois ici, à la construction).
        const apiRoutes = createRoutes(this.eventSubManager, this.streamStats, this.auth, () => this.ngrokManager);
        this.app.use('/', apiRoutes);

        // Assistant de premier lancement
        const setupRoutes = createSetupRoutes(this.auth, () => this.stop());
        this.app.use('/', setupRoutes);

        // Panneau de réglages permanent (couleurs, textes, alertes, animations)
        const settingsRoutes = createSettingsRoutes(this.broadcastEvent.bind(this));
        this.app.use('/', settingsRoutes);

        // Profils de configuration (display + sons d'alerte), créables/activables/exportables
        const profilesRoutes = createProfilesRoutes(this.broadcastEvent.bind(this));
        this.app.use('/', profilesRoutes);

        // Logs en direct
        const logsRoutes = createLogsRoutes();
        this.app.use('/', logsRoutes);

        // Simulation d'événements pour tester les overlays sans attendre un vrai follow/sub/raid
        const testToolsRoutes = createTestToolsRoutes(this.webhookHandler);
        this.app.use('/', testToolsRoutes);

        // Éditeur de scène (positionnement des éléments d'overlay par glisser-déposer)
        const sceneEditorRoutes = createSceneEditorRoutes();
        this.app.use('/', sceneEditorRoutes);

        // Intégration Spotify (morceau en cours de lecture, utilisable comme élément de scène)
        const spotifyRoutes = createSpotifyRoutes(this.spotifyAuth);
        this.app.use('/', spotifyRoutes);

        // Panneau d'administration (accueil de la fenêtre Electron) — volontairement séparé de
        // `/`, qui doit toujours rester l'overlay pour les sources navigateur OBS.
        this.app.get('/app', (req, res) => {
            if (!config.isConfigured()) {
                return res.redirect('/setup');
            }

            res.send(`
                <html>
                    <head>
                        <title>ElectrumOverlay</title>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <link rel="stylesheet" href="/css/app-ui.css">
                    </head>
                    <body>
                        <script src="/js/app-titlebar.js"></script>
                        <div class="page in-app">
                            <h1>ElectrumOverlay</h1>
                            <div class="field-row">
                                <div class="status-pill" id="serverStatusPill"><span class="dot"></span> Serveur actif</div>
                                <button type="button" class="btn" id="btnServerToggle">Arrêter le serveur</button>
                            </div>
                            <p class="hint" id="serverStatusHint" style="display:none;">Le serveur est arrêté : les overlays (OBS) et le chat ne fonctionnent plus tant qu'il n'est pas redémarré.</p>
                            <p class="msg error" id="ngrokWarning" style="display:none;">ngrok est activé mais pas connecté — vérifiez votre authtoken dans <a href="/setup">Configuration</a>. Sans ça, aucun événement Twitch (chat, follows, alertes...) ne peut arriver.</p>

                            <div class="card" id="updateBanner" style="display:none; margin-top:var(--space-4);">
                                <p id="updateBannerText" style="margin:0 0 var(--space-3);"></p>
                                <button type="button" class="btn btn-primary" id="btnInstallUpdate" style="display:none;">Installer et redémarrer</button>
                            </div>

                            <h2 style="margin-top:var(--space-6);">Raccourcis</h2>
                            <div class="link-grid">
                                <a href="/settings" class="link-card">
                                    <h3>Paramètres</h3>
                                    <p>Couleurs, textes, alertes, animations</p>
                                </a>
                                <a href="/scene-editor" class="link-card">
                                    <h3>Éditeur de scène</h3>
                                    <p>Positionner les éléments, créer des scènes...</p>
                                </a>
                                <a href="/spotify" class="link-card">
                                    <h3>Spotify</h3>
                                    <p>Afficher le morceau en cours de lecture</p>
                                </a>
                                <a href="/logs" class="link-card">
                                    <h3>Logs</h3>
                                    <p>Journal du serveur en direct</p>
                                </a>
                                <a href="/tests" class="link-card">
                                    <h3>Tests</h3>
                                    <p>Simuler follow, sub, raid, alertes...</p>
                                </a>
                                <a href="/stream-stats-html" class="link-card">
                                    <h3>Statistiques</h3>
                                    <p>Stats du stream en temps réel</p>
                                </a>
                                <a href="/auth-url" class="link-card" target="_blank">
                                    <h3>Autorisation Twitch</h3>
                                    <p>Ouvre dans le navigateur</p>
                                </a>
                                <a href="/setup" class="link-card">
                                    <h3>Assistant de configuration</h3>
                                    <p>Identifiants Twitch, ngrok, Trucky</p>
                                </a>
                                <a href="/subscriptions" class="link-card" target="_blank">
                                    <h3>Abonnements EventSub (JSON)</h3>
                                    <p>Ouvre dans le navigateur</p>
                                </a>
                                <a href="/status" class="link-card" target="_blank">
                                    <h3>Statut (JSON)</h3>
                                    <p>Ouvre dans le navigateur</p>
                                </a>
                            </div>
                        </div>

                        <script>
                            (function () {
                                if (!window.electronAPI) return; // page ouverte hors Electron : rien à piloter

                                const pill = document.getElementById('serverStatusPill');
                                const hint = document.getElementById('serverStatusHint');
                                const btn = document.getElementById('btnServerToggle');
                                const ngrokWarning = document.getElementById('ngrokWarning');

                                function render(isRunning) {
                                    pill.innerHTML = isRunning
                                        ? '<span class="dot"></span> Serveur actif'
                                        : 'Serveur arrêté';
                                    hint.style.display = isRunning ? 'none' : '';
                                    btn.textContent = isRunning ? 'Arrêter le serveur' : 'Démarrer le serveur';
                                    if (!isRunning) ngrokWarning.style.display = 'none';
                                }

                                function checkNgrokStatus() {
                                    fetch('/status').then(r => r.json()).then(data => {
                                        ngrokWarning.style.display = (data.ngrok?.enabled && !data.ngrok?.connected) ? '' : 'none';
                                    }).catch(() => {});
                                }

                                const updateBanner = document.getElementById('updateBanner');
                                const updateBannerText = document.getElementById('updateBannerText');
                                const btnInstallUpdate = document.getElementById('btnInstallUpdate');

                                function renderUpdater(state) {
                                    if (state.status === 'downloading') {
                                        updateBanner.style.display = '';
                                        updateBannerText.textContent = 'Téléchargement de la mise à jour v' + state.version + '... (' + (state.percent || 0) + '%)';
                                        btnInstallUpdate.style.display = 'none';
                                    } else if (state.status === 'downloaded') {
                                        updateBanner.style.display = '';
                                        updateBannerText.textContent = 'Mise à jour v' + state.version + ' prête à installer.';
                                        btnInstallUpdate.style.display = '';
                                    } else {
                                        updateBanner.style.display = 'none';
                                    }
                                }

                                window.electronAPI.getUpdaterStatus().then(renderUpdater);
                                window.electronAPI.onUpdaterStatusChange(renderUpdater);
                                btnInstallUpdate.addEventListener('click', () => window.electronAPI.installUpdate());

                                window.electronAPI.getServerStatus().then((isRunning) => {
                                    render(isRunning);
                                    if (isRunning) checkNgrokStatus();
                                });
                                window.electronAPI.onServerStatusChange((isRunning) => {
                                    render(isRunning);
                                    if (isRunning) setTimeout(checkNgrokStatus, 3000);
                                });
                                setInterval(() => {
                                    window.electronAPI.getServerStatus().then((isRunning) => { if (isRunning) checkNgrokStatus(); });
                                }, 10000);

                                btn.addEventListener('click', async () => {
                                    btn.disabled = true;
                                    const isRunning = await window.electronAPI.getServerStatus();
                                    await (isRunning ? window.electronAPI.stopServer() : window.electronAPI.startServer());
                                    render(await window.electronAPI.getServerStatus());
                                    btn.disabled = false;
                                });
                            })();
                        </script>
                    </body>
                </html>
            `);
        });

        // Route pour les statistiques de stream
        this.app.get('/api/stream-stats', async (req, res) => {
            try {
                const stats = await this.streamStats.getStats();
                res.json(stats);
            } catch (error) {
                console.error('❌ Erreur récupération stats:', error);
                res.status(500).json({ error: 'Erreur serveur' });
            }
        });

        // Route pour les informations du stream
        this.app.get('/api/stream-info', async (req, res) => {
            try {
                const info = await this.streamStats.getStreamInfo();
                res.json(info);
            } catch (error) {
                console.error('❌ Erreur récupération info stream:', error);
                res.status(500).json({ error: 'Erreur serveur' });
            }
        });
    }

    /**
     * Configuration de l'arrêt propre du serveur
     */
    setupGracefulShutdown() {
        const gracefulShutdown = async (signal) => {
            console.log(`\n🛑 Signal ${signal} reçu - Arrêt du serveur...`);

            try {
                await this.eventSubManager.cleanupSubscriptions();
                console.log('✅ Nettoyage terminé');
            } catch (error) {
                console.error('❌ Erreur lors du nettoyage:', error.message);
            }

            console.log('👋 Serveur arrêté proprement !');
            process.exit(0);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        // Gestion des erreurs non capturées
        process.on('uncaughtException', (error) => {
            console.error('\n⚠️  Erreur non capturée (le serveur continue):', error.message);
            console.error('Stack:', error.stack);
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('\n⚠️  Promesse rejetée non gérée (le serveur continue):', reason);
        });
    }

    /**
     * Démarrer le serveur. Résout une fois le serveur HTTP effectivement en écoute
     * (nécessaire pour qu'Electron puisse attendre avant de charger sa fenêtre dessus).
     */
    async start() {
        if (this.isRunning) {
            console.log('ℹ️  Le serveur tourne déjà.');
            return;
        }

        // Recréé à chaque démarrage : après un stop(), l'ancien serveur WebSocket est fermé et
        // sa référence effacée (voir stop()).
        this.setupWebSocket();

        // Première utilisation : ne pas toucher à ngrok/EventSub tant que l'assistant
        // n'a pas été complété, se contenter de servir la page /setup.
        if (!config.isConfigured()) {
            return new Promise((resolve, reject) => {
                this.httpServer = this.app.listen(this.port, () => {
                    console.log('🧙 Configuration initiale requise.');
                    console.log(`   Assistant : http://localhost:${this.port}/setup`);
                    this.isRunning = true;
                    resolve();
                });
                // Sans ça, un port déjà occupé (ex: une autre instance encore en train de se
                // fermer) laisse ce listen() échouer silencieusement et le process reste bloqué
                // pour toujours au lieu d'échouer proprement.
                this.httpServer.on('error', (error) => {
                    console.error(`❌ Impossible de démarrer le serveur sur le port ${this.port}:`, error.message);
                    reject(error);
                });
            });
        }

        // démarrer ngrok si configuré. Une erreur ici ne doit PAS empêcher le serveur HTTP (donc
        // la fenêtre Electron) de démarrer — sans ça, le moindre souci ngrok fait que l'app
        // semble ne "rien ouvrir du tout". Les abonnements EventSub échoueront proprement plus
        // tard (déjà géré par initializeTwitchServices) si WEBHOOK_URL reste indéfini.
        var WEBHOOK_URL;
        if (config.ngrok.ENABLED) {
            const NgrokManager = require('./src/services/NgrokManager');
            this.ngrokManager = new NgrokManager();
            try {
                WEBHOOK_URL = await this.ngrokManager.start(this.port, {
                    authtoken: config.ngrok.AUTHTOKEN || undefined
                });
            } catch (error) {
                console.error('⚠️  ngrok indisponible, le serveur démarre quand même sans webhook Twitch fonctionnel.');
            }
        } else {
            WEBHOOK_URL = config.twitch.WEBHOOK_URL;
        }

        return new Promise((resolve, reject) => {
            this.httpServer = this.app.listen(this.port, async () => {
                console.log('🚀 ================================');
                console.log('🎮 Twitch Overlay Server v1.0');
                console.log('🚀 ================================');
                console.log(`🌐 Serveur: http://localhost:${this.port}`);
                console.log(`📊 Stats: http://localhost:${this.port}/stream-stats-html`);
                console.log(`🔐 Auth: http://localhost:${this.port}/auth-url`);
                console.log(`📋 API: http://localhost:${this.port}/status`);
                console.log(`🔌 Webhook: ${WEBHOOK_URL}`);
                console.log('');
                console.log(`🎯 Chaîne: ID ${this.eventSubManager.currentBroadcasterId}`);
                console.log('🟢 Serveur prêt !');
                console.log('');

                // Heartbeat pour maintenir le processus actif
                this.startHeartbeat();
                this.startViewerCountPolling();
                this.startSpotifyPolling();

                this.isRunning = true;
                resolve();

                // Initialisation des services Twitch
                await this.initializeTwitchServices(WEBHOOK_URL);
            });
            this.httpServer.on('error', (error) => {
                console.error(`❌ Impossible de démarrer le serveur sur le port ${this.port}:`, error.message);
                reject(error);
            });
        });
    }

    /**
     * Arrête proprement le serveur (WebSocket, ngrok, HTTP) — nécessaire avant tout redémarrage
     * du process (ex: fin de l'assistant /setup) pour que le nouveau process retrouve les ports
     * 8080/8081/4040 (ngrok) réellement libres. Sans ça, le nouveau process peut rester bloqué
     * indéfiniment sur un `listen()` dont le callback ne se déclenchera jamais.
     */
    async stop() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.viewerCountInterval) {
            clearInterval(this.viewerCountInterval);
            this.viewerCountInterval = null;
        }
        if (this.spotifyInterval) {
            clearInterval(this.spotifyInterval);
            this.spotifyInterval = null;
        }
        if (this.wss) {
            await new Promise((resolve) => this.wss.close(resolve));
            this.wss = null;
        }
        if (this.ngrokManager) {
            await this.ngrokManager.stop();
            this.ngrokManager = null;
        }
        if (this.httpServer) {
            await new Promise((resolve) => {
                this.httpServer.close(resolve);
                // Sans ça, close() peut rester bloqué en attendant qu'une connexion keep-alive
                // se termine d'elle-même (ex: la requête fetch() qui a déclenché ce redémarrage).
                if (typeof this.httpServer.closeAllConnections === 'function') {
                    this.httpServer.closeAllConnections();
                }
            });
            this.httpServer = null;
        }
        this.isRunning = false;
    }

    /**
     * Démarrer le heartbeat
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            // Heartbeat silencieux pour maintenir le processus actif
        }, 30000);
    }

    /**
     * Twitch ne pousse pas le nombre de viewers via EventSub (contrairement aux follows/subs) —
     * seul un polling périodique de l'API Helix permet de l'obtenir, d'où cet intervalle séparé
     * du heartbeat. 60s : largement sous les limites de quota Twitch, suffisant pour un affichage
     * (ex: overlay de fin de stream, touche Stream Deck) qui n'a pas besoin d'être seconde-près.
     */
    startViewerCountPolling() {
        const poll = async () => {
            try {
                const count = await this.auth.getViewerCount(this.eventSubManager.currentBroadcasterId);
                this.streamStats.updateViewerCount(count);
            } catch (error) {
                // best-effort : un souci ponctuel de l'API Twitch ne doit jamais interrompre le serveur
            }
        };
        poll();
        this.viewerCountInterval = setInterval(poll, 60000);
    }

    /**
     * Spotify n'a pas de webhook pour "lecture en cours" (contrairement aux events Twitch) —
     * seul un polling périodique de son API permet de savoir ce qui joue. 5s : assez réactif pour
     * un overlay (le morceau affiché ne doit pas sembler à la traîne) sans s'approcher des limites
     * de quota Spotify. Ne diffuse un 'spotify-track-updated' QUE si le morceau a réellement
     * changé (voir sameSpotifyTrack) — sinon chaque poll spammerait inutilement tous les overlays
     * ouverts, y compris ceux sans widget Spotify. Ne tourne que si l'utilisateur a connecté son
     * compte (voir /spotify) ; sans ça, ensureValidToken() lèverait à chaque appel pour rien.
     */
    startSpotifyPolling() {
        const poll = async () => {
            if (!this.spotifyAuth.isConnected()) return;
            try {
                const track = await this.spotifyAuth.getCurrentlyPlaying();
                if (!sameSpotifyTrack(track, this.spotifyAuth.lastTrack)) {
                    this.spotifyAuth.lastTrack = track;
                    this.broadcastEvent({ type: 'spotify-track-updated', track });
                }
            } catch (error) {
                // best-effort : un souci ponctuel de l'API Spotify (quota, token expiré et
                // refresh en échec...) ne doit jamais interrompre le serveur
            }
        };
        poll();
        this.spotifyInterval = setInterval(poll, 5000);
    }

    /**
     * Initialiser les services Twitch
     */
    async initializeTwitchServices(WEBHOOK_URL) {
        setTimeout(async () => {
            try {
                console.log('🔍 Vérification du User Access Token...');
                await this.auth.verifyUserToken();
                console.log('');

                console.log('⚡ Configuration des abonnements EventSub...');
                await this.eventSubManager.setupSubscriptionsForChannel(
                    this.eventSubManager.currentBroadcasterId,
                    WEBHOOK_URL
                );

                console.log('');
                console.log('✅ Initialisation terminée ! Le serveur est maintenant pleinement opérationnel.');
                console.log('🔄 En attente des webhooks Twitch...');

            } catch (error) {
                console.error('❌ Erreur lors de l\'initialisation:', error.message);
                console.log('⚠️  Le serveur continue de fonctionner malgré cette erreur.');
                console.log('🔄 Vous pouvez utiliser les routes HTTP normalement.');
            }
        }, 2000);
    }

    /**
     * Support WebSocket pour les communications temps réel
     */
    setupWebSocket() {
        try {
            // Vérifier si le port WebSocket est déjà utilisé
            const net = require('net');
            const testServer = net.createServer();

            testServer.listen(config.server.WS_PORT || 8081, () => {
                testServer.close();

                // Port disponible, créer le serveur WebSocket
                this.wss = new WebSocket.Server({ port: config.server.WS_PORT || 8081 });

                this.wss.on('connection', (ws) => {
                    console.log('✅ Nouvelle connexion WebSocket');

                    ws.on('message', (message) => {
                        try {
                            const data = JSON.parse(message);
                            this.handleWebSocketMessage(ws, data);
                        } catch (error) {
                            console.error('❌ Erreur message WebSocket:', error);
                        }
                    });

                    ws.on('close', () => {
                        console.log('❌ Connexion WebSocket fermée');
                    });

                    // Envoyer un message de bienvenue
                    ws.send(JSON.stringify({
                        type: 'connected',
                        message: 'Connexion WebSocket établie'
                    }));
                });

                console.log(`🌐 Serveur WebSocket démarré sur le port ${config.server.WS_PORT || 8081}`);
            });

            testServer.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    console.log(`⚠️  Port WebSocket ${config.server.WS_PORT || 8081} déjà utilisé - WebSocket désactivé`);
                } else {
                    console.error('❌ Erreur démarrage WebSocket:', error);
                }
            });

        } catch (error) {
            console.error('❌ Erreur démarrage WebSocket:', error);
        }
    }

    handleWebSocketMessage(ws, data) {
        switch (data.type) {
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            case 'subscribe':
                // Abonner le client aux événements
                ws.eventTypes = data.events || ['all'];
                break;
            default:
                console.log('Message WebSocket non géré:', data.type);
        }
    }    // Diffuser un événement à tous les clients WebSocket connectés
    broadcastEvent(event) {
        if (this.wss) {
            this.wss.clients.forEach((client) => {
                if (client.readyState === client.OPEN) {
                    try {
                        client.send(JSON.stringify(event));
                    } catch (error) {
                        console.error('❌ Erreur diffusion WebSocket:', error);
                    }
                }
            });
        }
    }
}

// Démarrage de l'application
if (require.main === module) {
    const server = new TwitchOverlayServer();
    server.start().catch(error => {
        console.error('❌ Erreur fatale lors du démarrage:', error);
        process.exit(1);
    });
}

module.exports = TwitchOverlayServer;
