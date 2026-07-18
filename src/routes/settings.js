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
 * Routes du panneau de réglages permanent (profils, couleurs, textes, alertes, sons, animations,
 * panneaux) — séparé de /setup (identifiants Twitch/ngrok/Trucky). Sauvegarde immédiate, sans
 * redémarrage : les overlays déjà ouverts se mettent à jour via la diffusion WebSocket
 * 'config-updated' (sauf les paramètres d'animations, appliqués au prochain rafraîchissement de
 * page — voir le commentaire dans overlay-common.js). Les réglages édités ici appartiennent
 * toujours au profil actif (voir routes/profiles.js pour la gestion des profils eux-mêmes).
 */
function createSettingsRoutes(broadcastEvent) {
    const router = express.Router();

    router.get('/settings', (req, res) => {
        const activeId = config.getActiveProfileId();
        const profiles = config.listProfiles();
        const requestedId = typeof req.query.profile === 'string' ? req.query.profile : null;
        // On ne peut consulter/éditer qu'un profil qui existe réellement — retombe sur l'actif
        // si l'id demandé est absent ou a été supprimé entre-temps.
        const viewedId = (requestedId && profiles.some(p => p.id === requestedId)) ? requestedId : activeId;
        const viewedProfile = config.getProfileFull(viewedId);

        res.send(SETTINGS_PAGE_HTML(config.getEffectiveDisplay(viewedId), {
            activeId,
            viewedId,
            profiles,
            audio: viewedProfile.audio || {}
        }));
    });

    router.post('/api/settings', (req, res) => {
        const body = req.body || {};
        // Cible le profil affiché à l'écran au moment de l'enregistrement, pas forcément l'actif
        // (voir GET /settings) — repli sur l'actif si absent, par compatibilité.
        const profileId = body.profileId || config.getActiveProfileId();

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

        try {
            config.saveProfileDisplay(profileId, {
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
                    soundVolume: num(body.soundVolume, 80) / 100,
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
                    enabled: {
                        starting: Boolean(body.chatEnabledStarting),
                        index: Boolean(body.chatEnabledIndex),
                        ending: Boolean(body.chatEnabledEnding)
                    },
                    defaultColor: body.chatColor,
                    maxMessages: num(body.chatMaxMessages, 50)
                },
                stats: {
                    animationDuration: num(body.statsAnimationDuration, 1000),
                    updateInterval: num(body.statsUpdateInterval, 30000),
                    simulateData: Boolean(body.statsSimulateData)
                }
            });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        // Ne diffuse aux overlays que si c'est bien le profil actif qui vient d'être modifié —
        // éditer un profil qu'on ne fait que consulter ne doit rien changer en direct.
        if (profileId === config.getActiveProfileId()) {
            broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
        }
        res.json({ ok: true });
    });

    return router;
}

const SETTINGS_PAGE_HTML = (display, profileCtx) => `
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
        input[type="file"] { max-width: 220px; }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Paramètres</h1>
        <p>${profileCtx.viewedId === profileCtx.activeId
            ? "Les couleurs et textes s'appliquent immédiatement aux overlays déjà ouverts dans OBS. Les paramètres d'animations/panneaux s'appliquent au prochain rafraîchissement de la source."
            : "Tu consultes/modifies un profil qui n'est pas actif : les changements sont enregistrés mais ne s'appliqueront aux overlays qu'une fois ce profil activé (bouton « Activer » ci-dessous)."}</p>

        <details class="card" open>
            <summary>Profils</summary>
            <div class="details-body">
                <p class="hint">Choisis un profil pour voir/modifier ses réglages ci-dessous. Un seul profil est actif (visible sur les overlays) à la fois.</p>
                <div class="field-row">
                    <div class="field">
                        <label for="profileSelect">Profil affiché</label>
                        <select id="profileSelect">
                            ${profileCtx.profiles.map(p => `<option value="${esc(p.id)}" ${p.id === profileCtx.viewedId ? 'selected' : ''}>${esc(p.name)}${p.id === profileCtx.activeId ? ' (actif)' : ''}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="field-row" style="margin-top:var(--space-3);">
                    <button type="button" class="btn btn-primary" id="btnProfileActivate" ${profileCtx.viewedId === profileCtx.activeId ? 'disabled' : ''}>${profileCtx.viewedId === profileCtx.activeId ? 'Déjà actif' : 'Activer ce profil'}</button>
                    <button type="button" class="btn" id="btnProfileNew">Nouveau (copie de celui-ci)</button>
                    <button type="button" class="btn" id="btnProfileRename">Renommer</button>
                    <button type="button" class="btn" id="btnProfileExport">Exporter</button>
                    <button type="button" class="btn" id="btnProfileImport">Importer</button>
                    <button type="button" class="btn" id="btnProfileSeedThemes">Ajouter les profils de thèmes</button>
                    <button type="button" class="btn btn-danger" id="btnProfileDelete">Supprimer</button>
                    <input type="file" id="profileImportFile" accept="application/json" style="display:none;">
                </div>
                <div class="field-row" id="profileNameForm" style="display:none; margin-top:var(--space-3);">
                    <div class="field">
                        <label for="profileNameInput" id="profileNameFormLabel">Nom</label>
                        <input type="text" id="profileNameInput">
                    </div>
                    <button type="button" class="btn btn-primary" id="btnProfileNameConfirm">Valider</button>
                    <button type="button" class="btn btn-ghost" id="btnProfileNameCancel">Annuler</button>
                </div>
                <p class="msg" id="profileMsg" role="status"></p>
            </div>
        </details>

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
                        <div class="field"><label for="soundVolume">Volume des sons (%)</label><input type="number" id="soundVolume" value="${esc(Math.round((display.alerts?.soundVolume ?? 0.8) * 100))}" min="0" max="100" step="5"></div>
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
                    const audioMeta = profileCtx.audio[key];
                    return `
                    <div class="sub-block">
                        <h4>${esc(label)}</h4>
                        <div class="field-row">
                            <div class="field"><label for="alert_${key}_title">Titre</label><input type="text" id="alert_${key}_title" value="${esc(a.title || '')}"></div>
                            <div class="field"><label for="alert_${key}_message">Message par défaut</label><input type="text" id="alert_${key}_message" value="${esc(a.defaultMessage || '')}"></div>
                            <div class="field"><label for="alert_${key}_border">Couleur</label><input type="color" id="alert_${key}_border" value="${esc(a.border || '#8b45f6')}"></div>
                            <div class="field">
                                <label for="alert_${key}_sound">Son personnalisé</label>
                                <input type="file" id="alert_${key}_sound" class="alert-sound-input" data-alert-type="${key}" accept="audio/*">
                            </div>
                        </div>
                        ${audioMeta ? `<p class="hint">🔊 ${esc(audioMeta.filename)} <button type="button" class="btn btn-ghost alert-sound-remove" data-alert-type="${key}">Supprimer le son</button></p>` : ''}
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
                <div class="field-row" style="margin-bottom:var(--space-4);">
                    <label class="checkbox-row"><input type="checkbox" id="chatEnabledStarting" ${display.chat?.enabled?.starting !== false ? 'checked' : ''}> Afficher sur Starting</label>
                    <label class="checkbox-row"><input type="checkbox" id="chatEnabledIndex" ${display.chat?.enabled?.index !== false ? 'checked' : ''}> Afficher sur Index</label>
                    <label class="checkbox-row"><input type="checkbox" id="chatEnabledEnding" ${display.chat?.enabled?.ending !== false ? 'checked' : ''}> Afficher sur Ending</label>
                </div>
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
        const VIEWED_PROFILE_ID = ${JSON.stringify(profileCtx.viewedId)};

        // ---------- Profils ----------
        const profileSelect = document.getElementById('profileSelect');
        const profileMsg = document.getElementById('profileMsg');

        function setProfileMsg(text, ok) {
            profileMsg.textContent = text;
            profileMsg.className = 'msg ' + (ok ? 'success' : 'error');
        }

        // computeRedirect(data) : où naviguer après succès (ex: vers le profil nouvellement créé).
        // Sans elle, on recharge simplement la page courante (même ?profile=...).
        async function callProfileApi(url, options, computeRedirect) {
            try {
                const res = await fetch(url, options);
                const data = await res.json();
                if (data.ok) {
                    if (computeRedirect) {
                        window.location.href = computeRedirect(data);
                    } else {
                        location.reload();
                    }
                } else {
                    setProfileMsg(data.error || 'Erreur', false);
                }
            } catch (e) {
                setProfileMsg('Impossible de contacter le serveur.', false);
            }
        }

        // Changer de profil dans la liste charge immédiatement SES réglages (voir GET /settings) —
        // ça ne l'active pas, ça permet juste de le consulter/modifier.
        profileSelect.addEventListener('change', () => {
            window.location.href = '/settings?profile=' + encodeURIComponent(profileSelect.value);
        });

        document.getElementById('btnProfileActivate').addEventListener('click', () => {
            callProfileApi('/api/profiles/' + VIEWED_PROFILE_ID + '/activate', { method: 'POST' });
        });

        // Electron n'implémente pas window.prompt() (l'appel échoue silencieusement, aucune boîte
        // de dialogue ne s'affiche) — on utilise donc un petit champ inline plutôt qu'un prompt().
        const profileNameForm = document.getElementById('profileNameForm');
        const profileNameInput = document.getElementById('profileNameInput');
        const profileNameFormLabel = document.getElementById('profileNameFormLabel');
        let pendingProfileAction = null;

        function openProfileNameForm(mode, label, prefill) {
            pendingProfileAction = mode;
            profileNameFormLabel.textContent = label;
            profileNameInput.value = prefill || '';
            profileNameForm.style.display = '';
            profileNameInput.focus();
        }

        function closeProfileNameForm() {
            profileNameForm.style.display = 'none';
            pendingProfileAction = null;
        }

        document.getElementById('btnProfileNew').addEventListener('click', () => {
            openProfileNameForm('new', 'Nom du nouveau profil (copie de celui affiché)', '');
        });

        document.getElementById('btnProfileRename').addEventListener('click', () => {
            const current = profileSelect.options[profileSelect.selectedIndex]?.text.replace(' (actif)', '') || '';
            openProfileNameForm('rename', 'Nouveau nom', current);
        });

        document.getElementById('btnProfileNameCancel').addEventListener('click', closeProfileNameForm);

        document.getElementById('btnProfileNameConfirm').addEventListener('click', () => {
            const name = profileNameInput.value.trim();
            if (!name) return;
            if (pendingProfileAction === 'new') {
                callProfileApi('/api/profiles', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, basedOn: VIEWED_PROFILE_ID })
                }, (data) => '/settings?profile=' + encodeURIComponent(data.profile.id));
            } else if (pendingProfileAction === 'rename') {
                callProfileApi('/api/profiles/' + VIEWED_PROFILE_ID, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
            }
            closeProfileNameForm();
        });

        profileNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('btnProfileNameConfirm').click();
            if (e.key === 'Escape') closeProfileNameForm();
        });

        document.getElementById('btnProfileDelete').addEventListener('click', () => {
            if (!confirm('Supprimer ce profil ? Cette action est irréversible.')) return;
            callProfileApi('/api/profiles/' + VIEWED_PROFILE_ID, { method: 'DELETE' }, () => '/settings');
        });

        document.getElementById('btnProfileSeedThemes').addEventListener('click', () => {
            callProfileApi('/api/profiles/seed-theme-presets', { method: 'POST' });
        });

        document.getElementById('btnProfileExport').addEventListener('click', () => {
            window.location.href = '/api/profiles/' + VIEWED_PROFILE_ID + '/export';
        });

        document.getElementById('btnProfileImport').addEventListener('click', () => {
            document.getElementById('profileImportFile').click();
        });

        document.getElementById('profileImportFile').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append('file', file);
            callProfileApi('/api/profiles/import', { method: 'POST', body: formData }, (data) => '/settings?profile=' + encodeURIComponent(data.profile.id));
        });

        // ---------- Sons d'alerte (upload immédiat, indépendant du bouton Enregistrer) ----------
        // Portent sur le profil affiché (VIEWED_PROFILE_ID), pas forcément l'actif — comme le
        // reste des réglages de cette page.
        document.querySelectorAll('.alert-sound-input').forEach((input) => {
            input.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('file', file);
                callProfileApi('/api/profiles/' + VIEWED_PROFILE_ID + '/audio/' + input.dataset.alertType, {
                    method: 'POST',
                    body: formData
                });
            });
        });

        document.querySelectorAll('.alert-sound-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                callProfileApi('/api/profiles/' + VIEWED_PROFILE_ID + '/audio/' + btn.dataset.alertType, { method: 'DELETE' });
            });
        });

        // ---------- Réglages d'affichage ----------
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
                profileId: VIEWED_PROFILE_ID,
                themes,
                alerts,
                alertsEnabled: document.getElementById('alertsEnabled').checked,
                alertsDuration: document.getElementById('alertsDuration').value,
                alertsQueueDelay: document.getElementById('alertsQueueDelay').value,
                soundVolume: document.getElementById('soundVolume').value,
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

                chatEnabledStarting: document.getElementById('chatEnabledStarting').checked,
                chatEnabledIndex: document.getElementById('chatEnabledIndex').checked,
                chatEnabledEnding: document.getElementById('chatEnabledEnding').checked,
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
                    msg.textContent = (VIEWED_PROFILE_ID === ${JSON.stringify(profileCtx.activeId)})
                        ? 'Enregistré — les overlays ouverts se mettent à jour.'
                        : 'Enregistré sur ce profil (non actif — les overlays ne changent pas).';
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
