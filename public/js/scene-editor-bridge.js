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

    // Éléments ajoutés depuis l'éditeur (voir renderCustomTextsFromConfig dans overlay-common.js).
    const CUSTOM_TYPE_LABELS = {
        text: 'Texte',
        image: 'Image',
        box: 'Boîte',
        clock: 'Horloge',
        chat: 'Chat',
        alerts: 'Alertes',
        spotify: 'Spotify',
        keys: 'Touches'
    };

    function customLabel(el) {
        return CUSTOM_TYPE_LABELS[el.dataset.customType] || 'Texte';
    }

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
            /* Aligne le color-scheme sur celui de l'éditeur hôte (dark, app-ui.css) : quand les
               color-scheme de l'iframe et de la page hôte diffèrent, Chrome remplace la
               transparence par un fond opaque blanc — les pages transparentes (En direct, scènes
               personnalisées) perdaient leur fond noir d'aperçu. Sans effet hors éditeur. */
            :root { color-scheme: dark; }
            /* --scene-inv-zoom = 1/zoom, posée par setInverseZoomVar() (overlay-common.js) sur tout
               élément dont l'échelle applique un CSS zoom. Le zoom multiplie TOUTES les longueurs
               de l'élément, décorations d'édition comprises : sans compensation, le cadre, son
               étiquette et les poignées grossissaient avec l'échelle (à 400%, pointillé de 8px et
               étiquette démesurée). Chaque longueur de ces décorations est donc divisée par le zoom
               pour garder une taille visuelle constante quelle que soit l'échelle. La valeur de
               repli 1 couvre les éléments sans échelle (aucune variable posée). */
            [data-scene-el] {
                outline: calc(2px * var(--scene-inv-zoom, 1)) dashed rgba(34, 211, 238, 0.7);
                cursor: move; touch-action: none;
            }
            /* Zones d'alertes : en édition on montre le CADRE (là où les alertes peuvent
               apparaître), pas une fausse alerte — display:flex force la zone visible malgré son
               display:none de repos (un masquage à l'œil reste prioritaire : il est posé en
               inline !important, voir applyLayoutFromConfig/renderCustomTextsFromConfig). La
               vraie boîte d'alerte reste cachée tant qu'une alerte d'aperçu ne joue pas (.show,
               déclenchée par la barre d'outils de l'éditeur). */
            /* opacity forcée : la zone est à opacity:0 au repos (fondu des alertes) — en édition
               le cadre doit rester visible en permanence. Conséquence assumée : les alertes
               d'aperçu n'ont pas de fondu entrée/sortie ici (leurs mouvements restent). */
            [data-scene-alert-zone] { display: flex !important; opacity: 1 !important; background: rgba(244, 114, 182, 0.07); }
            /* Widget Spotify : masqué en usage normal tant qu'aucune musique ne joue réellement
               (voir applySpotifyTrackTo dans overlay-common.js) — en édition il doit rester
               visible/positionnable même à l'arrêt, fillWidgetPreview() y affiche alors un exemple. */
            [data-custom-type="spotify"] { display: flex !important; }
            [data-scene-alert-zone]:not(.show) .alert-box { display: none !important; }
            [data-scene-alert-zone]:not(.show)::after {
                content: "Zone d'alerte — l'alerte s'y ajuste au plus grand";
                color: rgba(255, 255, 255, 0.75);
                font: 600 15px/1.4 Inter, sans-serif;
                text-align: center;
                padding: 0 12px;
            }
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
                position: absolute; top: calc(-22px * var(--scene-inv-zoom, 1)); left: 0;
                background: #111827; color: #fff;
                font-family: -apple-system, sans-serif; font-weight: 600; line-height: 1.4;
                font-size: calc(11px * var(--scene-inv-zoom, 1));
                padding: calc(2px * var(--scene-inv-zoom, 1)) calc(7px * var(--scene-inv-zoom, 1));
                border-radius: calc(4px * var(--scene-inv-zoom, 1));
                white-space: nowrap; pointer-events: none;
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
                width: calc(14px * var(--scene-inv-zoom, 1));
                height: calc(14px * var(--scene-inv-zoom, 1));
                border-radius: calc(3px * var(--scene-inv-zoom, 1));
                background: #22d3ee; border: calc(2px * var(--scene-inv-zoom, 1)) solid #0b0d12;
                z-index: 1000000;
            }
            .scene-resize-handle:hover, .scene-resize-handle.scene-resizing { background: #67e8f9; }
            .scene-resize-both {
                right: calc(-9px * var(--scene-inv-zoom, 1));
                bottom: calc(-9px * var(--scene-inv-zoom, 1));
                cursor: nwse-resize;
            }
            .scene-resize-x {
                right: calc(-9px * var(--scene-inv-zoom, 1));
                top: 50%; transform: translateY(-50%); cursor: ew-resize;
            }
            .scene-resize-y {
                bottom: calc(-9px * var(--scene-inv-zoom, 1));
                left: 50%; transform: translateX(-50%); cursor: ns-resize;
            }
            /* Repères d'aimantation (centre de l'écran OU bords du cadre — voir setSnapGuides) :
               leur position (left/top) est posée dynamiquement en JS selon la ligne qui accroche
               réellement, ce CSS ne fixe que leur épaisseur/apparence. */
            .scene-snap-guide {
                position: fixed; background: #f472b6; pointer-events: none; z-index: 2000000;
                display: none; box-shadow: 0 0 6px rgba(244, 114, 182, 0.8);
            }
            .scene-snap-guide.visible { display: block; }
            .scene-snap-guide-v { top: 0; bottom: 0; width: 2px; margin-left: -1px; }
            .scene-snap-guide-h { left: 0; right: 0; height: 2px; margin-top: -1px; }
        `;
        document.head.appendChild(style);
    }

    // Aimantation au centre horizontal/vertical de l'écran pendant le drag (comme les guides
    // "smart" de PowerPoint/Figma) : quand le CENTRE de l'élément déplacé passe à proximité du
    // centre de l'écran sur un axe, sa position se cale exactement dessus le temps du survol —
    // pratique pour centrer une source sans calcul manuel. Seuil en px du canvas iframe
    // (1920x1080, fixe quelle que soit l'échelle d'aperçu — voir zoomOf) : une distance à l'écran
    // toujours proportionnelle à la taille réelle du rendu OBS, pas à la fenêtre d'édition.
    const CENTER_SNAP_THRESHOLD = 16;

    let snapGuideV = null;
    let snapGuideH = null;
    // posV/posH : position ÉCRAN (px canvas) où placer le repère, ou null pour le masquer — la
    // ligne peut désormais matérialiser n'importe laquelle des lignes d'aimantation (centre OU
    // un bord du cadre), pas seulement le centre, d'où la position dynamique plutôt qu'un fixe
    // left/top:50% en CSS.
    function setSnapGuides(posV, posH) {
        if (!snapGuideV) {
            snapGuideV = document.createElement('div');
            snapGuideV.className = 'scene-snap-guide scene-snap-guide-v';
            snapGuideH = document.createElement('div');
            snapGuideH.className = 'scene-snap-guide scene-snap-guide-h';
            document.body.appendChild(snapGuideV);
            document.body.appendChild(snapGuideH);
        }
        snapGuideV.classList.toggle('visible', posV !== null);
        if (posV !== null) snapGuideV.style.left = posV + 'px';
        snapGuideH.classList.toggle('visible', posH !== null);
        if (posH !== null) snapGuideH.style.top = posH + 'px';
    }

    /**
     * Calcule l'aimantation sur UN axe : `start` est la position visuelle du coin (left ou top)
     * actuellement visée, `size` la largeur/hauteur de l'élément sur cet axe, `guides` la liste
     * des lignes auxquelles il peut s'accrocher sur cet axe (centre de l'écran ET les deux bords
     * du cadre — voir CANVAS_GUIDES_X/Y). Trois points de l'élément peuvent s'accrocher
     * indépendamment à CHACUNE de ces lignes — son bord de DÉBUT (gauche/haut), son bord de FIN
     * (droite/bas), ou son CENTRE — chacun avec son propre calage de `start` en résultant. Sans
     * ça, seul un déplacement qui amène le CENTRE de l'élément près de l'axe s'accrochait : un
     * grand élément (chat, panneaux...) ne semblait jamais aimanté tant qu'on ne visait pas
     * précisément son milieu, ce qui donnait l'impression que seuls certains côtés "marchaient".
     * N'est qu'une AIMANTATION, pas un mur dur : rien n'empêche de continuer à tirer au-delà du
     * seuil pour, par exemple, sortir volontairement un élément du cadre — comme pour le centre.
     * Retourne le `start` ajusté et la ligne retenue (pour positionner le repère visuel), ou
     * `start` inchangé si rien n'accroche.
     */
    function snapAxis(start, size, guides, threshold) {
        const candidates = [start, start + size, start + size / 2];
        let best = null;
        let bestDist = Infinity;
        for (const guide of guides) {
            for (const value of candidates) {
                const dist = Math.abs(value - guide);
                if (dist <= threshold && dist < bestDist) {
                    bestDist = dist;
                    best = { start: start + (guide - value), guide };
                }
            }
        }
        return best === null ? { snapped: false, start, guide: null } : { snapped: true, start: best.start, guide: best.guide };
    }

    /**
     * Aimantation pendant un REDIMENSIONNEMENT : même principe que snapAxis (bord de début, bord
     * de fin, centre — comparés aux mêmes lignes que le drag), mais adapté au fait qu'on fait
     * varier une TAILLE, pas une position. Complication propre au redimensionnement : pour un
     * élément ancré normalement (gauche/haut fixes), seul le bord opposé (droite/bas) bouge quand
     * la taille change ; mais pour un élément à transform auto-centrante (ex: .alert-container en
     * translate(-50%,-50%)), LES DEUX bords bougent symétriquement (la taille grandit "des deux
     * côtés" autour du centre, qui lui reste fixe). Plutôt que supposer l'un ou l'autre
     * comportement, on le MESURE empiriquement : `nearBefore/farBefore` et `nearAfter/farAfter`
     * sont les positions du bord de début/fin avant et après avoir appliqué un changement de
     * taille test (`sizeChange`) — le rapport (delta position / delta taille) donne la pente
     * réelle de chaque bord, correcte quel que soit le mécanisme CSS, et permet de calculer
     * exactement la taille qui amènerait ce bord pile sur une ligne d'aimantation (relation
     * linéaire, donc une seule correction suffit, pas d'itération).
     */
    function snapResizeAxis(newSize, sizeChange, nearBefore, farBefore, nearAfter, farAfter, guides, threshold) {
        if (Math.abs(sizeChange) < 0.5) return { snapped: false, size: newSize, guide: null };

        const centerBefore = nearBefore + (farBefore - nearBefore) / 2;
        const centerAfter = nearAfter + (farAfter - nearAfter) / 2;
        const candidates = [
            { current: nearAfter, slope: (nearAfter - nearBefore) / sizeChange },
            { current: farAfter, slope: (farAfter - farBefore) / sizeChange },
            { current: centerAfter, slope: (centerAfter - centerBefore) / sizeChange }
        ];

        let best = null;
        let bestDist = Infinity;
        for (const guide of guides) {
            for (const c of candidates) {
                if (Math.abs(c.slope) < 0.001) continue; // ce point ne bouge pas avec la taille : rien à corriger
                const dist = Math.abs(c.current - guide);
                if (dist <= threshold && dist < bestDist) {
                    bestDist = dist;
                    best = { size: newSize + (guide - c.current) / c.slope, guide };
                }
            }
        }
        return best === null
            ? { snapped: false, size: newSize, guide: null }
            : { snapped: true, size: Math.max(MIN_SIZE_PX, best.size), guide: best.guide };
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

    // Échelle CSS zoom éventuelle (posée par applyLayoutFromConfig/renderCustomTextsFromConfig,
    // voir overlay-common.js) : Chrome multiplie par le zoom toutes les longueurs de l'élément
    // (positions ET dimensions) — les mesures getBoundingClientRect sont donc "visuelles", et
    // toute valeur écrite dans les styles doit être divisée par ce facteur pour atterrir au bon
    // endroit à l'écran.
    function zoomOf(el) {
        return parseFloat(getComputedStyle(el).zoom) || 1;
    }

    function referencePoint(el) {
        const rect = el.getBoundingClientRect();
        const { tx, ty } = getTransformOffset(el);
        // tx/ty viennent de getComputedStyle (valeurs spécifiées, non zoomées) alors que rect est
        // visuel : on les ramène en espace visuel avant de les soustraire.
        const z = zoomOf(el);
        return { left: rect.left - tx * z, top: rect.top - ty * z };
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
        let initialLeft = 0;
        let initialTop = 0;
        let initialRight = 0;
        let initialBottom = 0;
        let initialFontSize = 0;
        let resizeZoom = 1;

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
            // resizeZoom vaut toujours 1 pour les badges à texte adaptatif (data-scene-scale-text)
            // — leur "échelle" passe par la police, jamais par CSS zoom, voir applyLayoutFromConfig
            // dans overlay-common.js — diviser par ce zoom reste donc un no-op inoffensif pour eux.
            resizeZoom = zoomOf(el);
            startX = e.clientX;
            startY = e.clientY;
            initialWidth = rect.width;
            initialHeight = rect.height;
            // Bords de départ : nécessaires pour mesurer empiriquement, dans pointermove, l'effet
            // réel d'un changement de taille sur la position rendue (voir snapResizeAxis) — un
            // élément ancré normalement ne bouge que par son bord opposé, mais un élément à
            // transform auto-centrante (ex: .alert-container) bouge des DEUX côtés à la fois.
            initialLeft = rect.left;
            initialTop = rect.top;
            initialRight = rect.right;
            initialBottom = rect.bottom;
            initialFontSize = parseFloat(getComputedStyle(el).fontSize);
        });

        handle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            const scaleTextBadge = el.dataset.sceneScaleText !== undefined;
            // Lève max-width/max-height (ex: .alert-container a max-width:600px) pour que le
            // retour visuel pendant le drag ne soit pas silencieusement plafonné par le CSS.
            // Sans box-sizing:border-box, `width`/`height` ne fixeraient que le contenu (le
            // padding fixe s'ajouterait par-dessus), faussant la mesure du rect ci-dessous.
            el.style.boxSizing = 'border-box';

            // 1) Taille "brute" voulue (avant aimantation), suivant le curseur — écrite tout de
            // suite pour pouvoir mesurer où elle atterrit réellement (étape 2).
            let newWidth = initialWidth;
            let newHeight = initialHeight;
            if (axis === 'x' || axis === 'both') {
                el.style.maxWidth = 'none';
                newWidth = Math.max(MIN_SIZE_PX, initialWidth + (e.clientX - startX));
                el.style.width = (newWidth / resizeZoom) + 'px';
            }
            if (axis === 'y' || axis === 'both') {
                el.style.maxHeight = 'none';
                newHeight = Math.max(MIN_SIZE_PX, initialHeight + (e.clientY - startY));
                el.style.height = (newHeight / resizeZoom) + 'px';
            }

            // 2) Aimantation : le bord déplacé (droite pour une largeur, bas pour une hauteur) ET
            // le centre de l'élément peuvent s'accrocher aux mêmes lignes que le drag (bords du
            // cadre + centre écran) — voir snapResizeAxis pour la mesure empirique qui rend ça
            // correct même pour les éléments à transform auto-centrante. Simple aimantation, pas
            // un mur : rien n'empêche d'agrandir/rétrécir au-delà si on continue de tirer.
            const rect = el.getBoundingClientRect();
            let guideV = null;
            let guideH = null;
            if (axis === 'x' || axis === 'both') {
                const snapW = snapResizeAxis(
                    newWidth, newWidth - initialWidth,
                    initialLeft, initialRight, rect.left, rect.right,
                    [0, window.innerWidth / 2, window.innerWidth], CENTER_SNAP_THRESHOLD
                );
                if (snapW.snapped) { newWidth = snapW.size; guideV = snapW.guide; }
            }
            if (axis === 'y' || axis === 'both') {
                const snapH = snapResizeAxis(
                    newHeight, newHeight - initialHeight,
                    initialTop, initialBottom, rect.top, rect.bottom,
                    [0, window.innerHeight / 2, window.innerHeight], CENTER_SNAP_THRESHOLD
                );
                if (snapH.snapped) { newHeight = snapH.size; guideH = snapH.guide; }
            }
            setSnapGuides(guideV, guideH);

            // 3) Réécrit la taille — corrigée si une aimantation a été trouvée à l'étape 2.
            if (axis === 'x' || axis === 'both') el.style.width = (newWidth / resizeZoom) + 'px';
            if (axis === 'y' || axis === 'both') el.style.height = (newHeight / resizeZoom) + 'px';

            if (!scaleTextBadge) return;

            // Badge à contenu fixe : la police suit la taille FINALE (après aimantation) pour ne
            // pas "sauter" une fois le drag terminé (quand applyLayoutFromConfig() applique le
            // rendu final, voir overlay-common.js) — même calcul reproduit ici : le plus petit des
            // deux ratios connus (uniquement l'axe redimensionné si un seul l'est), pour ne jamais
            // déborder de la dimension la plus contraignante. Le placement (centrage) est géré par
            // le CSS flex de ces badges, pas par ce script.
            const widthRatio = (axis === 'x' || axis === 'both') ? newWidth / initialWidth : null;
            const heightRatio = (axis === 'y' || axis === 'both') ? newHeight / initialHeight : null;
            const scale = (widthRatio !== null && heightRatio !== null)
                ? Math.min(widthRatio, heightRatio)
                : (widthRatio ?? heightRatio);
            el.style.fontSize = Math.max(8, initialFontSize * scale) + 'px';
        });

        function endResize(e) {
            if (!resizing) return;
            resizing = false;
            handle.classList.remove('scene-resizing');
            try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }
            el.style.animationPlayState = '';
            setSnapGuides(null, null);

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
        let dragZoom = 1;
        el.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            // Sélection façon OBS : cliquer un élément sur l'aperçu le sélectionne aussi dans la
            // liste des sources du parent (qui affiche alors ses propriétés).
            window.parent.postMessage({ type: 'scene-element-selected', elementId: id }, '*');
            el.setPointerCapture(e.pointerId);
            el.classList.add('scene-dragging');
            // Fige une éventuelle animation CSS infinie (ex: .back-soon-banner/.waiting-indicator
            // pulsent aussi en scale) le temps du drag — sinon son transform continue d'osciller
            // par-dessus le left/top qu'on fixe ici, provoquant un tremblement visuel.
            el.style.animationPlayState = 'paused';
            const ref = referencePoint(el);
            dragZoom = zoomOf(el);
            startX = e.clientX;
            startY = e.clientY;
            originLeft = ref.left;
            originTop = ref.top;
            // Neutralise l'ancrage d'origine (right/bottom) dès le premier drag pour que le
            // déplacement soit prévisible immédiatement — sans jump grâce à referencePoint() qui
            // tient déjà compte de la transform de centrage éventuelle. Divisé par le zoom :
            // toutes les longueurs écrites sur un élément zoomé sont re-multipliées par Chrome.
            el.style.position = 'fixed';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.left = (originLeft / dragZoom) + 'px';
            el.style.top = (originTop / dragZoom) + 'px';
        });

        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const rawLeft = originLeft + (e.clientX - startX);
            const rawTop = originTop + (e.clientY - startY);

            // Écrit d'abord la position SANS aimantation, pour pouvoir mesurer la position
            // VISUELLE réellement rendue (getBoundingClientRect) avant de décider d'accrocher.
            // Indispensable pour les éléments à transform auto-centrante (ex: .alert-container en
            // translate(-50%,-50%), bannières en left:50%;translateX(-50%)) : `rawLeft` est une
            // coordonnée "neutre" qui compense déjà ce décalage (voir referencePoint()) — comparer
            // rawLeft DIRECTEMENT au centre écran comparerait donc le mauvais point, décalé d'une
            // demi-largeur/hauteur (l'aimantation semblait alors n'accrocher que via le bord
            // droit/bas). Toute la logique ci-dessous raisonne donc en pixels VISUELS (rect), puis
            // reconvertit l'ajustement trouvé en delta appliqué à rawLeft avant l'écriture finale
            // — un delta visuel se traduit 1:1 en delta de coordonnée neutre, quel que soit le
            // mécanisme de centrage CSS de l'élément.
            el.style.left = (rawLeft / dragZoom) + 'px';
            el.style.top = (rawTop / dragZoom) + 'px';
            const rect = el.getBoundingClientRect();

            // Chaque axe teste indépendamment le bord de début, le bord de fin ET le centre de
            // l'élément — pas seulement son centre — pour que l'accroche fonctionne quel que soit
            // le côté de l'élément qui approche l'axe. Lignes testées : le centre de l'écran ET
            // les deux bords du cadre (0 et innerWidth/innerHeight) — caler un élément pile sur le
            // bord de la scène évite de le laisser légèrement hors cadre par imprécision de
            // souris, sans empêcher de l'en sortir franchement si c'est voulu : il suffit de
            // continuer à tirer au-delà de la zone d'accroche, aucun mur dur.
            const snapX = snapAxis(rect.left, rect.width, [0, window.innerWidth / 2, window.innerWidth], CENTER_SNAP_THRESHOLD);
            const snapY = snapAxis(rect.top, rect.height, [0, window.innerHeight / 2, window.innerHeight], CENTER_SNAP_THRESHOLD);
            setSnapGuides(snapX.snapped ? snapX.guide : null, snapY.snapped ? snapY.guide : null);

            if (snapX.snapped) el.style.left = ((rawLeft + (snapX.start - rect.left)) / dragZoom) + 'px';
            if (snapY.snapped) el.style.top = ((rawTop + (snapY.start - rect.top)) / dragZoom) + 'px';
        });

        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('scene-dragging');
            try { el.releasePointerCapture(e.pointerId); } catch (err) { /* déjà relâché */ }
            el.style.animationPlayState = '';
            setSnapGuides(null, null);
            const ref = referencePoint(el);
            // top/left transmis (et stockés) en % VISUELS — le rendu les redivise par le zoom
            // (voir applyLayoutFromConfig/renderCustomTextsFromConfig). Reflètent déjà
            // l'éventuelle position aimantée du dernier pointermove.
            const top = (ref.top / window.innerHeight) * 100;
            const left = (ref.left / window.innerWidth) * 100;
            el.style.top = (top / dragZoom) + 'vh';
            el.style.left = (left / dragZoom) + 'vw';
            window.parent.postMessage({ type: 'scene-element-moved', elementId: id, top, left }, '*');
        }

        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
    }

    function wireStaticElements() {
        document.querySelectorAll('[data-scene-el]').forEach((el) => {
            const id = el.dataset.sceneEl;
            if (id.startsWith('custom:')) return; // gérés par wireCustomTexts()
            if (el.hasAttribute('data-scene-alert-zone')) watchAlertZoneReset(el);
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
    // Aperçu factice pour les widgets vides en usage normal — un chat vide n'est qu'un cadre
    // creux. Les zones d'alertes ne sont PAS remplies : seul leur cadre est matérialisé (voir le
    // CSS [data-scene-alert-zone] dans injectStyle) — l'alerte réelle ne s'y montre que via la
    // barre d'aperçu de l'éditeur. Uniquement en mode édition (tout ce script est un no-op sans
    // ?sceneEditor=1) : jamais visible dans OBS.
    function fillWidgetPreview(el) {
        if (el.dataset.customType === 'chat') {
            const container = el.querySelector('#chatContainer');
            if (container && container.children.length === 0) {
                container.innerHTML = [
                    ['Viewer1', 'Salut le stream !'],
                    ['Viewer2', 'GG pour la livraison'],
                    ['Viewer3', 'Exemple de message du chat']
                ].map(([name, msg]) => '<div class="chat-message"><div class="chat-username">' + name
                    + '</div><div class="chat-text">' + msg + '</div></div>').join('');
            }
        }
        if (el.dataset.customType === 'spotify') {
            // Si rien ne joue réellement (widget resté sur son état par défaut "Spotify" / "Rien
            // en cours de lecture"), affiche un exemple pour visualiser la mise en page — sans
            // toucher au widget si un vrai morceau est déjà affiché (fetchInitialSpotifyTrack ou
            // le WebSocket ont pu le peupler avant ce passage).
            const titleEl = el.querySelector('[data-spotify-title]');
            if (titleEl && titleEl.textContent === 'Spotify') {
                titleEl.textContent = 'Titre du morceau';
                const artistEl = el.querySelector('[data-spotify-artist]');
                if (artistEl) artistEl.textContent = 'Nom de l\'artiste';
                const artEl = el.querySelector('[data-spotify-art]');
                if (artEl) {
                    // 'block', pas '' : .spotify-art a display:none par défaut en CSS — un style
                    // inline vidé retomberait dessus, laissant le dégradé de substitution invisible.
                    artEl.style.display = 'block';
                    artEl.style.background = 'linear-gradient(135deg, #1db954, #191414)';
                }
            }
        }
        // Pas de cas 'keys' ici : contrairement au chat/à Spotify, le plateau clavier/souris est
        // un HUD permanent entièrement dessiné dès sa création (voir buildKeysRows() dans
        // overlay-common.js) — rien à peupler pour rester visible/positionnable en édition.
    }

    // Après une alerte, showAlert() laisse la zone avec les classes .show + .hide (le prochain
    // affichage les recycle) : nos sélecteurs :not(.show) ne re-matcheraient jamais et le cadre
    // ne réapparaîtrait pas. En édition uniquement, on remet la zone à l'état "cadre" une fois le
    // fondu de sortie terminé.
    function watchAlertZoneReset(zone) {
        if (zone.dataset.zoneResetWatched) return;
        zone.dataset.zoneResetWatched = '1';
        new MutationObserver(() => {
            if (zone.classList.contains('hide')) {
                setTimeout(() => {
                    zone.classList.remove('show', 'hide');
                    zone.style.opacity = '';
                }, 700);
            }
        }).observe(zone, { attributes: true, attributeFilter: ['class'] });
    }

    function wireCustomTexts() {
        document.querySelectorAll('[data-scene-custom-text]').forEach((el) => {
            const id = el.dataset.sceneEl; // "custom:<uuid>"
            fillWidgetPreview(el);
            if (el.dataset.sceneAlertZone) watchAlertZoneReset(el);
            addLabel(el, customLabel(el));
            makeDraggable(el, id);
            // Plateau clavier/souris : taille purement intrinsèque (contenu en px fixes × échelle,
            // voir renderCustomTextsFromConfig) — il n'a donc pas de poignées, l'échelle (%) dans
            // le panneau de propriétés est son seul réglage de taille. En laisser aurait écrit une
            // largeur/hauteur désormais ignorée au rendu : redimensionnement sans aucun effet.
            if (el.dataset.customType !== 'keys') {
                addResizeHandle(el, id, 'both');
                addResizeHandle(el, id, 'x');
                addResizeHandle(el, id, 'y');
            }
        });
    }

    function reportReady() {
        const elements = Array.from(document.querySelectorAll('[data-scene-el]')).map((el) => {
            const id = el.dataset.sceneEl;
            const isCustom = id.startsWith('custom:');
            return {
                id,
                label: isCustom ? customLabel(el) : (LABELS[id] || id),
                isCustom,
                customType: isCustom ? (el.dataset.customType || 'text') : undefined,
                hidden: getComputedStyle(el).display === 'none',
                // .textContent inclurait aussi le badge d'étiquette ajouté par addLabel() (enfant
                // DOM du même élément) — data-text-value (et url/color) restent les copies propres
                // des vraies valeurs, posées par renderCustomTextsFromConfig() dans overlay-common.js.
                text: isCustom ? (el.dataset.textValue ?? '') : undefined,
                url: isCustom ? (el.dataset.urlValue ?? '') : undefined,
                color: isCustom ? (el.dataset.colorValue ?? '') : undefined,
                // Style exposé par exposeStyleProps() (overlay-common.js) — '' = pas d'override.
                size: isCustom && el.dataset.propSize ? parseFloat(el.dataset.propSize) : undefined,
                font: isCustom ? (el.dataset.propFont || '') : undefined,
                glow: isCustom ? el.dataset.propGlow === '1' : undefined,
                radius: isCustom && el.dataset.propRadius ? parseFloat(el.dataset.propRadius) : undefined,
                opacity: isCustom && el.dataset.propOpacity ? parseFloat(el.dataset.propOpacity) : undefined,
                // Échelle + couleurs de thème par élément (posées par applyLayoutFromConfig pour
                // les intégrés, exposeStyleProps pour les customs).
                scale: el.dataset.propScale ? parseFloat(el.dataset.propScale) : undefined,
                primary: el.dataset.propPrimary || '',
                secondary: el.dataset.propSecondary || '',
                themeText: el.dataset.propText || '',
                panelBg: el.dataset.propPanelBg || '',
                panelBorder: el.dataset.propPanelBorder || '',
                // Les badges à texte adaptatif n'ont pas d'échelle (leur police suit déjà le
                // redimensionnement) — l'éditeur masque le champ.
                scaleText: el.dataset.sceneScaleText !== undefined,
                // Plateau clavier/souris ("keys") — voir exposeStyleProps() dans overlay-common.js.
                layout: isCustom ? (el.dataset.propLayout || '') : undefined,
                showFunctionRow: isCustom ? el.dataset.propShowFunctionRow === '1' : undefined,
                showDigitRow: isCustom ? el.dataset.propShowDigitRow === '1' : undefined,
                showMovement: isCustom ? el.dataset.propShowMovement === '1' : undefined,
                showModifiers: isCustom ? el.dataset.propShowModifiers === '1' : undefined,
                showArrows: isCustom ? el.dataset.propShowArrows === '1' : undefined,
                showMouse: isCustom ? el.dataset.propShowMouse === '1' : undefined
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

    // Aperçus d'événements demandés par la barre d'outils de l'éditeur (parent) : injectés
    // DIRECTEMENT dans cette page via les fonctions globales d'overlay-common.js — aucune
    // diffusion WebSocket, contrairement à la page /tests : les overlays ouverts dans OBS ne
    // voient rien, seul l'aperçu de l'éditeur joue l'alerte.
    function handlePreviewEvent(kind) {
        if (kind === 'chat') {
            if (typeof addChatMessage === 'function') {
                addChatMessage('PseudoTest', 'Un message de test dans le chat !', '#a855f7', {});
            }
            return;
        }
        if (typeof addAlertsToQueue !== 'function') return;
        if (kind === 'follow') addAlertsToQueue('follow', 'PseudoTest', 'Merci pour le follow !');
        else if (kind === 'sub') addAlertsToQueue('sub', 'PseudoTest', 'Merci pour le sub !', 'Ceci est un message de test');
        else if (kind === 'subs_gift') addAlertsToQueue('subs_gift', 'PseudoTest', 'Merci pour les 5 sub gifts !');
        else if (kind === 'raid') addAlertsToQueue('raid', 'Raid de PseudoTest', '', 'Bienvenue aux 42 viewers');
        else if (kind === 'bits') addAlertsToQueue('bits', 'PseudoTest', 'Merci pour les 100 bits !', 'Message de test');
    }

    /**
     * Centrage rapide (boutons "Centrer horiz./vert." de la barre d'outils) : demandé par le
     * parent avec seulement un id d'élément + un axe ('x' ou 'y'), calculé ici car seule cette
     * page connaît la taille réellement rendue de l'élément (zoom, contenu variable...). Réutilise
     * le même chemin d'enregistrement qu'un drag classique (postMessage 'scene-element-moved') —
     * aucune route API dédiée nécessaire.
     */
    function handleCenterElement(elementId, axis) {
        const el = document.querySelector('[data-scene-el="' + CSS.escape(elementId) + '"]');
        if (!el) return;
        const zoom = zoomOf(el);
        const ref = referencePoint(el);
        const rect = el.getBoundingClientRect();

        // Delta en pixels VISUELS — le même type de grandeur qu'un delta de souris pendant un
        // drag — appliqué à la référence "neutre" (ref.left/top, qui annule déjà tout décalage
        // de transform auto-centrante, voir referencePoint()). Écrire directement
        // `screenCenter - width/2` comme valeur CSS aurait été correct pour un élément ancré
        // normalement, mais faux pour un élément en transform:translate(-50%,-50%) (ex:
        // .alert-container) ou left:50%;translateX(-50%) (bannières...) : la position finale
        // aurait été décalée d'une demi-largeur/hauteur, plaçant le bord DROIT/BAS de l'élément
        // au centre au lieu de son centre réel. En passant par un delta ajouté à la référence
        // neutre — exactement comme le fait un drag normal — le résultat est correct quel que
        // soit le mécanisme de centrage CSS de l'élément.
        let left = ref.left;
        let top = ref.top;
        if (axis === 'x') {
            const targetLeft = window.innerWidth / 2 - rect.width / 2;
            left = ref.left + (targetLeft - rect.left);
        }
        if (axis === 'y') {
            const targetTop = window.innerHeight / 2 - rect.height / 2;
            top = ref.top + (targetTop - rect.top);
        }

        el.style.position = 'fixed';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = (left / zoom) + 'px';
        el.style.top = (top / zoom) + 'px';

        const topPct = (top / window.innerHeight) * 100;
        const leftPct = (left / window.innerWidth) * 100;
        el.style.top = (topPct / zoom) + 'vh';
        el.style.left = (leftPct / zoom) + 'vw';
        window.parent.postMessage({ type: 'scene-element-moved', elementId, top: topPct, left: leftPct }, '*');
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
        window.addEventListener('message', (event) => {
            const data = event.data;
            if (!data) return;
            if (data.type === 'scene-preview-event') handlePreviewEvent(data.kind);
            else if (data.type === 'scene-center-element') handleCenterElement(data.elementId, data.axis);
        });
    }

    if (document.readyState === 'complete') {
        setTimeout(init, 50);
    } else {
        window.addEventListener('load', () => setTimeout(init, 50));
    }
})();
