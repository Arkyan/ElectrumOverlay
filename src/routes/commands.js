const express = require('express');
const config = require('../config/store');

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Commandes de chat personnalisées (!discord...) : réponse dans le chat et/ou déclenchement
 * d'une action overlay (panneau gauche/bandeau bas — réutilise le mécanisme show-panel existant
 * de /tests). `commandManager` : instance partagée (voir src/services/CommandManager.js), la
 * même que celle branchée sur WebhookHandler dans server.js — le bouton "Tester" appelle
 * directement executeCommand() (réponse/action réelles) sans repasser par matching/cooldown.
 */
function createCommandsRoutes(commandManager) {
    const router = express.Router();

    router.get('/commands', (req, res) => {
        res.send(COMMANDS_PAGE_HTML({ commands: config.listCommands() }));
    });

    router.post('/api/commands', (req, res) => {
        try {
            const command = config.createCommand(req.body || {});
            res.json({ ok: true, command });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.put('/api/commands/:id', (req, res) => {
        try {
            const command = config.updateCommand(req.params.id, req.body || {});
            res.json({ ok: true, command });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/api/commands/:id', (req, res) => {
        try {
            config.deleteCommand(req.params.id);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Déclenche réellement la commande (envoie le message dans le vrai chat si "Réponse chat"
    // est activée) pour vérifier le réglage sans attendre qu'un viewer tape le déclencheur.
    router.post('/api/commands/:id/test', async (req, res) => {
        try {
            const command = config.listCommands().find(c => c.id === req.params.id);
            if (!command) {
                return res.status(404).json({ error: 'Commande introuvable' });
            }
            await commandManager.executeCommand(command, { chatter_user_name: 'Test' });
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    return router;
}

const PERMISSION_LABELS = {
    everyone: 'Tout le monde',
    vip: 'VIP et plus',
    moderator: 'Modérateurs et plus',
    broadcaster: 'Streamer uniquement'
};

function commandCardHTML(command, openByDefault) {
    const id = command.id;
    const isNew = id === 'new';
    const tags = [
        !command.enabled ? '<span class="cmd-tag">désactivée</span>' : '',
        command.chatReply?.enabled ? '<span class="cmd-tag">chat</span>' : '',
        command.overlayAction?.enabled ? '<span class="cmd-tag">overlay</span>' : ''
    ].join('');
    return `
    <details class="card cmd-card" data-command-id="${esc(id)}" ${openByDefault ? 'open' : ''}>
        <summary class="cmd-summary">
            <span class="cmd-summary-trigger">${isNew ? '+ Nouvelle commande' : (esc(command.trigger) || '(sans déclencheur)')}</span>
            <span class="cmd-summary-tags">${tags}</span>
        </summary>
        <div class="cmd-body">
            <div class="field-row">
                <div class="field" style="flex:1;">
                    <label>Déclencheur</label>
                    <input type="text" class="cmd-trigger" value="${esc(command.trigger)}" placeholder="!discord">
                </div>
                <div class="field">
                    <label>Permission</label>
                    <select class="cmd-permission">
                        ${Object.entries(PERMISSION_LABELS).map(([value, label]) =>
                            `<option value="${value}" ${command.permission === value ? 'selected' : ''}>${label}</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="field">
                    <label>Cooldown (s)</label>
                    <input type="number" class="cmd-cooldown" min="0" value="${esc(command.cooldownSeconds)}" style="width:90px;">
                </div>
            </div>

            <label class="checkbox-row"><input type="checkbox" class="cmd-enabled" ${command.enabled ? 'checked' : ''}> Commande activée</label>

            <div class="field" style="margin-top:var(--space-3);">
                <label class="checkbox-row"><input type="checkbox" class="cmd-reply-enabled" ${command.chatReply?.enabled ? 'checked' : ''}> Répondre dans le chat</label>
                <textarea class="cmd-reply-message" rows="2" placeholder="Merci {user} ! Rejoins le Discord : https://discord.gg/...">${esc(command.chatReply?.message || '')}</textarea>
                <p class="hint">{user} est remplacé par le pseudo de la personne qui a tapé la commande.</p>
            </div>

            <div class="field">
                <label class="checkbox-row"><input type="checkbox" class="cmd-overlay-enabled" ${command.overlayAction?.enabled ? 'checked' : ''}> Déclencher une action overlay</label>
                <select class="cmd-overlay-panel">
                    <option value="left" ${command.overlayAction?.panel !== 'bottom' ? 'selected' : ''}>Panneau gauche</option>
                    <option value="bottom" ${command.overlayAction?.panel === 'bottom' ? 'selected' : ''}>Bandeau bas</option>
                </select>
            </div>

            <div class="field-row" style="margin-top:var(--space-3);">
                <button type="button" class="btn btn-primary btn-save">Enregistrer</button>
                <button type="button" class="btn btn-test">Tester</button>
                <button type="button" class="btn btn-danger btn-delete">Supprimer</button>
                <span class="msg"></span>
            </div>
        </div>
    </details>`;
}

const COMMANDS_PAGE_HTML = ({ commands }) => `
<html>
<head>
    <title>Commandes - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        .page.wide { max-width: 980px; }
        textarea.cmd-reply-message { width: 100%; font-family: inherit; resize: vertical; }

        .cmd-card { padding: 0; }
        .cmd-summary {
            list-style: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-3);
            padding: var(--space-4) var(--space-5);
        }
        .cmd-summary::-webkit-details-marker { display: none; }
        .cmd-summary::before {
            content: '▸';
            display: inline-block;
            margin-right: var(--space-2);
            color: var(--text-muted);
            transition: transform 0.15s ease;
        }
        .cmd-card[open] .cmd-summary::before { transform: rotate(90deg); }
        .cmd-summary-trigger { font-weight: 600; font-family: monospace; font-size: 14px; }
        .cmd-summary-tags { display: flex; gap: var(--space-2); }
        .cmd-tag {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 999px;
            background: var(--surface-elevated);
            border: 1px solid var(--border);
            color: var(--text-muted);
        }
        .cmd-body { padding: 0 var(--space-5) var(--space-5); border-top: 1px solid var(--border); padding-top: var(--space-4); }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app wide">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Commandes</h1>
        <p class="hint">Commandes de chat personnalisées : réponse automatique et/ou action sur l'overlay. La réponse dans le chat nécessite d'avoir autorisé l'application avec le scope <code>user:write:chat</code> — si les réponses échouent silencieusement après une mise à jour, refais l'étape "Autorisation Twitch" depuis <a href="/setup">l'assistant de configuration</a>.</p>

        ${commandCardHTML({ id: 'new', trigger: '', enabled: true, permission: 'everyone', cooldownSeconds: 5, chatReply: { enabled: false, message: '' }, overlayAction: { enabled: false, panel: 'left' } }, true)}

        <h2 style="margin-top:var(--space-6);">Commandes existantes</h2>
        <div id="commandsList">
            ${commands.length ? commands.map((c) => commandCardHTML(c, false)).join('') : '<p class="hint">Aucune commande pour le moment.</p>'}
        </div>
    </div>

    <script>
        function readCommandCard(card) {
            return {
                trigger: card.querySelector('.cmd-trigger').value.trim(),
                enabled: card.querySelector('.cmd-enabled').checked,
                permission: card.querySelector('.cmd-permission').value,
                cooldownSeconds: Number(card.querySelector('.cmd-cooldown').value) || 0,
                chatReply: {
                    enabled: card.querySelector('.cmd-reply-enabled').checked,
                    message: card.querySelector('.cmd-reply-message').value
                },
                overlayAction: {
                    enabled: card.querySelector('.cmd-overlay-enabled').checked,
                    panel: card.querySelector('.cmd-overlay-panel').value
                }
            };
        }

        function showMsg(card, text, ok) {
            const msg = card.querySelector('.msg');
            msg.textContent = text;
            msg.className = 'msg ' + (ok ? 'success' : 'error');
        }

        document.querySelectorAll('.card[data-command-id]').forEach((card) => {
            const id = card.dataset.commandId;
            const isNew = id === 'new';

            card.querySelector('.btn-save').addEventListener('click', async () => {
                const body = readCommandCard(card);
                try {
                    const res = await fetch(isNew ? '/api/commands' : '/api/commands/' + id, {
                        method: isNew ? 'POST' : 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const data = await res.json();
                    if (data.ok) {
                        showMsg(card, 'Enregistré.', true);
                        setTimeout(() => window.location.reload(), 500);
                    } else {
                        showMsg(card, data.error || 'Erreur', false);
                    }
                } catch (err) {
                    showMsg(card, 'Impossible de contacter le serveur.', false);
                }
            });

            const deleteBtn = card.querySelector('.btn-delete');
            if (isNew) {
                deleteBtn.style.display = 'none';
            } else {
                deleteBtn.addEventListener('click', async () => {
                    if (!confirm('Supprimer cette commande ?')) return;
                    try {
                        const res = await fetch('/api/commands/' + id, { method: 'DELETE' });
                        const data = await res.json();
                        if (data.ok) {
                            card.remove();
                        } else {
                            showMsg(card, data.error || 'Erreur', false);
                        }
                    } catch (err) {
                        showMsg(card, 'Impossible de contacter le serveur.', false);
                    }
                });
            }

            const testBtn = card.querySelector('.btn-test');
            if (isNew) {
                testBtn.style.display = 'none';
            } else {
                testBtn.addEventListener('click', async () => {
                    testBtn.disabled = true;
                    try {
                        const res = await fetch('/api/commands/' + id + '/test', { method: 'POST' });
                        const data = await res.json();
                        showMsg(card, data.ok ? 'Testé — vérifie le chat/overlay.' : (data.error || 'Erreur'), data.ok);
                    } catch (err) {
                        showMsg(card, 'Impossible de contacter le serveur.', false);
                    }
                    testBtn.disabled = false;
                });
            }
        });
    </script>
</body>
</html>
`;

module.exports = createCommandsRoutes;
