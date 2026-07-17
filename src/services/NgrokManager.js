const ngrok = require('ngrok');
const fs = require('fs').promises;

/**
 * Gestionnaire pour ngrok - démarrage automatique et récupération d'URL
 */
class NgrokManager {
    constructor() {
        this.tunnelUrl = null;
        this.isConnected = false;
    }

    /**
     * Démarrer ngrok et obtenir l'URL publique
     * @param {number} port - Port local à exposer
     * @param {Object} options - Options ngrok optionnelles
     * @returns {Promise<string>} URL publique du tunnel
     */
    async start(port = 8080, options = {}) {
        const ngrokOptions = {
            addr: port,
            onLogEvent: (msg) => console.log('   [ngrok]', msg),
            ...options
        };

        // Le lancement du process ngrok local peut occasionnellement perdre la course entre
        // "il annonce être prêt" et "son API locale (127.0.0.1:4040) accepte vraiment des
        // connexions" (ECONNREFUSED) — quelques tentatives suffisent à absorber ça.
        const MAX_ATTEMPTS = 3;
        let lastError;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                console.log(`🚀 Démarrage de ngrok... (tentative ${attempt}/${MAX_ATTEMPTS})`);
                this.tunnelUrl = await ngrok.connect(ngrokOptions);
                this.isConnected = true;

                console.log(`✅ Tunnel ngrok établi !`);
                console.log(`🌐 URL publique: ${this.tunnelUrl}`);
                console.log(`📡 Redirige vers: http://localhost:${port}`);

                return this.tunnelUrl + '/eventsub';
            } catch (error) {
                lastError = error;
                console.error(`❌ Erreur lors du démarrage de ngrok (tentative ${attempt}/${MAX_ATTEMPTS}):`, error.message);
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                }
            }
        }

        throw lastError;
    }

    /**
     * Obtenir l'URL du tunnel (si connecté)
     * @returns {string|null} URL publique ou null si non connecté
     */
    getUrl() {
        return this.tunnelUrl;
    }

    /**
     * Obtenir l'URL complète du webhook
     * @returns {string|null} URL webhook complète ou null si non connecté
     */
    getWebhookUrl() {
        return this.tunnelUrl ? `${this.tunnelUrl}/eventsub` : null;
    }

    /**
     * Vérifier si ngrok est connecté
     * @returns {boolean} État de la connexion
     */
    isRunning() {
        return this.isConnected;
    }

    /**
     * Obtenir les informations détaillées des tunnels
     * @returns {Promise<Array>} Liste des tunnels actifs
     */
    async getTunnelInfo() {
        try {
            const api = ngrok.getApi();
            if (!api) {
                return null;
            }
            const tunnels = await api.listTunnels();
            return tunnels;
        } catch (error) {
            console.error('❌ Erreur récupération infos tunnels:', error.message);
            return null;
        }
    }

    /**
     * Fermer ngrok proprement
     */
    async stop() {
        try {
            if (this.isConnected) {
                console.log('🛑 Fermeture de ngrok...');
                await ngrok.disconnect();
                await ngrok.kill();
                this.isConnected = false;
                this.tunnelUrl = null;
                console.log('✅ Ngrok fermé proprement');
            }
        } catch (error) {
            console.error('❌ Erreur fermeture ngrok:', error.message);
        }
    }

    /**
     * Redémarrer ngrok (utile en cas de problème)
     * @param {number} port - Port local à exposer
     * @param {Object} options - Options ngrok optionnelles
     */
    async restart(port = 8080, options = {}) {
        console.log('🔄 Redémarrage de ngrok...');
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, 2000)); // Pause de 2s
        return await this.start(port, options);
    }

    /**
     * Vérifier si ngrok est installé et accessible
     * @returns {Promise<boolean>} True si ngrok est disponible
     */
    static async checkAvailability() {
        try {
            // Tenter d'importer ngrok sans erreur
            require('ngrok');
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = NgrokManager;
