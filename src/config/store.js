const fs = require('fs');
const path = require('path');

/**
 * Racine de l'application (dossier contenant server.js, src/, public/).
 */
function appRoot() {
    return path.join(__dirname, '..', '..');
}

const DEFAULTS_PATH = path.join(__dirname, 'defaults.json');

// ELECTRUM_CONFIG_DIR est positionné par electron/main.js pour pointer vers un dossier
// utilisateur inscriptible (app.getPath('userData')) une fois l'app installée — écrire à côté
// de l'exécutable ne fonctionne pas s'il est installé dans Program Files.
const CONFIG_DIR = process.env.ELECTRUM_CONFIG_DIR || path.join(appRoot(), 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'overlay-config.json');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) {
        return override !== undefined ? override : base;
    }
    const result = { ...base };
    for (const key of Object.keys(override)) {
        result[key] = deepMerge(base[key], override[key]);
    }
    return result;
}

/**
 * Comme deepMerge, mais mute `target` en place au lieu de retourner un nouvel objet.
 * Nécessaire pour que tous les modules ayant déjà fait `require('./config/store')`
 * voient immédiatement les changements de saveConfig() sans redémarrer le process.
 */
function deepMergeInPlace(target, source) {
    for (const key of Object.keys(source)) {
        if (isPlainObject(source[key]) && isPlainObject(target[key])) {
            deepMergeInPlace(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
    return target;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Lit les overrides utilisateur (config/overlay-config.json). Fichier absent = première utilisation.
 */
function loadOverrides() {
    try {
        return readJson(CONFIG_PATH);
    } catch (error) {
        return {};
    }
}

/**
 * Fusionne un patch partiel dans les overrides existants, l'écrit sur disque, et met à jour
 * en place l'objet config partagé pour que les changements soient visibles immédiatement
 * par tous les modules (utile pendant l'assistant de configuration, avant tout redémarrage).
 */
function saveConfig(partial) {
    const overrides = deepMerge(loadOverrides(), partial);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2), 'utf-8');
    deepMergeInPlace(config, partial);
    return config;
}

function isConfigured(cfg) {
    const twitch = cfg.twitch || {};
    return Boolean(twitch.CLIENT_ID && twitch.CLIENT_SECRET && twitch.BROADCASTER_ID && twitch.USER_ACCESS_TOKEN);
}

/**
 * Construit l'objet OVERLAY_CONFIG exposé au frontend (route /js/config.js et diffusion
 * WebSocket 'config-updated') — un seul endroit pour définir cette forme.
 */
function toFrontendConfig() {
    return {
        server: {
            host: config.server.HOST,
            port: config.server.PORT,
            wsPort: config.server.WS_PORT
        },
        twitch: {
            broadcasterId: config.twitch.BROADCASTER_ID
        },
        ...config.display
    };
}

const config = deepMerge(readJson(DEFAULTS_PATH), loadOverrides());

module.exports = config;
module.exports.saveConfig = saveConfig;
module.exports.isConfigured = () => isConfigured(config);
module.exports.getConfigPath = () => CONFIG_PATH;
module.exports.appRoot = appRoot;
module.exports.toFrontendConfig = toFrontendConfig;
