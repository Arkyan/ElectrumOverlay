/**
 * Classe pour gérer les statistiques du stream en temps réel
 */
class StreamStatsManager {
    constructor() {
        this.stats = this.getDefaultStats();
    }

    /**
     * Obtenir les statistiques par défaut
     */
    getDefaultStats() {
        return {
            isLive: false,
            startTime: null,
            follows: 0,
            subscribers: 0,
            chatMessages: 0,
            title: '',
            game: '',
            viewerCount: 0
        };
    }

    /**
     * Réinitialiser les statistiques
     */
    reset() {
        console.log('📊 Réinitialisation des statistiques du stream');
        this.stats = this.getDefaultStats();
    }

    /**
     * Marquer le stream comme commencé
     */
    startStream(streamData) {
        this.reset();
        this.stats.isLive = true;
        this.stats.startTime = streamData.started_at || new Date().toISOString();
        this.stats.title = streamData.title || '';
        this.stats.game = streamData.category_name || streamData.game_name || '';

        console.log('🔴 Stream démarré - Statistiques initialisées');
        this.display();
    }

    /**
     * Marquer le stream comme terminé
     */
    endStream() {
        console.log('⚫ Stream terminé - Statistiques finales:');
        this.display();
        this.stats.isLive = false;
    }

    /**
     * Mettre à jour les informations du stream
     */
    updateStreamInfo(title, game) {
        if (this.stats.isLive) {
            this.stats.title = title || this.stats.title;
            this.stats.game = game || this.stats.game;
            console.log('📊 Informations du stream mises à jour');
        }
    }

    /**
     * Ajouter un nouveau follow
     */
    addFollow() {
        this.stats.follows++;
        console.log(`📊 +1 Follow ! Total: ${this.stats.follows}`);
    }

    /**
     * Ajouter un nouvel abonné
     */
    addSubscriber(count = 1) {
        this.stats.subscribers += count;
        const message = count > 1 ?
            `📊 +${count} Abonnés ! Total: ${this.stats.subscribers}` :
            `📊 +1 Abonné ! Total: ${this.stats.subscribers}`;
        console.log(message);
    }

    /**
     * Ajouter un message de chat
     */
    addChatMessage() {
        this.stats.chatMessages++;

        // Afficher les stats seulement tous les 10 messages pour éviter le spam
        if (this.stats.chatMessages % 10 === 0) {
            console.log(`📊 Messages de chat: ${this.stats.chatMessages}`);
        }
    }

    /**
     * Mettre à jour le nombre de viewers
     */
    updateViewerCount(count) {
        this.stats.viewerCount = count;
    }

    /**
     * Calculer la durée du stream
     */
    getStreamDuration() {
        if (!this.stats.isLive || !this.stats.startTime) {
            return "Stream hors ligne";
        }

        const now = new Date();
        const start = new Date(this.stats.startTime);
        const diffMs = now - start;

        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Obtenir les statistiques complètes
     */
    getStats() {
        return {
            ...this.stats,
            streamDuration: this.getStreamDuration(),
            streamDurationMs: this.stats.isLive && this.stats.startTime ?
                new Date() - new Date(this.stats.startTime) : 0
        };
    }

    /**
     * Obtenir les informations du stream (alias pour getStats)
     */
    getStreamInfo() {
        return this.getStats();
    }

    /**
     * Afficher les statistiques actuelles
     */
    display() {
        console.log('\n📊 === STATISTIQUES DU STREAM ===');
        console.log(`🔴 Statut: ${this.stats.isLive ? 'EN DIRECT' : 'HORS LIGNE'}`);

        if (this.stats.isLive) {
            console.log(`⏱️  Durée: ${this.getStreamDuration()}`);
            console.log(`📺 Titre: ${this.stats.title || 'Non défini'}`);
            console.log(`🎮 Jeu: ${this.stats.game || 'Non défini'}`);
            if (this.stats.viewerCount > 0) {
                console.log(`👥 Viewers: ${this.stats.viewerCount}`);
            }
        }

        console.log(`💙 Nouveaux follows: ${this.stats.follows}`);
        console.log(`⭐ Nouveaux abonnés: ${this.stats.subscribers}`);
        console.log(`💬 Messages de chat: ${this.stats.chatMessages}`);
        console.log('=====================================\n');
    }

    /**
     * Générer une page HTML des statistiques
     */
    generateHTMLStats() {
        const stats = this.stats;

        return `
        <html>
            <head>
                <title>Statistiques - ElectrumOverlay</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="/css/app-ui.css">
                <style>
                    .grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                        gap: var(--space-3);
                        margin-top: var(--space-4);
                    }
                    .mini-card { background: var(--surface-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-4); text-align: center; }
                    .mini-card .number { font-size: 30px; font-weight: 700; color: var(--accent); }
                    .mini-card .label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
                    .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: var(--space-2); }
                    .status-indicator.live { background: var(--error); }
                    .status-indicator.offline { background: var(--text-faint); }
                </style>
            </head>
            <body>
                <script src="/js/app-titlebar.js"></script>
                <div class="page in-app">
                    <a class="back-link" href="/app">← Retour</a>
                    <h1>Statistiques du stream</h1>

                    <div class="card">
                        <h2 class="card-title" id="statusTitle">
                            <span class="status-indicator" id="statusDot"></span>
                            <span id="statusText"></span>
                        </h2>
                        <p id="statusDetails" class="hint"></p>
                    </div>

                    <div class="card">
                        <h2 class="card-title">Ce stream</h2>
                        <div class="grid">
                            <div class="mini-card"><div class="number" id="statFollows">0</div><div class="label">Nouveaux follows</div></div>
                            <div class="mini-card"><div class="number" id="statSubs">0</div><div class="label">Nouveaux abonnés</div></div>
                            <div class="mini-card"><div class="number" id="statChat">0</div><div class="label">Messages de chat</div></div>
                        </div>
                    </div>

                    <p class="hint">Mise à jour automatique toutes les 5 secondes.</p>
                </div>

                <script>
                    function render(stats) {
                        document.getElementById('statusDot').className = 'status-indicator ' + (stats.isLive ? 'live' : 'offline');
                        document.getElementById('statusText').textContent = stats.isLive ? 'En direct' : 'Hors ligne';
                        document.getElementById('statusDetails').textContent = stats.isLive
                            ? [stats.streamDuration, stats.title, stats.game, stats.viewerCount ? stats.viewerCount + ' viewers' : ''].filter(Boolean).join(' • ')
                            : '';
                        document.getElementById('statFollows').textContent = stats.follows;
                        document.getElementById('statSubs').textContent = stats.subscribers;
                        document.getElementById('statChat').textContent = stats.chatMessages;
                    }

                    render(${JSON.stringify(this.getStats()).replace(/</g, '\\u003c')});

                    setInterval(() => {
                        fetch('/api/stream-stats').then(r => r.json()).then(render).catch(() => {});
                    }, 5000);
                </script>
            </body>
        </html>
        `;
    }
}

module.exports = StreamStatsManager;
