const express = require('express');
const config = require('../config/store');

const THEME_PAGES = [
    { key: 'starting', label: 'Starting (écran d\'attente)' },
    { key: 'index', label: 'Index (overlay principal)' },
    { key: 'pause', label: 'Pause' },
    { key: 'ending', label: 'Ending (écran de fin)' }
];

const ALERT_TYPES = [
    { key: 'follow', label: 'Follow' },
    { key: 'sub', label: 'Sub' },
    { key: 'subs_gift', label: 'Sub Gift' },
    { key: 'raid', label: 'Raid' },
    { key: 'bits', label: 'Bits' }
];

// Animations qui suivent toutes le même schéma { enabled, count, duration: [min, max] }.
// circuitLines et dvdLogo ont une forme différente, traités à part dans le template.
const PARTICLE_ANIMATIONS = [
    { key: 'particles', label: 'Particules' },
    { key: 'stars', label: 'Étoiles' },
    { key: 'meteors', label: 'Météores' }
];

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Routes du panneau de réglages permanent (couleurs, textes, alertes, animations, panneaux) —
 * séparé de /setup (identifiants Twitch/ngrok/Trucky). Sauvegarde immédiate, sans redémarrage :
 * les overlays déjà ouverts se mettent à jour via la diffusion WebSocket 'config-updated'
 * (sauf les paramètres d'animations, appliqués au prochain rafraîchissement de page — voir le
 * commentaire dans overlay-common.js).
 */
function createSettingsRoutes(broadcastEvent) {
    const router = express.Router();

    router.get('/settings', (req, res) => {
        res.send(SETTINGS_PAGE_HTML(config.display));
    });

    router.post('/api/settings', (req, res) => {
        const body = req.body || {};

        const themes = {};
        for (const { key } of THEME_PAGES) {
            const t = body.themes?.[key];
            if (!t) continue;
            themes[key] = {
                primary: t.primary,
                secondary: t.secondary,
                accent: t.accent,
                panelBorder: t.panelBorder
            };
        }

        const alertTypes = {};
        for (const { key } of ALERT_TYPES) {
            const a = body.alerts?.[key];
            if (!a) continue;
            alertTypes[key] = {
                title: a.title,
                defaultMessage: a.defaultMessage,
                border: a.border
            };
        }

        const infoTexts = Array.isArray(body.infoTexts)
            ? body.infoTexts.filter(v => typeof v === 'string')
            : undefined;

        const animations = {
            enabled: Boolean(body.animationsEnabled),
            circuitLines: {
                enabled: Boolean(body.circuitLinesEnabled),
                horizontal: num(body.circuitLinesHorizontal, 10),
                vertical: num(body.circuitLinesVertical, 8),
                duration: num(body.circuitLinesDuration, 6)
            },
            dvdLogo: {
                enabled: Boolean(body.dvdLogoEnabled),
                speed: num(body.dvdLogoSpeed, 2),
                updateInterval: num(body.dvdLogoUpdateInterval, 16)
            }
        };
        for (const { key } of PARTICLE_ANIMATIONS) {
            animations[key] = {
                enabled: Boolean(body[key + 'Enabled']),
                count: num(body[key + 'Count'], 30),
                duration: [num(body[key + 'DurationMin'], 5), num(body[key + 'DurationMax'], 8)]
            };
        }

        config.saveConfig({
            display: {
                themes,
                alerts: {
                    enabled: Boolean(body.alertsEnabled),
                    duration: num(body.alertsDuration, 6000),
                    queueDelay: num(body.alertsQueueDelay, 500),
                    confettiEnabled: Boolean(body.confettiEnabled),
                    confettiParticles: num(body.confettiParticles, 300),
                    confettiSpread: num(body.confettiSpread, 360),
                    confettiVelocity: num(body.confettiVelocity, 50),
                    confettiTicks: num(body.confettiTicks, 250),
                    types: alertTypes
                },
                panels: {
                    left: {
                        enabled: Boolean(body.leftPanelEnabled),
                        interval: num(body.leftPanelInterval, 300000),
                        duration: num(body.leftPanelDuration, 15000),
                        firstDelay: num(body.leftPanelFirstDelay, 30000)
                    },
                    bottom: {
                        enabled: Boolean(body.bottomBarEnabled),
                        interval: num(body.bottomBarInterval, 180000),
                        duration: num(body.bottomBarDuration, 20000),
                        firstDelay: num(body.bottomBarFirstDelay, 10000),
                        content: {
                            ...(infoTexts ? { infoTexts } : {}),
                            ...(typeof body.scrollingText === 'string' ? { scrollingText: body.scrollingText } : {})
                        }
                    }
                },
                animations,
                chat: {
                    defaultColor: body.chatColor,
                    maxMessages: num(body.chatMaxMessages, 50)
                },
                stats: {
                    animationDuration: num(body.statsAnimationDuration, 1000),
                    updateInterval: num(body.statsUpdateInterval, 30000),
                    simulateData: Boolean(body.statsSimulateData)
                }
            }
        });

        broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
        res.json({ ok: true });
    });

    return router;
}

const SETTINGS_PAGE_HTML = (display) => `
<html>
<head>
    <title>Paramètres - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        .save-bar {
            position: sticky; bottom: 0;
            display: flex; align-items: center; gap: var(--space-3);
            padding: var(--space-4) 0;
            background: linear-gradient(to top, var(--bg) 60%, transparent);
        }
        input[type="number"] { width: 90px; }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Paramètres</h1>
        <p>Les couleurs et textes s'appliquent immédiatement aux overlays déjà ouverts dans OBS. Les paramètres d'animations/panneaux s'appliquent au prochain rafraîchissement de la source.</p>

        <details class="card" open>
            <summary>Thèmes par page</summary>
            <div class="details-body">
                ${THEME_PAGES.map(({ key, label }) => {
                    const t = display.themes?.[key] || {};
                    return `
                    <div class="sub-block">
                        <h4>${esc(label)}</h4>
                        <div class="field-row">
                            <div class="field"><label for="theme_${key}_primary">Primaire</label><input type="color" id="theme_${key}_primary" value="${esc(t.primary || '#a855f7')}"></div>
                            <div class="field"><label for="theme_${key}_secondary">Secondaire</label><input type="color" id="theme_${key}_secondary" value="${esc(t.secondary || '#8b45f6')}"></div>
                            <div class="field"><label for="theme_${key}_accent">Accent</label><input type="color" id="theme_${key}_accent" value="${esc(t.accent || '#7c3aed')}"></div>
                            <div class="field"><label for="theme_${key}_panelBorder">Bordure panneaux</label><input type="color" id="theme_${key}_panelBorder" value="${esc(t.panelBorder || '#8b45f6')}"></div>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </details>

        <details class="card">
            <summary>Alertes</summary>
            <div class="details-body">
                <div class="sub-block">
                    <h4>Réglages globaux</h4>
                    <div class="field-row">
                        <label class="checkbox-row"><input type="checkbox" id="alertsEnabled" ${display.alerts?.enabled !== false ? 'checked' : ''}> Activées</label>
                        <div class="field"><label for="alertsDuration">Durée affichage (ms)</label><input type="number" id="alertsDuration" value="${esc(display.alerts?.duration ?? 6000)}" min="500" step="500"></div>
                        <div class="field"><label for="alertsQueueDelay">Délai entre alertes (ms)</label><input type="number" id="alertsQueueDelay" value="${esc(display.alerts?.queueDelay ?? 500)}" min="0" step="100"></div>
                    </div>
                    <div class="field-row" style="margin-top:var(--space-3);">
                        <label class="checkbox-row"><input type="checkbox" id="confettiEnabled" ${display.alerts?.confettiEnabled !== false ? 'checked' : ''}> Confettis</label>
                        <div class="field"><label for="confettiParticles">Nombre</label><input type="number" id="confettiParticles" value="${esc(display.alerts?.confettiParticles ?? 300)}" min="0"></div>
                        <div class="field"><label for="confettiSpread">Étendue</label><input type="number" id="confettiSpread" value="${esc(display.alerts?.confettiSpread ?? 360)}" min="0" max="360"></div>
                        <div class="field"><label for="confettiVelocity">Vitesse</label><input type="number" id="confettiVelocity" value="${esc(display.alerts?.confettiVelocity ?? 50)}" min="0"></div>
                        <div class="field"><label for="confettiTicks">Durée</label><input type="number" id="confettiTicks" value="${esc(display.alerts?.confettiTicks ?? 250)}" min="0"></div>
                    </div>
                </div>
                ${ALERT_TYPES.map(({ key, label }) => {
                    const a = display.alerts?.types?.[key] || {};
                    return `
                    <div class="sub-block">
                        <h4>${esc(label)}</h4>
                        <div class="field-row">
                            <div class="field"><label for="alert_${key}_title">Titre</label><input type="text" id="alert_${key}_title" value="${esc(a.title || '')}"></div>
                            <div class="field"><label for="alert_${key}_message">Message par défaut</label><input type="text" id="alert_${key}_message" value="${esc(a.defaultMessage || '')}"></div>
                            <div class="field"><label for="alert_${key}_border">Couleur</label><input type="color" id="alert_${key}_border" value="${esc(a.border || '#8b45f6')}"></div>
                        </div>
                    </div>`;
                }).join('')}
                <p class="hint">L'icône et le dégradé de fond de chaque alerte restent réservés à l'édition manuelle de config/overlay-config.json (display.alerts.types).</p>
            </div>
        </details>

        <details class="card">
            <summary>Panneau gauche (index.html)</summary>
            <div class="details-body">
                <label class="checkbox-row" style="margin-bottom:var(--space-4);"><input type="checkbox" id="leftPanelEnabled" ${display.panels?.left?.enabled ? 'checked' : ''}> Activé</label>
                <div class="field-row">
                    <div class="field"><label for="leftPanelInterval">Intervalle (ms)</label><input type="number" id="leftPanelInterval" value="${esc(display.panels?.left?.interval ?? 300000)}" min="0" step="1000"></div>
                    <div class="field"><label for="leftPanelDuration">Durée affichage (ms)</label><input type="number" id="leftPanelDuration" value="${esc(display.panels?.left?.duration ?? 15000)}" min="0" step="1000"></div>
                    <div class="field"><label for="leftPanelFirstDelay">Premier délai (ms)</label><input type="number" id="leftPanelFirstDelay" value="${esc(display.panels?.left?.firstDelay ?? 30000)}" min="0" step="1000"></div>
                </div>
            </div>
        </details>

        <details class="card">
            <summary>Bandeau bas de page</summary>
            <div class="details-body">
                <label class="checkbox-row" style="margin-bottom:var(--space-4);"><input type="checkbox" id="bottomBarEnabled" ${display.panels?.bottom?.enabled ? 'checked' : ''}> Afficher le bandeau</label>
                <div class="field"><label for="infoLine1">Ligne d'info 1</label><input type="text" id="infoLine1" value="${esc(display.panels?.bottom?.content?.infoTexts?.[0] || '')}"></div>
                <div class="field"><label for="infoLine2">Ligne d'info 2</label><input type="text" id="infoLine2" value="${esc(display.panels?.bottom?.content?.infoTexts?.[1] || '')}"></div>
                <div class="field"><label for="infoLine3">Ligne d'info 3</label><input type="text" id="infoLine3" value="${esc(display.panels?.bottom?.content?.infoTexts?.[2] || '')}"></div>
                <div class="field"><label for="scrollingText">Texte défilant</label><input type="text" id="scrollingText" value="${esc(display.panels?.bottom?.content?.scrollingText || '')}"></div>
                <div class="field-row" style="margin-top:var(--space-3);">
                    <div class="field"><label for="bottomBarInterval">Intervalle (ms)</label><input type="number" id="bottomBarInterval" value="${esc(display.panels?.bottom?.interval ?? 180000)}" min="0" step="1000"></div>
                    <div class="field"><label for="bottomBarDuration">Durée affichage (ms)</label><input type="number" id="bottomBarDuration" value="${esc(display.panels?.bottom?.duration ?? 20000)}" min="0" step="1000"></div>
                    <div class="field"><label for="bottomBarFirstDelay">Premier délai (ms)</label><input type="number" id="bottomBarFirstDelay" value="${esc(display.panels?.bottom?.firstDelay ?? 10000)}" min="0" step="1000"></div>
                </div>
            </div>
        </details>

        <details class="card">
            <summary>Animations</summary>
            <div class="details-body">
                <label class="checkbox-row" style="margin-bottom:var(--space-4);"><input type="checkbox" id="animationsEnabled" ${display.animations?.enabled !== false ? 'checked' : ''}> Activées globalement</label>

                ${PARTICLE_ANIMATIONS.map(({ key, label }) => {
                    const a = display.animations?.[key] || {};
                    const duration = a.duration || [5, 8];
                    return `
                    <div class="sub-block">
                        <label class="checkbox-row"><input type="checkbox" id="${key}Enabled" ${a.enabled !== false ? 'checked' : ''}> ${esc(label)}</label>
                        <div class="field-row" style="margin-top:var(--space-3);">
                            <div class="field"><label for="${key}Count">Nombre</label><input type="number" id="${key}Count" value="${esc(a.count ?? 30)}" min="0"></div>
                            <div class="field"><label for="${key}DurationMin">Durée min (s)</label><input type="number" id="${key}DurationMin" value="${esc(duration[0])}" min="0" step="0.5"></div>
                            <div class="field"><label for="${key}DurationMax">Durée max (s)</label><input type="number" id="${key}DurationMax" value="${esc(duration[1])}" min="0" step="0.5"></div>
                        </div>
                    </div>`;
                }).join('')}

                <div class="sub-block">
                    <label class="checkbox-row"><input type="checkbox" id="circuitLinesEnabled" ${display.animations?.circuitLines?.enabled ? 'checked' : ''}> Lignes de circuit</label>
                    <div class="field-row" style="margin-top:var(--space-3);">
                        <div class="field"><label for="circuitLinesHorizontal">Horizontales</label><input type="number" id="circuitLinesHorizontal" value="${esc(display.animations?.circuitLines?.horizontal ?? 10)}" min="0"></div>
                        <div class="field"><label for="circuitLinesVertical">Verticales</label><input type="number" id="circuitLinesVertical" value="${esc(display.animations?.circuitLines?.vertical ?? 8)}" min="0"></div>
                        <div class="field"><label for="circuitLinesDuration">Durée (s)</label><input type="number" id="circuitLinesDuration" value="${esc(display.animations?.circuitLines?.duration ?? 6)}" min="0" step="0.5"></div>
                    </div>
                </div>

                <div class="sub-block">
                    <label class="checkbox-row"><input type="checkbox" id="dvdLogoEnabled" ${display.animations?.dvdLogo?.enabled !== false ? 'checked' : ''}> Logo DVD</label>
                    <div class="field-row" style="margin-top:var(--space-3);">
                        <div class="field"><label for="dvdLogoSpeed">Vitesse</label><input type="number" id="dvdLogoSpeed" value="${esc(display.animations?.dvdLogo?.speed ?? 2)}" min="0" step="0.5"></div>
                        <div class="field"><label for="dvdLogoUpdateInterval">Intervalle rafraîchissement (ms)</label><input type="number" id="dvdLogoUpdateInterval" value="${esc(display.animations?.dvdLogo?.updateInterval ?? 16)}" min="1"></div>
                    </div>
                </div>

                <p class="hint">S'applique au prochain rafraîchissement de la source navigateur dans OBS (pas instantané, contrairement aux couleurs/textes).</p>
            </div>
        </details>

        <details class="card">
            <summary>Chat</summary>
            <div class="details-body">
                <div class="field-row">
                    <div class="field"><label for="chatColor">Couleur par défaut</label><input type="color" id="chatColor" value="${esc(display.chat?.defaultColor || '#3b82f6')}"></div>
                    <div class="field"><label for="chatMaxMessages">Messages max affichés</label><input type="number" id="chatMaxMessages" value="${esc(display.chat?.maxMessages ?? 50)}" min="1" max="200"></div>
                </div>
            </div>
        </details>

        <details class="card">
            <summary>Statistiques (ending.html)</summary>
            <div class="details-body">
                <div class="field-row">
                    <div class="field"><label for="statsAnimationDuration">Durée animation compteurs (ms)</label><input type="number" id="statsAnimationDuration" value="${esc(display.stats?.animationDuration ?? 1000)}" min="0" step="100"></div>
                    <div class="field"><label for="statsUpdateInterval">Intervalle de mise à jour (ms)</label><input type="number" id="statsUpdateInterval" value="${esc(display.stats?.updateInterval ?? 30000)}" min="0" step="1000"></div>
                </div>
                <label class="checkbox-row" style="margin-top:var(--space-3);"><input type="checkbox" id="statsSimulateData" ${display.stats?.simulateData ? 'checked' : ''}> Simuler des données (tests, sans vrai stream)</label>
            </div>
        </details>

        <div class="save-bar">
            <button type="button" class="btn btn-primary" id="btnSave">Enregistrer</button>
            <div class="msg" id="msg" role="status"></div>
        </div>
    </div>

    <script>
        const THEME_PAGES = ${JSON.stringify(THEME_PAGES.map(p => p.key))};
        const ALERT_TYPES = ${JSON.stringify(ALERT_TYPES.map(a => a.key))};
        const PARTICLE_ANIMATIONS = ${JSON.stringify(PARTICLE_ANIMATIONS.map(a => a.key))};

        document.getElementById('btnSave').addEventListener('click', async () => {
            const themes = {};
            for (const key of THEME_PAGES) {
                themes[key] = {
                    primary: document.getElementById('theme_' + key + '_primary').value,
                    secondary: document.getElementById('theme_' + key + '_secondary').value,
                    accent: document.getElementById('theme_' + key + '_accent').value,
                    panelBorder: document.getElementById('theme_' + key + '_panelBorder').value
                };
            }

            const alerts = {};
            for (const key of ALERT_TYPES) {
                alerts[key] = {
                    title: document.getElementById('alert_' + key + '_title').value,
                    defaultMessage: document.getElementById('alert_' + key + '_message').value,
                    border: document.getElementById('alert_' + key + '_border').value
                };
            }

            const payload = {
                themes,
                alerts,
                alertsEnabled: document.getElementById('alertsEnabled').checked,
                alertsDuration: document.getElementById('alertsDuration').value,
                alertsQueueDelay: document.getElementById('alertsQueueDelay').value,
                confettiEnabled: document.getElementById('confettiEnabled').checked,
                confettiParticles: document.getElementById('confettiParticles').value,
                confettiSpread: document.getElementById('confettiSpread').value,
                confettiVelocity: document.getElementById('confettiVelocity').value,
                confettiTicks: document.getElementById('confettiTicks').value,

                leftPanelEnabled: document.getElementById('leftPanelEnabled').checked,
                leftPanelInterval: document.getElementById('leftPanelInterval').value,
                leftPanelDuration: document.getElementById('leftPanelDuration').value,
                leftPanelFirstDelay: document.getElementById('leftPanelFirstDelay').value,

                bottomBarEnabled: document.getElementById('bottomBarEnabled').checked,
                bottomBarInterval: document.getElementById('bottomBarInterval').value,
                bottomBarDuration: document.getElementById('bottomBarDuration').value,
                bottomBarFirstDelay: document.getElementById('bottomBarFirstDelay').value,
                infoTexts: [
                    document.getElementById('infoLine1').value,
                    document.getElementById('infoLine2').value,
                    document.getElementById('infoLine3').value
                ],
                scrollingText: document.getElementById('scrollingText').value,

                animationsEnabled: document.getElementById('animationsEnabled').checked,
                circuitLinesEnabled: document.getElementById('circuitLinesEnabled').checked,
                circuitLinesHorizontal: document.getElementById('circuitLinesHorizontal').value,
                circuitLinesVertical: document.getElementById('circuitLinesVertical').value,
                circuitLinesDuration: document.getElementById('circuitLinesDuration').value,
                dvdLogoEnabled: document.getElementById('dvdLogoEnabled').checked,
                dvdLogoSpeed: document.getElementById('dvdLogoSpeed').value,
                dvdLogoUpdateInterval: document.getElementById('dvdLogoUpdateInterval').value,

                chatColor: document.getElementById('chatColor').value,
                chatMaxMessages: document.getElementById('chatMaxMessages').value,

                statsAnimationDuration: document.getElementById('statsAnimationDuration').value,
                statsUpdateInterval: document.getElementById('statsUpdateInterval').value,
                statsSimulateData: document.getElementById('statsSimulateData').checked
            };

            for (const key of PARTICLE_ANIMATIONS) {
                payload[key + 'Enabled'] = document.getElementById(key + 'Enabled').checked;
                payload[key + 'Count'] = document.getElementById(key + 'Count').value;
                payload[key + 'DurationMin'] = document.getElementById(key + 'DurationMin').value;
                payload[key + 'DurationMax'] = document.getElementById(key + 'DurationMax').value;
            }

            const btn = document.getElementById('btnSave');
            btn.disabled = true;
            const msg = document.getElementById('msg');
            try {
                const res = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (data.ok) {
                    msg.textContent = 'Enregistré — les overlays ouverts se mettent à jour.';
                    msg.className = 'msg success';
                } else {
                    msg.textContent = data.error || 'Erreur';
                    msg.className = 'msg error';
                }
            } catch (e) {
                msg.textContent = 'Impossible de contacter le serveur.';
                msg.className = 'msg error';
            }
            btn.disabled = false;
        });
    </script>
</body>
</html>
`;

module.exports = createSettingsRoutes;
