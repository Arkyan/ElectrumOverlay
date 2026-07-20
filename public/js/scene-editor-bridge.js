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
            /* Certains éléments (.alert-container) ont overflow:hidden pour l'usage normal (crop
               du média héro) — en mode édition uniquement, on force overflow:visible pour que les
               poignées de redimensionnement (qui dépassent volontairement de la boîte, voir
               .scene-resize-handle plus bas) ne soient jamais clippées/non cliquables. */
            [data-scene-el] { overflow: visible !important; }
            /* .overlay (starting/pause/ending) est une boîte plein écran (width/height:100%,
               z-index:1) qui centre le titre — ses frères (horloge, indicateur de pause,
               bannières...) ont un z-index:auto, donc plus bas dans l'empilement : .overlay
               intercepte alors TOUS les clics sur l'écran, même là où il n'affiche rien à cet
               endroit (le hit-testing suit l'ordre d'empilement de la boîte, pas le contenu visible
               en dessous). Sans ce pointer-events:none, l'horloge/les bannières etc. ne reçoivent
               jamais leur pointerdown — d'où l'impossibilité de les déplacer/redimensionner alors
               que la même logique fonctionne pour les éléments qui ne sont pas sous .overlay
               (chat, panneau gauche, bandeau bas...). [data-scene-el] réactive explicitement les
               clics pour celui de ses descendants qui doit rester déplaçable (titleBlock). */
            .overlay { pointer-events: none; }
            [data-scene-el] { pointer-events: auto; }
            .scene-el-label {
                position: absolute; top: -22px; left: 0;
                background: #111827; color: #fff; font: 600 11px/1.4 -apple-system, sans-serif;
                padding: 2px 7px; border-radius: 4px; white-space: nowrap; pointer-events: none;
                z-index: 999999;
            }
            .scene-resize-handle {
                /* À cheval sur le bord (centrée dessus via l'offset négatif = -moitié de sa
                   propre taille totale 18px), jamais posée entièrement à l'intérieur : sur un
                   petit élément (ex: l'horloge, ~130x44px), une poignée "inside" à quelques px du
                   bord se retrouvait à moins de sa propre hauteur du centre vertical de la boîte,
                   donc superposée à la poignée d'axe (both vs x/y qui se chevauchaient de ~50%,
                   rendant impossible de cliquer la bonne poignée, voire bloquant le drag du corps
                   de l'élément lui-même). Centrer sur le bord donne un écartement qui ne dépend
                   plus de la taille de la boîte. */
                position: absolute;
                width: 14px; height: 14px; border-radius: 3px;
                background: #22d3ee; border: 2px solid #0b0d12;
                z-index: 1000000;
            }
            .scene-resize-handle:hover, .scene-resize-handle.scene-resizing { background: #67e8f9; }
            .scene-resize-both { right: -9px; bottom: -9px; cursor: nwse-resize; }
            .scene-resize-x { right: -9px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
            .scene-resize-y { bottom: -9px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
        `;
        document.head.appendChild(style);
    }

    // Plusieurs éléments se centrent via une transform self-référentielle (ex: .alert-container
    // en translate(-50%,-50%), .back-soon-banner/.waiting-indicator en left:50%;
    // transform:translateX(-50%)) : leur `left`/`top` CSS ne désigne donc pas leur coin haut-gauche
    // visuel réel, contrairement aux autres éléments. On ne touche jamais `transform` (les
    // animations d'entrée/sortie ou de pulsation en dépendent), donc on compense génériquement en
    // lisant le décalage (tx,ty) déjà appliqué par la transform courante (peu importe laquelle) :
    // le vrai coin haut-gauche "si la transform était neutre" = rect - (tx,ty). Sans ça, réappliquer
    // ce même rect.left en `left` en gardant la transform active provoque un DOUBLE décalage (ex:
    // -50% une fois pour le centrage CSS, une deuxième fois car on repart de la position déjà
    // décalée) — visible comme un saut d'un cran dès le clic initial.
    function getTransformOffset(el) {
        const transform = getComputedStyle(el).transform;
        if (!transform || transform === 'none') return { tx: 0, ty: 0 };
        const m3d = transform.match(/^matrix3d\(([^)]+)\)$/);
        if (m3d) {
            const p = m3d[1].split(',').map(Number);
            return { tx: p[12] || 0, ty: p[13] || 0 };
        }
        const m2d = transform.match(/^matrix\(([^)]+)\)$/);
        if (m2d) {
            const p = m2d[1].split(',').map(Number);
            return { tx: p[4] || 0, ty: p[5] || 0 };
        }
        return { tx: 0, ty: 0 };
    }

    function referencePoint(el) {
        const rect = el.getBoundingClientRect();
        const { tx, ty } = getTransformOffset(el);
        return { left: rect.left - tx, top: rect.top - ty };
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
        let initialFontSize = 0;

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation(); // ne pas déclencher aussi le drag du parent
            resizing = true;
            handle.classList.add('scene-resizing');
            handle.setPointerCapture(e.pointerId);
            // Fige une éventuelle animation CSS infinie sur l'élément (ex: .back-soon-banner
            // pulse aussi en scale) le temps du drag — sinon son transform continue d'osciller
            // par-dessus le width/height qu'on fixe ici, provoquant un tremblement visuel.
            el.style.animationPlayState = 'paused';

            const rect = el.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            initialWidth = rect.width;
            initialHeight = rect.height;
            initialFontSize = parseFloat(getComputedStyle(el).fontSize);
        });

        handle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            // Lève max-width/max-height (ex: .alert-container a max-width:600px) pour que le
            // retour visuel pendant le drag ne soit pas silencieusement plafonné par le CSS.
            if (el.dataset.sceneScaleText !== undefined) {
                // Badge à contenu fixe : la boîte se redimensionne librement (axes indépendants,
                // comme les autres éléments) mais la police suit en direct pour ne pas "sauter" une
                // fois le drag terminé (quand applyLayoutFromConfig() applique le rendu final, voir
                // overlay-common.js) — même calcul reproduit ici : le plus petit des deux ratios
                // connus (uniquement l'axe glissé si un seul l'est), pour ne jamais déborder de la
                // dimension la plus contraignante. Le placement (centrage) est géré par le CSS
                // flex de ces badges, pas par ce script.
                let newWidth = initialWidth, newHeight = initialHeight;
                let widthRatio = null, heightRatio = null;
                // initialWidth/Height viennent de getBoundingClientRect() (boîte de bordure) —
                // sans box-sizing:border-box, `width`/`height` ne fixeraient que le contenu et le
                // padding fixe s'ajouterait par-dessus, faussant le calcul de ratio (voir la même
                // note dans applyLayoutFromConfig(), overlay-common.js, pour le rendu final).
                el.style.boxSizing = 'border-box';
                if (axis === 'x' || axis === 'both') {
                    el.style.maxWidth = 'none';
                    newWidth = Math.max(MIN_SIZE_PX, initialWidth + (e.clientX - startX));
                    el.style.width = newWidth + 'px';
                    widthRatio = newWidth / initialWidth;
                }
                if (axis === 'y' || axis === 'both') {
                    el.style.maxHeight = 'none';
                    newHeight = Math.max(MIN_SIZE_PX, initialHeight + (e.clientY - startY));
                    el.style.height = newHeight + 'px';
                    heightRatio = newHeight / initialHeight;
                }
                const scale = (widthRatio !== null && heightRatio !== null)
                    ? Math.min(widthRatio, heightRatio)
                    : (widthRatio ?? heightRatio);
                el.style.fontSize = Math.max(8, initialFontSize * scale) + 'px';
                return;
            }
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
            el.style.animationPlayState = '';

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
            // Fige une éventuelle animation CSS infinie (ex: .back-soon-banner/.waiting-indicator
            // pulsent aussi en scale) le temps du drag — sinon son transform continue d'osciller
            // par-dessus le left/top qu'on fixe ici, provoquant un tremblement visuel.
            el.style.animationPlayState = 'paused';
            const ref = referencePoint(el);
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
            el.style.animationPlayState = '';
            const ref = referencePoint(el);
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
