/**
 * Pont d'édition de scène — rend les éléments marqués [data-scene-el] déplaçables (Pointer Events
 * + setPointerCapture, pour ne pas perdre le drag quand le curseur sort visuellement du petit
 * aperçu réduit dans /scene-editor). L'édition de TEXTE ne se fait plus sur l'aperçu (les
 * animations — glow, typing, shine... — gênent le clic précis) : ce script se contente de
 * remonter la liste des textes éditables et leur valeur actuelle au parent, qui affiche les champs
 * dans sa sidebar (voir sceneEditor.js). Communique avec la page parente (/scene-editor, dans une
 * iframe) par postMessage UNIQUEMENT pour le drag — masquer/afficher, réinitialiser, éditer un
 * texte, ajouter/supprimer un texte custom sont initiés par le parent et se propagent
 * automatiquement via le flux WebSocket 'config-updated' déjà utilisé par tout le reste de la
 * config (voir applyLayoutFromConfig/applyTextOverridesFromConfig/renderCustomTextsFromConfig
 * dans overlay-common.js) — aucune commande parent→iframe n'est donc nécessaire ici.
 *
 * N'a AUCUN effet si la page est ouverte normalement (OBS, navigateur direct) : tout le script est
 * un no-op tant que ?sceneEditor=1 n'est pas présent dans l'URL — sans danger à charger sur toutes
 * les pages overlay en permanence, comme app-titlebar.js pour l'admin Electron.
 */
(function () {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('sceneEditor') !== '1') return;

    // Libellés humains pour les éléments/textes connus — un id absent de ces listes reste
    // affichable (repli sur l'id brut), au cas où un nouveau data-scene-el/data-scene-text serait
    // ajouté sans mettre à jour ces listes.
    const LABELS = {
        chatPanel: 'Chat',
        leftPanel: 'Panneau gauche',
        bottomBar: 'Bandeau bas',
        alertContainer: 'Alertes',
        titleBlock: 'Titre / texte principal',
        waitingIndicator: "Indicateur d'attente",
        streamStats: 'Statistiques',
        pauseIndicator: 'Indicateur de pause',
        realTimeClock: 'Horloge',
        backSoonBanner: 'Bannière « de retour »',
        viewersWaiting: 'Viewers en attente'
    };

    const TEXT_LABELS = {
        startingTitle: 'Titre',
        startingSubtitle: 'Sous-titre',
        endingTitle: 'Titre',
        endingSubtitle: 'Sous-titre',
        endingThanks: 'Message de remerciement',
        pauseTitle: 'Titre',
        pauseSubtitle: 'Sous-titre',
        pauseIndicatorLabel: 'Étiquette indicateur de pause',
        backSoonText: 'Texte bannière « de retour »',
        viewersWaitingLabel: "Étiquette viewers en attente",
        chatHeaderLabel: 'En-tête du chat',
        leftPanelTitle1: 'Titre section 1 (panneau gauche)',
        leftPanelTitle2: 'Titre section 2 (panneau gauche)',
        leftPanelTitle3: 'Titre section 3 (panneau gauche)'
    };

    let styleInjected = false;
    function injectStyle() {
        if (styleInjected) return;
        styleInjected = true;
        const style = document.createElement('style');
        style.textContent = `
            [data-scene-el] { outline: 2px dashed rgba(34, 211, 238, 0.7); cursor: move; touch-action: none; }
            [data-scene-el].scene-dragging { outline-color: #22d3ee; outline-style: solid; }
            .scene-el-label {
                position: absolute; top: -22px; left: 0;
                background: #111827; color: #fff; font: 600 11px/1.4 -apple-system, sans-serif;
                padding: 2px 7px; border-radius: 4px; white-space: nowrap; pointer-events: none;
                z-index: 999999;
            }
            .scene-resize-handle {
                /* En positif (pas en négatif) : certains éléments (.alert-container) ont
                   overflow:hidden, qui clipperait/rendrait la poignée non cliquable si elle
                   dépassait de la boîte. */
                position: absolute;
                width: 14px; height: 14px; border-radius: 3px;
                background: #22d3ee; border: 2px solid #0b0d12;
                z-index: 1000000;
            }
            .scene-resize-handle:hover, .scene-resize-handle.scene-resizing { background: #67e8f9; }
            .scene-resize-both { right: 2px; bottom: 2px; cursor: nwse-resize; }
            .scene-resize-x { right: 2px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
            .scene-resize-y { bottom: 2px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
        `;
        document.head.appendChild(style);
    }

    // .alert-container se centre via transform: translate(-50%, -50%) (voir overlay-common.css) —
    // top/left y désignent donc le CENTRE de l'élément, pas son coin haut-gauche comme pour les
    // autres. On ne touche jamais `transform` (l'animation d'entrée/sortie des alertes en dépend),
    // donc on compense ici pour que le point déplacé corresponde à ce que applyLayoutFromConfig()
    // réappliquera ensuite (voir overlay-common.js).
    function referencePoint(el, id) {
        const rect = el.getBoundingClientRect();
        if (id === 'alertContainer') {
            return { left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 };
        }
        return { left: rect.left, top: rect.top };
    }

    function addLabel(el, text) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const badge = document.createElement('div');
        badge.className = 'scene-el-label';
        badge.textContent = text;
        el.appendChild(badge);
    }

    // Poignées de redimensionnement : posent width/height en dur (jamais transform:scale, qui
    // étirerait visuellement le texte/les icônes plutôt que de leur donner plus d'espace).
    // axis='both' (coin) fait varier les deux indépendamment (redimensionnement libre, pas
    // verrouillé en proportions) ; axis='x'/'y' (bords) ne touchent qu'une seule dimension — c'est
    // ce qui permet un redimensionnement horizontal ou vertical seul en plus du général. Pour
    // .alert-container, translate(-50%,-50%) est relatif à sa propre taille : le centrage reste
    // donc correct automatiquement, sans calcul de point de référence particulier ici.
    const MIN_SIZE_PX = 24;

    function addResizeHandle(el, id, axis) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const handle = document.createElement('div');
        handle.className = 'scene-resize-handle scene-resize-' + axis;
        el.appendChild(handle);

        let resizing = false;
        let startX = 0;
        let startY = 0;
        let initialWidth = 0;
        let initialHeight = 0;

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation(); // ne pas déclencher aussi le drag du parent
            resizing = true;
            handle.classList.add('scene-resizing');
            handle.setPointerCapture(e.pointerId);

            const rect = el.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            initialWidth = rect.width;
            initialHeight = rect.height;
        });

        handle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            // Lève max-width/max-height (ex: .alert-container a max-width:600px) pour que le
            // retour visuel pendant le drag ne soit pas silencieusement plafonné par le CSS.
            if (axis === 'x' || axis === 'both') {
                el.style.maxWidth = 'none';
                el.style.width = Math.max(MIN_SIZE_PX, initialWidth + (e.clientX - startX)) + 'px';
            }
            if (axis === 'y' || axis === 'both') {
                el.style.maxHeight = 'none';
                el.style.height = Math.max(MIN_SIZE_PX, initialHeight + (e.clientY - startY)) + 'px';
            }
        });

        function endResize(e) {
            if (!resizing) return;
            resizing = false;
            handle.classList.remove('scene-resizing');
            try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }

            const rect = el.getBoundingClientRect();
            const payload = { type: 'scene-element-resized', elementId: id };
            if (axis === 'x' || axis === 'both') payload.width = (rect.width / window.innerWidth) * 100;
            if (axis === 'y' || axis === 'both') payload.height = (rect.height / window.innerHeight) * 100;
            window.parent.postMessage(payload, '*');
        }

        handle.addEventListener('pointerup', endResize);
        handle.addEventListener('pointercancel', endResize);
    }

    function makeDraggable(el, id) {
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;

        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            el.setPointerCapture(e.pointerId);
            el.classList.add('scene-dragging');
            const ref = referencePoint(el, id);
            startX = e.clientX;
            startY = e.clientY;
            originLeft = ref.left;
            originTop = ref.top;
            // Neutralise l'ancrage d'origine (right/bottom) dès le premier drag pour que le
            // déplacement soit prévisible immédiatement — sans jump grâce à referencePoint() qui
            // tient déjà compte de la transform de centrage éventuelle.
            el.style.position = 'fixed';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.left = originLeft + 'px';
            el.style.top = originTop + 'px';
        });

        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            el.style.left = (originLeft + (e.clientX - startX)) + 'px';
            el.style.top = (originTop + (e.clientY - startY)) + 'px';
        });

        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('scene-dragging');
            try { el.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }
            const ref = referencePoint(el, id);
            const top = (ref.top / window.innerHeight) * 100;
            const left = (ref.left / window.innerWidth) * 100;
            el.style.top = top + 'vh';
            el.style.left = left + 'vw';
            window.parent.postMessage({ type: 'scene-element-moved', elementId: id, top, left }, '*');
        }

        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
    }

    function wireStaticElements() {
        document.querySelectorAll('[data-scene-el]').forEach((el) => {
            const id = el.dataset.sceneEl;
            if (id.startsWith('custom:')) return; // gérés par wireCustomTexts()
            addLabel(el, LABELS[id] || id);
            makeDraggable(el, id);
            addResizeHandle(el, id, 'both');
            addResizeHandle(el, id, 'x');
            addResizeHandle(el, id, 'y');
        });
    }

    // Les éléments texte "custom" sont recréés en entier par renderCustomTextsFromConfig() à
    // chaque config-updated (voir overlay-common.js) : on les re-câble (drag + resize) à chaque
    // fois via cet événement plutôt qu'une seule fois au chargement.
    function wireCustomTexts() {
        document.querySelectorAll('[data-scene-custom-text]').forEach((el) => {
            const id = el.dataset.sceneEl; // "custom:<uuid>"
            addLabel(el, 'Texte');
            makeDraggable(el, id);
            addResizeHandle(el, id, 'both');
            addResizeHandle(el, id, 'x');
            addResizeHandle(el, id, 'y');
        });
    }

    function reportReady() {
        const elements = Array.from(document.querySelectorAll('[data-scene-el]')).map((el) => {
            const id = el.dataset.sceneEl;
            const isCustom = id.startsWith('custom:');
            return {
                id,
                label: isCustom ? 'Texte' : (LABELS[id] || id),
                isCustom,
                hidden: getComputedStyle(el).display === 'none',
                // .textContent inclurait aussi le badge d'étiquette ajouté par addLabel() (enfant
                // DOM du même élément) — data-text-value reste la copie propre du vrai texte,
                // posée par renderCustomTextsFromConfig() dans overlay-common.js.
                text: isCustom ? (el.dataset.textValue ?? '') : undefined
            };
        });

        // Textes statiques du HTML (titres, sous-titres, en-têtes...) — édités depuis la sidebar,
        // pas sur l'aperçu. Les textes custom sont déjà couverts ci-dessus (dans `elements`).
        // Le HTML source de certains textes est indenté sur plusieurs lignes (mise en forme du
        // fichier) : on aplatit les espaces/retours à la ligne pour un champ éditable propre.
        const texts = Array.from(document.querySelectorAll('[data-scene-text]:not([data-scene-custom-text])')).map((el) => {
            const textId = el.dataset.sceneText;
            return { textId, label: TEXT_LABELS[textId] || textId, value: el.textContent.trim().replace(/\s+/g, ' ') };
        });

        window.parent.postMessage({ type: 'scene-editor-ready', elements, texts }, '*');
    }

    function init() {
        injectStyle();
        wireStaticElements();
        wireCustomTexts();
        reportReady();
        window.addEventListener('scene-custom-texts-rendered', () => {
            wireCustomTexts();
            reportReady();
        });
    }

    if (document.readyState === 'complete') {
        setTimeout(init, 50);
    } else {
        window.addEventListener('load', () => setTimeout(init, 50));
    }
})();
