/**
 * JavaScript commun pour les overlays Twitch
 * Contient toutes les fonctions partagées entre starting.html, index.html et ending.html
 */

function getOverlayConfig() {
    if (typeof globalThis !== 'undefined' && globalThis.OVERLAY_CONFIG) {
        return globalThis.OVERLAY_CONFIG;
    }
    return {};
}

function hexToRgbTriplet(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const normalized = hex.trim().replace('#', '');
    const expanded = normalized.length === 3
        ? normalized.split('').map(ch => ch + ch).join('')
        : normalized;
    if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
}

// Clés des 4 pages intégrées — tout autre pageKey est l'id d'une scène personnalisée. Sert à
// choisir les bons défauts : les pages intégrées gardent leur fond de thème et suivent les
// réglages d'animations globaux tant qu'aucun réglage de scène ne les surcharge.
const OVERLAY_BUILTIN_PAGES = ['starting', 'index', 'pause', 'ending'];

function getThemeKeyFromLocation() {
    const path = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname.toLowerCase() : '';
    if (path.endsWith('/starting.html') || path.endsWith('starting.html')) return 'starting';
    if (path.endsWith('/ending.html') || path.endsWith('ending.html')) return 'ending';
    if (path.endsWith('/pause.html') || path.endsWith('pause.html')) return 'pause';
    // Scène personnalisée (/scene/<uuid>) : la clé de page est l'id de la scène — layout,
    // customTexts, texts... s'indexent dessus exactement comme sur les 4 pages intégrées.
    const sceneMatch = path.match(/\/scene\/([a-z0-9-]+)/);
    if (sceneMatch) return sceneMatch[1];
    return 'index';
}

function applyThemeFromConfig() {
    const cfg = getOverlayConfig();
    const themeKey = getThemeKeyFromLocation();
    const theme = (cfg.themes && cfg.themes[themeKey]) ? cfg.themes[themeKey] : null;
    if (!theme) return;

    const root = document.documentElement;
    if (!root) return;

    if (theme.primary) {
        root.style.setProperty('--theme-primary', theme.primary);
        const rgb = hexToRgbTriplet(theme.primary);
        if (rgb) root.style.setProperty('--theme-primary-rgb', rgb);
    }
    if (theme.secondary) {
        root.style.setProperty('--theme-secondary', theme.secondary);
        const rgb = hexToRgbTriplet(theme.secondary);
        if (rgb) root.style.setProperty('--theme-secondary-rgb', rgb);
    }
    if (theme.accent) {
        root.style.setProperty('--theme-accent', theme.accent);
        const rgb = hexToRgbTriplet(theme.accent);
        if (rgb) root.style.setProperty('--theme-accent-rgb', rgb);
    }

    // Champs étendus (optionnels)
    const background = theme.background || theme.bg || theme.accent;
    if (background) {
        root.style.setProperty('--theme-bg', background);
        const rgb = hexToRgbTriplet(background);
        if (rgb) root.style.setProperty('--theme-bg-rgb', rgb);
    }
    const surface = theme.surface;
    if (surface) {
        root.style.setProperty('--theme-surface', surface);
        const rgb = hexToRgbTriplet(surface);
        if (rgb) root.style.setProperty('--theme-surface-rgb', rgb);
    }
    if (theme.text) {
        root.style.setProperty('--theme-text', theme.text);
    }
    if (theme.mutedText) {
        root.style.setProperty('--theme-muted-text', theme.mutedText);
    }
    if (theme.panelBg) {
        root.style.setProperty('--theme-panel-bg', theme.panelBg);
        const rgb = hexToRgbTriplet(theme.panelBg);
        if (rgb) root.style.setProperty('--theme-panel-bg-rgb', rgb);
    }
    if (theme.panelBorder) {
        root.style.setProperty('--theme-panel-border', theme.panelBorder);
    }

    if (cfg.chat && cfg.chat.defaultColor) {
        root.style.setProperty('--chat-default-color', cfg.chat.defaultColor);
    }
    if (cfg.chat && cfg.chat.badgeSize) {
        root.style.setProperty('--chat-badge-size', cfg.chat.badgeSize);
    }

    const timerColor = cfg.panels?.left?.timerColor;
    if (timerColor) {
        root.style.setProperty('--timer-color', timerColor);
        const rgb = hexToRgbTriplet(timerColor);
        if (rgb) root.style.setProperty('--timer-color-rgb', rgb);
    }
}

function applyBottomBarVisibilityFromConfig() {
    const cfg = getOverlayConfig();
    const visible = cfg.panels?.bottom?.enabled !== false;
    document.querySelectorAll('.bottom-bar, #bottomBar').forEach(el => {
        el.style.display = visible ? '' : 'none';
    });
}

function applyChatVisibilityFromConfig() {
    const cfg = getOverlayConfig();
    const pageKey = getThemeKeyFromLocation();
    const visible = cfg.chat?.enabled?.[pageKey] !== false;
    // :not([data-scene-custom-text]) : un widget chat AJOUTÉ depuis l'éditeur de scène a sa
    // propre visibilité (œil de l'éditeur) — la bascule globale de /settings ne concerne que le
    // panneau intégré de la page.
    document.querySelectorAll('.chat-panel:not([data-scene-custom-text])').forEach(el => {
        el.style.display = visible ? '' : 'none';
    });
}

/**
 * Positions/visibilité custom posées depuis l'éditeur de scène (/scene-editor), par page —
 * cfg.layout[page] = { elementId: {top?, left?, hidden?} } (top/left en % de la hauteur/largeur).
 * Entièrement déclaratif : chaque élément déplaçable est reposé à partir de RIEN d'autre que la
 * config à chaque appel (y compris pour revenir à sa position CSS par défaut quand son override
 * a été retiré) — indispensable pour que "Réinitialiser" et "Masquer/Afficher" depuis
 * /scene-editor s'appliquent en direct via la diffusion WebSocket 'config-updated', sans recharger
 * la page. On ne touche jamais `transform` : les éléments qui en dépendent pour leur
 * centrage/animation (ex: .alert-container) continuent de fonctionner normalement, seul leur
 * point d'ancrage top/left change.
 */
function applyLayoutFromConfig() {
    const cfg = getOverlayConfig();
    const pageKey = getThemeKeyFromLocation();
    const layout = cfg.layout?.[pageKey] || {};

    document.querySelectorAll('[data-scene-el]').forEach((el) => {
        const elementId = el.dataset.sceneEl;
        if (elementId.startsWith('custom:')) return; // gérés par renderCustomTextsFromConfig()
        const pos = layout[elementId];

        // Échelle visuelle par élément via CSS zoom : contrairement au redimensionnement
        // width/height (qui donne plus d'espace au contenu à taille de texte constante), le zoom
        // agrandit tout — texte, icônes, paddings — comme l'échelle d'une source dans OBS, sans
        // toucher à transform (réservé aux animations). Chrome multiplie par le zoom TOUTES les
        // longueurs de l'élément (top/left/width/height compris — vérifié empiriquement) : les
        // valeurs stockées étant "visuelles" (ce que l'utilisateur voit et dépose au drag), tout
        // ce qu'on écrit dans les styles est donc divisé par le zoom. Les badges à texte adaptatif
        // (data-scene-scale-text) sont exclus : leur police suit déjà le redimensionnement, un
        // zoom par-dessus ferait double emploi et fausserait leur mesure "naturelle".
        const isScaleTextBadge = el.dataset.sceneScaleText !== undefined;
        const zoom = (!isScaleTextBadge && pos && typeof pos.scale === 'number' && pos.scale > 0) ? pos.scale / 100 : 1;
        el.style.zoom = zoom !== 1 ? String(zoom) : '';

        // Couleurs de thème surchargées PAR ÉLÉMENT : les variables --theme-* sont posées
        // localement sur l'élément — tout son CSS (et celui de ses descendants) qui consomme ces
        // variables les résout alors à la valeur locale, sans toucher au reste de la page. Les
        // variantes -rgb (utilisées dans des rgba(...) par le CSS des panneaux) suivent.
        // Entièrement déclaratif : sans override, on retire la propriété (retour au thème de la
        // page). Les datasets exposent les valeurs à l'éditeur de scène (reportReady, bridge).
        [['primary', '--theme-primary'], ['secondary', '--theme-secondary'], ['text', '--theme-text'],
         ['panelBg', '--theme-panel-bg'], ['panelBorder', '--theme-panel-border']].forEach(([key, cssVar]) => {
            const value = (pos && typeof pos[key] === 'string') ? pos[key] : null;
            if (value) {
                el.style.setProperty(cssVar, value);
                const rgb = hexToRgbTriplet(value);
                if (rgb) el.style.setProperty(cssVar + '-rgb', rgb);
            } else {
                el.style.removeProperty(cssVar);
                el.style.removeProperty(cssVar + '-rgb');
            }
            el.dataset['prop' + key.charAt(0).toUpperCase() + key.slice(1)] = value || '';
        });
        el.dataset.propScale = (pos && typeof pos.scale === 'number') ? String(pos.scale) : '';

        if (pos && typeof pos.top === 'number' && typeof pos.left === 'number') {
            // Ramené dans [0,100] : un ancien bug de l'éditeur (compensation de drag ignorant le
            // scale() des animations d'alerte) a pu enregistrer des positions hors écran (ex:
            // top 114vh / left 119vw constaté en vrai) — l'élément semblait alors avoir disparu.
            // Le bornage au rendu répare ces données sans migration : l'élément réapparaît en
            // bord d'écran, prêt à être repositionné.
            el.style.position = 'fixed';
            el.style.top = (Math.min(100, Math.max(0, pos.top)) / zoom) + 'vh';
            el.style.left = (Math.min(100, Math.max(0, pos.left)) / zoom) + 'vw';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        } else {
            el.style.position = '';
            el.style.top = '';
            el.style.left = '';
            el.style.right = '';
            el.style.bottom = '';
        }

        // Ne touche display que si l'éditeur de scène a un avis explicite dessus — sinon on
        // laisse la main à applyChatVisibilityFromConfig()/applyBottomBarVisibilityFromConfig()
        // (chat/bandeau bas ont leur propre bascule dans les réglages classiques). 'important' :
        // en mode édition, le bridge force l'affichage des zones d'alertes via une règle
        // !important — seul un inline important garde la main pour qu'un élément masqué à l'œil
        // reste réellement masqué (et remonté comme tel).
        if (pos && typeof pos.hidden === 'boolean') {
            if (pos.hidden) el.style.setProperty('display', 'none', 'important');
            else el.style.removeProperty('display');
        }

        // Taille : de vraies dimensions CSS (pas transform:scale, qui déformerait le texte/les
        // icônes) — l'élément dispose juste de plus/moins d'espace. Pour .alert-container, sa
        // propre transform: translate(-50%,-50%) est relative à sa taille courante, donc le
        // centrage reste correct automatiquement sans rien de spécial ici. Axes indépendants pour
        // les panneaux à contenu variable (chat...) : redimensionner horizontalement ne doit pas
        // affecter la hauteur, et inversement. On lève aussi max-width/max-height (ex:
        // .alert-container a max-width:600px) : sans ça, un override plus grand que le plafond CSS
        // serait silencieusement ignoré. Les badges à contenu fixe (data-scene-scale-text) suivent
        // une logique différente, voir plus bas : leurs axes ne sont PAS indépendants, un seul
        // facteur d'échelle s'applique aux deux pour garder leurs proportions.
        const hasWidth = pos && typeof pos.width === 'number' && pos.width > 0;
        const hasHeight = pos && typeof pos.height === 'number' && pos.height > 0;
        const scaleText = el.dataset.sceneScaleText !== undefined;

        // Badges à contenu court et fixe (horloge, indicateur de pause, bannières, compteur de
        // viewers, stats de fin...) marqués data-scene-scale-text : contrairement au chat (une
        // LISTE, où agrandir révèle plus de lignes à taille inchangée), il n'y a ici aucun contenu
        // supplémentaire à révéler — agrandir la boîte sans faire grossir le texte ne fait
        // qu'ajouter du vide autour, ce qui ne correspond pas à l'intention du redimensionnement. On
        // mesure donc sa taille/police NATURELLES juste avant de poser un éventuel override — PAS une
        // capture mise en cache une seule fois au chargement : ces badges contiennent une icône
        // FontAwesome chargée depuis un CDN externe, et si elle finit de charger APRÈS le tout
        // premier rendu, sa largeur réelle grandit après coup ; une capture figée trop tôt aurait
        // capturé une largeur par défaut trop petite, faussant durablement le ratio (constaté : un
        // ratio ~2x trop grand, police démesurée). Mesurer à chaque passage (init, config-updated) au
        // lieu d'une seule fois élimine ce problème de timing.
        let naturalWidth, naturalHeight, naturalFontSize;
        if (scaleText) {
            const had = { w: el.style.width, h: el.style.height, mw: el.style.maxWidth, mh: el.style.maxHeight, fs: el.style.fontSize };
            el.style.width = el.style.height = el.style.maxWidth = el.style.maxHeight = el.style.fontSize = '';
            const naturalRect = el.getBoundingClientRect();
            naturalWidth = naturalRect.width;
            naturalHeight = naturalRect.height;
            naturalFontSize = parseFloat(getComputedStyle(el).fontSize);
            el.style.width = had.w; el.style.height = had.h; el.style.maxWidth = had.mw; el.style.maxHeight = had.mh; el.style.fontSize = had.fs;
        }

        if (scaleText) {
            // Contenu fixe et court (pas une liste comme le chat) : la forme de la boîte reste
            // librement redimensionnable (largeur/hauteur indépendantes, un seul axe touché laisse
            // l'autre en auto — comme pour les panneaux), mais son CONTENU (icône, texte) doit
            // suivre en taille pour remplir l'espace, et rester bien centré quelle que soit la
            // forme obtenue (voir le display:flex + align-items/justify-content ajoutés sur ces
            // badges en CSS — la boîte n'étant pas flex à l'origine, agrandir sa hauteur laissait
            // sinon le contenu collé en haut au lieu de se recentrer). Le facteur d'échelle de
            // police prend le PLUS PETIT des deux ratios connus (seulement l'axe réellement
            // redimensionné si un seul l'est) pour ne jamais déborder de la dimension la plus
            // contraignante.
            if ((hasWidth || hasHeight) && naturalWidth > 0 && naturalHeight > 0 && naturalFontSize > 0) {
                const widthRatio = hasWidth ? (pos.width / 100 * window.innerWidth) / naturalWidth : null;
                const heightRatio = hasHeight ? (pos.height / 100 * window.innerHeight) / naturalHeight : null;
                const scale = (widthRatio !== null && heightRatio !== null)
                    ? Math.min(widthRatio, heightRatio)
                    : (widthRatio ?? heightRatio);
                // naturalWidth/Height viennent de getBoundingClientRect() (boîte de bordure,
                // padding inclus), mais ces badges n'ont pas box-sizing:border-box — sans le
                // forcer ici, `width`/`height` ne fixeraient que la boîte de CONTENU, et le
                // padding fixe en px s'ajouterait par-dessus, faussant le calcul de ratio dès que
                // padding/bordure ne sont pas négligeables face à la taille cible.
                el.style.boxSizing = 'border-box';
                el.style.width = hasWidth ? pos.width + 'vw' : '';
                el.style.maxWidth = hasWidth ? 'none' : '';
                el.style.height = hasHeight ? pos.height + 'vh' : '';
                el.style.maxHeight = hasHeight ? 'none' : '';
                el.style.fontSize = Math.max(8, naturalFontSize * scale) + 'px';
            } else {
                el.style.boxSizing = '';
                el.style.width = '';
                el.style.height = '';
                el.style.maxWidth = '';
                el.style.maxHeight = '';
                el.style.fontSize = '';
            }
        } else {
            // Divisé par le zoom : les dimensions stockées sont visuelles (voir plus haut).
            el.style.width = hasWidth ? (pos.width / zoom) + 'vw' : '';
            el.style.maxWidth = hasWidth ? 'none' : '';
            el.style.height = hasHeight ? (pos.height / zoom) + 'vh' : '';
            el.style.maxHeight = hasHeight ? 'none' : '';
        }
    });
}

/**
 * Capture, une seule fois par élément et avant toute application d'override, le texte "par
 * défaut" tel qu'écrit dans le HTML — sert de repli déclaratif dans applyTextOverridesFromConfig()
 * quand aucun override n'est (ou plus) défini pour cet id. Doit être appelée avant le tout premier
 * appel à applyTextOverridesFromConfig(), sinon un texte déjà remplacé serait capturé comme si
 * c'était le défaut.
 */
function captureDefaultTexts() {
    document.querySelectorAll('[data-scene-text]:not([data-scene-custom-text])').forEach((el) => {
        if (el.dataset.sceneDefaultText === undefined) {
            el.dataset.sceneDefaultText = el.textContent;
        }
    });
}

/**
 * Overrides de texte posés depuis l'éditeur de scène pour les éléments statiques marqués
 * data-scene-text dans le HTML (titre, sous-titre, en-tête de chat...) — cfg.texts[page] =
 * { textId: "valeur" }. Entièrement déclaratif : une chaîne vide est une valeur légitime (texte
 * volontairement vidé) et s'applique donc bien, et un id sans override revient au texte par
 * défaut capturé — nécessaire pour qu'un texte vidé OU réinitialisé se répercute directement sur
 * tous les overlays déjà ouverts (pas seulement l'aperçu de l'éditeur, qui se recharge lui-même).
 */
function applyTextOverridesFromConfig() {
    const cfg = getOverlayConfig();
    const pageKey = getThemeKeyFromLocation();
    const texts = cfg.texts?.[pageKey] || {};
    document.querySelectorAll('[data-scene-text]:not([data-scene-custom-text])').forEach((el) => {
        const value = texts[el.dataset.sceneText];
        el.textContent = (typeof value === 'string') ? value : (el.dataset.sceneDefaultText ?? '');
    });
}

/**
 * Éléments ajoutés librement depuis l'éditeur de scène (pas dans le HTML de base) —
 * cfg.customTexts[page] = { id: {type, top, left, ...} }, type ∈ text/image/box/clock (absent =
 * text, compat avec les profils créés quand seul le texte existait — d'où le nom de la clé).
 * Recréés en entier à chaque appel plutôt que diffés un par un : plus simple et cet appel reste
 * rare (init + config-updated).
 */
function renderCustomTextsFromConfig() {
    const cfg = getOverlayConfig();
    const pageKey = getThemeKeyFromLocation();

    // Le widget chat est recréé à CHAQUE config-updated (comme tout élément custom) : sans
    // transplantation, les messages déjà reçus seraient perdus au moindre réglage modifié —
    // le WebSocket ne rejoue pas l'historique.
    const previousChat = document.querySelector('[data-scene-custom-text] #chatContainer');
    const previousChatMessages = previousChat ? previousChat.innerHTML : null;

    document.querySelectorAll('[data-scene-custom-text]').forEach((el) => el.remove());

    const customTexts = cfg.customTexts?.[pageKey];
    if (!customTexts) return;

    // Style texte partagé par les types text et clock : taille (vh), couleur, police, néon.
    function applyTextStyle(el, item, defaultSize) {
        const size = (typeof item.size === 'number' && item.size > 0) ? item.size : defaultSize;
        const family = item.font === 'inter' ? "Inter, sans-serif" : "'Baron Neue Black', Inter, sans-serif";
        const color = item.color || '#ffffff';
        el.style.color = color;
        el.style.font = '600 ' + size + 'vh ' + family;
        el.style.textShadow = item.glow
            ? '0 0 10px ' + color + ', 0 0 32px ' + color + ', 0 2px 8px rgba(0, 0, 0, 0.6)'
            : '0 2px 8px rgba(0, 0, 0, 0.6)';
        el.dataset.colorValue = item.color || '';
    }

    // Valeurs de style brutes exposées à l'éditeur de scène : le panneau de propriétés n'a pas
    // accès à la config des overlays, il lit ces datasets via scene-editor-bridge.js
    // (reportReady). Chaîne vide = pas d'override, l'éditeur affiche alors sa valeur par défaut.
    function exposeStyleProps(el, item) {
        el.dataset.propSize = (typeof item.size === 'number') ? String(item.size) : '';
        el.dataset.propFont = item.font || '';
        el.dataset.propGlow = item.glow ? '1' : '';
        el.dataset.propRadius = (typeof item.radius === 'number') ? String(item.radius) : '';
        el.dataset.propOpacity = (typeof item.opacity === 'number') ? String(item.opacity) : '';
        el.dataset.propScale = (typeof item.scale === 'number') ? String(item.scale) : '';
    }

    for (const [id, item] of Object.entries(customTexts)) {
        const type = item.type || 'text';
        const el = document.createElement('div');
        el.dataset.sceneEl = 'custom:' + id;
        el.dataset.sceneCustomText = '1';
        el.dataset.customType = type;
        // L'état masqué des éléments custom vit dans layout[page]['custom:<id>'] (même mécanisme
        // que les éléments intégrés — applyLayoutFromConfig() saute volontairement les ids
        // custom, c'est donc ici qu'il s'applique). display:none plutôt que ne pas rendre du
        // tout : l'éditeur de scène doit continuer à lister l'élément pour pouvoir le réafficher.
        // Exception alerts : ce widget est déjà masqué par défaut en CSS (il n'apparaît que le
        // temps d'une alerte via .show) — on ne pose un display inline que pour le forcer caché.
        const hiddenByLayout = !!cfg.layout?.[pageKey]?.['custom:' + id]?.hidden;
        // 'important' : en mode édition, le bridge force l'affichage des zones d'alertes en
        // pointillés via une règle !important — seul un inline important garde la main pour
        // qu'un élément masqué à l'œil reste réellement masqué (et remonté comme tel).
        if (hiddenByLayout) el.style.setProperty('display', 'none', 'important');
        // Échelle visuelle (chat/spotify : leur contenu interne a des tailles CSS fixes, le zoom
        // est le seul moyen de tout agrandir d'un bloc) — mêmes règles que les éléments intégrés
        // dans applyLayoutFromConfig() : valeurs stockées visuelles, styles divisés par le zoom.
        // Pas d'échelle pour les alertes : leur taille découle de la zone (fitAlertBox).
        const zoom = ((type === 'chat' || type === 'spotify') && typeof item.scale === 'number' && item.scale > 0)
            ? item.scale / 100 : 1;
        if (zoom !== 1) el.style.zoom = String(zoom);
        el.style.position = 'fixed';
        // Même bornage [0,100] que les éléments intégrés (applyLayoutFromConfig) : répare les
        // positions hors écran enregistrées par l'ancien bug de drag.
        el.style.top = (Math.min(100, Math.max(0, item.top ?? 40)) / zoom) + 'vh';
        el.style.left = (Math.min(100, Math.max(0, item.left ?? 40)) / zoom) + 'vw';
        el.style.zIndex = '250';
        // De vraies dimensions CSS (pas transform:scale, qui déformerait le contenu) : l'élément
        // dispose de plus/moins d'espace et le texte wrappe normalement au lieu d'être étiré.
        if (typeof item.width === 'number' && item.width > 0) el.style.width = (item.width / zoom) + 'vw';
        if (typeof item.height === 'number' && item.height > 0) el.style.height = (item.height / zoom) + 'vh';

        if (type === 'text') {
            el.textContent = item.text || '';
            // Copie indépendante du texte réel : une fois en mode édition de scène, un badge
            // d'étiquette est ajouté comme enfant DOM de cet élément (voir addLabel() dans
            // scene-editor-bridge.js), ce qui pollue el.textContent — ce dataset reste la source
            // fiable pour retrouver le texte "propre" depuis la sidebar.
            el.dataset.textValue = item.text || '';
            applyTextStyle(el, item, 2.4);
        } else if (type === 'image') {
            el.dataset.urlValue = item.url || '';
            if (!el.style.width) el.style.width = '20vw';
            if (item.url) {
                const img = document.createElement('img');
                img.src = item.url;
                img.alt = '';
                img.style.display = 'block';
                img.style.width = '100%';
                img.style.height = el.style.height ? '100%' : 'auto';
                img.style.objectFit = 'contain';
                if (typeof item.radius === 'number') img.style.borderRadius = item.radius + 'px';
                if (typeof item.opacity === 'number') img.style.opacity = String(item.opacity / 100);
                el.appendChild(img);
            } else {
                // Pas encore d'URL : un cadre visible reste nécessaire pour pouvoir sélectionner/
                // déplacer l'élément dans l'éditeur — invisible en usage normal serait acceptable,
                // mais autant montrer clairement qu'une image attend son URL.
                if (!el.style.height) el.style.height = '12vh';
                el.style.border = '2px dashed rgba(255, 255, 255, 0.45)';
                el.style.borderRadius = '8px';
                if (!hiddenByLayout) el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'center';
                el.style.color = 'rgba(255, 255, 255, 0.65)';
                el.style.font = "600 1.8vh Inter, sans-serif";
                el.textContent = 'Image — URL à définir';
            }
        } else if (type === 'box') {
            el.dataset.colorValue = item.color || '#a855f7';
            if (!el.style.width) el.style.width = '20vw';
            if (!el.style.height) el.style.height = '20vh';
            el.style.background = item.color || '#a855f7';
            el.style.borderRadius = (typeof item.radius === 'number' ? item.radius : 8) + 'px';
            if (typeof item.opacity === 'number') el.style.opacity = String(item.opacity / 100);
            // Une boîte sert de fond par nature : toujours sous les autres éléments custom
            // (texte, image, horloge à 250), sinon une boîte ajoutée après eux les recouvrirait
            // sans aucun moyen de changer l'ordre d'empilement depuis l'éditeur.
            el.style.zIndex = '240';
        } else if (type === 'clock') {
            // Le temps vit dans un span enfant dédié : en mode édition, étiquette et poignées de
            // redimensionnement sont ajoutées comme enfants du même élément — écraser
            // el.textContent chaque seconde les détruirait.
            const span = document.createElement('span');
            span.dataset.sceneClockDisplay = '1';
            span.textContent = new Date().toLocaleTimeString('fr-FR');
            el.appendChild(span);
            applyTextStyle(el, item, 4);
            ensureCustomClockTicker();
        } else if (type === 'chat') {
            // Vrai panneau de chat : même structure/classes que le panneau intégré d'index.html —
            // addChatMessage() (getElementById('chatContainer')) et le CSS .chat-panel de
            // overlay-common.css fonctionnent tels quels. Unicité par scène garantie côté store
            // (SINGLETON_ELEMENT_TYPES). item.text = titre de l'en-tête.
            el.dataset.textValue = item.text || 'CHAT';
            el.className = 'chat-panel';
            if (!el.style.width) el.style.width = '15vw';
            if (!el.style.height) el.style.height = '40vh';
            const header = document.createElement('div');
            header.className = 'chat-header';
            header.innerHTML = '<i class="fas fa-comments"></i> ';
            header.appendChild(document.createTextNode(item.text || 'CHAT'));
            const container = document.createElement('div');
            container.className = 'chat-container';
            container.id = 'chatContainer';
            if (previousChatMessages) container.innerHTML = previousChatMessages;
            el.appendChild(header);
            el.appendChild(container);
        } else if (type === 'alerts') {
            // ZONE d'alertes (follow/sub/raid/bits...) : mêmes ids et structure zone/boîte
            // qu'index.html, donc showAlert()/fitAlertBox() la pilotent tels quels — l'alerte
            // s'ajuste au plus grand format qui tient dans le cadre défini dans l'éditeur.
            // Invisible tant qu'aucune alerte ne joue (.show) ; en mode édition, seul le cadre
            // est matérialisé (voir scene-editor-bridge.js). Testable depuis /tests ou la barre
            // d'aperçu de l'éditeur.
            el.className = 'alert-container';
            el.id = 'alertContainer';
            el.dataset.sceneAlertZone = '1';
            el.innerHTML = '<div class="alert-box" id="alertBox">'
                + '<img class="alert-media" id="alertMedia" alt="">'
                + '<div class="alert-icon" id="alertIcon"><i class="fas fa-heart"></i></div>'
                + '<div class="alert-body">'
                + '<div class="alert-title" id="alertTitle"></div>'
                + '<div class="alert-username" id="alertUsername"></div>'
                + '<div class="alert-message" id="alertMessage"></div>'
                + '<div class="alert-amount" id="alertAmount" style="display: none;"></div>'
                + '</div>'
                + '</div>';
            el.style.zIndex = '300';
        } else if (type === 'spotify') {
            // Morceau Spotify en cours de lecture — pas de singleton (contrairement à chat/alerts,
            // aucun id DOM partagé n'est nécessaire) : plusieurs widgets peuvent coexister sur une
            // même scène, tous mis à jour ensemble par applySpotifyTrack() (voir plus bas), appelée
            // au premier chargement (fetch /api/spotify/now-playing) et à chaque message WebSocket
            // 'spotify-track-updated'. item.color = couleur d'accent du titre/de la bordure.
            el.className = 'spotify-widget';
            el.dataset.colorValue = item.color || '#1db954';
            el.style.setProperty('--spotify-accent', item.color || '#1db954');
            if (!el.style.width) el.style.width = '22vw';
            el.innerHTML = '<img class="spotify-art" data-spotify-art alt="">'
                + '<div class="spotify-info">'
                + '<div class="spotify-title" data-spotify-title>Spotify</div>'
                + '<div class="spotify-artist" data-spotify-artist>Rien en cours de lecture</div>'
                + '</div>';
            applySpotifyTrackTo(el, lastSpotifyTrack);
        }
        exposeStyleProps(el, item);
        document.body.appendChild(el);
    }

    // Signale au bridge d'édition (scene-editor-bridge.js) que de nouveaux éléments viennent
    // d'apparaître, pour qu'il les rende déplaçables/éditables — lui seul écoute cet événement,
    // aucun effet en usage normal (OBS, navigateur direct).
    window.dispatchEvent(new CustomEvent('scene-custom-texts-rendered'));
}

/**
 * Réglages de scène (cfg.scenes[pageKey] = {background, effects, name?}) : fond de page
 * (thème / transparent / couleur / dégradé) et halos animés d'ambiance. Valent pour TOUTES les
 * pages — intégrées comprises, leur entrée étant créée au premier réglage depuis l'éditeur ;
 * sans réglage, une page intégrée garde son fond de thème ('theme') et une scène personnalisée
 * reste transparente. Les EFFETS (particules, étoiles...) ne sont pas gérés ici mais à la
 * création dans initCommonOverlay() — comme pour les réglages d'animation globaux, un changement
 * d'effet ne s'applique donc qu'au prochain rechargement de la page (l'éditeur de scène recharge
 * son aperçu lui-même).
 */
function applySceneSettingsFromConfig() {
    const cfg = getOverlayConfig();
    const pageKey = getThemeKeyFromLocation();
    const isBuiltin = OVERLAY_BUILTIN_PAGES.includes(pageKey);
    const bg = cfg.scenes?.[pageKey]?.background || {};
    const mode = bg.mode || (isBuiltin ? 'theme' : 'transparent');

    if (mode === 'color') {
        document.body.style.background = bg.color || '#0f172a';
    } else if (mode === 'gradient') {
        document.body.style.background = 'linear-gradient(135deg, ' + (bg.color || '#0f172a') + ', ' + (bg.color2 || '#1e293b') + ')';
    } else if (mode === 'transparent') {
        document.body.style.background = 'transparent';
    } else {
        // 'theme' : retour au fond CSS de la page (var(--theme-bg), overlay-common.css).
        document.body.style.background = '';
    }

    // Les halos .background-animation/.breathing-effect n'ont de sens que sur un fond opaque —
    // sur un fond transparent ils peindraient un dégradé radial par-dessus le jeu. En mode
    // 'theme', on rend la main au CSS de la page (certaines pages intégrées en ont d'origine).
    document.querySelectorAll('.background-animation, .breathing-effect').forEach((el) => {
        el.style.display = (mode === 'color' || mode === 'gradient') ? '' : (mode === 'transparent' ? 'none' : '');
    });
}

// Un seul ticker partagé pour toutes les horloges custom de la page, démarré à la première
// horloge rencontrée et jamais arrêté (inoffensif si les horloges disparaissent : le sélecteur
// ne matche alors plus rien).
let customClockTickerStarted = false;
function ensureCustomClockTicker() {
    if (customClockTickerStarted) return;
    customClockTickerStarted = true;
    setInterval(() => {
        document.querySelectorAll('[data-scene-clock-display]').forEach((el) => {
            el.textContent = new Date().toLocaleTimeString('fr-FR');
        });
    }, 1000);
}

/**
 * Dernier morceau Spotify connu, tenu à jour par le WebSocket ('spotify-track-updated', voir
 * initWebSocket) et consulté par renderCustomTextsFromConfig() à chaque (re)création d'un widget
 * (ex: après un config-updated) pour qu'il n'affiche jamais un état "vide" pendant les quelques
 * secondes qui séparent le rendu du prochain poll serveur. `null` = rien en cours de lecture (état
 * légitime, pas une absence de données).
 */
let lastSpotifyTrack = null;

function applySpotifyTrackTo(el, track) {
    const art = el.querySelector('[data-spotify-art]');
    const title = el.querySelector('[data-spotify-title]');
    const artist = el.querySelector('[data-spotify-artist]');
    if (!art || !title || !artist) return;
    if (track) {
        title.textContent = track.title;
        artist.textContent = track.artist;
        if (track.albumArt) {
            art.src = track.albumArt;
            // 'block', pas '' : la classe .spotify-art a display:none par défaut (masquée tant
            // qu'aucune pochette n'est connue) — effacer le style inline ne ferait que retomber
            // sur cette règle de classe, laissant l'image invisible malgré le src posé.
            art.style.display = 'block';
        } else {
            art.removeAttribute('src');
            art.style.display = 'none';
        }
        el.classList.toggle('is-paused', !track.isPlaying);
    } else {
        title.textContent = 'Spotify';
        artist.textContent = 'Rien en cours de lecture';
        art.removeAttribute('src');
        art.style.display = 'none';
        el.classList.remove('is-paused');
    }
}

/** Met à jour TOUS les widgets Spotify de la page (il n'y a pas de singleton, voir store.js). */
function applySpotifyTrack(track) {
    lastSpotifyTrack = track;
    document.querySelectorAll('.spotify-widget').forEach((el) => applySpotifyTrackTo(el, track));
}

/** État initial au chargement, avant le premier message WebSocket — best-effort. */
async function fetchInitialSpotifyTrack() {
    try {
        const res = await fetch('/api/spotify/now-playing');
        const data = await res.json();
        applySpotifyTrack(data.track || null);
    } catch (error) {
        // best-effort : un widget resterait alors sur son état "vide" par défaut jusqu'au
        // prochain message WebSocket, sans casser le reste de la page.
    }
}

function applyBottomBarContentFromConfig() {
    const cfg = getOverlayConfig();
    const content = cfg.panels?.bottom?.content;
    if (!content) return;

    const infoTexts = Array.isArray(content.infoTexts) ? content.infoTexts : null;
    const scrollingText = (typeof content.scrollingText === 'string') ? content.scrollingText : null;

    document.querySelectorAll('.bottom-bar').forEach(bar => {
        // 1) Texte défilant (index.html)
        if (scrollingText) {
            const scrollEl = bar.querySelector('.scroll-content');
            if (scrollEl) {
                scrollEl.textContent = scrollingText;
            }
        }

        // 2) Items info (index.html: .info-item) – on remplit les textes dans l'ordre
        if (infoTexts && infoTexts.length > 0) {
            const infoItemTextEls = bar.querySelectorAll('.info-item .info-text');
            if (infoItemTextEls && infoItemTextEls.length > 0) {
                infoItemTextEls.forEach((el, idx) => {
                    if (typeof infoTexts[idx] === 'string') {
                        el.textContent = infoTexts[idx];
                    }
                });
                return;
            }

            // 3) Items info (starting/ending.html: .bottom-info > .info-text)
            const directTextEls = bar.querySelectorAll('.bottom-info > .info-text, .bottom-info > span.info-text, .bottom-info > div.info-text');
            if (directTextEls && directTextEls.length > 0) {
                directTextEls.forEach((el, idx) => {
                    if (typeof infoTexts[idx] === 'string') {
                        el.textContent = infoTexts[idx];
                    }
                });
            }
        }
    });
}

function shouldLog(level) {
    const cfg = getOverlayConfig();
    const dbg = cfg.debug || {};
    if (!dbg.enabled) return false;
    const order = { error: 0, warn: 1, info: 2, debug: 3 };
    const configured = (dbg.logLevel && order[dbg.logLevel] !== undefined) ? order[dbg.logLevel] : order.info;
    const requested = (level && order[level] !== undefined) ? order[level] : order.info;
    return requested <= configured;
}

function log(level, ...args) {
    if (!shouldLog(level)) return;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(...args);
}

// Variables globales
const alertQueue = [];
let isProcessingAlerts = false; // Variable pour éviter les traitements parallèles
const badgeUrlMapping = {
    'broadcaster': {},
    'subscriber': {},
    'global': {}
};

// ========== GESTION DES ALERTES ==========

function showAlert(type, username, message = '', amount = '') {
    return new Promise((resolve) => {
        const cfg = getOverlayConfig();
        if (cfg.alerts && cfg.alerts.enabled === false) {
            resolve();
            return;
        }

        const alertContainer = document.getElementById('alertContainer');
        const alertIcon = document.getElementById('alertIcon');
        const alertMedia = document.getElementById('alertMedia');
        const alertTitle = document.getElementById('alertTitle');
        const alertUsername = document.getElementById('alertUsername');
        const alertMessage = document.getElementById('alertMessage');
        const alertAmount = document.getElementById('alertAmount');

        // Pages sans conteneur d'alertes (scènes personnalisées /scene/<id>, pages starting/
        // pause/ending) : les événements Twitch arrivent quand même par WebSocket — ignorer
        // proprement plutôt que de planter sur alertIcon.innerHTML.
        if (!alertContainer || !alertIcon) {
            resolve();
            return;
        }

        // Utiliser la config pour les types d'alertes
        const typesCfg = (cfg.alerts && cfg.alerts.types) ? cfg.alerts.types : {};
        const config = typesCfg[type] || typesCfg.follow;
        if (!config) {
            resolve();
            return;
        }

        // Configuration de l'alerte
        alertIcon.innerHTML = config.icon;
        alertTitle.textContent = config.title;
        alertUsername.textContent = username || 'Anonymous';
        alertMessage.textContent = message || config.defaultMessage;

        // Couleur d'accent par type (bordure, badge icône, titre, glow) — voir --alert-accent
        // dans overlay-common.css. Le fond du cadre reprend en plus un léger dégradé
        // gradientStart -> gradientEnd (repli sur border si absent des deux côtés).
        alertContainer.style.setProperty('--alert-accent', config.border || 'var(--theme-primary, #a855f7)');
        const gradientStartRgb = hexToRgbTriplet(config.gradientStart) || hexToRgbTriplet(config.border);
        const gradientEndRgb = hexToRgbTriplet(config.gradientEnd) || hexToRgbTriplet(config.border);
        if (gradientStartRgb) alertContainer.style.setProperty('--alert-gradient-start-rgb', gradientStartRgb);
        if (gradientEndRgb) alertContainer.style.setProperty('--alert-gradient-end-rgb', gradientEndRgb);

        // Média "hero" (image/GIF uploadé depuis /settings) : bascule la mise en page en grand
        // format si présent, sinon on garde le style compact avec icône (voir .has-media dans
        // overlay-common.css).
        if (alertMedia) {
            if (config.media) {
                // Re-fit une fois le média chargé : sa hauteur naturelle change la taille de la
                // boîte, donc l'échelle qui la fait tenir dans la zone.
                alertMedia.onload = () => fitAlertBox();
                alertMedia.src = config.media;
                alertContainer.classList.add('has-media');
            } else {
                alertMedia.onload = null;
                alertMedia.removeAttribute('src');
                alertContainer.classList.remove('has-media');
            }
        }

        // Animation d'entrée/sortie par type (fade/slide/zoom/bounce, voir .anim-* dans
        // overlay-common.css) — une seule classe anim-* à la fois sur le conteneur.
        alertContainer.classList.remove('anim-fade', 'anim-slide', 'anim-zoom', 'anim-bounce');
        alertContainer.classList.add(`anim-${config.animationStyle || 'fade'}`);

        if (amount) {
            alertAmount.textContent = amount;
            alertAmount.style.display = 'inline-block';
        } else {
            alertAmount.style.display = 'none';
        }

        // Son personnalisé pour ce type d'alerte (uploadé depuis /settings), best-effort : ne
        // doit jamais bloquer l'alerte visuelle si le fichier est absent ou si le navigateur
        // refuse la lecture automatique.
        if (config.sound) {
            const audio = new Audio(config.sound);
            audio.volume = Math.min(1, Math.max(0, cfg.alerts?.soundVolume ?? 0.8));
            audio.play().catch(() => {});
        }

        // Afficher l'alerte — l'ajustement à la zone se mesure une fois .show posé (display:flex,
        // sinon toutes les mesures valent 0).
        alertContainer.classList.remove('hide');
        alertContainer.classList.add('show');
        alertContainer.style.opacity = 1;
        fitAlertBox();

        // Ajouter l'effet de confettis avec la config, assortis à la couleur de l'alerte
        if (typeof confetti !== 'undefined' && (!cfg.alerts || cfg.alerts.confettiEnabled !== false)) {
            confetti({
                particleCount: cfg.alerts?.confettiParticles ?? 300,
                startVelocity: cfg.alerts?.confettiVelocity ?? 50,
                spread: cfg.alerts?.confettiSpread ?? 360,
                ticks: cfg.alerts?.confettiTicks ?? 250,
                colors: config.border ? [config.border, '#ffffff'] : undefined,
                origin: { y: 0.5 }
            });
        }

        // Cacher l'alerte après la durée configurée
        setTimeout(() => {
            alertContainer.classList.add('hide');
            alertContainer.style.opacity = 0;
            setTimeout(resolve, 600);
        }, cfg.alerts?.duration ?? 6000);
    });
}

/**
 * Met la boîte d'alerte (#alertBox, composée à taille naturelle fixe en px — voir .alert-box
 * dans overlay-common.css) à l'échelle du plus grand format qui tient dans sa zone
 * (#alertContainer, le cadre positionné depuis l'éditeur de scène). Agrandit comme réduit :
 * une grande zone donne une grande alerte. Rappelée au chargement du média (sa hauteur
 * naturelle n'est connue qu'à ce moment-là — sans ça un GIF encore non chargé donnerait une
 * boîte mesurée trop courte, donc une échelle trop grande).
 */
function fitAlertBox() {
    const zone = document.getElementById('alertContainer');
    const box = document.getElementById('alertBox');
    if (!zone || !box) return;
    box.style.zoom = '';
    const zoneWidth = zone.clientWidth;
    const zoneHeight = zone.clientHeight;
    const boxWidth = box.offsetWidth;
    const boxHeight = box.offsetHeight;
    if (!zoneWidth || !zoneHeight || !boxWidth || !boxHeight) return;
    box.style.zoom = String(Math.max(0.1, Math.min(zoneWidth / boxWidth, zoneHeight / boxHeight)));
}

function processAlertQueue() {
    // Si on traite déjà des alertes ou qu'il n'y en a pas, on arrête
    if (isProcessingAlerts || alertQueue.length === 0) {
        return;
    }

    isProcessingAlerts = true;
    const currentAlert = alertQueue.shift();

    showAlert(...currentAlert).then(() => {
        isProcessingAlerts = false;

        // Traiter la prochaine alerte après un petit délai
        const cfg = getOverlayConfig();
        const queueDelay = cfg.alerts?.queueDelay ?? 500;
        setTimeout(() => {
            processAlertQueue();
        }, queueDelay);
    });
}

function addAlertsToQueue(type, username, message = '', amount = '') {
    alertQueue.push([type, username, message, amount]);

    // Démarrer le traitement seulement si on ne traite pas déjà
    if (!isProcessingAlerts) {
        processAlertQueue();
    }
}

// ========== GESTION DU CHAT ==========

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function addChatMessage(username, message, color, badgeUrls) {
    const cfg = getOverlayConfig();
    const container = document.getElementById('chatContainer');
    if (!container) return;

    const messageElement = document.createElement('div');
    messageElement.className = 'chat-message';
    messageElement.innerHTML = `
        <div class="chat-username" style="color: ${color || cfg.chat?.defaultColor || '#3b82f6'};">
            ${badgeUrls ? Object.entries(badgeUrls).map(([key, url]) => `<img src="${url}" alt="${key} badge" class="chat-badge">`).join('') : ''}
            ${escapeHtml(username || 'Anonymous')}
        </div>
        <div class="chat-text">${escapeHtml(message || '')}</div>
    `;
    container.appendChild(messageElement);
    if (cfg.chat?.scrollBehavior === 'smooth') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    } else {
        container.scrollTop = container.scrollHeight;
    }
}

// ========== GESTION DES BADGES ==========

async function fetchBadges(broadcasterId) {
    try {
        const cfg = getOverlayConfig();
        const host = cfg.server?.host ?? 'localhost';
        const port = cfg.server?.port ?? 8080;
        const baseUrl = `http://${host}:${port}`;
        const response = await fetch(`${baseUrl}/badges/${broadcasterId}`);
        const responseGlobal = await fetch(`${baseUrl}/badgesglobal`);

        const data = await response.json();

        // Traitement des badges pour le diffuseur
        data.data.forEach(badgeSet => {
            const setId = badgeSet.set_id;
            badgeSet.versions.forEach(badge => {
                badgeUrlMapping[setId] = badgeUrlMapping[setId] || {};
                badgeUrlMapping[setId][badge.id] = badge.image_url_1x;
            });
        });

        const globalData = await responseGlobal.json();

        // Traitement des badges globaux
        globalData.data.forEach(badgeSet => {
            const setId = badgeSet.set_id;
            badgeSet.versions.forEach(badge => {
                badgeUrlMapping.global[`${setId}/${badge.id}`] = badge.image_url_1x;
            });
        });
    } catch (error) {
        console.error('Erreur lors du chargement des badges:', error);
    }
}

// ========== WEBSOCKET ==========

function initWebSocket() {
    const cfg = getOverlayConfig();
    const host = cfg.server?.host ?? 'localhost';
    const wsPort = cfg.server?.wsPort ?? 8081;
    const ws = new WebSocket(`ws://${host}:${wsPort}`);

    ws.onopen = function () {
        if (cfg.debug?.showWebSocketLogs !== false) {
            log('info', 'WebSocket connecté');
        }
    };

    ws.onmessage = function (event) {
        const data = JSON.parse(event.data);

        if (data.type === 'config-updated') {
            // Réglages changés depuis /settings : réappliquer sans recharger la page.
            // Les alertes lisent déjà getOverlayConfig() à chaque déclenchement, donc suivent
            // automatiquement. Les compteurs/toggles d'animations, eux, ne sont posés qu'au
            // chargement de la page et ne peuvent pas être réappliqués ici.
            globalThis.OVERLAY_CONFIG = data.config;
            applyThemeFromConfig();
            applySceneSettingsFromConfig();
            applyBottomBarContentFromConfig();
            applyBottomBarVisibilityFromConfig();
            applyChatVisibilityFromConfig();
            applyLayoutFromConfig();
            applyTextOverridesFromConfig();
            renderCustomTextsFromConfig();
            return;
        }

        if (data.type === 'spotify-track-updated') {
            applySpotifyTrack(data.track);
            return;
        }

        if (data.type === 'show-panel') {
            // Déclenchement direct (page /tests, plugin Stream Deck...) — pas de simulation de
            // message de chat. showInfoPanel/showBottomBar sont définis dans index.js (index.html
            // uniquement) ; sur les autres pages ces fonctions n'existent pas, on ne fait rien.
            // force=true : un déclenchement manuel doit s'afficher même si le panneau est
            // désactivé dans les réglages (seul le cycle automatique respecte ce réglage).
            if (data.panel === 'left' && typeof showInfoPanel === 'function') showInfoPanel(true);
            if (data.panel === 'bottom' && typeof showBottomBar === 'function') showBottomBar(true);
            return;
        }

        if (data.type === 'message') {
            if (data.message.startsWith('!')) {
                if (data.message === '!info' && typeof showInfoPanel === 'function') {
                    showInfoPanel();
                }
                return;
            } else {
                const userBadges = data.badges;
                const badgeUrls = {};

                for (const [badgeKey, badgeValue] of Object.entries(userBadges)) {
                    if (badgeUrlMapping[badgeKey] && badgeUrlMapping[badgeKey][badgeValue]) {
                        badgeUrls[badgeKey] = badgeUrlMapping[badgeKey][badgeValue];
                    } else if (badgeUrlMapping.global && badgeUrlMapping.global[`${badgeKey}/${badgeValue}`]) {
                        badgeUrls[badgeKey] = badgeUrlMapping.global[`${badgeKey}/${badgeValue}`];
                    } else {
                        console.warn(`Badge non trouvé pour ${badgeKey}/${badgeValue}`);
                    }
                }

                addChatMessage(data.username, data.message, data.color, badgeUrls);
            }
        }
        else if (data.type === 'channel.raid') {
            const raidMessage = `Raid de ${data.data.from_broadcaster_user_name}`;
            const raidAmount = data.data.viewers ? ` Bienvenue au ${data.data.viewers} viewers` : '';
            addAlertsToQueue('raid', raidMessage, '', raidAmount);
        }
        else if (data.type === 'channel.subscribe' && !data.data.is_gift) {
            const message = data.data.message ? data.data.message.text || '' : '';
            const subMessage = data.data.cumulative_months ? `Merci pour le resub ! ${data.data.cumulative_months} mois` : 'Merci pour le sub !';
            addAlertsToQueue('sub', data.data.user_name, subMessage, message);
        }
        else if (data.type === 'channel.subscribe' && data.data.is_gift) {
            addAlertsToQueue('sub', data.data.user_name, `Merci pour le sub gift !`, '');
        }
        else if (data.type === 'channel.subscription.gift') {
            addAlertsToQueue('subs_gift', data.data.user_name, `Merci pour les ${data.data.total} sub gifts !`, '');
        }
        else if (data.type === 'channel.cheer') {
            var cheerUserName = data.data.is_anonymous ? 'Anonymous' : data.data.user_name;
            addAlertsToQueue('bits', cheerUserName, `Merci pour les  ${data.data.bits} bits !`, data.data.message ? data.data.message : '');
        }
        else if (data.type === 'channel.follow') {
            addAlertsToQueue('follow', data.data.user_name, `Merci pour le follow !`);
        }
    };

    ws.onerror = function (error) {
        if (cfg.debug?.showWebSocketLogs !== false) {
            log('error', 'Erreur WebSocket:', error);
        }
    };

    ws.onclose = function () {
        if (cfg.debug?.showWebSocketLogs !== false) {
            log('info', 'WebSocket fermé');
        }
    };

    return ws;
}

// ========== ANIMATIONS COMMUNES ==========

function createParticles(count = 30, duration = [5, 8]) {
    const particlesContainer = document.getElementById('particles');
    if (!particlesContainer) return;

    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * duration[1] + 's';
        particle.style.animationDuration = (Math.random() * (duration[1] - duration[0]) + duration[0]) + 's';
        particlesContainer.appendChild(particle);
    }
}

function createStars(count = 80, duration = [1.5, 2.5]) {
    const starsContainer = document.getElementById('stars');
    if (!starsContainer) return;

    for (let i = 0; i < count; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 100 + '%';
        star.style.animationDelay = Math.random() * (duration[1] ?? 2.5) + 's';
        const min = duration[0] ?? 1.5;
        const max = duration[1] ?? 2.5;
        star.style.animationDuration = (Math.random() * (max - min) + min) + 's';
        starsContainer.appendChild(star);
    }
}

function createMeteors(count = 8, duration = [2, 3]) {
    const meteorsContainer = document.getElementById('meteors');
    if (!meteorsContainer) return;

    for (let i = 0; i < count; i++) {
        const meteor = document.createElement('div');
        meteor.className = 'meteor';
        meteor.style.left = Math.random() * 100 + '%';
        meteor.style.animationDelay = Math.random() * (duration[1] ?? 3) + 's';
        const min = duration[0] ?? 2;
        const max = duration[1] ?? 3;
        meteor.style.animationDuration = (Math.random() * (max - min) + min) + 's';
        meteorsContainer.appendChild(meteor);
    }
}

function createCircuitLines(horizontal = 10, vertical = 8, duration = 6) {
    const circuitContainer = document.getElementById('circuitLines');
    if (!circuitContainer) return;

    // Lignes horizontales
    for (let i = 0; i < horizontal; i++) {
        const line = document.createElement('div');
        line.className = 'circuit-line horizontal';
        line.style.top = Math.random() * 100 + '%';
        line.style.left = Math.random() * 80 + '%';
        line.style.animationDelay = Math.random() * duration + 's';
        circuitContainer.appendChild(line);
    }

    // Lignes verticales
    for (let i = 0; i < vertical; i++) {
        const line = document.createElement('div');
        line.className = 'circuit-line vertical';
        line.style.left = Math.random() * 100 + '%';
        line.style.top = Math.random() * 80 + '%';
        line.style.animationDelay = Math.random() * duration + 's';
        circuitContainer.appendChild(line);
    }
}

// ========== LOGO DVD ANIMATION ==========

function initDVDLogo() {
    const cfg = getOverlayConfig();
    const logoContainer = document.getElementById('logoContainer');
    const dvdLogo = document.getElementById('dvdLogo');

    if (!logoContainer || !dvdLogo) return;

    // Désactivé : masquer explicitement, sinon le logo reste visible (figé au coin
    // haut-gauche, sa position CSS par défaut) faute de transform jamais appliqué.
    // La bascule de la scène est prioritaire quand elle est renseignée (comme les autres effets —
    // voir animEnabled() dans initCommonOverlay) ; sinon réglages globaux pour les pages
    // intégrées, coupé pour une scène personnalisée.
    const dvdPageKey = getThemeKeyFromLocation();
    const dvdSceneFx = cfg.scenes?.[dvdPageKey]?.effects || {};
    const dvdEnabled = (dvdSceneFx.dvdLogo !== undefined)
        ? !!dvdSceneFx.dvdLogo
        : (OVERLAY_BUILTIN_PAGES.includes(dvdPageKey) && cfg.animations?.enabled !== false && cfg.animations?.dvdLogo?.enabled !== false);
    if (!dvdEnabled) {
        logoContainer.style.display = 'none';
        return;
    }
    logoContainer.style.display = '';

    const rectWidth = 1916;
    const rectHeight = 1075;
    const rectTop = 0;
    const rectLeft = 0;
    const logoWidth = 50;
    const logoHeight = 71.88;

    let posX = Math.random() * (rectWidth - logoWidth) + rectLeft;
    let posY = Math.random() * (rectHeight - logoHeight) + rectTop;
    const speed = cfg.animations?.dvdLogo?.speed ?? 2;
    let deltaX = speed;
    let deltaY = speed;

    function moveLogo() {
        posX += deltaX;
        posY += deltaY;

        if (posX <= rectLeft || posX >= rectWidth + rectLeft - logoWidth) {
            deltaX = -deltaX;
        }
        if (posY <= rectTop || posY >= rectHeight + rectTop - logoHeight) {
            deltaY = -deltaY;
        }

        logoContainer.style.transform = `translate(${posX}px, ${posY}px)`;
    }

    const updateInterval = cfg.animations?.dvdLogo?.updateInterval ?? 16;
    setInterval(moveLogo, updateInterval);
}

// ========== ANIMATION COMPTEURS ==========

function animateCounter(element, start, end, duration) {
    if (!element) return;

    const startTime = Date.now();

    function updateCounter() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeOutQuart = 1 - Math.pow(1 - progress, 4);
        const currentValue = Math.round(start + (end - start) * easeOutQuart);

        element.textContent = currentValue;

        if (progress < 1) {
            requestAnimationFrame(updateCounter);
        }
    }

    updateCounter();
}

// ========== INITIALISATION ==========

function initCommonOverlay() {
    const cfg = getOverlayConfig();

    // Thème (couleurs) + variables CSS
    applyThemeFromConfig();

    // Fond et halos d'ambiance des scènes personnalisées (no-op sur les pages intégrées)
    applySceneSettingsFromConfig();

    // Contenu bottom bar (textes centralisés)
    applyBottomBarContentFromConfig();

    // Panneaux statiques (starting/ending) : possibilité de les masquer via config
    applyBottomBarVisibilityFromConfig();

    // Boîte de chat (index.html) : possibilité de la masquer via config
    applyChatVisibilityFromConfig();

    // Positions/visibilité/textes custom posés depuis l'éditeur de scène (/scene-editor)
    applyLayoutFromConfig();
    captureDefaultTexts(); // avant le premier appel, sinon un texte déjà remplacé serait pris pour le défaut
    applyTextOverridesFromConfig();
    renderCustomTextsFromConfig();

    // État initial d'un éventuel widget Spotify — avant le premier message WebSocket, sans quoi
    // il resterait affiché "Rien en cours de lecture" jusqu'au prochain changement de morceau
    // (potentiellement plusieurs minutes). N'appelle l'API que si la page en a réellement un.
    if (document.querySelector('.spotify-widget')) {
        fetchInitialSpotifyTrack();
    }

    // Un badge marqué data-scene-scale-text (horloge, indicateur de pause...) contient une icône
    // FontAwesome chargée depuis un CDN externe : si applyLayoutFromConfig() tourne AVANT que cette
    // police ne finisse de charger, sa mesure de largeur "naturelle" (utilisée pour calculer le
    // facteur d'échelle du texte, voir plus haut) est capturée trop petite (icône en glyphe de
    // repli), faussant durablement le ratio pour toute la session. On relance donc une passe une
    // fois les polices confirmées chargées.
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => applyLayoutFromConfig());
    }

    // Charger les badges
    if (cfg.twitch?.broadcasterId) {
        fetchBadges(cfg.twitch.broadcasterId);
    }

    // Initialiser WebSocket
    initWebSocket();

    // Créer les animations de base. Chaque scène (intégrée ou personnalisée) peut surcharger
    // effet par effet via cfg.scenes[pageKey].effects ; un effet non renseigné retombe sur les
    // réglages d'animations globaux pour les pages intégrées, et sur "coupé" pour une scène
    // personnalisée (qui doit naître vierge). Les compteurs/durées restent ceux des réglages
    // globaux : pas de raison de les dupliquer par scène.
    const scenePageKey = getThemeKeyFromLocation();
    const sceneFx = cfg.scenes?.[scenePageKey]?.effects || {};
    const sceneIsBuiltin = OVERLAY_BUILTIN_PAGES.includes(scenePageKey);
    const animEnabled = (name) => (sceneFx[name] !== undefined)
        ? !!sceneFx[name]
        : (sceneIsBuiltin && cfg.animations?.enabled !== false && cfg.animations?.[name]?.enabled !== false);
    if (animEnabled('particles')) {
        createParticles(cfg.animations?.particles?.count ?? 30, cfg.animations?.particles?.duration ?? [5, 8]);
    }
    if (animEnabled('stars')) {
        createStars(cfg.animations?.stars?.count ?? 80, cfg.animations?.stars?.duration ?? [1.5, 2.5]);
    }
    if (animEnabled('meteors')) {
        createMeteors(cfg.animations?.meteors?.count ?? 8, cfg.animations?.meteors?.duration ?? [2, 3]);
    }
    if (animEnabled('circuitLines')) {
        createCircuitLines(
            cfg.animations?.circuitLines?.horizontal ?? 10,
            cfg.animations?.circuitLines?.vertical ?? 8,
            cfg.animations?.circuitLines?.duration ?? 6
        );
    }

    // Initialiser le logo DVD
    initDVDLogo();

    try {
        if (typeof globalThis !== 'undefined') {
            globalThis.__OVERLAY_COMMON_ANIMATIONS_DONE = true;
        }
    } catch (_) {
        // no-op
    }
}

// Auto-initialisation quand le DOM est chargé
document.addEventListener('DOMContentLoaded', initCommonOverlay);
