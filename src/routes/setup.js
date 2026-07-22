const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../config/store');

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Éclaircit/assombrit une couleur hex d'un pourcentage donné.
 */
function shadeHex(hex, percent) {
    const normalized = (hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return hex;
    const num = parseInt(normalized, 16);
    const delta = Math.round(255 * (percent / 100));
    const clamp = (v) => Math.min(255, Math.max(0, v));
    const r = clamp((num >> 16) + delta);
    const g = clamp(((num >> 8) & 0xff) + delta);
    const b = clamp((num & 0xff) + delta);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Relance le process. Sous Electron, un simple respawn de process.execPath/argv relancerait
 * le binaire Electron avec les mauvais arguments (nouvelle fenêtre + tray en double) — on
 * utilise donc app.relaunch(), l'API prévue pour ça. En `node server.js` pur (dev sans Electron),
 * on respawn directement le process.
 *
 * `stopServer` (optionnel) est attendu AVANT de tuer le process : sans ça, l'ancien process peut
 * encore tenir les ports 8080/8081/4040 (ngrok) au moment où le nouveau démarre, qui reste alors
 * bloqué indéfiniment sur un listen() dont le callback ne se déclenche jamais (rien ne s'ouvre).
 */
async function restartApp(stopServer) {
    if (stopServer) {
        try {
            await stopServer();
        } catch (error) {
            // best-effort : on relance de toute façon
        }
    }

    if (process.versions.electron) {
        const { app } = require('electron');
        app.relaunch();
        app.exit(0);
        return;
    }

    const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd()
    });
    child.unref();
    process.exit(0);
}

/**
 * Routes de configuration (identifiants Twitch, autorisation, branding/ngrok).
 * Les 3 sections sont indépendantes : on peut revenir en modifier une seule sans redonner les
 * autres, qu'elles aient déjà été renseignées ou non.
 * `stopServer` : callback async pour fermer proprement le serveur avant un redémarrage.
 */
function createSetupRoutes(auth, stopServer) {
    const router = express.Router();

    router.get('/setup', (req, res) => {
        res.send(SETUP_PAGE_HTML(config));
    });

    // Identifiants de l'application Twitch (dev.twitch.tv/console/apps). Le secret n'est jamais
    // pré-rempli côté page (secret) ; s'il est laissé vide ici, on garde celui déjà enregistré.
    router.post('/api/setup/credentials', (req, res) => {
        const { clientId, clientSecret } = req.body || {};
        if (!clientId || !clientId.trim()) {
            return res.status(400).json({ error: 'Client ID requis' });
        }
        if (!clientSecret && !config.twitch.CLIENT_SECRET) {
            return res.status(400).json({ error: 'Client Secret requis' });
        }

        config.saveConfig({
            twitch: {
                CLIENT_ID: clientId.trim(),
                ...(clientSecret ? { CLIENT_SECRET: clientSecret.trim() } : {})
            }
        });
        res.json({ ok: true });
    });

    // URL d'autorisation Twitch, générée à partir du Client ID actuellement enregistré
    router.get('/api/setup/auth-url', (req, res) => {
        if (!config.twitch.CLIENT_ID) {
            return res.status(400).json({ error: 'Enregistrez d\'abord votre Client ID' });
        }
        res.json({ url: auth.generateAuthUrl(), redirectUri: config.twitch.REDIRECT_URI });
    });

    router.get('/api/setup/auth-status', (req, res) => {
        res.json({
            authenticated: auth.isAuthenticated(),
            broadcasterId: config.twitch.BROADCASTER_ID || null,
            broadcasterLogin: config.twitch.BROADCASTER_LOGIN || null
        });
    });

    // Branding + ngrok, puis redémarrage (ngrok ne se reconfigure qu'au démarrage du process,
    // contrairement aux réglages purement visuels de /settings). Les intégrations tierces
    // optionnelles (Spotify, Trucky) vivent sur /integrations — pas de restart nécessaire là-bas,
    // leurs services relisent la config à chaque appel.
    router.post('/api/setup/finish', (req, res) => {
        const {
            infoLine1, infoLine2, infoLine3, scrollingText, accentColor,
            ngrokEnabled, ngrokAuthtoken
        } = req.body || {};

        if (!auth.isAuthenticated()) {
            return res.status(400).json({ error: 'Autorisation Twitch requise avant d\'enregistrer' });
        }

        const themeOverrides = {};
        if (accentColor) {
            const secondary = shadeHex(accentColor, -10);
            for (const page of ['starting', 'index', 'pause', 'ending']) {
                themeOverrides[page] = { primary: accentColor, secondary, panelBorder: accentColor };
            }
        }

        const infoTexts = [infoLine1, infoLine2, infoLine3].filter(v => typeof v === 'string' && v.trim().length > 0);

        config.saveConfig({
            twitch: config.twitch.WEBHOOK_SECRET ? {} : { WEBHOOK_SECRET: crypto.randomBytes(16).toString('hex') },
            ngrok: {
                ENABLED: Boolean(ngrokEnabled),
                // Laisser vide = garder l'authtoken déjà enregistré (jamais réaffiché en clair).
                ...(ngrokAuthtoken ? { AUTHTOKEN: ngrokAuthtoken.trim() } : {})
            },
            display: {
                panels: {
                    bottom: {
                        content: {
                            ...(infoTexts.length > 0 ? { infoTexts } : {}),
                            ...(scrollingText ? { scrollingText } : {})
                        }
                    }
                },
                themes: themeOverrides
            }
        });

        res.json({ ok: true });
        setTimeout(() => restartApp(stopServer), 800);
    });

    return router;
}

const SETUP_PAGE_HTML = (config) => {
    const port = config.server.PORT;
    const bottom = config.display?.panels?.bottom?.content || {};
    const accentDefault = config.display?.themes?.index?.primary || '#a855f7';

    return `
<html>
<head>
    <title>Configuration - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        ul.requirements { margin: 0 0 var(--space-4); padding-left: 20px; color: var(--text-muted); font-size: 13px; }
        ul.requirements code {
            background: var(--surface-elevated); padding: 1px 6px; border-radius: 4px; color: var(--text);
        }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Configuration</h1>
        <p>Chaque section se sauvegarde indépendamment — pas besoin de tout redonner pour changer un seul réglage. Tout reste sur votre machine, rien n'est envoyé ailleurs qu'à Twitch.</p>

        <section class="card" id="step1">
            <h2 class="card-title">Application Twitch</h2>
            <p>Créez une application sur <a href="https://dev.twitch.tv/console/apps" target="_blank">dev.twitch.tv/console/apps</a> :</p>
            <ul class="requirements">
                <li>OAuth Redirect URL : <code>http://localhost:${port}/auth-callback</code></li>
                <li>Category : "Application Integration"</li>
                <li>Client Type : "Confidential"</li>
            </ul>
            <div class="field">
                <label for="clientId">Client ID</label>
                <input type="text" id="clientId" autocomplete="off" value="${esc(config.twitch.CLIENT_ID)}">
            </div>
            <div class="field">
                <label for="clientSecret">Client Secret</label>
                <input type="password" id="clientSecret" autocomplete="off" placeholder="${config.twitch.CLIENT_SECRET ? 'Déjà enregistré — laisser vide pour ne pas changer' : ''}">
            </div>
            <button type="button" class="btn btn-primary" id="btnStep1">Enregistrer</button>
            <div class="msg" id="msg1" role="status"></div>
        </section>

        <section class="card" id="step2">
            <h2 class="card-title">Autorisation Twitch</h2>
            <p>Autorisez l'application avec le compte Twitch qui streame. Ça s'ouvre dans votre navigateur habituel — revenez ici une fois l'autorisation faite.</p>
            <div class="status-pill" id="authStatusPill">Vérification...</div>
            <div class="field" style="margin-top:var(--space-3);">
                <label for="broadcasterDisplay">Chaîne suivie (broadcaster ID)</label>
                <input type="text" id="broadcasterDisplay" value="${esc(config.twitch.BROADCASTER_LOGIN ? '@' + config.twitch.BROADCASTER_LOGIN + ' — ID ' + config.twitch.BROADCASTER_ID : (config.twitch.BROADCASTER_ID || 'Aucune — autorisez d\'abord'))}" readonly disabled>
                <p class="hint">Déterminé automatiquement par le compte qui autorise ci-dessus — pas modifiable ici.</p>
            </div>
            <div class="field-row" style="margin-top:var(--space-3);">
                <button type="button" class="btn btn-primary" id="btnAuth">Autoriser à nouveau</button>
                <button type="button" class="btn" id="btnAuthCheck">Vérifier le statut</button>
            </div>
            <div class="msg" id="msg2" role="status"></div>
        </section>

        <section class="card" id="step3">
            <h2 class="card-title">Branding et ngrok</h2>
            <div class="field">
                <label for="accentColor">Couleur principale de l'overlay</label>
                <input type="color" id="accentColor" value="${esc(accentDefault)}">
            </div>
            <div class="field">
                <label for="infoLine1">Ligne d'info 1 (ex : twitch.tv/votre_chaine)</label>
                <input type="text" id="infoLine1" value="${esc(bottom.infoTexts?.[0] || '')}">
            </div>
            <div class="field">
                <label for="infoLine2">Ligne d'info 2 (ex : discord.gg/votre_serveur)</label>
                <input type="text" id="infoLine2" value="${esc(bottom.infoTexts?.[1] || '')}">
            </div>
            <div class="field">
                <label for="infoLine3">Ligne d'info 3 (ex : votresite.fr)</label>
                <input type="text" id="infoLine3" value="${esc(bottom.infoTexts?.[2] || '')}">
            </div>
            <div class="field">
                <label for="scrollingText">Texte défilant</label>
                <input type="text" id="scrollingText" value="${esc(bottom.scrollingText || '')}">
            </div>

            <div class="sub-block">
                <label class="checkbox-row"><input type="checkbox" id="ngrokEnabled" ${config.ngrok.ENABLED ? 'checked' : ''}> Utiliser ngrok (tunnel automatique pour les webhooks Twitch)</label>
                <div class="hint">Requiert un compte gratuit : <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank">dashboard.ngrok.com/get-started/your-authtoken</a></div>
                <div class="field" style="margin-top:var(--space-3);margin-bottom:0;">
                    <label for="ngrokAuthtoken">Authtoken ngrok</label>
                    <input type="password" id="ngrokAuthtoken" autocomplete="off" placeholder="${config.ngrok.AUTHTOKEN ? 'Déjà enregistré — laisser vide pour ne pas changer' : ''}">
                </div>
            </div>

            <button type="button" class="btn btn-primary" id="btnFinish">Enregistrer</button>
            <div class="hint">Le serveur redémarre après cette sauvegarde (ngrok ne se reconfigure qu'au lancement). Spotify et Trucky se configurent séparément depuis <a href="/integrations">Intégrations</a>, sans redémarrage.</div>
            <div class="msg" id="msg3" role="status"></div>
        </section>
    </div>

    <script>
        const msg = (id, text, isError) => {
            const el = document.getElementById(id);
            el.textContent = text;
            el.className = 'msg ' + (isError ? 'error' : 'success');
        };

        async function refreshAuthStatus() {
            const pill = document.getElementById('authStatusPill');
            const broadcasterDisplay = document.getElementById('broadcasterDisplay');
            try {
                const res = await fetch('/api/setup/auth-status');
                const data = await res.json();
                pill.innerHTML = data.authenticated
                    ? '<span class="dot"></span> Autorisé (chaîne ID ' + data.broadcasterId + ')'
                    : 'Pas encore autorisé';
                broadcasterDisplay.value = data.broadcasterId
                    ? (data.broadcasterLogin ? '@' + data.broadcasterLogin + ' — ID ' + data.broadcasterId : data.broadcasterId)
                    : "Aucune — autorisez d'abord";
            } catch (e) {
                pill.textContent = 'Statut indisponible';
            }
        }
        refreshAuthStatus();

        document.getElementById('btnStep1').addEventListener('click', async () => {
            const clientId = document.getElementById('clientId').value.trim();
            const clientSecret = document.getElementById('clientSecret').value.trim();
            const res = await fetch('/api/setup/credentials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, clientSecret })
            });
            const data = await res.json();
            if (data.ok) {
                document.getElementById('clientSecret').value = '';
                document.getElementById('clientSecret').placeholder = 'Déjà enregistré — laisser vide pour ne pas changer';
                msg('msg1', 'Enregistré.', false);
            } else {
                msg('msg1', data.error || 'Erreur', true);
            }
        });

        document.getElementById('btnAuth').addEventListener('click', async () => {
            const res = await fetch('/api/setup/auth-url');
            const data = await res.json();
            if (data.url) {
                window.open(data.url, '_blank');
            } else {
                msg('msg2', data.error || 'Erreur', true);
            }
        });

        document.getElementById('btnAuthCheck').addEventListener('click', async () => {
            await refreshAuthStatus();
            const res = await fetch('/api/setup/auth-status');
            const data = await res.json();
            msg('msg2', data.authenticated
                ? 'Autorisation confirmée (chaîne ID ' + data.broadcasterId + ')'
                : "Pas encore autorisé. Vérifiez que vous avez bien cliqué sur \\"Autoriser\\" dans l'onglet Twitch.",
                !data.authenticated);
        });

        document.getElementById('btnFinish').addEventListener('click', async () => {
            const btn = document.getElementById('btnFinish');
            btn.disabled = true;
            const payload = {
                infoLine1: document.getElementById('infoLine1').value.trim(),
                infoLine2: document.getElementById('infoLine2').value.trim(),
                infoLine3: document.getElementById('infoLine3').value.trim(),
                scrollingText: document.getElementById('scrollingText').value.trim(),
                accentColor: document.getElementById('accentColor').value,
                ngrokEnabled: document.getElementById('ngrokEnabled').checked,
                ngrokAuthtoken: document.getElementById('ngrokAuthtoken').value.trim()
            };
            const res = await fetch('/api/setup/finish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.ok) {
                msg('msg3', 'Configuration enregistrée, redémarrage en cours...', false);
                setTimeout(() => { window.location.href = '/app'; }, 4000);
            } else {
                btn.disabled = false;
                msg('msg3', data.error || 'Erreur', true);
            }
        });
    </script>
</body>
</html>
`;
};

module.exports = createSetupRoutes;
