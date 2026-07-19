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

function getThemeKeyFromLocation() {
    const path = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname.toLowerCase() : '';
    if (path.endsWith('/starting.html') || path.endsWith('starting.html')) return 'starting';
    if (path.endsWith('/ending.html') || path.endsWith('ending.html')) return 'ending';
    if (path.endsWith('/pause.html') || path.endsWith('pause.html')) return 'pause';
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
    document.querySelectorAll('.chat-panel').forEach(el => {
        el.style.display = visible ? '' : 'none';
    });
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
                alertMedia.src = config.media;
                alertContainer.classList.add('has-media');
            } else {
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

        // Afficher l'alerte
        alertContainer.classList.remove('hide');
        alertContainer.classList.add('show');
        alertContainer.style.opacity = 1;

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
            applyBottomBarContentFromConfig();
            applyBottomBarVisibilityFromConfig();
            applyChatVisibilityFromConfig();
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
    if (cfg.animations?.enabled === false || cfg.animations?.dvdLogo?.enabled === false) {
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

    // Contenu bottom bar (textes centralisés)
    applyBottomBarContentFromConfig();

    // Panneaux statiques (starting/ending) : possibilité de les masquer via config
    applyBottomBarVisibilityFromConfig();

    // Boîte de chat (index.html) : possibilité de la masquer via config
    applyChatVisibilityFromConfig();

    // Charger les badges
    if (cfg.twitch?.broadcasterId) {
        fetchBadges(cfg.twitch.broadcasterId);
    }

    // Initialiser WebSocket
    initWebSocket();

    // Créer les animations de base
    if (cfg.animations?.enabled !== false) {
        if (cfg.animations?.particles?.enabled !== false) {
            createParticles(cfg.animations?.particles?.count ?? 30, cfg.animations?.particles?.duration ?? [5, 8]);
        }
        if (cfg.animations?.stars?.enabled !== false) {
            createStars(cfg.animations?.stars?.count ?? 80, cfg.animations?.stars?.duration ?? [1.5, 2.5]);
        }
        if (cfg.animations?.meteors?.enabled !== false) {
            createMeteors(cfg.animations?.meteors?.count ?? 8, cfg.animations?.meteors?.duration ?? [2, 3]);
        }
        if (cfg.animations?.circuitLines?.enabled !== false) {
            createCircuitLines(
                cfg.animations?.circuitLines?.horizontal ?? 10,
                cfg.animations?.circuitLines?.vertical ?? 8,
                cfg.animations?.circuitLines?.duration ?? 6
            );
        }
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
