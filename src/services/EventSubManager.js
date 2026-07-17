const axios = require('axios');
const config = require('../config/store');
const TwitchAuth = require('./TwitchAuth');

/**
 * Classe pour gérer les abonnements EventSub
 */
class EventSubManager {
    constructor(auth) {
        this.auth = auth || new TwitchAuth();
        this.currentBroadcasterId = config.twitch.BROADCASTER_ID;
        this.activeSubscriptions = new Map();
    }

    /**
     * Créer un abonnement EventSub
     */
    async createSubscription(type, condition, version = '1', webhookUrl) {
        const accessToken = await this.auth.getAppAccessToken();
        console.log(`🔧 Tentative de création d'abonnement pour ${type}...`);

        // Vérifications spéciales pour les messages de chat
        if (type === 'channel.chat.message') {
            if (!this.auth.userAccessToken) {
                console.warn('⚠️  ATTENTION: Pour les messages de chat, l\'utilisateur doit avoir autorisé l\'application!');
                console.warn(`⚠️  Visitez: http://localhost:${config.server.PORT}/auth-url pour obtenir votre token`);
            }
        }

        try {
            console.log(`📡 Création de l'abonnement pour ${type} avec le callback : ${webhookUrl}`);
            const response = await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
                type: type,
                version: version,
                condition: condition,
                transport: {
                    method: 'webhook',
                    callback: webhookUrl,
                    secret: config.twitch.WEBHOOK_SECRET
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID,
                    'Content-Type': 'application/json'
                }
            });

            console.log(`✅ Abonnement créé pour ${type}`);
            this.activeSubscriptions.set(response.data.data[0].id, {
                type,
                condition,
                ...response.data.data[0]
            });

            return response.data;
        } catch (error) {
            console.error(`❌ Erreur lors de la création de l'abonnement ${type}:`, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Vérifier les abonnements existants. Retourne les abonnements complets (pas juste leur
     * type) : setupSubscriptionsForChannel doit pouvoir comparer leur callback à l'URL webhook
     * actuelle pour détecter un abonnement pointant vers un ancien tunnel ngrok mort.
     */
    async checkExistingSubscriptions() {
        try {
            const accessToken = await this.auth.getAppAccessToken();

            const response = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID
                }
            });

            console.log('📋 Vérification des abonnements existants...');

            if (response.data.data.length > 0) {
                console.log(`   - ${response.data.data.length} abonnements trouvés:`);
                response.data.data.forEach(sub => {
                    console.log(`     • ${sub.type} (${sub.status})`);
                    this.activeSubscriptions.set(sub.id, sub);
                });
            } else {
                console.log('   - Aucun abonnement existant trouvé');
            }

            return response.data.data;
        } catch (error) {
            console.error('❌ Erreur lors de la vérification des abonnements:', error.response?.data || error.message);
            return [];
        }
    }

    /**
     * Supprimer un abonnement précis.
     */
    async deleteSubscription(id) {
        const accessToken = await this.auth.getAppAccessToken();
        await axios.delete(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${id}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Client-Id': config.twitch.CLIENT_ID
            }
        });
        this.activeSubscriptions.delete(id);
    }

    /**
     * Condition par défaut d'un type d'événement EventSub pour une chaîne donnée.
     * channel.raid et channel.follow ont une forme de condition différente des autres types.
     */
    defaultConditionFor(type, broadcasterId) {
        switch (type) {
            case 'channel.raid':
                return { to_broadcaster_user_id: broadcasterId };
            case 'channel.follow':
                return { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId };
            default:
                return { broadcaster_user_id: broadcasterId };
        }
    }

    /**
     * Configurer les abonnements pour une chaîne spécifique
     */
    async setupSubscriptionsForChannel(broadcasterId, webhookUrl) {
        console.log(`🔧 Configuration des abonnements EventSub pour la chaîne ID: ${broadcasterId}`);
        this.currentBroadcasterId = broadcasterId;

        try {
            const existingSubs = await this.checkExistingSubscriptions();

            // Préparer les abonnements de base
            const subscriptionsToTry = [
                ...config.eventTypes.basic.map(event => ({
                    ...event,
                    condition: event.condition || this.defaultConditionFor(event.type, broadcasterId)
                })),
                ...config.eventTypes.chat.map(event => ({
                    ...event,
                    condition: event.condition || {
                        broadcaster_user_id: broadcasterId,
                        user_id: broadcasterId
                    }
                }))
            ];

            // Un abonnement du même type peut déjà exister mais pointer vers une ancienne URL
            // (ex: un tunnel ngrok gratuit change d'adresse à chaque redémarrage) : Twitch ne
            // délivrera alors plus jamais rien dessus. On ne le garde que si son callback
            // correspond exactement à l'URL webhook actuelle ; sinon on le supprime et on le
            // recrée avec la bonne URL.
            const subscriptionsToCreate = [];
            let upToDateCount = 0;

            for (const sub of subscriptionsToTry) {
                const existing = existingSubs.find(s => s.type === sub.type);
                if (existing && existing.transport?.callback === webhookUrl) {
                    upToDateCount++;
                    continue;
                }
                if (existing) {
                    console.log(`♻️  Callback obsolète pour ${sub.type}, recréation avec la nouvelle URL...`);
                    try {
                        await this.deleteSubscription(existing.id);
                    } catch (error) {
                        console.warn(`⚠️  Impossible de supprimer l'ancien abonnement ${sub.type}:`, error.response?.data?.message || error.message);
                    }
                }
                subscriptionsToCreate.push(sub);
            }

            if (subscriptionsToCreate.length === 0) {
                console.log('✅ Tous les abonnements requis existent déjà et pointent vers la bonne URL !');
                return;
            }

            console.log(`📝 Création de ${subscriptionsToCreate.length} nouveaux abonnements...`);

            let successCount = 0;
            let totalAttempts = subscriptionsToCreate.length;

            for (const sub of subscriptionsToCreate) {
                try {
                    console.log(`🎯 Création d'abonnement aux ${sub.description}...`);
                    await this.createSubscription(sub.type, sub.condition, sub.version, webhookUrl);
                    successCount++;
                } catch (error) {
                    console.warn(`⚠️  Échec pour ${sub.type}: ${error.response?.data?.message || error.message}`);
                    continue;
                }
            }

            console.log('');
            console.log(`✅ Configuration terminée ! ${successCount}/${totalAttempts} nouveaux abonnements créés.`);
            console.log(`📊 Total: ${upToDateCount + successCount} abonnements actifs.`);

        } catch (error) {
            console.error('❌ Erreur lors de la configuration des abonnements:', error.message);
            throw error;
        }
    }

    /**
     * Supprimer tous les abonnements
     */
    async cleanupSubscriptions() {
        console.log('\n🧹 Nettoyage des abonnements EventSub...');
        try {
            const accessToken = await this.auth.getAppAccessToken();

            // Récupérer tous les abonnements
            const response = await axios.get('https://api.twitch.tv/helix/eventsub/subscriptions', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-Id': config.twitch.CLIENT_ID
                }
            });

            if (response.data.data.length > 0) {
                console.log(`🗑️  Suppression de ${response.data.data.length} abonnements...`);

                // Supprimer chaque abonnement
                for (const subscription of response.data.data) {
                    await this.deleteSubscription(subscription.id);
                    console.log(`🗑️  Supprimé: ${subscription.type}`);
                }

                console.log('✅ Tous les abonnements ont été supprimés');
            } else {
                console.log('📭 Aucun abonnement à supprimer');
            }
        } catch (error) {
            console.error('❌ Erreur lors du nettoyage:', error.response?.data || error.message);
        }
    }

    /**
     * Obtenir la liste des abonnements actifs
     */
    getActiveSubscriptions() {
        return Array.from(this.activeSubscriptions.values());
    }

    /**
     * Changer la chaîne trackée
     */
    async changeChannel(username) {
        console.log(`🔄 Changement de chaîne vers: ${username}`);

        // Obtenir les infos du nouveau broadcaster
        const broadcasterData = await this.auth.getBroadcasterID(username);

        // Nettoyer les abonnements existants
        await this.cleanupSubscriptions();

        // Configurer pour la nouvelle chaîne
        await this.setupSubscriptionsForChannel(broadcasterData.id);

        console.log(`✅ Changement réussi ! Maintenant en train de tracker: ${username} (ID: ${broadcasterData.id})`);

        return broadcasterData;
    }
}

module.exports = EventSubManager;
