const express = require('express');
const multer = require('multer');
const config = require('../config/store');

// memoryStorage : on écrit nous-mêmes le buffer au bon endroit (config.setProfileAudio /
// config.importProfile gèrent déjà tout le chemin/extension), pas besoin du stockage disque
// temporaire par défaut de multer ni de son nettoyage.
const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('audio/')) {
            return cb(new Error('Le fichier doit être un son (audio/*)'));
        }
        cb(null, true);
    }
});

// Limite plus large que le son : les GIF animés dépassent facilement quelques Mo.
const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Le fichier doit être une image ou un GIF (image/*)'));
        }
        cb(null, true);
    }
});

// Limite plus large : un profil exporté peut embarquer jusqu'à 5 sons encodés en base64.
const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

function multerErrorMessage(err, maxLabel) {
    return err.code === 'LIMIT_FILE_SIZE' ? `Fichier trop volumineux (max ${maxLabel})` : err.message;
}

/**
 * Routes de gestion des profils (display + sons d'alerte par type). Un seul profil actif à la
 * fois ; l'activation diffuse 'config-updated' comme /api/settings, avec les mêmes limites
 * (couleurs/textes/sons en direct, animations au prochain rafraîchissement de la source OBS).
 */
function createProfilesRoutes(broadcastEvent) {
    const router = express.Router();

    router.get('/api/profiles', (req, res) => {
        res.json({ activeId: config.getActiveProfileId(), profiles: config.listProfiles() });
    });

    router.post('/api/profiles', (req, res) => {
        try {
            const body = req.body || {};
            const profile = config.createProfile(body.name, body.basedOn);
            res.json({ ok: true, profile });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Crée les profils de thème (couleurs) prêts à l'emploi qui n'existent pas encore — voir
    // config.ensureThemePresetProfiles(). Ne touche jamais un profil existant.
    router.post('/api/profiles/seed-theme-presets', (req, res) => {
        try {
            const created = config.ensureThemePresetProfiles();
            res.json({ ok: true, created });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.post('/api/profiles/:id/activate', (req, res) => {
        try {
            config.setActiveProfile(req.params.id);
            broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.put('/api/profiles/:id', (req, res) => {
        try {
            const profile = config.renameProfile(req.params.id, (req.body || {}).name);
            res.json({ ok: true, profile });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/api/profiles/:id', (req, res) => {
        try {
            config.deleteProfile(req.params.id);
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.post('/api/profiles/:id/audio/:alertType', (req, res) => {
        audioUpload.single('file')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: multerErrorMessage(err, '5 Mo') });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'Fichier audio manquant' });
            }
            try {
                config.setProfileAudio(req.params.id, req.params.alertType, {
                    filename: req.file.originalname,
                    mimeType: req.file.mimetype,
                    buffer: req.file.buffer
                });
                if (req.params.id === config.getActiveProfileId()) {
                    broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
                }
                res.json({ ok: true });
            } catch (error) {
                res.status(400).json({ error: error.message });
            }
        });
    });

    router.delete('/api/profiles/:id/audio/:alertType', (req, res) => {
        try {
            config.deleteProfileAudio(req.params.id, req.params.alertType);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Sert le fichier son binaire d'un profil — c'est l'URL posée dans
    // cfg.alerts.types[type].sound (voir config.toFrontendConfig()) et lue par les overlays.
    router.get('/api/profiles/:id/audio/:alertType', (req, res) => {
        const info = config.getProfileAudioFilePath(req.params.id, req.params.alertType);
        if (!info) {
            return res.sendStatus(404);
        }
        res.type(info.mimeType || 'application/octet-stream');
        res.sendFile(info.path, (error) => {
            if (error && !res.headersSent) res.sendStatus(404);
        });
    });

    router.post('/api/profiles/:id/media/:alertType', (req, res) => {
        mediaUpload.single('file')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: multerErrorMessage(err, '10 Mo') });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'Fichier image/GIF manquant' });
            }
            try {
                config.setProfileMedia(req.params.id, req.params.alertType, {
                    filename: req.file.originalname,
                    mimeType: req.file.mimetype,
                    buffer: req.file.buffer
                });
                if (req.params.id === config.getActiveProfileId()) {
                    broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
                }
                res.json({ ok: true });
            } catch (error) {
                res.status(400).json({ error: error.message });
            }
        });
    });

    router.delete('/api/profiles/:id/media/:alertType', (req, res) => {
        try {
            config.deleteProfileMedia(req.params.id, req.params.alertType);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Sert le média "hero" (image/GIF) d'un profil — URL posée dans cfg.alerts.types[type].media.
    router.get('/api/profiles/:id/media/:alertType', (req, res) => {
        const info = config.getProfileMediaFilePath(req.params.id, req.params.alertType);
        if (!info) {
            return res.sendStatus(404);
        }
        res.type(info.mimeType || 'application/octet-stream');
        res.sendFile(info.path, (error) => {
            if (error && !res.headersSent) res.sendStatus(404);
        });
    });

    // Position/taille/visibilité custom d'un élément déplaçable (éditeur de scène) — patch partiel
    // { top?, left?, hidden?, width?, height? } en % (vh/vw pour les 4). width/height sont de
    // vraies dimensions CSS (pas un transform:scale) : le contenu (texte, icônes) ne se déforme
    // pas, il dispose juste de plus/moins d'espace — séparés pour permettre un redimensionnement
    // horizontal, vertical, ou libre selon la poignée utilisée. Ne recrée jamais l'entrée de zéro :
    // déplacer un élément masqué le laisse masqué, et inversement.
    // Couleurs de thème surchargées PAR ÉLÉMENT (variables CSS --theme-* posées localement sur
    // l'élément, voir applyLayoutFromConfig) + échelle visuelle (zoom, en %).
    const ELEMENT_STYLE_COLOR_KEYS = ['primary', 'secondary', 'text', 'panelBg', 'panelBorder'];

    // Positions bornées à [-100,200] (% de la hauteur/largeur d'écran). top/left désignent le coin
    // HAUT-GAUCHE : borner à 0 rendait impossible de faire dépasser un élément par le haut ou par la
    // gauche (alors que left:100 le sortait déjà entièrement à droite) — d'où ces bornes
    // symétriques, larges d'un écran de chaque côté, de quoi sortir complètement n'importe quel
    // élément par n'importe quel bord. Ce qui dépasse est simplement rogné : les éléments sont en
    // position:fixed dans un body 100vw/100vh en overflow:hidden, donc la page reste exactement à la
    // taille de la source navigateur OBS (1920x1080), sans scroll ni agrandissement du cadre capturé.
    // Les bornes restent là uniquement pour rejeter les valeurs aberrantes (ancien bug de
    // compensation de drag, qui enregistrait des positions type 114vh) ; un élément volontairement
    // sorti du cadre reste récupérable via le bouton « Recentrer » de l'éditeur de scène.
    const clampPercent = (v) => Math.min(200, Math.max(-100, v));

    router.post('/api/profiles/:id/layout/:page/:elementId', (req, res) => {
        try {
            const { top, left, hidden, width, height, scale } = req.body || {};
            const patch = {};
            if (typeof top === 'number') patch.top = clampPercent(top);
            if (typeof left === 'number') patch.left = clampPercent(left);
            if (typeof hidden === 'boolean') patch.hidden = hidden;
            if (typeof width === 'number' && width > 0) patch.width = width;
            if (typeof height === 'number' && height > 0) patch.height = height;
            if (typeof scale === 'number') patch.scale = Math.max(25, Math.min(400, scale));
            for (const key of ELEMENT_STYLE_COLOR_KEYS) {
                if (typeof (req.body || {})[key] === 'string') patch[key] = req.body[key];
            }
            config.updateProfileElementLayout(req.params.id, req.params.page, req.params.elementId, patch);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Retire tout override (position + visibilité) — revient à la position/visibilité par défaut.
    router.delete('/api/profiles/:id/layout/:page/:elementId', (req, res) => {
        try {
            config.resetProfileElementLayout(req.params.id, req.params.page, req.params.elementId);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Override de texte d'un élément statique (titre, sous-titre, en-tête de chat...).
    router.post('/api/profiles/:id/text/:page/:textId', (req, res) => {
        try {
            const { value } = req.body || {};
            config.setProfileText(req.params.id, req.params.page, req.params.textId, typeof value === 'string' ? value : '');
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/api/profiles/:id/text/:page/:textId', (req, res) => {
        try {
            config.resetProfileText(req.params.id, req.params.page, req.params.textId);
            config.resetProfileTextStyle(req.params.id, req.params.page, req.params.textId);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Style (taille en vh, police) du même texte statique — endpoint séparé de son contenu, car
    // stocké séparément (voir setProfileTextStyle dans store.js). Patch partiel : n'envoyer que
    // le champ modifié suffit. La réinitialisation passe par le DELETE de /text/... ci-dessus,
    // qui remet contenu ET style à leur valeur d'origine (un seul bouton ↺ dans l'éditeur).
    router.post('/api/profiles/:id/text-style/:page/:textId', (req, res) => {
        try {
            const { size, font } = req.body || {};
            const patch = {};
            // `undefined` (et non "absent du patch") est ce qui EFFACE un réglage : le champ vidé
            // dans l'éditeur envoie size:0 / font:"" pour revenir au style CSS de la page, alors
            // qu'une clé absente doit, elle, laisser le réglage existant intact (patch partiel).
            if (typeof size === 'number') patch.size = size > 0 ? Math.min(30, size) : undefined;
            if (typeof font === 'string') patch.font = (font === 'baron' || font === 'inter') ? font : undefined;
            config.setProfileTextStyle(req.params.id, req.params.page, req.params.textId, patch);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Éléments ajoutés librement depuis l'éditeur de scène (texte, image, boîte, horloge —
    // voir CUSTOM_ELEMENT_TYPES dans store.js ; type absent/inconnu = texte, pour compat).
    router.post('/api/profiles/:id/custom-text/:page', (req, res) => {
        try {
            const { type, text, url, color, top, left } = req.body || {};
            const elementId = config.addProfileCustomText(req.params.id, req.params.page, { type, text, url, color, top, left });
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true, elementId });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.patch('/api/profiles/:id/custom-text/:page/:elementId', (req, res) => {
        try {
            const {
                text, url, color, top, left, width, height, size, font, glow, opacity, radius, scale,
                textScale, speed,
                layout, showFunctionRow, showDigitRow, showMovement, showModifiers, showArrows, showMouse
            } = req.body || {};
            const patch = {};
            if (typeof text === 'string') patch.text = text;
            if (typeof url === 'string') patch.url = url;
            if (typeof color === 'string') patch.color = color;
            if (typeof top === 'number') patch.top = clampPercent(top);
            if (typeof left === 'number') patch.left = clampPercent(left);
            if (typeof width === 'number' && width > 0) patch.width = width;
            if (typeof height === 'number' && height > 0) patch.height = height;
            // Style (texte/horloge : taille en vh, police, effet néon — image/boîte : opacité %,
            // arrondi px). Bornés ici plutôt que côté rendu, pour que la config stockée reste saine.
            if (typeof size === 'number' && size > 0) patch.size = Math.min(30, size);
            if (font === 'baron' || font === 'inter') patch.font = font;
            if (typeof glow === 'boolean') patch.glow = glow;
            if (typeof opacity === 'number') patch.opacity = Math.max(0, Math.min(100, opacity));
            if (typeof radius === 'number') patch.radius = Math.max(0, Math.min(200, radius));
            if (typeof scale === 'number') patch.scale = Math.max(25, Math.min(400, scale));
            // Taille du TEXTE des widgets (chat, Spotify) en % — distincte de `size` (en vh, bornée
            // à 30 pour texte/horloge) et de `scale` (zoom de tout le widget, contenant compris) :
            // ici seules les polices internes grossissent, le cadre du widget ne bouge pas.
            if (typeof textScale === 'number') patch.textScale = Math.max(25, Math.min(400, textScale));
            // Vitesse de défilement du bandeau de chat (chatTicker), en px/s.
            if (typeof speed === 'number') patch.speed = Math.max(10, Math.min(400, speed));
            // Plateau clavier/souris ("keys") : disposition affichée (voir buildKeysBlocks dans
            // overlay-common.js) et blocs de touches activables indépendamment.
            if (layout === 'qwerty' || layout === 'azerty') patch.layout = layout;
            if (typeof showFunctionRow === 'boolean') patch.showFunctionRow = showFunctionRow;
            if (typeof showDigitRow === 'boolean') patch.showDigitRow = showDigitRow;
            if (typeof showMovement === 'boolean') patch.showMovement = showMovement;
            if (typeof showModifiers === 'boolean') patch.showModifiers = showModifiers;
            if (typeof showArrows === 'boolean') patch.showArrows = showArrows;
            if (typeof showMouse === 'boolean') patch.showMouse = showMouse;
            config.updateProfileCustomText(req.params.id, req.params.page, req.params.elementId, patch);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/api/profiles/:id/custom-text/:page/:elementId', (req, res) => {
        try {
            config.removeProfileCustomText(req.params.id, req.params.page, req.params.elementId);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Scènes personnalisées (pages d'overlay supplémentaires servies sur /scene/<sceneId>).
    router.post('/api/profiles/:id/scenes', (req, res) => {
        try {
            const sceneId = config.addProfileScene(req.params.id, (req.body || {}).name);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true, sceneId });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // 'theme' : fond par défaut de la page (pages intégrées uniquement — pour une scène
    // personnalisée il équivaut à 'transparent' côté rendu).
    const SCENE_BG_MODES = ['theme', 'transparent', 'color', 'gradient'];
    const SCENE_EFFECTS = ['particles', 'stars', 'meteors', 'circuitLines', 'dvdLogo'];

    router.patch('/api/profiles/:id/scenes/:sceneId', (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (typeof body.name === 'string') patch.name = body.name;
            if (body.background && typeof body.background === 'object') {
                patch.background = {};
                if (SCENE_BG_MODES.includes(body.background.mode)) patch.background.mode = body.background.mode;
                if (typeof body.background.color === 'string') patch.background.color = body.background.color;
                if (typeof body.background.color2 === 'string') patch.background.color2 = body.background.color2;
            }
            if (body.effects && typeof body.effects === 'object') {
                patch.effects = {};
                for (const key of SCENE_EFFECTS) {
                    if (typeof body.effects[key] === 'boolean') patch.effects[key] = body.effects[key];
                }
            }
            config.updateProfileScene(req.params.id, req.params.sceneId, patch);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/api/profiles/:id/scenes/:sceneId', (req, res) => {
        try {
            config.removeProfileScene(req.params.id, req.params.sceneId);
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    const THEME_FIELDS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'mutedText', 'panelBg', 'panelBorder'];

    // Couleurs de thème d'une page, éditées directement depuis l'éditeur de scène — patch
    // partiel, fusionné par saveProfileDisplay() qui gère déjà correctement l'imbrication
    // (les couleurs non fournies restent inchangées).
    router.patch('/api/profiles/:id/theme/:page', (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            for (const field of THEME_FIELDS) {
                if (typeof body[field] === 'string') patch[field] = body[field];
            }
            config.saveProfileDisplay(req.params.id, { themes: { [req.params.page]: patch } });
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Listes de messages rotatifs de la page pause (défilement + barre de progression), éditées
    // depuis l'éditeur de scène — chaque tableau remplace entièrement le précédent (pas de fusion
    // par index, sinon impossible de raccourcir la liste). Un tableau vide est légitime : pause.js
    // retombe alors sur ses messages par défaut plutôt que d'afficher une page sans texte.
    router.patch('/api/profiles/:id/pause-messages', (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if (Array.isArray(body.messages)) {
                patch.messages = body.messages.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
            }
            if (Array.isArray(body.progressMessages)) {
                patch.progressMessages = body.progressMessages.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
            }
            config.saveProfileDisplay(req.params.id, { pause: patch });
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.get('/api/profiles/:id/export', (req, res) => {
        let profile;
        try {
            profile = config.getProfileFull(req.params.id);
        } catch (error) {
            return res.status(404).json({ error: 'Profil introuvable' });
        }

        const audio = {};
        for (const type of config.ALERT_TYPES) {
            const entry = profile.audio && profile.audio[type];
            if (!entry) continue;
            const data = config.readProfileAudioBuffer(req.params.id, type);
            if (!data) continue;
            audio[type] = {
                filename: entry.filename,
                mimeType: entry.mimeType,
                dataBase64: data.buffer.toString('base64')
            };
        }

        const media = {};
        for (const type of config.ALERT_TYPES) {
            const entry = profile.media && profile.media[type];
            if (!entry) continue;
            const data = config.readProfileMediaBuffer(req.params.id, type);
            if (!data) continue;
            media[type] = {
                filename: entry.filename,
                mimeType: entry.mimeType,
                dataBase64: data.buffer.toString('base64')
            };
        }

        const exportPayload = {
            exportedFrom: 'ElectrumOverlay',
            exportVersion: 1,
            name: profile.name,
            display: profile.display,
            audio,
            media
        };

        const safeName = (profile.name || 'profil').replace(/[^a-z0-9_-]+/gi, '_');
        res.set('Content-Disposition', `attachment; filename="${safeName}.electrumprofile.json"`);
        res.type('application/json');
        res.send(JSON.stringify(exportPayload, null, 2));
    });

    router.post('/api/profiles/import', (req, res) => {
        importUpload.single('file')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: multerErrorMessage(err, '20 Mo') });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'Fichier de profil manquant' });
            }
            try {
                const payload = JSON.parse(req.file.buffer.toString('utf-8'));
                const profile = config.importProfile(payload);
                res.json({ ok: true, profile });
            } catch (error) {
                res.status(400).json({ error: 'Fichier de profil invalide : ' + error.message });
            }
        });
    });

    return router;
}

module.exports = createProfilesRoutes;
