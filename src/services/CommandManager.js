const config = require('../config/store');

/**
 * Commandes de chat personnalisées (!discord, etc.) : réponse dans le chat et/ou déclenchement
 * d'une action sur l'overlay, indépendamment configurables par commande (voir /commands).
 */
class CommandManager {
    constructor(auth, broadcastEvent) {
        this.auth = auth;
        this.broadcastEvent = broadcastEvent;

        // Cooldown par commande, en mémoire seulement (réinitialisé au redémarrage — comme
        // StreamStatsManager, pas de persistance disque nécessaire pour ça).
        this.lastTriggered = new Map();

        // Le streamer n'a pas de compte bot séparé : sendChatMessage() envoie la réponse en son
        // propre nom, donc Twitch la renvoie ensuite via EventSub comme un message de chat normal.
        // On garde les message_id de nos propres envois pour ignorer cet écho au lieu de le
        // retraiter comme une invocation (boucle si jamais le texte de réponse commence par "!").
        this.sentMessageIds = new Set();
    }

    getPermissionLevel(event) {
        if (event.chatter_user_id === config.twitch.BROADCASTER_ID) return 'broadcaster';
        const badgeSetIds = new Set((event.badges || []).map(b => b.set_id));
        if (badgeSetIds.has('moderator')) return 'moderator';
        if (badgeSetIds.has('vip')) return 'vip';
        return 'everyone';
    }

    hasPermission(level, required) {
        const order = config.COMMAND_PERMISSIONS;
        return order.indexOf(level) >= order.indexOf(required || 'everyone');
    }

    findCommand(text) {
        const token = text.trim().split(/\s+/)[0].toLowerCase();
        return config.listCommands().find(c => c.enabled && c.trigger === token);
    }

    /**
     * Point d'entrée appelé (fire-and-forget) par WebhookHandler pour chaque message de chat réel.
     * Ne doit jamais lever — un souci ici ne doit jamais casser le traitement du webhook.
     */
    async handleMessage(event) {
        const text = (event.message && event.message.text) || '';
        if (!text.trim().startsWith('!')) return;

        if (event.message_id && this.sentMessageIds.has(event.message_id)) {
            this.sentMessageIds.delete(event.message_id);
            return;
        }

        const command = this.findCommand(text);
        if (!command) return;

        if (!this.hasPermission(this.getPermissionLevel(event), command.permission)) return;

        const cooldownMs = (command.cooldownSeconds || 0) * 1000;
        const last = this.lastTriggered.get(command.id);
        if (last && Date.now() - last < cooldownMs) return;
        this.lastTriggered.set(command.id, Date.now());

        await this.executeCommand(command, event);
    }

    /**
     * Actions d'une commande (réponse chat / action overlay), indépendamment du chemin
     * d'invocation — matching/permission/cooldown restent l'affaire de handleMessage() et ne
     * sont jamais rejoués ici (utilisé aussi par le bouton "Tester" de /commands).
     */
    async executeCommand(command, event) {
        if (command.chatReply?.enabled && command.chatReply.message) {
            try {
                const message = command.chatReply.message.replace(/\{user\}/g, event.chatter_user_name || '');
                const sent = await this.auth.sendChatMessage(message);
                if (sent?.message_id) {
                    this.sentMessageIds.add(sent.message_id);
                    if (this.sentMessageIds.size > 200) {
                        this.sentMessageIds.delete(this.sentMessageIds.values().next().value);
                    }
                }
            } catch (error) {
                // best-effort : un souci Twitch (scope manquant, rate-limit...) ne doit jamais
                // empêcher l'action overlay de se déclencher.
                console.error(`❌ Échec de la réponse chat pour ${command.trigger}:`, error.response?.data || error.message);
            }
        }

        if (command.overlayAction?.enabled && this.broadcastEvent) {
            this.broadcastEvent({ type: 'show-panel', panel: command.overlayAction.panel });
        }
    }
}

module.exports = CommandManager;
