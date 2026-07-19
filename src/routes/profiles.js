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
