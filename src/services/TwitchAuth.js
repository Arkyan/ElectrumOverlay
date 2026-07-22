const axios = require('axios');
const qs = require('qs');
const config = require('../config/store');

/**
 * Classe pour gérer l'authentification Twitch
 */
class TwitchAuth {
    constructor() {
        this.appAccessToken = null;
        this.userAccessToken = config.twitch.USER_ACCESS_TOKEN;
    }

    /**
     * Obtenir un App Access Token
     */
    async getAppAccessToken() {
        if (this.appAccessToken) {
            return this.appAccessToken;
        }

        const data = qs.stringify({
            'client_id': config.twitch.CLIENT_ID,
            'client_secret': config.twitch.CLIENT_SECRET,
            'grant_type': 'client_credentials'
        });

        const requestConfig = {
            method: 'post',
            maxBodyLength: Infinity,
            url: 'https://id.twitch.tv/oauth2/token',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: data
        };

        try {
            const response = await axios.request(requestConfig);
            this.appAccessToken = response.data.access_token;
            console.log('✅ App Access Token obtenu:', this.appAccessToken);
            return this.appAccessToken;
        } catch (error) {
            console.error('❌ Erreur lors de la récupération du token d\'accès d\'application:', error.message);
            throw new Error('Erreur lors de la récupération du token d\'accès d\'application');
        }
    }

    /**
     * Interroger l'endpoint /validate de Twitch pour un token utilisateur donné.
     * Retourne { client_id, user_id, login, scopes } ou null si le token est invalide.
     */
    async validateUserToken(token) {
        try {
            const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            return response.data;
        } catch (error) {
            console.error('❌ Token utilisateur invalide:', error.response?.data || error.message);
            return null;
        }
    }

    /**
     * Vérifier les scopes du User Access Token
     */
    async verifyUserToken() {
        if (!this.userAccessToken) {
            console.warn('⚠️  USER_ACCESS_TOKEN non configuré ou invalide');
            return false;
        }

        const data = await this.validateUserToken(this.userAccessToken);
        if (!data) {
            return false;
        }

        console.log('✅ Token utilisateur vérifié:');
        console.log(`   - Client ID: ${data.client_id}`);
        console.log(`   - User ID: ${data.user_id}`);
        console.log(`   - Scopes: ${data.scopes.join(', ')}`);

        // Vérifier si les scopes requis sont présents
        const hasAllScopes = config.twitch.SCOPES.every(scope =>
            data.scopes.includes(scope)
        );

        if (!hasAllScopes) {
            console.warn('⚠️  Scopes manquants pour les messages de chat');
            console.warn(`   - Requis: ${config.twitch.SCOPES.join(', ')}`);
            console.warn(`   - Présents: ${data.scopes.join(', ')}`);
        }

        return hasAllScopes;
    }

    /**
     * Générer l'URL d'autorisation OAuth
     */
    generateAuthUrl() {
        const params = new URLSearchParams({
            response_type: 'token',
            client_id: config.twitch.CLIENT_ID,
            redirect_uri: config.twitch.REDIRECT_URI,
            scope: config.twitch.SCOPES.join(' ')
        });

        return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
    }

    /**
     * Mettre à jour le User Access Token
     */
    setUserAccessToken(token) {
        this.userAccessToken = token;
    }

    /**
     * Obtenir l'ID d'un broadcaster par son nom d'utilisateur
     */
    async getBroadcasterID(username) {
        const accessToken = await this.getAppAccessToken();

        try {
            const response = await axios.get(`https://api.twitch.tv/helix/users?login=${username}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID
                }
            });

            if (response.data.data.length === 0) {
                throw new Error(`Utilisateur ${username} non trouvé`);
            }

            return response.data.data[0];
        } catch (error) {
            console.error('❌ Erreur lors de la récupération du Broadcaster ID:', error.message);
            throw error;
        }
    }

    /**
     * Nombre de viewers actuels si la chaîne est en direct, 0 sinon (hors ligne ou erreur).
     * Twitch ne pousse pas cette donnée via EventSub (contrairement aux follows/subs) — il n'y a
     * pas d'autre moyen que d'interroger Helix directement, d'où ce polling périodique
     * (voir TwitchOverlayServer.startViewerCountPolling() dans server.js).
     */
    async getViewerCount(broadcasterId) {
        try {
            const accessToken = await this.getAppAccessToken();
            const response = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID
                }
            });

            const stream = response.data.data[0];
            return stream ? stream.viewer_count : 0;
        } catch (error) {
            console.error('❌ Erreur lors de la récupération du nombre de viewers:', error.response?.data || error.message);
            return 0;
        }
    }

    /**
     * Vérifier si l'authentification est active
     */
    isAuthenticated() {
        return !!(this.userAccessToken);
    }

    /**
     * Envoyer un message dans le chat (pour les réponses de commandes personnalisées — voir
     * CommandManager). Nécessite le scope user:write:chat sur le token utilisateur ; sender_id
     * est le broadcaster lui-même (pas de compte bot séparé).
     */
    async sendChatMessage(message) {
        try {
            const response = await axios.post('https://api.twitch.tv/helix/chat/messages', {
                broadcaster_id: config.twitch.BROADCASTER_ID,
                sender_id: config.twitch.BROADCASTER_ID,
                message
            }, {
                headers: {
                    'Authorization': `Bearer ${this.userAccessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID,
                    'Content-Type': 'application/json'
                }
            });

            const result = response.data.data[0];
            if (!result.is_sent) {
                console.warn(`⚠️  Message chat refusé par Twitch: ${result.drop_reason?.message || 'raison inconnue'}`);
            }
            return result;
        } catch (error) {
            console.error('❌ Erreur lors de l\'envoi du message de chat:', error.response?.data || error.message);
            throw error;
        }
    }
}

module.exports = TwitchAuth;
