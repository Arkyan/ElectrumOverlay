const express = require('express');
const config = require('../config/store');

// Les 4 pages d'overlay intégrées — les scènes personnalisées (display.scenes du profil actif)
// s'ajoutent à cette liste côté client, servies sur /scene/<id>.
const BUILTIN_SCENES = [
    { key: 'starting', label: 'Démarrage', url: '/starting.html' },
    { key: 'index', label: 'En direct', url: '/' },
    { key: 'pause', label: 'Pause', url: '/pause.html' },
    { key: 'ending', label: 'Fin', url: '/ending.html' }
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

// Résolution de référence de l'aperçu — celle des sources navigateur OBS (1920x1080). L'iframe
// reste à sa taille réelle (les vw/vh à l'intérieur correspondent donc à de vrais % d'écran) et
// n'est que visuellement réduite via transform:scale, recalculé côté client selon la place dispo.
const CANVAS_W = 1920;
const CANVAS_H = 1080;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Sérialisation JSON sûre pour un bloc <script> inline : les noms de scène / messages de pause
// sont saisis par l'utilisateur — un « </script> » dedans fermerait le bloc et injecterait du
// HTML arbitraire dans la page. < est parfaitement valide en JSON, aucune perte.
function js(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Éditeur de scène façon OBS : liste des scènes à gauche (les 4 pages intégrées + les scènes
 * personnalisées, créables/renommables/supprimables), grand aperçu au centre (la vraie page dans
 * une iframe avec ?sceneEditor=1, voir public/js/scene-editor-bridge.js), et à droite un panneau
 * Sources / Textes / Scène. Les éléments se déplacent/redimensionnent à la souris sur l'aperçu ;
 * leurs propriétés (texte, URL d'image, couleur...) s'éditent dans le panneau après sélection.
 * Toute action s'enregistre immédiatement (pas de bouton "Enregistrer" global) et se répercute en
 * direct sur l'aperçu ET les overlays déjà ouverts via la diffusion WebSocket 'config-updated'
 * déjà en place pour le reste de la config. Édite toujours le profil ACTIF — contrairement à
 * /settings, pas de sélecteur de profil ici, pour garder l'interface simple.
 */
function createSceneEditorRoutes() {
    const router = express.Router();

    router.get('/scene-editor', (req, res) => {
        const activeId = config.getActiveProfileId();
        const effectiveDisplay = config.getEffectiveDisplay(activeId);
        const anims = effectiveDisplay.animations || {};
        const animsOn = anims.enabled !== false;
        res.send(SCENE_EDITOR_HTML({
            activeId,
            themes: effectiveDisplay.themes || {},
            pause: effectiveDisplay.pause || {},
            scenes: effectiveDisplay.scenes || {},
            // État effectif des réglages d'animations globaux — les cases à cocher "Effets" d'une
            // page intégrée affichent ces défauts tant que la scène ne les surcharge pas.
            animDefaults: {
                particles: animsOn && anims.particles?.enabled !== false,
                stars: animsOn && anims.stars?.enabled !== false,
                meteors: animsOn && anims.meteors?.enabled !== false,
                circuitLines: animsOn && anims.circuitLines?.enabled !== false,
                dvdLogo: animsOn && anims.dvdLogo?.enabled !== false
            }
        }));
    });

    // Page d'une scène personnalisée — l'URL à mettre dans une source navigateur OBS. Fond
    // transparent (comme toute source d'overlay) : le contenu vient exclusivement des éléments
    // ajoutés dans l'éditeur, rendus par renderCustomTextsFromConfig() (overlay-common.js) qui
    // indexe layout/customTexts sur l'id de scène extrait de l'URL. Ne connaît que les scènes du
    // profil ACTIF : une scène d'un profil inactif n'est volontairement pas servie (ses éléments
    // ne seraient de toute façon pas dans la config diffusée aux overlays).
    router.get('/scene/:sceneId', (req, res) => {
        const scenes = (config.display && config.display.scenes) || {};
        const scene = scenes[req.params.sceneId];
        // Les pages intégrées peuvent avoir une entrée display.scenes (fond/effets) : ce ne sont
        // pas pour autant des scènes servies ici — elles ont leurs propres pages HTML.
        if (!scene || config.BUILTIN_PAGE_KEYS.includes(req.params.sceneId)) {
            return res.status(404).send('<html><body style="background:#0b0d12;color:#e9eaee;font-family:sans-serif;padding:40px;"><h1>Scène introuvable</h1><p>Cette scène n\'existe pas (ou appartient à un profil qui n\'est pas actif).</p></body></html>');
        }
        res.send(CUSTOM_SCENE_HTML(scene.name));
    });

    return router;
}

const CUSTOM_SCENE_HTML = (name) => `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(name)} - ElectrumOverlay</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <link rel="stylesheet" href="/css/overlay-common.css">
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1"></script>
    <style>
        /* Fond transparent par défaut (source navigateur OBS par-dessus le jeu) — PAS de
           !important : applySceneSettingsFromConfig() (overlay-common.js) pose le fond choisi
           dans l'éditeur (couleur/dégradé) en style inline, qui doit pouvoir gagner.
           color-scheme:dark aligné sur l'éditeur (/scene-editor, app-ui.css) : quand les
           color-scheme de l'iframe et de la page hôte diffèrent, Chrome peint un fond opaque
           blanc à la place de la transparence — l'aperçu perdait son fond noir. */
        :root { color-scheme: dark; }
        html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; background: transparent; }
    </style>
</head>
<body>
    <!-- Même attirail que les pages intégrées : halos d'ambiance (visibles seulement sur fond
         opaque, voir applySceneSettingsFromConfig), conteneurs d'animations (peuplés par
         initCommonOverlay selon les effets activés sur la scène) et logo DVD rebondissant.
         Tout reste vide/masqué tant que la scène n'active rien. -->
    <div class="background-animation" style="display: none;"></div>
    <div class="breathing-effect" style="display: none;"></div>
    <div class="stars" id="stars"></div>
    <div class="meteors" id="meteors"></div>
    <div class="circuit-lines" id="circuitLines"></div>
    <div class="particles" id="particles"></div>
    <div style="position: absolute; display: none;" id="logoContainer">
        <img id="dvdLogo" src="/logo.png" alt="DVD Logo">
    </div>

    <!-- overlay-common.js s'auto-initialise au DOMContentLoaded : rendu des éléments custom
         (textes, images, chat, alertes...), WebSocket temps réel et animations de la scène. -->
    <script src="/js/config.js"></script>
    <script src="/js/overlay-common.js"></script>
    <script src="/js/scene-editor-bridge.js"></script>
</body>
</html>
`;

const SCENE_EDITOR_HTML = ({ activeId, themes, pause, scenes, animDefaults }) => `
<html>
<head>
    <title>Éditeur de scène - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        html, body { height: 100%; overflow: hidden; }
        .se-app {
            display: flex; flex-direction: column;
            height: 100vh; padding-top: var(--titlebar-height);
        }
        .se-header {
            display: flex; align-items: baseline; gap: var(--space-4);
            padding: var(--space-3) var(--space-4);
            border-bottom: 1px solid var(--border); flex: 0 0 auto;
        }
        .se-header h1 { font-size: 16px; margin: 0; }
        .se-header .back-link { margin: 0; }
        .se-header .se-header-hint { font-size: 12px; color: var(--text-faint); margin-left: auto; }
        .se-main { display: flex; flex: 1 1 auto; min-height: 0; }

        /* ---- Panneaux latéraux ---- */
        .se-panel { display: flex; flex-direction: column; min-height: 0; background: var(--surface); }
        .se-scenes { flex: 0 0 200px; border-right: 1px solid var(--border); }
        .se-right { flex: 0 0 320px; border-left: 1px solid var(--border); }
        .se-panel-title {
            font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
            color: var(--text-faint); padding: var(--space-3) var(--space-4) var(--space-2);
        }
        .se-list { flex: 1 1 auto; overflow-y: auto; padding: 0 var(--space-2) var(--space-2); }
        .se-panel-footer {
            flex: 0 0 auto; display: flex; gap: var(--space-2); align-items: center;
            padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border);
            position: relative;
        }
        .se-icon-btn {
            width: 30px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
            background: var(--surface-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm);
            color: var(--text); font-size: 15px; cursor: pointer; padding: 0;
        }
        .se-icon-btn:hover { border-color: var(--border-strong); }
        .se-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .se-icon-btn.armed { border-color: var(--danger); color: var(--danger); }

        .se-row {
            display: flex; align-items: center; gap: var(--space-2);
            padding: 7px 10px; border-radius: var(--radius-sm); cursor: pointer;
            font-size: 13px; color: var(--text-muted); user-select: none;
        }
        .se-row:hover { background: var(--surface-elevated); color: var(--text); }
        .se-row.active { background: var(--accent); color: var(--accent-text); }
        .se-row .se-row-icon { flex: 0 0 16px; text-align: center; font-size: 12px; opacity: 0.8; }
        .se-row .se-row-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .se-row .se-row-eye {
            flex: 0 0 auto; background: none; border: none; cursor: pointer; padding: 2px 4px;
            font-size: 13px; color: inherit; opacity: 0.85; border-radius: 4px;
        }
        .se-row .se-row-eye:hover { background: rgba(255, 255, 255, 0.12); }
        .se-row .se-row-eye.off { opacity: 0.35; }
        /* Éléments intégrés retirés de la scène : présentés en retrait (ce ne sont plus des
           sources), avec le seul bouton qui les concerne encore — le rétablissement. */
        .se-removed-block { margin-top: var(--space-3); border-top: 1px solid var(--border); padding-top: var(--space-2); }
        .se-removed-block .hint { margin: 0 0 var(--space-1) 10px; }
        .se-row-removed { cursor: default; opacity: 0.55; }
        .se-row-removed:hover { background: none; color: var(--text-muted); }
        .se-row .se-row-restore {
            flex: 0 0 auto; background: none; border: none; cursor: pointer; padding: 2px 6px;
            font-size: 14px; color: inherit; border-radius: 4px;
        }
        .se-row .se-row-restore:hover { background: rgba(255, 255, 255, 0.12); color: var(--text); }
        .se-list-sep {
            font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
            color: var(--text-faint); padding: var(--space-3) 10px var(--space-1);
        }
        .se-empty { font-size: 12px; color: var(--text-faint); padding: var(--space-2) 10px; }

        /* ---- Aperçu central ---- */
        .se-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
        .se-toolbar {
            flex: 0 0 auto; display: flex; align-items: center; gap: var(--space-2);
            padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border);
            background: var(--surface);
        }
        .se-toolbar-label {
            font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
            color: var(--text-faint); margin-right: var(--space-2);
        }
        .se-toolbar-btn {
            background: var(--surface-elevated); border: 1px solid var(--border); color: var(--text);
            border-radius: 999px; padding: 5px 14px; font-size: 12px; font-weight: 600;
            font-family: inherit; cursor: pointer;
        }
        .se-toolbar-btn:hover { border-color: var(--accent); }
        .se-toolbar-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .se-toolbar-btn:disabled:hover { border-color: var(--border); }
        .se-toolbar-sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 var(--space-2); }
        .se-toolbar-hint { margin-left: auto; font-size: 11px; color: var(--text-faint); }
        .se-canvas {
            flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center;
            background: var(--bg); padding: var(--space-4); overflow: hidden;
        }
        .se-stage {
            position: relative; overflow: hidden; background: #000;
            border: 1px solid var(--border-strong); border-radius: 4px;
            box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
        }
        .se-stage iframe {
            width: ${CANVAS_W}px; height: ${CANVAS_H}px;
            transform-origin: 0 0; border: 0; display: block;
        }

        /* ---- Onglets du panneau droit ---- */
        .se-tabs { display: flex; gap: 2px; padding: var(--space-2) var(--space-2) 0; flex: 0 0 auto; }
        .se-tab {
            flex: 1; background: none; border: none; border-radius: var(--radius-sm) var(--radius-sm) 0 0;
            color: var(--text-muted); font: 600 12px/1 inherit; font-family: inherit;
            padding: 9px 4px; cursor: pointer; border-bottom: 2px solid transparent;
        }
        .se-tab:hover { color: var(--text); }
        .se-tab.active { color: var(--text); border-bottom-color: var(--accent); }
        .se-tab-panel { display: none; flex: 1 1 auto; min-height: 0; flex-direction: column; }
        .se-tab-panel.active { display: flex; }
        .se-tab-scroll { flex: 1 1 auto; overflow-y: auto; padding: var(--space-3); }

        /* ---- Propriétés ---- */
        .se-props {
            flex: 0 0 auto; border-top: 1px solid var(--border);
            padding: var(--space-3); max-height: 45%; overflow-y: auto;
        }
        .se-props h4 { margin: 0 0 var(--space-3); font-size: 12px; color: var(--text-muted); }
        .se-props .field { margin-bottom: var(--space-3); }
        .se-props input[type="text"], .se-props input[type="number"] { width: 100%; }
        select {
            background: var(--surface-elevated); border: 1px solid var(--border); color: var(--text);
            border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; font-family: inherit;
            width: 100%;
        }
        .se-menu button:disabled { opacity: 0.4; cursor: not-allowed; }
        .se-menu button:disabled:hover { background: none; color: var(--text); }
        .se-fx-row { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
        .se-btn-row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .btn-sm { padding: 5px 12px; font-size: 12px; }

        .se-text-row { margin-bottom: var(--space-3); }
        .se-text-row label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: var(--space-1); }
        .se-text-row .field-row { gap: var(--space-2); align-items: center; flex-wrap: nowrap; }
        .se-text-row input[type="text"] { flex: 1; min-width: 0; }
        /* Ligne taille/police, sous le champ de contenu : volontairement plus discrète (petits
           champs) — c'est un réglage secondaire par rapport au texte lui-même. */
        .se-text-style-row { margin-top: var(--space-1); }
        .se-text-style-row input[type="number"] { width: 72px; flex: 0 0 auto; }
        .se-text-style-row select { flex: 1; min-width: 0; }

        .se-color-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); }
        .se-color-grid .field { margin-bottom: 0; }
        .se-color-grid label { font-size: 11px; }

        .se-msg-row { display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
        .se-msg-row input[type="text"] { flex: 1; min-width: 0; }

        .se-url-row { display: flex; gap: var(--space-2); align-items: center; }
        .se-url-row input { flex: 1; min-width: 0; font-size: 12px; }

        /* ---- Menu "+ Ajouter" ---- */
        .se-menu {
            position: absolute; bottom: calc(100% + 4px); left: var(--space-2);
            background: var(--surface-elevated); border: 1px solid var(--border-strong);
            border-radius: var(--radius-sm); padding: 4px; z-index: 50; min-width: 150px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); display: none;
        }
        .se-menu.open { display: block; }
        .se-menu button {
            display: flex; align-items: center; gap: var(--space-2); width: 100%;
            background: none; border: none; color: var(--text); font-size: 13px; font-family: inherit;
            padding: 8px 10px; border-radius: 4px; cursor: pointer; text-align: left;
        }
        .se-menu button:hover { background: var(--accent); color: var(--accent-text); }

        .se-toast {
            position: fixed; top: calc(var(--titlebar-height) + var(--space-3)); right: var(--space-4);
            background: var(--surface-elevated); border: 1px solid var(--border); color: var(--text);
            padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); font-size: 13px;
            opacity: 0; transform: translateY(-8px); transition: opacity 0.2s ease, transform 0.2s ease;
            pointer-events: none; z-index: 999;
        }
        .se-toast.show { opacity: 1; transform: translateY(0); }
        .se-toast.error { border-color: var(--danger); color: var(--error); }
        .hint { margin: 0 0 var(--space-2); }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="se-toast" id="toast"></div>
    <div class="se-app">
        <div class="se-header">
            <a class="back-link" href="/app">← Retour</a>
            <h1>Éditeur de scène</h1>
            <span class="se-header-hint">Glisse les éléments sur l'aperçu — tout s'enregistre automatiquement sur le profil actif</span>
        </div>
        <div class="se-main">
            <div class="se-panel se-scenes">
                <div class="se-panel-title">Scènes</div>
                <div class="se-list" id="sceneList"></div>
                <div class="se-panel-footer">
                    <button type="button" class="se-icon-btn" id="btnAddScene" title="Nouvelle scène">+</button>
                    <button type="button" class="se-icon-btn" id="btnDeleteScene" title="Supprimer la scène">−</button>
                </div>
            </div>

            <div class="se-center">
                <div class="se-toolbar">
                    <span class="se-toolbar-label">Aligner :</span>
                    <button type="button" class="se-toolbar-btn" id="btnCenterH" title="Centrer horizontalement la source sélectionnée" disabled>↔ Centrer horiz.</button>
                    <button type="button" class="se-toolbar-btn" id="btnCenterV" title="Centrer verticalement la source sélectionnée" disabled>↕ Centrer vert.</button>
                    <span class="se-toolbar-sep"></span>
                    <span class="se-toolbar-label">Aperçu :</span>
                    <button type="button" class="se-toolbar-btn" data-test="follow">Follow</button>
                    <button type="button" class="se-toolbar-btn" data-test="sub">Sub</button>
                    <button type="button" class="se-toolbar-btn" data-test="subs_gift">Gift de subs</button>
                    <button type="button" class="se-toolbar-btn" data-test="raid">Raid</button>
                    <button type="button" class="se-toolbar-btn" data-test="bits">Bits</button>
                    <button type="button" class="se-toolbar-btn" data-test="chat">Message chat</button>
                    <span class="se-toolbar-hint">Aperçu visible uniquement ici — pas dans OBS</span>
                </div>
                <div class="se-canvas" id="canvasWrap">
                    <div class="se-stage" id="stage">
                        <iframe id="sceneFrame"></iframe>
                    </div>
                </div>
            </div>

            <div class="se-panel se-right">
                <div class="se-tabs">
                    <button type="button" class="se-tab active" data-tab="sources">Sources</button>
                    <button type="button" class="se-tab" data-tab="texts">Textes</button>
                    <button type="button" class="se-tab" data-tab="scene">Scène</button>
                </div>
                <div class="se-tab-panel active" data-tab="sources">
                    <div class="se-list" id="sourcesList"><p class="se-empty">Chargement de l'aperçu...</p></div>
                    <div class="se-panel-footer">
                        <div class="se-menu" id="addMenu">
                            <button type="button" data-type="text">T&nbsp;&nbsp;Texte</button>
                            <button type="button" data-type="image">▨&nbsp;&nbsp;Image</button>
                            <button type="button" data-type="box">■&nbsp;&nbsp;Boîte de couleur</button>
                            <button type="button" data-type="clock">◷&nbsp;&nbsp;Horloge</button>
                            <button type="button" data-type="chat">💬&nbsp;&nbsp;Chat Twitch</button>
                            <button type="button" data-type="chatTicker">🎞️&nbsp;&nbsp;Chat défilant</button>
                            <button type="button" data-type="alerts">🔔&nbsp;&nbsp;Alertes</button>
                            <button type="button" data-type="spotify">🎵&nbsp;&nbsp;Spotify</button>
                            <button type="button" data-type="keys">⌨️&nbsp;&nbsp;Touches</button>
                            <button type="button" data-type="statBadge">📈&nbsp;&nbsp;Donnée du stream</button>
                            <button type="button" data-type="badge">🏷️&nbsp;&nbsp;Badge (icône + texte)</button>
                            <button type="button" data-type="rotatingText">🔁&nbsp;&nbsp;Messages rotatifs</button>
                            <button type="button" data-type="infoPanel">📋&nbsp;&nbsp;Panneau Trucky</button>
                            <button type="button" data-type="bottomBar">📢&nbsp;&nbsp;Bandeau bas</button>
                        </div>
                        <button type="button" class="se-icon-btn" id="btnAddElement" title="Ajouter un élément">+</button>
                        <button type="button" class="se-icon-btn" id="btnDeleteElement" title="Supprimer l'élément sélectionné (un élément intégré est retiré de la scène, rétablissable)">−</button>
                    </div>
                    <div class="se-props" id="elProps"><p class="se-empty">Sélectionne une source pour voir ses propriétés.</p></div>
                </div>
                <div class="se-tab-panel" data-tab="texts">
                    <div class="se-tab-scroll" id="textsList"><p class="se-empty">Chargement de l'aperçu...</p></div>
                </div>
                <div class="se-tab-panel" data-tab="scene">
                    <div class="se-tab-scroll" id="sceneProps"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const ACTIVE_PROFILE_ID = ${js(activeId)};
        const THEME_FIELDS = ${js(THEME_FIELDS)};
        const CANVAS_W = ${CANVAS_W};
        const CANVAS_H = ${CANVAS_H};

        // État global. SCENES/THEMES/PAUSE sont maintenus côté client après chaque action (les
        // réponses API ne renvoient pas l'état complet) ; elements/texts sont toujours resynchronisés
        // depuis l'iframe via 'scene-editor-ready', re-émis à chaque 'config-updated' — la liste des
        // sources reflète donc en permanence ce que l'aperçu affiche réellement.
        const ANIM_DEFAULTS = ${js(animDefaults)};
        let SCENES = ${js(BUILTIN_SCENES.map(s => ({
            ...s,
            builtin: true,
            background: (scenes[s.key] && scenes[s.key].background) || { mode: 'theme', color: '#0f172a', color2: '#1e293b' },
            effects: (scenes[s.key] && scenes[s.key].effects) || {}
        })))}
            .concat(Object.entries(${js(scenes)})
                .filter(([id]) => !${js(BUILTIN_SCENES.map(s => s.key))}.includes(id))
                .map(([id, s]) => ({
                    key: id, label: s.name, url: '/scene/' + id, builtin: false,
                    background: s.background || { mode: 'transparent', color: '#0f172a', color2: '#1e293b' },
                    effects: s.effects || {}
                })));
        let THEMES = ${js(themes)};
        let PAUSE = ${js({ messages: pause.messages || [], progressMessages: pause.progressMessages || [] })};

        let currentKey = 'starting';
        let elements = [];
        let texts = [];
        // Éléments intégrés retirés de la page courante (remontés par le bridge) : ils ne sont plus
        // des sources, mais restent rétablissables depuis la liste dédiée du panneau Sources.
        let removedBuiltins = [];
        let selectedId = null;

        const frame = document.getElementById('sceneFrame');

        function esc(value) {
            return String(value ?? '').replace(/[&<>"']/g, (c) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
        }

        let toastTimer = null;
        function toast(text, ok = true) {
            const el = document.getElementById('toast');
            el.textContent = text;
            el.className = 'se-toast show' + (ok ? '' : ' error');
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

        function jsonBody(method, body) {
            return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        }

        function sceneByKey(key) { return SCENES.find((s) => s.key === key); }

        // ---------- Aperçu : échelle adaptée à la place disponible ----------
        function fitCanvas() {
            const wrap = document.getElementById('canvasWrap');
            const scale = Math.min(
                (wrap.clientWidth - 32) / CANVAS_W,
                (wrap.clientHeight - 32) / CANVAS_H
            );
            const stage = document.getElementById('stage');
            stage.style.width = Math.round(CANVAS_W * scale) + 'px';
            stage.style.height = Math.round(CANVAS_H * scale) + 'px';
            frame.style.transform = 'scale(' + scale + ')';
        }
        window.addEventListener('resize', fitCanvas);

        // ---------- Scènes ----------
        function loadScene(key) {
            currentKey = key;
            selectedId = null;
            elements = [];
            texts = [];
            renderSceneList();
            renderSources();
            renderProps();
            renderTexts();
            renderSceneTab();
            const scene = sceneByKey(key);
            frame.src = scene.url + (scene.url.includes('?') ? '&' : '?') + 'sceneEditor=1';
        }

        function reloadScene() {
            const scene = sceneByKey(currentKey);
            frame.src = scene.url + (scene.url.includes('?') ? '&' : '?') + 'sceneEditor=1';
        }

        function renderSceneList() {
            const builtin = SCENES.filter((s) => s.builtin);
            const custom = SCENES.filter((s) => !s.builtin);
            const row = (s) => \`
                <div class="se-row\${s.key === currentKey ? ' active' : ''}" data-scene="\${s.key}">
                    <span class="se-row-icon">\${s.builtin ? '◇' : '◆'}</span>
                    <span class="se-row-name">\${esc(s.label)}</span>
                </div>\`;
            document.getElementById('sceneList').innerHTML =
                builtin.map(row).join('') +
                '<div class="se-list-sep">Mes scènes</div>' +
                (custom.length ? custom.map(row).join('') : '<p class="se-empty">Aucune — crée ta première scène avec +</p>');
            document.getElementById('btnDeleteScene').disabled = !!(sceneByKey(currentKey) || {}).builtin;
        }

        document.getElementById('sceneList').addEventListener('click', (e) => {
            const row = e.target.closest('.se-row');
            if (row && row.dataset.scene !== currentKey) loadScene(row.dataset.scene);
        });

        document.getElementById('btnAddScene').addEventListener('click', async () => {
            const count = SCENES.filter((s) => !s.builtin).length;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/scenes',
                jsonBody('POST', { name: 'Nouvelle scène' + (count ? ' ' + (count + 1) : '') }));
            if (!res) return;
            SCENES.push({
                key: res.sceneId,
                label: 'Nouvelle scène' + (count ? ' ' + (count + 1) : ''),
                url: '/scene/' + res.sceneId,
                builtin: false,
                background: { mode: 'transparent', color: '#0f172a', color2: '#1e293b' },
                effects: {}
            });
            toast('Scène créée — renomme-la dans l\\'onglet "Scène".');
            loadScene(res.sceneId);
        });

        // Suppression en deux clics (pas de window.confirm, peu fiable sous Electron) : le premier
        // arme le bouton, le second confirme. Se désarme en cliquant ailleurs.
        function armButton(btn, onConfirm) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.classList.contains('armed')) {
                    btn.classList.remove('armed');
                    onConfirm();
                } else {
                    btn.classList.add('armed');
                    toast('Clique à nouveau pour confirmer la suppression.');
                }
            });
            document.addEventListener('click', (e) => {
                if (e.target !== btn) btn.classList.remove('armed');
            });
        }

        armButton(document.getElementById('btnDeleteScene'), async () => {
            const scene = sceneByKey(currentKey);
            if (!scene || scene.builtin) return;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/scenes/' + scene.key, { method: 'DELETE' });
            if (!res) return;
            SCENES = SCENES.filter((s) => s.key !== scene.key);
            toast('Scène supprimée.');
            loadScene('starting');
        });

        // ---------- Communication avec l'iframe ----------
        function apiUrlFor(fullId) {
            const isCustom = fullId.startsWith('custom:');
            const rawId = isCustom ? fullId.replace(/^custom:/, '') : fullId;
            return {
                isCustom,
                url: isCustom
                    ? '/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + currentKey + '/' + rawId
                    : '/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + currentKey + '/' + rawId
            };
        }

        window.addEventListener('message', async (event) => {
            // Une seule iframe : ignorer tout message qui ne vient pas d'elle (ex: reliquat d'une
            // scène précédente pendant un changement de src).
            if (event.source !== frame.contentWindow) return;
            const data = event.data;
            if (!data || !data.type) return;

            if (data.type === 'scene-editor-ready') {
                elements = data.elements;
                texts = data.texts;
                removedBuiltins = data.removedBuiltins || [];
                // Si la sélection a disparu (élément supprimé), on la retire ; sinon on la garde
                // à travers les resynchronisations (drag, édition, config-updated...).
                if (selectedId && !elements.some((el) => el.id === selectedId)) selectedId = null;
                renderSources();
                renderProps();
                renderTexts();
            } else if (data.type === 'scene-element-selected') {
                selectedId = data.elementId;
                renderSources();
                renderProps();
            } else if (data.type === 'scene-element-moved') {
                const { isCustom, url } = apiUrlFor(data.elementId);
                await callApi(url, jsonBody(isCustom ? 'PATCH' : 'POST', { top: data.top, left: data.left }));
            } else if (data.type === 'scene-element-resized') {
                // data.width/height ne sont présents que pour l'axe concerné (JSON.stringify omet
                // les clés undefined) — un resize horizontal seul ne touche jamais la hauteur.
                const { isCustom, url } = apiUrlFor(data.elementId);
                await callApi(url, jsonBody(isCustom ? 'PATCH' : 'POST', { width: data.width, height: data.height }));
            }
        });

        // ---------- Sources ----------
        const TYPE_ICONS = {
            text: 'T', image: '▨', box: '■', clock: '◷', chat: '💬', chatTicker: '🎞️',
            alerts: '🔔', spotify: '🎵', keys: '⌨️',
            statBadge: '📈', badge: '🏷️', rotatingText: '🔁', infoPanel: '📋', bottomBar: '📢'
        };

        function renderSources() {
            const el = document.getElementById('sourcesList');
            if (elements.length === 0) {
                el.innerHTML = '<p class="se-empty">Aucune source sur cette scène — ajoute un élément avec +</p>';
            } else {
                el.innerHTML = elements.map((item) => \`
                    <div class="se-row\${item.id === selectedId ? ' active' : ''}" data-el="\${item.id}">
                        <span class="se-row-icon">\${item.isCustom ? (TYPE_ICONS[item.customType] || 'T') : '◇'}</span>
                        <span class="se-row-name">\${esc(item.label)}</span>
                        <button type="button" class="se-row-eye\${item.hidden ? ' off' : ''}" data-el="\${item.id}" title="\${item.hidden ? 'Afficher' : 'Masquer'}">\${item.hidden ? '⊘' : '👁'}</button>
                    </div>\`).join('');
            }
            // Éléments intégrés retirés : listés à part, avec un bouton de rétablissement — sans
            // quoi le retrait serait un aller simple (l'élément n'est plus sélectionnable).
            if (removedBuiltins.length > 0) {
                el.innerHTML += '<div class="se-removed-block"><p class="hint">Éléments retirés de cette scène</p>'
                    + removedBuiltins.map((item) => \`
                        <div class="se-row se-row-removed">
                            <span class="se-row-icon">◇</span>
                            <span class="se-row-name">\${esc(item.label)}</span>
                            <button type="button" class="se-row-restore" data-restore="\${esc(item.id)}" title="Rétablir sur cette scène">↺</button>
                        </div>\`).join('')
                    + '</div>';
            }
            const selected = elements.find((it) => it.id === selectedId);
            // Actif aussi pour les éléments intégrés : le bouton les RETIRE de la scène (voir le
            // handler), au lieu de les supprimer définitivement comme un élément custom.
            document.getElementById('btnDeleteElement').disabled = !selected;
            // Centrage : n'a de sens que sur un élément réellement sélectionné.
            document.getElementById('btnCenterH').disabled = !selected;
            document.getElementById('btnCenterV').disabled = !selected;
        }

        document.getElementById('sourcesList').addEventListener('click', async (e) => {
            const restore = e.target.closest('.se-row-restore');
            if (restore) {
                e.stopPropagation();
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + currentKey + '/' + restore.dataset.restore,
                    jsonBody('POST', { removed: false }));
                if (res) toast('Élément rétabli.');
                return;
            }
            const eye = e.target.closest('.se-row-eye');
            if (eye) {
                e.stopPropagation();
                const item = elements.find((it) => it.id === eye.dataset.el);
                if (!item) return;
                const nextHidden = !item.hidden;
                // L'état masqué passe TOUJOURS par layout/<id complet> (y compris pour les éléments
                // custom) — même mécanisme que l'ancienne version de l'éditeur, lu par
                // applyLayoutFromConfig()/renderCustomTextsFromConfig() côté overlay.
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + currentKey + '/' + item.id,
                    jsonBody('POST', { hidden: nextHidden }));
                if (res) {
                    item.hidden = nextHidden; // optimiste — la resynchro 'ready' confirmera
                    renderSources();
                    renderProps();
                }
                return;
            }
            const row = e.target.closest('.se-row');
            if (row) {
                selectedId = row.dataset.el;
                renderSources();
                renderProps();
            }
        });

        // ---------- Ajout / suppression d'éléments ----------
        const addMenu = document.getElementById('addMenu');
        document.getElementById('btnAddElement').addEventListener('click', (e) => {
            e.stopPropagation();
            // Chat et alertes : ids DOM uniques (#chatContainer, #alertContainer) — une seule
            // instance par scène. Le blocage tient compte du bloc INTÉGRÉ équivalent encore présent
            // sur la page (les pages intégrées ont le leur en dur) : dès qu'il est retiré ou
            // converti, l'ajout redevient possible. Testé sur la liste des sources réelle plutôt
            // que sur le nom de la page, qui ne dit plus rien de ce qu'elle contient.
            const BUILTIN_EQUIVALENT = { chat: 'chatPanel', alerts: 'alertContainer' };
            ['chat', 'alerts'].forEach((type) => {
                const btn = addMenu.querySelector('button[data-type="' + type + '"]');
                const already = elements.some((it) => it.customType === type);
                const builtinPresent = elements.some((it) => it.id === BUILTIN_EQUIVALENT[type]);
                btn.disabled = already || builtinPresent;
                btn.title = btn.disabled
                    ? (builtinPresent ? 'Déjà présent sur cette page (élément intégré)' : 'Un seul par scène')
                    : '';
            });
            addMenu.classList.toggle('open');
        });
        document.addEventListener('click', () => addMenu.classList.remove('open'));

        addMenu.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-type]');
            if (!btn) return;
            addMenu.classList.remove('open');
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + currentKey,
                jsonBody('POST', {
                    type: btn.dataset.type,
                    top: 30 + Math.random() * 25,
                    left: 30 + Math.random() * 25
                }));
            if (res) {
                selectedId = 'custom:' + res.elementId;
                toast('Élément ajouté.');
                // La liste se resynchronise via le 'scene-editor-ready' déclenché par config-updated.
            }
        });

        armButton(document.getElementById('btnDeleteElement'), async () => {
            const item = elements.find((it) => it.id === selectedId);
            if (!item) return;
            // Élément INTÉGRÉ : il vit dans le HTML de la page, on ne peut pas le supprimer pour de
            // bon — on le retire de la scène (drapeau "removed"), ce qui le fait disparaître de
            // l'aperçu ET de la liste des sources. Réversible depuis « Éléments retirés ».
            if (!item.isCustom) {
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + currentKey + '/' + item.id,
                    jsonBody('POST', { removed: true }));
                if (res) {
                    selectedId = null;
                    toast('Élément retiré de la scène.');
                }
                return;
            }
            const rawId = item.id.replace(/^custom:/, '');
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + currentKey + '/' + rawId, { method: 'DELETE' });
            if (res) toast('Élément supprimé.');
        });

        // ---------- Propriétés de l'élément sélectionné ----------
        // Un descripteur par type d'élément — kind détermine l'input rendu et la coercion à la
        // sauvegarde (l'API n'accepte que des types stricts : nombre pour size/opacity/radius,
        // booléen pour glow...). def = valeur affichée quand aucun override n'est enregistré,
        // alignée sur les défauts du rendu (renderCustomTextsFromConfig, overlay-common.js).
        // Sources de données et icônes des widgets génériques. Doivent rester alignées sur
        // STAT_SOURCES / SCENE_ICON_KEYS (store.js, qui valide les patchs) et sur SCENE_ICONS
        // (overlay-common.js, qui les traduit en classes FontAwesome) — une clé en trop ici serait
        // silencieusement refusée par l'API, une clé en moins deviendrait inatteignable.
        const STAT_SOURCE_OPTIONS = [
            { value: 'viewers', label: 'Viewers en direct' },
            { value: 'followers', label: 'Nouveaux followers' },
            { value: 'subs', label: 'Nouveaux subs' },
            { value: 'messages', label: 'Messages de chat' },
            { value: 'duration', label: 'Durée du stream' },
            { value: 'game', label: 'Jeu en cours' },
            { value: 'title', label: 'Titre du stream' }
        ];
        const ICON_OPTIONS = [
            { value: 'none', label: '(aucune)' }, { value: 'users', label: 'Utilisateurs' },
            { value: 'heart', label: 'Cœur' }, { value: 'star', label: 'Étoile' },
            { value: 'comments', label: 'Bulles de chat' }, { value: 'clock', label: 'Horloge' },
            { value: 'hourglass', label: 'Sablier' }, { value: 'pause', label: 'Pause' },
            { value: 'play', label: 'Lecture' }, { value: 'gamepad', label: 'Manette' },
            { value: 'truck', label: 'Camion' }, { value: 'chart', label: 'Graphique' },
            { value: 'bell', label: 'Cloche' }, { value: 'arrow', label: 'Flèche' },
            { value: 'coffee', label: 'Café' }, { value: 'wrench', label: 'Clé à molette' },
            { value: 'twitch', label: 'Twitch' }, { value: 'discord', label: 'Discord' },
            { value: 'youtube', label: 'YouTube' }, { value: 'globe', label: 'Site web' },
            { value: 'instagram', label: 'Instagram' }, { value: 'tiktok', label: 'TikTok' }
        ];

        const PROP_SPECS = {
            text: [
                { prop: 'text', label: 'Texte', kind: 'text' },
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 2.4, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: 'Couleur', kind: 'color', def: '#ffffff' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'glow', label: 'Effet néon', kind: 'check' }
            ],
            clock: [
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 4, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: 'Couleur', kind: 'color', def: '#ffffff' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'glow', label: 'Effet néon', kind: 'check' }
            ],
            image: [
                { prop: 'url', label: "URL de l'image (https://... ou /chemin local)", kind: 'text', placeholder: 'https://exemple.com/image.png' },
                { prop: 'radius', label: 'Arrondi (px)', kind: 'number', def: 0, step: 1, min: 0, max: 200 },
                { prop: 'opacity', label: 'Opacité (%)', kind: 'number', def: 100, step: 1, min: 0, max: 100 }
            ],
            box: [
                { prop: 'color', label: 'Couleur', kind: 'color', def: '#a855f7' },
                { prop: 'opacity', label: 'Opacité (%)', kind: 'number', def: 100, step: 1, min: 0, max: 100 },
                { prop: 'radius', label: 'Arrondi (px)', kind: 'number', def: 8, step: 1, min: 0, max: 200 }
            ],
            chat: [
                { prop: 'text', label: 'Titre du panneau', kind: 'text' },
                { prop: 'scale', label: 'Échelle (%)', kind: 'number', def: 100, step: 5, min: 25, max: 400 },
                { prop: 'textScale', label: 'Taille du texte (%)', kind: 'number', def: 100, step: 5, min: 25, max: 400 },
                { prop: 'font', label: 'Police', kind: 'font' },
                // 92 = l'opacité de repli du fond (.chat-panel), pas 100 : le champ affiche donc
                // le rendu réel tant qu'aucun override n'est enregistré.
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 92, step: 5, min: 0, max: 100 }
            ],
            chatTicker: [
                { prop: 'speed', label: 'Vitesse (px/s)', kind: 'number', def: 60, step: 5, min: 10, max: 400 },
                { prop: 'textScale', label: 'Taille du texte (%)', kind: 'number', def: 100, step: 5, min: 25, max: 400 },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 60, step: 5, min: 0, max: 100 }
            ],
            // Zone d'alertes : pas d'échelle — sa taille EST le réglage (l'alerte s'ajuste au
            // plus grand format qui tient dans le cadre).
            alerts: [],
            spotify: [
                { prop: 'color', label: "Couleur d'accent", kind: 'color', def: '#1db954' },
                { prop: 'scale', label: 'Échelle (%)', kind: 'number', def: 100, step: 5, min: 25, max: 400 },
                { prop: 'textScale', label: 'Taille du texte (%)', kind: 'number', def: 100, step: 5, min: 25, max: 400 },
                { prop: 'font', label: 'Police', kind: 'font' },
                // 85 = l'opacité d'origine du fond de .spotify-widget (voir le champ chat).
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 85, step: 5, min: 0, max: 100 }
            ],
            keys: [
                { prop: 'color', label: "Couleur d'accent", kind: 'color', def: '#f59e0b' },
                { prop: 'scale', label: 'Échelle (%)', kind: 'number', def: 100, step: 5, min: 25, max: 400 },
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 35, step: 5, min: 0, max: 100 },
                {
                    prop: 'layout', label: 'Disposition clavier', kind: 'select', def: 'azerty',
                    options: [{ value: 'azerty', label: 'AZERTY (ZQSD)' }, { value: 'qwerty', label: 'QWERTY (WASD)' }]
                },
                { prop: 'showFunctionRow', label: 'Rangée F1-F12', kind: 'check', def: true },
                { prop: 'showDigitRow', label: 'Rangée chiffres', kind: 'check', def: true },
                { prop: 'showMovement', label: 'Touches de déplacement', kind: 'check', def: true },
                { prop: 'showModifiers', label: 'Shift/Ctrl/Alt/Espace/Entrée', kind: 'check', def: true },
                { prop: 'showArrows', label: 'Flèches directionnelles', kind: 'check', def: true },
                { prop: 'showMouse', label: 'Souris', kind: 'check', def: true }
            ],
            // Widgets génériques : leur taille se règle par la POLICE (tout leur CSS est en em,
            // voir applySceneWidgetStyle) — d'où "Taille (vh)" plutôt qu'une échelle en %.
            statBadge: [
                { prop: 'source', label: 'Donnée affichée', kind: 'select', def: 'viewers', options: STAT_SOURCE_OPTIONS },
                { prop: 'text', label: 'Libellé (après la valeur)', kind: 'text', placeholder: 'ex: en attente' },
                { prop: 'icon', label: 'Icône', kind: 'select', def: 'users', options: ICON_OPTIONS },
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 2.6, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: "Couleur d'accent", kind: 'color', def: '#a855f7' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'glow', label: 'Effet néon', kind: 'check' },
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 85, step: 5, min: 0, max: 100 }
            ],
            badge: [
                { prop: 'text', label: 'Libellé', kind: 'text' },
                { prop: 'icon', label: 'Icône', kind: 'select', def: 'pause', options: ICON_OPTIONS },
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 2.6, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: "Couleur d'accent", kind: 'color', def: '#a855f7' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'glow', label: 'Effet néon', kind: 'check' },
                { prop: 'pulse', label: 'Pulsation', kind: 'check', def: true },
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 85, step: 5, min: 0, max: 100 }
            ],
            rotatingText: [
                { prop: 'text', label: 'Messages (un par ligne)', kind: 'textarea', placeholder: 'Un message par ligne' },
                { prop: 'interval', label: 'Intervalle (s)', kind: 'number', def: 4, step: 1, min: 1, max: 120 },
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 2.2, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: 'Couleur', kind: 'color', def: '#ffffff' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'glow', label: 'Effet néon', kind: 'check' }
            ],
            infoPanel: [
                { prop: 'showTrip', label: 'Section « trajet »', kind: 'check', def: true },
                { prop: 'title1', label: 'Titre section 1', kind: 'text', placeholder: 'TRAJET ACTUEL' },
                { prop: 'showStats', label: 'Section « stats »', kind: 'check', def: true },
                { prop: 'title2', label: 'Titre section 2', kind: 'text', placeholder: 'STATS' },
                { prop: 'showCompany', label: 'Section « VTC »', kind: 'check', def: true },
                { prop: 'title3', label: 'Titre section 3', kind: 'text', placeholder: 'VTC' },
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 1.5, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: "Couleur d'accent", kind: 'color', def: '#a855f7' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 90, step: 5, min: 0, max: 100 },
                { prop: 'autoShow', label: 'Apparition périodique', kind: 'check', def: true }
            ],
            bottomBar: [
                { prop: 'text', label: 'Items (un par ligne, « icone|texte »)', kind: 'textarea', placeholder: 'twitch|MonPseudo' },
                { prop: 'scrolling', label: 'Texte défilant (optionnel)', kind: 'text' },
                { prop: 'size', label: 'Taille (vh)', kind: 'number', def: 1.6, step: 0.1, min: 0.5, max: 30 },
                { prop: 'color', label: "Couleur d'accent", kind: 'color', def: '#a855f7' },
                { prop: 'font', label: 'Police', kind: 'font' },
                { prop: 'opacity', label: 'Opacité du fond (%)', kind: 'number', def: 90, step: 5, min: 0, max: 100 },
                { prop: 'autoShow', label: 'Apparition périodique', kind: 'check', def: true }
            ]
        };

        // Style par élément INTÉGRÉ : couleurs de thème locales (variables --theme-* posées sur
        // l'élément seul) + échelle visuelle. 'text' est envoyé tel quel à l'API mais lu depuis
        // item.themeText (le champ 'text' du rapport iframe désigne déjà le contenu textuel).
        const BUILTIN_STYLE_COLORS = [
            { prop: 'primary', label: 'Primaire' },
            { prop: 'secondary', label: 'Secondaire' },
            { prop: 'text', label: 'Texte' },
            { prop: 'panelBg', label: 'Fond' },
            { prop: 'panelBorder', label: 'Bordure' }
        ];

        function propFieldHtml(spec, item) {
            const raw = item[spec.prop];
            if (spec.kind === 'color') {
                return \`<div class="field"><label>\${esc(spec.label)}</label>
                    <input type="color" class="se-prop" data-prop="\${spec.prop}" data-kind="color" value="\${esc(raw || spec.def)}"></div>\`;
            }
            if (spec.kind === 'number') {
                const val = (typeof raw === 'number') ? raw : spec.def;
                return \`<div class="field"><label>\${esc(spec.label)}</label>
                    <input type="number" class="se-prop" data-prop="\${spec.prop}" data-kind="number" value="\${val}" step="\${spec.step}" min="\${spec.min}" max="\${spec.max}"></div>\`;
            }
            if (spec.kind === 'font') {
                const val = raw || 'baron';
                return \`<div class="field"><label>\${esc(spec.label)}</label>
                    <select class="se-prop" data-prop="font" data-kind="text">
                        <option value="baron"\${val === 'baron' ? ' selected' : ''}>Baron Neue (titres)</option>
                        <option value="inter"\${val === 'inter' ? ' selected' : ''}>Inter (lisible)</option>
                    </select></div>\`;
            }
            // Sélecteur générique à options fournies par le spec (ex: layout clavier) — data-kind
            // "text" (pas "select") : savePropChange() n'a pas de cas dédié, le select.value déjà
            // une chaîne tombe dans son branch par défaut, même mécanisme que le sélecteur 'font'.
            if (spec.kind === 'select') {
                const val = raw || spec.def;
                return \`<div class="field"><label>\${esc(spec.label)}</label>
                    <select class="se-prop" data-prop="\${spec.prop}" data-kind="text">
                        \${spec.options.map((o) => \`<option value="\${esc(o.value)}"\${o.value === val ? ' selected' : ''}>\${esc(o.label)}</option>\`).join('')}
                    </select></div>\`;
            }
            if (spec.kind === 'check') {
                return \`<div class="field"><label class="checkbox-row"><input type="checkbox" class="se-prop" data-prop="\${spec.prop}" data-kind="check"\${raw ? ' checked' : ''}> \${esc(spec.label)}</label></div>\`;
            }
            // Multiligne (messages rotatifs, items du bandeau) : porte se-prop-text comme les
            // champs texte, donc sauvegardé au blur et non à chaque frappe — indispensable ici, une
            // sauvegarde par touche recréerait tout le widget à chaque caractère.
            if (spec.kind === 'textarea') {
                return \`<div class="field"><label>\${esc(spec.label)}</label>
                    <textarea class="se-prop se-prop-text" data-prop="\${spec.prop}" data-kind="text" rows="4" placeholder="\${esc(spec.placeholder || '')}">\${esc(raw || '')}</textarea></div>\`;
            }
            return \`<div class="field"><label>\${esc(spec.label)}</label>
                <input type="text" class="se-prop se-prop-text" data-prop="\${spec.prop}" data-kind="text" value="\${esc(raw || '')}" placeholder="\${esc(spec.placeholder || '')}"></div>\`;
        }

        function renderProps() {
            const box = document.getElementById('elProps');
            const item = elements.find((it) => it.id === selectedId);
            if (!item) {
                box.innerHTML = '<p class="se-empty">Sélectionne une source pour voir ses propriétés.</p>';
                return;
            }
            let fields = '';
            let note = '';
            // Filet de sécurité du dépassement de cadre : un élément peut être tiré entièrement hors
            // de l'écran (positions négatives comprises, voir clampLayoutPercent) — il n'est alors
            // plus attrapable à la souris dans l'aperçu, seulement sélectionnable dans la liste des
            // sources. Ce bouton le ramène toujours à une position sûrement visible.
            const recenterBtn = \`<button type="button" class="btn btn-ghost btn-sm" id="btnRecenterEl" title="Ramène l'élément au centre du cadre s'il a été sorti de l'écran">Recentrer</button>\`;
            if (item.isCustom) {
                fields = (PROP_SPECS[item.customType] || []).map((spec) => propFieldHtml(spec, item)).join('');
                if (item.customType === 'chat' || item.customType === 'chatTicker' || item.customType === 'alerts') {
                    note = '<p class="hint">Reprend les couleurs du thème de la scène (onglet Scène).</p>';
                }
                if (item.customType === 'chatTicker') {
                    note += '<p class="hint">Les messages défilent de droite à gauche en continu. Redimensionne le bandeau en largeur pour couvrir l\\'écran ; sa hauteur suit la taille du texte. L\\'aperçu est figé ici, le défilement ne joue que sur l\\'overlay réel.</p>';
                }
                if (item.customType === 'alerts') {
                    note += '<p class="hint">Le cadre définit où les alertes peuvent apparaître : chaque alerte s\\'affiche au plus grand format qui y tient, média (image/GIF) en entier. Teste le rendu avec la barre "Aperçu" en haut.</p>';
                }
                if (item.customType === 'spotify') {
                    note += '<p class="hint">Affiche le morceau en cours de lecture sur le compte Spotify connecté — configure la connexion depuis la page <a href="/integrations" target="_blank">Intégrations</a>.</p>';
                }
                if (item.customType === 'infoPanel') {
                    note += '<p class="hint">Trajet en cours et statistiques VTC du compte Trucky configuré — active l\\'intégration depuis la page <a href="/integrations" target="_blank">Intégrations</a>.</p>';
                }
                if (item.customType === 'keys') {
                    note += '<p class="hint">Affiche les touches clavier/souris pressées (WASD, flèches, Espace, modificateurs, F1-F12, chiffres, clics) — active la capture depuis la page <a href="/integrations" target="_blank">Intégrations</a>.</p>';
                }
                fields += \`<div class="se-btn-row">\${recenterBtn}</div>\`;
            } else {
                const theme = THEMES[currentKey] || {};
                const fallbackFor = (key) => {
                    const f = THEME_FIELDS.find((t) => t.key === key);
                    return theme[key] || (f ? f.fallback : '#ffffff');
                };
                fields = '<div class="se-color-grid">' + BUILTIN_STYLE_COLORS.map((c) => {
                    const current = (c.prop === 'text' ? item.themeText : item[c.prop]) || fallbackFor(c.prop);
                    return \`<div class="field"><label>\${esc(c.label)}</label>
                        <input type="color" class="se-bprop" data-prop="\${c.prop}" data-kind="color" value="\${esc(current)}"></div>\`;
                }).join('') + '</div>';
                // Pas d'échelle pour les badges à texte adaptatif (leur police suit déjà le
                // redimensionnement) ni pour la zone d'alertes (sa taille EST le réglage :
                // l'alerte s'ajuste au plus grand format qui tient dans le cadre).
                if (!item.scaleText && item.id !== 'alertContainer') {
                    fields += \`<div class="field" style="margin-top:var(--space-3);"><label>Échelle (%)</label>
                        <input type="number" class="se-bprop" data-prop="scale" data-kind="number" value="\${typeof item.scale === 'number' ? item.scale : 100}" step="5" min="25" max="400"></div>\`;
                }
                // Opacité du fond : proposée pour le seul élément intégré dont le CSS la consomme
                // (le panneau de chat, présent sur les pages Démarrage/Jeu/Fin — voir
                // --chat-bg-opacity). 92 = l'opacité de repli de son fond, donc "pas d'override".
                if (item.id === 'chatPanel') {
                    fields += \`<div class="field"><label>Opacité du fond (%)</label>
                        <input type="number" class="se-bprop" data-prop="opacity" data-kind="number" value="\${typeof item.opacity === 'number' ? item.opacity : 92}" step="5" min="0" max="100"></div>\`;
                }
                fields += \`<div class="se-btn-row">\${recenterBtn}<button type="button" class="btn btn-ghost btn-sm" id="btnResetEl">Réinitialiser</button></div>\`;
                note = '<p class="hint">Couleurs et échelle appliquées à cet élément uniquement (selon l\\'élément, certaines couleurs peuvent être sans effet). Réinitialiser efface position, taille et style. L\\'œil le masque ; le bouton − le retire complètement de la scène (rétablissable en bas de la liste des sources).</p>';
                if (item.id === 'alertContainer') {
                    note = '<p class="hint">Le cadre définit où les alertes peuvent apparaître : chaque alerte s\\'affiche au plus grand format qui y tient, média (image/GIF) en entier. Teste le rendu avec la barre "Aperçu" en haut.</p>' + note;
                }
            }
            box.innerHTML = \`<h4>\${esc(item.label)}\${item.hidden ? ' (masqué)' : ''}</h4>\` + fields + note;

            // Réutilise le centrage de la barre d'outils sur les DEUX axes (calculé dans l'iframe,
            // seule à connaître la taille réellement rendue de l'élément et son mécanisme de
            // centrage CSS) plutôt qu'une position en dur : l'enregistrement suit alors le même
            // chemin qu'un drag classique, sans route dédiée.
            const recenterEl = document.getElementById('btnRecenterEl');
            if (recenterEl) {
                recenterEl.addEventListener('click', () => {
                    centerSelected('both');
                    toast('Élément recentré.');
                });
            }

            const resetBtn = document.getElementById('btnResetEl');
            if (resetBtn) {
                resetBtn.addEventListener('click', async () => {
                    const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + currentKey + '/' + item.id, { method: 'DELETE' });
                    if (res) toast('Élément réinitialisé.');
                });
            }
        }

        // Champs texte : sauvegarde au blur (éviter un PATCH par frappe) ; le reste au change.
        document.getElementById('elProps').addEventListener('focusout', (e) => {
            const input = e.target.closest('.se-prop-text');
            if (input) savePropChange(input);
        });
        document.getElementById('elProps').addEventListener('change', (e) => {
            const builtinInput = e.target.closest('.se-bprop');
            if (builtinInput) { saveBuiltinProp(builtinInput); return; }
            const input = e.target.closest('.se-prop:not(.se-prop-text)');
            if (input) savePropChange(input);
        });

        // Style d'un élément intégré : enregistré dans son entrée layout (même endpoint que
        // position/visibilité), appliqué en direct par applyLayoutFromConfig via config-updated.
        async function saveBuiltinProp(input) {
            const item = elements.find((it) => it.id === selectedId);
            if (!item || item.isCustom) return;
            let value;
            if (input.dataset.kind === 'number') {
                value = Number(input.value);
                if (!Number.isFinite(value)) return;
            } else {
                value = input.value;
            }
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/layout/' + currentKey + '/' + item.id,
                jsonBody('POST', { [input.dataset.prop]: value }));
            if (res) {
                item[input.dataset.prop === 'text' ? 'themeText' : input.dataset.prop] = value;
                toast('Enregistré.');
            }
        }

        async function savePropChange(input) {
            const item = elements.find((it) => it.id === selectedId);
            if (!item || !item.isCustom) return;
            let value;
            if (input.dataset.kind === 'number') {
                value = Number(input.value);
                if (!Number.isFinite(value)) return;
            } else if (input.dataset.kind === 'check') {
                value = input.checked;
            } else {
                value = input.value;
            }
            const rawId = item.id.replace(/^custom:/, '');
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/custom-text/' + currentKey + '/' + rawId,
                jsonBody('PATCH', { [input.dataset.prop]: value }));
            if (res) {
                item[input.dataset.prop] = value; // évite un flash de l'ancienne valeur avant la resynchro
                toast('Enregistré.');
            }
        }

        // ---------- Textes intégrés (titres, sous-titres, en-têtes...) ----------
        function renderTexts() {
            const el = document.getElementById('textsList');
            const scene = sceneByKey(currentKey);
            if (!texts || texts.length === 0) {
                el.innerHTML = '<p class="se-empty">' + (scene && !scene.builtin
                    ? 'Les scènes personnalisées n\\'ont pas de textes intégrés — ajoute des éléments Texte depuis l\\'onglet Sources.'
                    : 'Aucun texte intégré sur cette scène.') + '</p>';
                return;
            }
            // Taille/police laissées VIDES quand aucun réglage n'est enregistré (placeholder
            // "auto" / option "(par défaut)") : un texte sans override doit suivre le CSS de la
            // page, et revider le champ est ce qui l'y ramène (voir la route text-style).
            el.innerHTML = texts.map((item) => \`
                <div class="se-text-row" data-text="\${item.textId}">
                    <label>\${esc(item.label)}</label>
                    <div class="field-row">
                        <input type="text" class="se-static-text" data-text="\${item.textId}" value="\${esc(item.value)}">
                        <button type="button" class="btn btn-ghost btn-sm se-static-text-reset" data-text="\${item.textId}" title="Revenir au texte et au style par défaut">↺</button>
                    </div>
                    <div class="field-row se-text-style-row">
                        <input type="number" class="se-text-style" data-text="\${item.textId}" data-prop="size"
                            value="\${typeof item.size === 'number' ? item.size : ''}" placeholder="auto"
                            step="0.1" min="0.5" max="30" title="Taille en vh (vide = taille par défaut de la page)">
                        <select class="se-text-style" data-text="\${item.textId}" data-prop="font" title="Police">
                            <option value=""\${!item.font ? ' selected' : ''}>(par défaut)</option>
                            <option value="baron"\${item.font === 'baron' ? ' selected' : ''}>Baron Neue</option>
                            <option value="inter"\${item.font === 'inter' ? ' selected' : ''}>Inter</option>
                        </select>
                    </div>
                </div>\`).join('');
        }

        // Taille/police d'un texte intégré : endpoint distinct du contenu (stockage séparé, voir
        // setProfileTextStyle dans store.js). 'change' et non 'focusout' : couvre aussi le select.
        document.getElementById('textsList').addEventListener('change', async (e) => {
            const input = e.target.closest('.se-text-style');
            if (!input) return;
            const prop = input.dataset.prop;
            // Champ vidé => 0 / "" : la route interprète ces valeurs comme "revenir au défaut".
            const value = (prop === 'size') ? (parseFloat(input.value) || 0) : input.value;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/text-style/' + currentKey + '/' + input.dataset.text,
                jsonBody('POST', { [prop]: value }));
            if (res) toast('Style enregistré.');
        });

        document.getElementById('textsList').addEventListener('focusout', async (e) => {
            const input = e.target.closest('.se-static-text');
            if (!input) return;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/text/' + currentKey + '/' + input.dataset.text,
                jsonBody('POST', { value: input.value }));
            if (res) toast('Texte enregistré.');
        });

        document.getElementById('textsList').addEventListener('click', async (e) => {
            const btn = e.target.closest('.se-static-text-reset');
            if (!btn) return;
            btn.disabled = true;
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/text/' + currentKey + '/' + btn.dataset.text, { method: 'DELETE' });
            if (res) {
                toast('Texte réinitialisé.');
                // Le texte par défaut vit dans le HTML de la page, pas dans la config — recharger
                // l'aperçu le retrouve et re-déclenche un 'scene-editor-ready' à jour.
                reloadScene();
            }
            btn.disabled = false;
        });

        // ---------- Onglet Scène (nom, URL OBS, fond, effets, couleurs, messages de pause) ----------
        const SCENE_EFFECTS = [
            { key: 'particles', label: 'Particules flottantes' },
            { key: 'stars', label: 'Étoiles scintillantes' },
            { key: 'meteors', label: 'Météores' },
            { key: 'circuitLines', label: 'Lignes de circuit' },
            { key: 'dvdLogo', label: 'Logo rebondissant' }
        ];

        function sectionTitle(text) {
            return '<h4 style="margin:var(--space-4) 0 var(--space-2); font-size:12px; color:var(--text-muted);">' + text + '</h4>';
        }

        function renderSceneTab() {
            const scene = sceneByKey(currentKey);
            const box = document.getElementById('sceneProps');
            const obsUrl = window.location.origin + scene.url;

            let html = '';
            if (scene.builtin) {
                html += \`<div class="field"><label>Nom</label><div>\${esc(scene.label)}</div></div>\`;
            } else {
                html += \`<div class="field"><label>Nom de la scène</label>
                    <div class="se-url-row">
                        <input type="text" id="sceneNameInput" value="\${esc(scene.label)}">
                        <button type="button" class="btn btn-sm" id="btnRenameScene">OK</button>
                    </div></div>\`;
            }

            html += \`<div class="field"><label>URL pour OBS (source navigateur, 1920×1080)</label>
                <div class="se-url-row">
                    <input type="text" readonly value="\${esc(obsUrl)}" id="obsUrlInput">
                    <button type="button" class="btn btn-sm" id="btnCopyUrl">Copier</button>
                </div></div>\`;

            {
                const bg = scene.background || {};
                const mode = bg.mode || (scene.builtin ? 'theme' : 'transparent');
                html += sectionTitle('Fond');
                html += \`<div class="field">
                    <select id="bgMode">
                        \${scene.builtin ? \`<option value="theme"\${mode === 'theme' ? ' selected' : ''}>Thème de la page (par défaut)</option>\` : ''}
                        <option value="transparent"\${mode === 'transparent' ? ' selected' : ''}>Transparent (par-dessus le jeu)</option>
                        <option value="color"\${mode === 'color' ? ' selected' : ''}>Couleur unie + halos animés</option>
                        <option value="gradient"\${mode === 'gradient' ? ' selected' : ''}>Dégradé + halos animés</option>
                    </select></div>
                    <div class="se-color-grid" id="bgColors" style="\${(mode !== 'color' && mode !== 'gradient') ? 'display:none;' : ''}">
                        <div class="field"><label>Couleur</label><input type="color" class="se-bg-color" data-field="color" value="\${esc(bg.color || '#0f172a')}"></div>
                        <div class="field" style="\${mode !== 'gradient' ? 'display:none;' : ''}"><label>Couleur 2</label><input type="color" class="se-bg-color" data-field="color2" value="\${esc(bg.color2 || '#1e293b')}"></div>
                    </div>\`;

                // Case cochée = état EFFECTIF : la surcharge de la scène si posée, sinon les
                // réglages d'animations globaux (pages intégrées) ou rien (scène personnalisée).
                const fx = scene.effects || {};
                const fxState = (key) => fx[key] !== undefined ? fx[key] : (scene.builtin ? ANIM_DEFAULTS[key] : false);
                html += sectionTitle('Effets d\\'ambiance');
                html += '<div class="se-fx-row">' + SCENE_EFFECTS.map((f) => \`
                    <label class="checkbox-row"><input type="checkbox" class="se-fx-check" data-field="\${f.key}"\${fxState(f.key) ? ' checked' : ''}> \${esc(f.label)}</label>\`).join('') + '</div>';
                html += '<p class="hint">Densité et vitesse des effets : réglages globaux d\\'animations dans Paramètres. L\\'aperçu se recharge à chaque changement.</p>';
            }

            // Couleurs du thème : pour toutes les scènes — sur une scène personnalisée elles
            // pilotent les widgets (chat, alertes) et les halos de fond.
            const theme = THEMES[scene.key] || {};
            html += sectionTitle('Couleurs');
            html += '<div class="se-color-grid">' + THEME_FIELDS.map((f) => \`
                <div class="field"><label>\${esc(f.label)}</label>
                    <input type="color" class="se-theme-color" data-field="\${f.key}" value="\${esc(theme[f.key] || f.fallback)}"></div>\`).join('') + '</div>';

            if (scene.key === 'pause') {
                html += msgListHtml('messages', 'Messages qui défilent', PAUSE.messages);
                html += msgListHtml('progressMessages', 'Messages de la barre de progression', PAUSE.progressMessages);
                html += '<p class="hint">Une liste vidée revient aux messages par défaut.</p>';
            }

            box.innerHTML = html;

            document.getElementById('btnCopyUrl').addEventListener('click', () => {
                navigator.clipboard.writeText(obsUrl).then(
                    () => toast('URL copiée.'),
                    () => toast('Impossible de copier l\\'URL.', false)
                );
            });

            const renameBtn = document.getElementById('btnRenameScene');
            if (renameBtn) {
                renameBtn.addEventListener('click', async () => {
                    const name = document.getElementById('sceneNameInput').value.trim();
                    if (!name) return;
                    const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/scenes/' + scene.key,
                        jsonBody('PATCH', { name }));
                    if (res) {
                        scene.label = name;
                        toast('Scène renommée.');
                        renderSceneList();
                    }
                });
            }
        }

        // Fond de la scène : appliqué en direct par l'aperçu via config-updated (pas de
        // rechargement) — contrairement aux effets, créés une seule fois au chargement de la page.
        async function saveSceneBackground() {
            const scene = sceneByKey(currentKey);
            const background = {
                mode: document.getElementById('bgMode').value,
                color: document.querySelector('.se-bg-color[data-field="color"]').value,
                color2: document.querySelector('.se-bg-color[data-field="color2"]').value
            };
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/scenes/' + scene.key,
                jsonBody('PATCH', { background }));
            if (res) {
                scene.background = background;
                toast('Fond enregistré.');
                renderSceneTab();
            }
        }

        function msgListHtml(field, title, items) {
            return \`<h4 style="margin:var(--space-4) 0 var(--space-2); font-size:12px; color:var(--text-muted);">\${title}</h4>
                <div id="msgList_\${field}">\${items.map((m) => msgRowHtml(field, m)).join('')}</div>
                <button type="button" class="btn btn-sm se-msg-add" data-field="\${field}">+ Ajouter un message</button>\`;
        }

        function msgRowHtml(field, value) {
            return \`<div class="se-msg-row" data-field="\${field}">
                <input type="text" class="se-msg-input" value="\${esc(value)}">
                <button type="button" class="btn btn-ghost btn-sm se-msg-remove" title="Supprimer">✕</button>
            </div>\`;
        }

        // Sauvegarde toujours le tableau ENTIER, reconstitué depuis l'ordre actuel des lignes du
        // DOM (remplacement côté API, pas de fusion par index — voir profiles.js).
        async function saveMsgList(field) {
            const container = document.getElementById('msgList_' + field);
            const values = Array.from(container.querySelectorAll('.se-msg-input')).map((el) => el.value);
            const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/pause-messages',
                jsonBody('PATCH', { [field]: values }));
            if (res) {
                PAUSE[field] = values.map((v) => v.trim()).filter(Boolean);
                toast('Messages enregistrés.');
            }
        }

        const scenePropsEl = document.getElementById('sceneProps');
        scenePropsEl.addEventListener('focusout', (e) => {
            if (e.target.closest('.se-msg-input')) saveMsgList(e.target.closest('.se-msg-row').dataset.field);
        });
        scenePropsEl.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.se-msg-remove');
            if (removeBtn) {
                const field = removeBtn.closest('.se-msg-row').dataset.field;
                removeBtn.closest('.se-msg-row').remove();
                saveMsgList(field);
                return;
            }
            const addBtn = e.target.closest('.se-msg-add');
            if (addBtn) {
                const field = addBtn.dataset.field;
                const container = document.getElementById('msgList_' + field);
                container.insertAdjacentHTML('beforeend', msgRowHtml(field, ''));
                container.lastElementChild.querySelector('.se-msg-input').focus();
            }
        });
        scenePropsEl.addEventListener('change', async (e) => {
            const themeInput = e.target.closest('.se-theme-color');
            if (themeInput) {
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/theme/' + currentKey,
                    jsonBody('PATCH', { [themeInput.dataset.field]: themeInput.value }));
                if (res) {
                    THEMES[currentKey] = { ...(THEMES[currentKey] || {}), [themeInput.dataset.field]: themeInput.value };
                    toast('Couleur enregistrée.');
                }
                return;
            }
            if (e.target.closest('#bgMode') || e.target.closest('.se-bg-color')) {
                await saveSceneBackground();
                return;
            }
            const fxInput = e.target.closest('.se-fx-check');
            if (fxInput) {
                const scene = sceneByKey(currentKey);
                const res = await callApi('/api/profiles/' + ACTIVE_PROFILE_ID + '/scenes/' + scene.key,
                    jsonBody('PATCH', { effects: { [fxInput.dataset.field]: fxInput.checked } }));
                if (res) {
                    scene.effects = { ...(scene.effects || {}), [fxInput.dataset.field]: fxInput.checked };
                    toast('Effet ' + (fxInput.checked ? 'activé' : 'désactivé') + '.');
                    // Les effets sont créés une seule fois au chargement de la page (comme les
                    // réglages d'animations globaux) — recharger l'aperçu pour les voir.
                    reloadScene();
                }
            }
        });

        // ---------- Onglets du panneau droit ----------
        document.querySelectorAll('.se-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.se-tab').forEach((b) => b.classList.toggle('active', b === btn));
                document.querySelectorAll('.se-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tab === btn.dataset.tab));
            });
        });

        // Entrée = valider (défocaliser) dans tous les champs texte de l'éditeur.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('.se-prop-text, .se-static-text, .se-msg-input, #sceneNameInput')) {
                e.preventDefault();
                e.target.blur();
            }
        });

        // ---------- Barre d'outils : aperçus d'alertes/chat dans l'iframe ----------
        // postMessage direct vers l'aperçu (géré par scene-editor-bridge.js) — contrairement à la
        // page /tests, rien n'est diffusé par WebSocket : les overlays ouverts dans OBS ne
        // voient pas ces événements de démonstration.
        document.querySelectorAll('.se-toolbar-btn[data-test]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'scene-preview-event', kind: btn.dataset.test }, '*');
                }
            });
        });

        // ---------- Barre d'outils : centrage rapide de la source sélectionnée ----------
        // Le calcul (largeur/hauteur réelles de l'élément, zoom éventuel...) ne peut se faire que
        // dans l'iframe — le parent se contente de demander l'axe, comme pour les aperçus
        // d'alertes ci-dessus. La réponse ('scene-element-moved') est traitée par le handler déjà
        // en place plus haut (window.addEventListener('message', ...)), donc l'enregistrement et
        // la resynchro suivent le même chemin qu'un drag classique.
        function centerSelected(axis) {
            if (!selectedId || !frame.contentWindow) return;
            frame.contentWindow.postMessage({ type: 'scene-center-element', elementId: selectedId, axis }, '*');
        }
        document.getElementById('btnCenterH').addEventListener('click', () => centerSelected('x'));
        document.getElementById('btnCenterV').addEventListener('click', () => centerSelected('y'));

        fitCanvas();
        loadScene('starting');
    </script>
</body>
</html>
`;

module.exports = createSceneEditorRoutes;
