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
    router.post('/api/profiles/:id/layout/:page/:elementId', (req, res) => {
        try {
            const { top, left, hidden, width, height } = req.body || {};
            const patch = {};
            if (typeof top === 'number') patch.top = top;
            if (typeof left === 'number') patch.left = left;
            if (typeof hidden === 'boolean') patch.hidden = hidden;
            if (typeof width === 'number' && width > 0) patch.width = width;
            if (typeof height === 'number' && height > 0) patch.height = height;
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
            config.setProfileText(req.params.id, req.params.page, req.params.textId, '');
            if (req.params.id === config.getActiveProfileId()) {
                broadcastEvent({ type: 'config-updated', config: config.toFrontendConfig() });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // Éléments texte ajoutés librement depuis l'éditeur de scène.
    router.post('/api/profiles/:id/custom-text/:page', (req, res) => {
        try {
            const { text, top, left } = req.body || {};
            const elementId = config.addProfileCustomText(req.params.id, req.params.page, { text, top, left });
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
            const { text, top, left, width, height } = req.body || {};
            const patch = {};
            if (typeof text === 'string') patch.text = text;
            if (typeof top === 'number') patch.top = top;
            if (typeof left === 'number') patch.left = left;
            if (typeof width === 'number' && width > 0) patch.width = width;
            if (typeof height === 'number' && height > 0) patch.height = height;
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
