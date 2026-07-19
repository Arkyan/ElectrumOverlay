const express = require('express');
const config = require('../config/store');

const SCENE_PAGES = [
    { key: 'starting', label: 'Starting', url: '/starting.html' },
    { key: 'index', label: 'Index', url: '/' },
    { key: 'pause', label: 'Pause', url: '/pause.html' },
    { key: 'ending', label: 'Ending', url: '/ending.html' }
];

const THEME_FIELDS = [
    { key: 'primary', label: 'Primaire', fallback: '#a855f7' },
    { key: 'secondary', label: 'Secondaire', fallback: '#8b45f6' },
    { key: 'accent', label: 'Accent', fallback: '#7c3aed' },
    { key: 'panelBorder', label: 'Bordure panneaux', fallback: '#8b45f6' },
    { key: 'background', label: 'Fond général', fallback: '#0f172a' },
    { key: 'surface', label: 'Surface', fallback: '#1e293b' },
    { key: 'panelBg', label: 'Fond panneaux', fallback: '#0f172a' },
    { key: 'text', label: 'Texte', fallback: '#e2e8f0' },
    { key: 'mutedText', label: 'Texte atténué', fallback: '#94a3b8' }
];

// Résolution de référence pour l'aperçu — correspond à ce que la plupart des sources navigateur
// OBS utilisent (1920x1080). L'iframe reste à sa taille réelle (les vw/vh à l'intérieur
// correspondent donc à de vrais % d'écran) et n'est que visuellement réduite via transform:scale.
const CANVAS_W = 1920;
const CANVAS_H = 1080;
const PREVIEW_W = 1100;
const PREVIEW_SCALE = PREVIEW_W / CANVAS_W;
const PREVIEW_H = Math.round(CANVAS_H * PREVIEW_SCALE);

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Éditeur de scène : positionne à la souris les éléments d'overlay (chat, panneaux, alertes,
 * titres...), édite leur texte au double-clic, permet de les masquer/réafficher, et d'ajouter/
 * supprimer des textes libres — directement sur un aperçu de la vraie page (chargée dans une
 * iframe avec ?sceneEditor=1, voir public/js/scene-editor-bridge.js). Toute action s'enregistre
 * immédiatement (comme le reste des sous-fonctionnalités de profil : sons, média...), pas de
 * bouton "Enregistrer" global — et se répercute en direct sur l'aperçu ET les overlays déjà
 * ouverts via la diffusion WebSocket 'config-updated' déjà en place pour le reste de la config.
 * Édite toujours le profil ACTIF pour l'instant — contrairement à /settings, pas de sélecteur de
 * profil ici, pour garder ce premier jet simple.
 */
function createSceneEditorRoutes() {
    const router = express.Router();

    router.get('/scene-editor', (req, res) => {
        const activeId = config.getActiveProfileId();
        const themes = config.getEffectiveDisplay(activeId).themes || {};
        res.send(SCENE_EDITOR_HTML({ activeId, themes }));
    });

    return router;
}

const SCENE_EDITOR_HTML = ({ activeId, themes }) => `
<html>
<head>
    <title>Éditeur de scène - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        .page { max-width: 1460px; }
        .scene-editor-layout { display: flex; gap: var(--space-4); align-items: flex-start; }
        .scene-editor-canvas-wrap {
            width: ${PREVIEW_W}px; height: ${PREVIEW_H}px;
            overflow: hidden; position: relative;
            background: #000; border-radius: var(--radius-sm); border: 1px solid var(--border);
            flex: 0 0 auto;
        }
        .scene-editor-iframe {
            width: ${CANVAS_W}px; height: ${CANVAS_H}px;
            transform: scale(${PREVIEW_SCALE}); transform-origin: 0 0;
            border: 0;
        }
        .scene-editor-sidebar { flex: 1 1 auto; min-width: 220px; }
        .scene-el-row {
            display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
            background: var(--surface-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm);
            padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2); font-size: 13px;
        }
        .scene-el-row .scene-el-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .scene-el-row .scene-el-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
        .scene-el-row.scene-el-row-wrap { flex-direction: column; align-items: stretch; gap: var(--space-2); }
        .scene-text-row { margin-bottom: var(--space-2); }
        .scene-text-row label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: var(--space-1); }
        .scene-text-row .field-row { gap: var(--space-2); align-items: center; }
        .scene-text-row input[type="text"] { flex: 1; min-width: 0; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .scene-toast {
            position: fixed; top: calc(var(--titlebar-height) + var(--space-3)); right: var(--space-4);
            background: var(--surface-elevated); border: 1px solid var(--border); color: var(--text);
            padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); font-size: 13px;
            opacity: 0; transform: translateY(-8px); transition: opacity 0.2s ease, transform 0.2s ease;
            pointer-events: none; z-index: 999;
        }
        .scene-toast.show { opacity: 1; transform: translateY(0); }
        .scene-toast.error { border-color: var(--danger); color: var(--error); }
        .scene-hint-row { margin-bottom: var(--space-3); }
        .scene-color-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); }
        .scene-color-grid .field { margin-bottom: 0; }
        .scene-color-grid label { font-size: 11px; }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="scene-toast" id="toast"></div>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <h1>Éditeur de scène</h1>
        <p>Glisse un élément sur l'aperçu pour le déplacer ; les textes se modifient dans la liste à droite (les animations rendent l'édition directe sur l'aperçu peu pratique). Chaque action s'enregistre immédiatement sur le profil actif et se répercute en direct sur les overlays déjà ouverts.</p>

        <div class="tab-bar" data-tabgroup="scenepage">
            ${SCENE_PAGES.map((p, i) => `<button type="button" class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${p.key}">${esc(p.label)}</button>`).join('')}
        </div>

        ${SCENE_PAGES.map((p, i) => `
        <div class="tab-panel${i === 0 ? ' active' : ''}" data-tabgroup="scenepage" data-tab="${p.key}">
            <div class="scene-editor-layout">
                <div class="scene-editor-canvas-wrap">
                    <iframe class="scene-editor-iframe" data-page="${p.key}" data-src="${p.url}${p.url.includes('?') ? '&' : '?'}sceneEditor=1"></iframe>
                </div>
                <div class="scene-editor-sidebar">
                    <h3>Couleurs</h3>
                    <div class="scene-color-grid" data-page="${p.key}">
                        ${THEME_FIELDS.map(({ key, label, fallback }) => `
                        <div class="field">
                            <label for="theme_${p.key}_${key}">${esc(label)}</label>
                            <input type="color" id="theme_${p.key}_${key}" class="scene-theme-color" data-page="${p.key}" data-field="${key}" value="${esc((themes[p.key] && themes[p.key][key]) || fallback)}">
                        </div>`).join('')}
                    </div>

                    <h3 style="margin-top:var(--space-4);">Éléments</h3>
                    <div class="scene-hint-row field-row">
                        <button type="button" class="btn btn-sm scene-add-text" data-page="${p.key}">+ Ajouter un texte</button>
                    </div>
                    <div id="sidebar_${p.key}">
                        <p class="hint">Chargement de l'aperçu...</p>
                    </div>

                    <h3 style="margin-top:var(--space-4);">Textes</h3>
                    <div id="texts_${p.key}">
                        <p class="hint">Chargement de l'aperçu...</p>
                    </div>
                </div>
            </div>
        </div>`).join('')}
    </div>

    <script>
        const ACTIVE_PROFILE_ID = ${JSON.stringify(activeId)};
        // État local par page/élément : { hidden } pour les éléments intégrés, alimenté par le
        // premier postMessage 'scene-editor-ready' puis mis à jour de façon optimiste au clic
        // (l'appel API tourne en parallèle, pas besoin d'attendre une confirmation de l'iframe).
        const elementState = {};

        function esc(value) {
            return String(value ?? '').replace(/[&<>"']/g, (c) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
        }

        let toastTimer = null;
        function toast(text, ok = true) {
            const el = document.getElementById('toast');
            el.textContent = text;
            el.className = 'scene-toast show' + (ok ? '' : ' error');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
        }

        async function callApi(url, options) {
            try {
                const res = await fetch(url, options);
                const data = await res.json();
                if (!data.ok) { toast(data.error || 'Erreur', false); return null; }
                return data;
            } catch (err) {
                toast('Impossible de contacter le serveur.', false);
                return null;
            }
        }

        function renderSidebar(page, elements) {
            elementState[page] = elementState[page] || {};
            elements.forEach((item) => {
                if (!(item.id in elementState[page])) elementState[page][item.id] = { hidden: item.hidden };
            });

            const el = document.getElementById('sidebar_' + page);
            if (elements.length === 0) {
                el.innerHTML = '<p class="hint">Aucun élément sur cette page pour l\\'instant.</p>';
                return;
            }
            el.innerHTML = elements.map((item) => {
                const hidden = elementState[page][item.id].hidden;
                const rawId = item.isCustom ? item.id.replace(/^custom:/, '') : item.id;
                return \`
                <div class="scene-el-row\${item.isCustom ? ' scene-el-row-wrap' : ''}" data-page="\${page}" data-el="\${item.id}">
                    <span class="scene-el-name">\${esc(item.label)}</span>
                    \${item.isCustom ? \`<input type="text" class="scene-custom-text-input" data-page="\${page}" data-el="\${rawId}" value="\${esc(item.text || '')}">\` : ''}
                    <span class="scene-el-actions">
                        <button type="button" class="btn btn-ghost btn-sm scene-el-toggle-hidden" data-page="\${page}" data-el="\${rawId}" data-custom="\${item.isCustom ? '1' : ''}">\${hidden ? 'Afficher' : 'Masquer'}</button>
                        \${item.isCustom
                            ? \`<button type="button" class="btn btn-ghost btn-sm scene-el-delete" data-page="\${page}" data-el="\${rawId}">Supprimer</button>\`
                            : \`<button type="button" class="btn btn-ghost btn-sm scene-el-reset" data-page="\${page}" data-el="\${rawId}">Réinitialiser</button>\`}
                    </span>
                </div>\`;
            }).join('');
        }

        function renderTexts(page, texts) {
            const el = document.getElementById('texts_' + page);
            if (!texts || texts.length === 0) {
                el.innerHTML = '<p class="hint">Aucun texte sur cette page.</p>';
                return;
            }
            el.innerHTML = texts.map((item) => \`
                <div class="scene-text-row" data-page="\${page}" data-text="\${item.textId}">
                    <label>\${esc(item.label)}</label>
                    <div class="field-row">
                        <input type="text" class="scene-text-input" data-page="\${page}" data-text="\${item.textId}" value="\${esc(item.value)}">
                        <button type="button" class="btn btn-ghost btn-sm scene-text-reset" data-page="\${page}" data-text="\${item.textId}">Réinitialiser</button>
                    </div>
                </div>\`).join('');
        }

        function iframeForWindow(win) {
            return Array.from(document.querySelectorAll('.scene-editor-iframe')).find((f) => f.contentWindow === win);
        }

        window.addEventListener('message', async (event) => {
            const data = event.data;
            if (!data || !data.type) return;
            const iframe = iframeForWindow(event.source);
            if (!iframe) return;
            const page = iframe.dataset.page;

            // Les éléments custom stockent position/taille dans customTexts, pas layout — router
            // vers le bon endpoint sous peine que le changement soit ignoré et que l'élément
            // revienne à son état d'origine au prochain config-updated.
            function elementApiUrl(elementId) {
                const isCustom = elementId.startsWith('custom:');
                const rawId = isCustom ? elementId.replace(/^custom:/, '') : elementId;
                return {
                    isCustom,
                    url: isCustom
                        ? '/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + page + '/' + rawId
                        : '/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + page + '/' + rawId
                };
            }

            if (data.type === 'scene-editor-ready') {
                renderSidebar(page, data.elements);
                renderTexts(page, data.texts);
            } else if (data.type === 'scene-element-moved') {
                const { isCustom, url } = elementApiUrl(data.elementId);
                await callApi(url, {
                    method: isCustom ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ top: data.top, left: data.left })
                });
            } else if (data.type === 'scene-element-resized') {
                // data.width/height ne sont présents que pour l'axe concerné (JSON.stringify
                // omet naturellement les clés undefined) — un resize horizontal seul ne touche
                // donc jamais la hauteur enregistrée, et inversement.
                const { isCustom, url } = elementApiUrl(data.elementId);
                await callApi(url, {
                    method: isCustom ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ width: data.width, height: data.height })
                });
            }
        });

        function reloadIframe(page) {
            const iframe = document.querySelector('.scene-editor-iframe[data-page="' + page + '"]');
            iframe.src = iframe.dataset.src;
        }

        // ---------- Textes intégrés (titres, sous-titres, en-têtes...) ----------
        document.addEventListener('focusout', async (e) => {
            const input = e.target.closest('.scene-text-input');
            if (!input) return;
            const { page, text: textId } = input.dataset;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/text/' + page + '/' + textId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: input.value })
            });
            if (res) toast('Texte enregistré.');
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('.scene-text-input, .scene-custom-text-input')) {
                e.preventDefault();
                e.target.blur();
            }
        });

        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('.scene-text-reset');
            if (!btn) return;
            const { page, text: textId } = btn.dataset;
            btn.disabled = true;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/text/' + page + '/' + textId, { method: 'DELETE' });
            if (res) {
                toast('Texte réinitialisé.');
                // Le texte "par défaut" vit dans le HTML de la page, pas dans la config — on
                // recharge l'aperçu pour le retrouver, ce qui redemande aussi un 'scene-editor-ready'
                // à jour (met la sidebar à jour automatiquement).
                reloadIframe(page);
            }
            btn.disabled = false;
        });

        // ---------- Texte des éléments custom ----------
        document.addEventListener('focusout', async (e) => {
            const input = e.target.closest('.scene-custom-text-input');
            if (!input) return;
            const { page, el: elementId } = input.dataset;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + page + '/' + elementId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: input.value })
            });
            if (res) toast('Texte enregistré.');
        });

        // ---------- Onglets (charge l'iframe seulement au premier affichage) ----------
        function ensureIframeLoaded(page) {
            const iframe = document.querySelector('.scene-editor-iframe[data-page="' + page + '"]');
            if (!iframe.src) iframe.src = iframe.dataset.src;
        }

        document.querySelectorAll('[data-tabgroup="scenepage"].tab-bar .tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-tabgroup="scenepage"].tab-bar .tab-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.tab-panel[data-tabgroup="scenepage"]').forEach((panel) => {
                    panel.classList.toggle('active', panel.dataset.tab === btn.dataset.tab);
                });
                ensureIframeLoaded(btn.dataset.tab);
            });
        });

        ensureIframeLoaded('starting');

        // ---------- Couleurs de thème ----------
        document.querySelectorAll('.scene-theme-color').forEach((input) => {
            input.addEventListener('change', async () => {
                const { page, field } = input.dataset;
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/theme/' + page, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [field]: input.value })
                });
                if (res) toast('Couleur enregistrée.');
            });
        });

        // ---------- Masquer / Afficher ----------
        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('.scene-el-toggle-hidden');
            if (!btn) return;
            const { page, el: elementId, custom } = btn.dataset;
            const fullId = custom ? 'custom:' + elementId : elementId;
            const current = elementState[page] && elementState[page][fullId];
            const nextHidden = !(current && current.hidden);
            btn.disabled = true;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + page + '/' + fullId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hidden: nextHidden })
            });
            if (res) {
                elementState[page][fullId] = { ...elementState[page][fullId], hidden: nextHidden };
                btn.textContent = nextHidden ? 'Afficher' : 'Masquer';
                toast(nextHidden ? 'Élément masqué.' : 'Élément affiché.');
            }
            btn.disabled = false;
        });

        // ---------- Réinitialiser (éléments intégrés) ----------
        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('.scene-el-reset');
            if (!btn) return;
            const { page, el: elementId } = btn.dataset;
            btn.disabled = true;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + page + '/' + elementId, { method: 'DELETE' });
            if (res) {
                if (elementState[page]) elementState[page][elementId] = { hidden: false };
                const row = btn.closest('.scene-el-row');
                const toggleBtn = row && row.querySelector('.scene-el-toggle-hidden');
                if (toggleBtn) toggleBtn.textContent = 'Masquer';
                toast('Position réinitialisée.');
            }
            btn.disabled = false;
        });

        // ---------- Supprimer un texte custom ----------
        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('.scene-el-delete');
            if (!btn) return;
            const { page, el: elementId } = btn.dataset;
            btn.disabled = true;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + page + '/' + elementId, { method: 'DELETE' });
            if (res) {
                toast('Texte supprimé.');
            }
            btn.disabled = false;
        });

        // ---------- Ajouter un texte ----------
        document.querySelectorAll('.scene-add-text').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const page = btn.dataset.page;
                btn.disabled = true;
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + page, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: 'Nouveau texte',
                        top: 30 + Math.random() * 30,
                        left: 30 + Math.random() * 30
                    })
                });
                if (res) toast('Texte ajouté — modifie-le dans la liste "Éléments" ci-dessous.');
                btn.disabled = false;
            });
        });
    </script>
</body>
</html>
`;

module.exports = createSceneEditorRoutes;
