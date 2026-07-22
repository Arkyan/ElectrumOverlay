const axios = require('axios');
const qs = require('qs');
const config = require('../config/store');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const NOW_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

/**
 * Authentification et lecture "en cours" Spotify. Suit le même rôle que TwitchAuth.js mais avec
 * un flux OAuth différent : Spotify n'offre pas d'implicit grant côté navigateur pour les scopes
 * dont on a besoin, et surtout founit un refresh token — contrairement au token Twitch (implicit
 * grant, sans refresh, qui expire simplement et redemande une reconnexion), le token Spotify est
 * rafraîchi automatiquement en arrière-plan tant que le refresh token reste valide (l'utilisateur
 * ne se reconnecte donc qu'une seule fois, sauf révocation manuelle côté Spotify).
 */
class SpotifyAuth {
    constructor() {
        // Dernier morceau connu (best-effort, mis à jour par le polling de server.js) — exposé
        // pour que /api/spotify/now-playing et un overlay qui recharge en cours de route
        // obtiennent un état immédiat sans attendre le prochain cycle de polling.
        this.lastTrack = null;
    }

    isConfigured() {
        return Boolean(config.spotify.CLIENT_ID && config.spotify.CLIENT_SECRET);
    }

    isConnected() {
        return Boolean(config.spotify.REFRESH_TOKEN);
    }

    generateAuthUrl() {
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.spotify.CLIENT_ID,
            redirect_uri: config.spotify.REDIRECT_URI,
            scope: config.spotify.SCOPES.join(' '),
            show_dialog: 'true'
        });
        return `${AUTHORIZE_URL}?${params.toString()}`;
    }

    basicAuthHeader() {
        const raw = `${config.spotify.CLIENT_ID}:${config.spotify.CLIENT_SECRET}`;
        return `Basic ${Buffer.from(raw).toString('base64')}`;
    }

    /** Échange le `code` reçu sur /api/spotify/callback contre un access + refresh token. */
    async exchangeCodeForTokens(code) {
        const data = qs.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.spotify.REDIRECT_URI
        });

        const response = await axios.post(TOKEN_URL, data, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': this.basicAuthHeader()
            }
        });

        this.persistTokens(response.data);
    }

    /**
     * Renouvelle l'access token via le refresh token stocké. Spotify ne renvoie un NOUVEAU
     * refresh token que par intermittence (rotation) — on ne garde donc l'ancien que si la
     * réponse n'en fournit pas de nouveau, sans quoi le refresh suivant échouerait.
     */
    async refreshAccessToken() {
        if (!config.spotify.REFRESH_TOKEN) {
            throw new Error('Aucun refresh token Spotify enregistré');
        }
        const data = qs.stringify({
            grant_type: 'refresh_token',
            refresh_token: config.spotify.REFRESH_TOKEN
        });

        const response = await axios.post(TOKEN_URL, data, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': this.basicAuthHeader()
            }
        });

        this.persistTokens(response.data);
    }

    persistTokens(data) {
        const patch = {
            ACCESS_TOKEN: data.access_token,
            // expires_in est en secondes ; on retranche une marge de 60s pour rafraîchir un peu
            // avant l'expiration réelle plutôt que de risquer un appel API avec un token périmé.
            EXPIRES_AT: Date.now() + Math.max(0, (data.expires_in - 60)) * 1000
        };
        if (data.refresh_token) patch.REFRESH_TOKEN = data.refresh_token;
        config.saveConfig({ spotify: patch });
    }

    disconnect() {
        config.saveConfig({ spotify: { ACCESS_TOKEN: '', REFRESH_TOKEN: '', EXPIRES_AT: 0 } });
        this.lastTrack = null;
    }

    /** Rafraîchit le token si nécessaire, puis retourne un access token utilisable. */
    async ensureValidToken() {
        if (!this.isConnected()) {
            throw new Error('Spotify non connecté');
        }
        if (!config.spotify.ACCESS_TOKEN || Date.now() >= config.spotify.EXPIRES_AT) {
            await this.refreshAccessToken();
        }
        return config.spotify.ACCESS_TOKEN;
    }

    /**
     * Morceau actuellement en cours de lecture, ou null si rien ne joue / lecture sur un autre
     * type de contenu sans piste (podcast en pause, etc.). Best-effort : une erreur ponctuelle de
     * l'API Spotify ne doit jamais interrompre le polling (voir server.js).
     */
    async getCurrentlyPlaying() {
        const token = await this.ensureValidToken();
        const response = await axios.get(NOW_PLAYING_URL, {
            headers: { 'Authorization': `Bearer ${token}` },
            // 204 (rien en cours) est une réponse VALIDE, pas une erreur — sans ça axios la
            // rejette comme les vrais échecs (401/500...).
            validateStatus: (status) => status === 200 || status === 204
        });

        if (response.status === 204 || !response.data || !response.data.item) {
            return null;
        }

        const item = response.data.item;
        const art = (item.album && item.album.images && item.album.images[0]) ? item.album.images[0].url : null;
        return {
            isPlaying: Boolean(response.data.is_playing),
            title: item.name,
            artist: (item.artists || []).map((a) => a.name).join(', '),
            album: item.album ? item.album.name : '',
            albumArt: art,
            progressMs: response.data.progress_ms || 0,
            durationMs: item.duration_ms || 0
        };
    }
}

module.exports = SpotifyAuth;
