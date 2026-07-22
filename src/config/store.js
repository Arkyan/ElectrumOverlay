const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');

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

const DEFAULTS = readJson(DEFAULTS_PATH);
const THEME_PRESETS = readJson(path.join(__dirname, 'theme-presets.json'));

// Types d'alertes valides, dérivés de defaults.json plutôt que recopiés en dur ailleurs
// (settings.js et routes/profiles.js s'appuient dessus pour valider les uploads de sons).
const ALERT_TYPES = Object.keys(DEFAULTS.display.alerts.types);

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

function writeOverrides(overrides) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2), 'utf-8');
}

/**
 * Fusionne un patch partiel dans les overrides existants, l'écrit sur disque, et met à jour
 * en place l'objet config partagé pour que les changements soient visibles immédiatement
 * par tous les modules (utile pendant l'assistant de configuration, avant tout redémarrage).
 * Ne concerne plus `display` (voir saveActiveProfileDisplay) : uniquement twitch/ngrok/trucky/server.
 */
function saveConfig(partial) {
    const overrides = deepMerge(loadOverrides(), partial);
    writeOverrides(overrides);
    deepMergeInPlace(config, partial);
    return config;
}

function isConfigured(cfg) {
    const twitch = cfg.twitch || {};
    return Boolean(twitch.CLIENT_ID && twitch.CLIENT_SECRET && twitch.BROADCASTER_ID && twitch.USER_ACCESS_TOKEN);
}

// ============================================================================
// Profils (display + sons d'alerte). Un seul profil actif à la fois ; son
// contenu "display" remplace entièrement (pas fusionne) config.display, contrairement
// à saveConfig() qui ne patch qu'un sous-ensemble des clés racine (twitch/ngrok/...).
// ============================================================================

function profilePath(id) {
    return path.join(PROFILES_DIR, `${id}.json`);
}

function profileAudioDir(id) {
    return path.join(PROFILES_DIR, 'audio', id);
}

function profileMediaDir(id) {
    return path.join(PROFILES_DIR, 'media', id);
}

function listProfileIds() {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    return fs.readdirSync(PROFILES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
}

function readProfileFile(id) {
    return readJson(profilePath(id));
}

function writeProfileFile(profile) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    fs.writeFileSync(profilePath(profile.id), JSON.stringify(profile, null, 2), 'utf-8');
}

/**
 * Profil complet (display + audio), en tenant compte du cache mémoire si c'est l'actif
 * (évite une relecture disque et reste cohérent avec des écritures pas encore "settle").
 */
function getProfileFull(id) {
    return (id === getActiveProfileId()) ? activeProfile : readProfileFile(id);
}

function listProfiles() {
    return listProfileIds()
        .map((id) => {
            try {
                const p = readProfileFile(id);
                return { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt };
            } catch (error) {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
}

let activeProfile = null;

function getActiveProfileId() {
    return activeProfile ? activeProfile.id : null;
}

function recomputeDisplay() {
    config.display = deepMerge(DEFAULTS.display, (activeProfile && activeProfile.display) || {});
}

/**
 * Charge (ou migre) le profil actif au démarrage du process. Si aucun profil n'existe encore
 * (install neuve, ou mise à jour depuis une version antérieure à cette fonctionnalité), on crée
 * un profil "Défaut" à partir du display déjà chargé (préserve toute personnalisation existante)
 * et on retire la clé "display" désormais obsolète à la racine d'overlay-config.json.
 */
function loadActiveProfile() {
    const overrides = loadOverrides();
    let ids = listProfileIds();
    let id = overrides.activeProfileId;

    if (ids.length === 0) {
        const now = new Date().toISOString();
        const initial = {
            id: crypto.randomUUID(),
            name: 'Défaut',
            createdAt: now,
            updatedAt: now,
            display: JSON.parse(JSON.stringify(config.display)),
            audio: {},
            media: {}
        };
        writeProfileFile(initial);
        id = initial.id;
        ids = [id];

        const { display, ...rest } = overrides;
        writeOverrides({ ...rest, activeProfileId: id });

        // Quelques profils de thème prêts à l'emploi pour découvrir le système de profils dès la
        // première utilisation, sans repartir d'une page blanche.
        ensureThemePresetProfiles();
    } else if (!id || !ids.includes(id)) {
        id = ids[0];
        writeOverrides({ ...overrides, activeProfileId: id });
    }

    activeProfile = readProfileFile(id);
    if (!activeProfile.audio) activeProfile.audio = {};
    if (!activeProfile.media) activeProfile.media = {};
    recomputeDisplay();
}

function createProfile(name, basedOnId) {
    const now = new Date().toISOString();
    // Copie du profil consulté (celui affiché dans /settings au moment du clic, pas forcément
    // l'actif) plutôt que des defaults : un nouveau profil sert en général à partir d'un
    // réglage existant pour n'en personnaliser qu'une partie.
    const base = getProfileFull(basedOnId || getActiveProfileId());
    const profile = {
        id: crypto.randomUUID(),
        name: String(name || '').trim() || 'Nouveau profil',
        createdAt: now,
        updatedAt: now,
        display: JSON.parse(JSON.stringify((base && base.display) || {})),
        audio: {},
        media: {}
    };
    writeProfileFile(profile);
    return { id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

/**
 * Crée un profil à partir d'un thème de couleurs prêt à l'emploi (src/config/theme-presets.json).
 * Ne touche qu'à `display.themes` : tout le reste (alertes, animations, panneaux...) reste celui
 * des defaults, comme n'importe quel profil neuf.
 */
function createProfileFromThemePreset(presetName) {
    const preset = THEME_PRESETS.find((p) => p.name === presetName);
    if (!preset) throw new Error('Thème inconnu');

    const now = new Date().toISOString();
    const profile = {
        id: crypto.randomUUID(),
        name: preset.name,
        createdAt: now,
        updatedAt: now,
        display: { themes: JSON.parse(JSON.stringify(preset.themes)) },
        audio: {},
        media: {}
    };
    writeProfileFile(profile);
    return { id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

/**
 * Crée les profils de thème manquants (identifiés par nom, pas par contenu — un profil renommé
 * par l'utilisateur vers le même nom qu'un thème ne sera pas dupliqué). Appelé à la migration
 * initiale (install neuve) et exposé via un bouton dans /settings pour les installations
 * existantes qui n'en ont pas encore profité.
 */
function ensureThemePresetProfiles() {
    const existingNames = new Set(listProfiles().map((p) => p.name));
    const created = [];
    for (const preset of THEME_PRESETS) {
        if (!existingNames.has(preset.name)) {
            created.push(createProfileFromThemePreset(preset.name));
        }
    }
    return created;
}

function renameProfile(id, name) {
    const profile = readProfileFile(id);
    profile.name = String(name || '').trim() || profile.name;
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (activeProfile && activeProfile.id === id) activeProfile.name = profile.name;
    return { id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

function deleteProfile(id) {
    const ids = listProfileIds();
    if (ids.length <= 1) {
        throw new Error('Impossible de supprimer le dernier profil restant');
    }
    if (id === getActiveProfileId()) {
        throw new Error('Impossible de supprimer le profil actif — activez-en un autre d\'abord');
    }
    if (!ids.includes(id)) {
        throw new Error('Profil introuvable');
    }
    fs.rmSync(profilePath(id), { force: true });
    fs.rmSync(profileAudioDir(id), { recursive: true, force: true });
    fs.rmSync(profileMediaDir(id), { recursive: true, force: true });
}

// ============================================================================
// Commandes de chat personnalisées (voir src/services/CommandManager.js). Section globale
// simple (pas liée à un profil) : `config.commands` est un tableau remplacé en bloc à chaque
// saveConfig (deepMergeInPlace ne fusionne pas les tableaux élément par élément), donc chaque
// fonction ci-dessous relit puis réécrit le tableau complet.
// ============================================================================

const COMMAND_PERMISSIONS = ['everyone', 'vip', 'moderator', 'broadcaster'];

function normalizeTrigger(trigger) {
    const value = String(trigger || '').trim().toLowerCase();
    if (!/^![^\s]+$/.test(value)) {
        throw new Error('Le déclencheur doit commencer par "!" et ne pas contenir d\'espace');
    }
    return value;
}

function listCommands() {
    return config.commands || [];
}

function createCommand(data) {
    const trigger = normalizeTrigger(data.trigger);
    if (listCommands().some(c => c.trigger === trigger)) {
        throw new Error(`Une commande ${trigger} existe déjà`);
    }
    const now = new Date().toISOString();
    const command = {
        id: crypto.randomUUID(),
        trigger,
        enabled: data.enabled !== false,
        permission: COMMAND_PERMISSIONS.includes(data.permission) ? data.permission : 'everyone',
        cooldownSeconds: Number.isFinite(Number(data.cooldownSeconds)) ? Math.max(0, Number(data.cooldownSeconds)) : 5,
        chatReply: {
            enabled: Boolean(data.chatReply?.enabled),
            message: String(data.chatReply?.message || '').trim()
        },
        overlayAction: {
            enabled: Boolean(data.overlayAction?.enabled),
            panel: data.overlayAction?.panel === 'bottom' ? 'bottom' : 'left'
        },
        createdAt: now,
        updatedAt: now
    };
    const commands = [...listCommands(), command];
    saveConfig({ commands });
    return command;
}

function updateCommand(id, patch) {
    const commands = listCommands();
    const existing = commands.find(c => c.id === id);
    if (!existing) {
        throw new Error('Commande introuvable');
    }
    const trigger = patch.trigger !== undefined ? normalizeTrigger(patch.trigger) : existing.trigger;
    if (commands.some(c => c.id !== id && c.trigger === trigger)) {
        throw new Error(`Une commande ${trigger} existe déjà`);
    }
    const updated = {
        ...existing,
        trigger,
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
        permission: COMMAND_PERMISSIONS.includes(patch.permission) ? patch.permission : existing.permission,
        cooldownSeconds: patch.cooldownSeconds !== undefined && Number.isFinite(Number(patch.cooldownSeconds))
            ? Math.max(0, Number(patch.cooldownSeconds))
            : existing.cooldownSeconds,
        chatReply: patch.chatReply !== undefined ? {
            enabled: Boolean(patch.chatReply?.enabled),
            message: String(patch.chatReply?.message || '').trim()
        } : existing.chatReply,
        overlayAction: patch.overlayAction !== undefined ? {
            enabled: Boolean(patch.overlayAction?.enabled),
            panel: patch.overlayAction?.panel === 'bottom' ? 'bottom' : 'left'
        } : existing.overlayAction,
        updatedAt: new Date().toISOString()
    };
    saveConfig({ commands: commands.map(c => c.id === id ? updated : c) });
    return updated;
}

function deleteCommand(id) {
    const commands = listCommands();
    if (!commands.some(c => c.id === id)) {
        throw new Error('Commande introuvable');
    }
    saveConfig({ commands: commands.filter(c => c.id !== id) });
}

function setActiveProfile(id) {
    if (!listProfileIds().includes(id)) {
        throw new Error('Profil introuvable');
    }
    writeOverrides({ ...loadOverrides(), activeProfileId: id });
    activeProfile = readProfileFile(id);
    if (!activeProfile.audio) activeProfile.audio = {};
    if (!activeProfile.media) activeProfile.media = {};
    recomputeDisplay();
}

/**
 * Display "effectif" (defaults + overrides) d'un profil quelconque, actif ou non — utilisé par
 * /settings pour afficher/éditer un profil qu'on ne fait que consulter, sans toucher à
 * config.display (qui reste toujours celui du profil actif, seul à s'appliquer aux overlays).
 */
function getEffectiveDisplay(id) {
    const profile = getProfileFull(id);
    return deepMerge(DEFAULTS.display, (profile && profile.display) || {});
}

/**
 * Patch le display d'un profil quelconque (actif ou non). Ne recalcule config.display (et donc
 * ne devient visible sur les overlays) que si `id` est bien le profil actif — éditer un profil
 * qu'on ne fait que consulter dans /settings ne doit jamais changer ce qui tourne en direct.
 */
function saveProfileDisplay(id, partial) {
    const profile = getProfileFull(id);
    profile.display = deepMerge(profile.display, partial);
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

/**
 * Position/visibilité custom (top/left en % de la hauteur/largeur + hidden, cf. l'éditeur de
 * scène) d'un élément déplaçable sur une page donnée. `patch` ne fait que compléter/écraser les
 * clés fournies (déplacer un élément ne doit pas effacer son état masqué, et inversement) —
 * deepMerge ne sachant pas fusionner "en place" à ce niveau précis sans écraser le reste du
 * display, on manipule l'objet directement plutôt que de passer par saveProfileDisplay().
 */
function updateProfileElementLayout(id, page, elementId, patch) {
    const profile = getProfileFull(id);
    profile.display = profile.display || {};
    profile.display.layout = profile.display.layout || {};
    profile.display.layout[page] = profile.display.layout[page] || {};
    profile.display.layout[page][elementId] = { ...profile.display.layout[page][elementId], ...patch };

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

/** Retire tout override (position ET visibilité) d'un élément — revient à son état CSS par défaut. */
function resetProfileElementLayout(id, page, elementId) {
    const profile = getProfileFull(id);
    if (profile.display && profile.display.layout && profile.display.layout[page]) {
        delete profile.display.layout[page][elementId];
    }
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

/**
 * Override de texte pour un élément statique marqué data-scene-text dans le HTML (titre,
 * sous-titre, en-tête de chat...). `value` est toujours stockée telle quelle, y compris vide :
 * une chaîne vide est une valeur légitime (l'utilisateur a volontairement vidé le texte), pas un
 * signal pour revenir au texte par défaut — voir resetProfileText() pour ça.
 */
function setProfileText(id, page, textId, value) {
    const profile = getProfileFull(id);
    profile.display = profile.display || {};
    profile.display.texts = profile.display.texts || {};
    profile.display.texts[page] = profile.display.texts[page] || {};
    profile.display.texts[page][textId] = value;

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

/** Retire l'override de texte — revient au texte par défaut présent dans le HTML de la page. */
function resetProfileText(id, page, textId) {
    const profile = getProfileFull(id);
    if (profile.display && profile.display.texts && profile.display.texts[page]) {
        delete profile.display.texts[page][textId];
    }
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

/**
 * Éléments ajoutés librement par l'utilisateur depuis l'éditeur de scène (pas présents dans
 * le HTML de base) — stockés par id généré, un objet (pas un tableau) pour patch/suppression
 * directs par id sans avoir à retrouver leur index. Historiquement limités au texte (d'où le
 * nom de la clé `customTexts`, conservé pour ne pas invalider les profils existants), ils
 * portent depuis un `type` : text (défaut, pour compat), image (URL), box (aplat de couleur),
 * clock (horloge en direct), chat (panneau de chat Twitch en direct), alerts (conteneur
 * d'alertes follow/sub/raid...) ou spotify (morceau en cours de lecture, voir SpotifyAuth) — voir
 * renderCustomTextsFromConfig() dans overlay-common.js.
 */
const CUSTOM_ELEMENT_TYPES = ['text', 'image', 'box', 'clock', 'chat', 'alerts', 'spotify'];

// Les widgets à id DOM unique (#chatContainer, #alertContainer — cf. addChatMessage()/showAlert()
// qui les retrouvent par getElementById) ne supportent qu'une instance par page.
const SINGLETON_ELEMENT_TYPES = ['chat', 'alerts'];

function addProfileCustomText(id, page, { type, text, url, color, top, left }) {
    const profile = getProfileFull(id);
    profile.display = profile.display || {};
    profile.display.customTexts = profile.display.customTexts || {};
    profile.display.customTexts[page] = profile.display.customTexts[page] || {};

    const elementId = crypto.randomUUID();
    const entry = {
        type: CUSTOM_ELEMENT_TYPES.includes(type) ? type : 'text',
        top: typeof top === 'number' ? top : 40,
        left: typeof left === 'number' ? left : 40
    };
    if (SINGLETON_ELEMENT_TYPES.includes(entry.type)
        && Object.values(profile.display.customTexts[page]).some((e) => e.type === entry.type)) {
        throw new Error('Un seul élément de ce type par scène');
    }
    if (entry.type === 'text') entry.text = text || 'Nouveau texte';
    if (entry.type === 'chat') entry.text = text || 'CHAT'; // titre du panneau
    if (entry.type === 'image') entry.url = typeof url === 'string' ? url : '';
    if (entry.type === 'box') entry.color = typeof color === 'string' ? color : '#a855f7';
    if (entry.type === 'spotify') entry.color = typeof color === 'string' ? color : '#1db954'; // vert Spotify
    profile.display.customTexts[page][elementId] = entry;

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
    return elementId;
}

function updateProfileCustomText(id, page, elementId, patch) {
    const profile = getProfileFull(id);
    const entry = profile.display && profile.display.customTexts && profile.display.customTexts[page] && profile.display.customTexts[page][elementId];
    if (!entry) {
        throw new Error('Élément introuvable');
    }
    Object.assign(entry, patch);

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

function removeProfileCustomText(id, page, elementId) {
    const profile = getProfileFull(id);
    if (profile.display && profile.display.customTexts && profile.display.customTexts[page]) {
        delete profile.display.customTexts[page][elementId];
    }
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

// ============================================================================
// Scènes personnalisées : pages d'overlay créées par l'utilisateur depuis /scene-editor,
// servies sur /scene/<sceneId> pour être ajoutées comme source navigateur dans OBS. Une
// scène n'est qu'une "page" supplémentaire aux yeux du reste du système : ses éléments
// réutilisent tels quels customTexts[sceneId] / layout[sceneId] — aucun code spécifique
// ailleurs, seule getThemeKeyFromLocation() (overlay-common.js) sait extraire l'id de l'URL.
// ============================================================================

function addProfileScene(id, name) {
    const profile = getProfileFull(id);
    profile.display = profile.display || {};
    profile.display.scenes = profile.display.scenes || {};

    const sceneId = crypto.randomUUID();
    profile.display.scenes[sceneId] = {
        name: String(name || '').trim() || 'Nouvelle scène',
        createdAt: new Date().toISOString(),
        // Fond transparent par défaut (usage overlay par-dessus le jeu) ; 'color'/'gradient'
        // activent aussi les halos animés .background-animation/.breathing-effect, pour pouvoir
        // recréer l'ambiance des pages intégrées (voir applySceneSettingsFromConfig(),
        // overlay-common.js).
        background: { mode: 'transparent', color: '#0f172a', color2: '#1e293b' },
        // Effets décoratifs (particules, étoiles...) : tous coupés par défaut — contrairement aux
        // pages intégrées qui suivent display.animations, une scène neuve doit rester vierge.
        effects: {}
    };

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
    return sceneId;
}

// Les 4 pages intégrées peuvent elles aussi porter des réglages de scène (fond, effets) : leur
// entrée dans display.scenes est créée à la volée au premier réglage, identifiée par leur clé de
// page plutôt qu'un uuid — l'éditeur et /scene/:id savent les distinguer des scènes créées.
const BUILTIN_PAGE_KEYS = ['starting', 'index', 'pause', 'ending'];

/** Patch partiel {name?, background?, effects?} — background/effects fusionnés clé par clé. */
function updateProfileScene(id, sceneId, patch) {
    const profile = getProfileFull(id);
    profile.display = profile.display || {};
    profile.display.scenes = profile.display.scenes || {};
    let scene = profile.display.scenes[sceneId];
    if (!scene) {
        if (!BUILTIN_PAGE_KEYS.includes(sceneId)) {
            throw new Error('Scène introuvable');
        }
        scene = profile.display.scenes[sceneId] = {};
    }
    if (typeof patch.name === 'string' && patch.name.trim()) scene.name = patch.name.trim();
    if (isPlainObject(patch.background)) scene.background = { ...scene.background, ...patch.background };
    if (isPlainObject(patch.effects)) scene.effects = { ...scene.effects, ...patch.effects };

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

function removeProfileScene(id, sceneId) {
    if (BUILTIN_PAGE_KEYS.includes(sceneId)) {
        throw new Error('Les scènes intégrées ne peuvent pas être supprimées');
    }
    const profile = getProfileFull(id);
    const display = profile.display || {};
    if (!display.scenes || !display.scenes[sceneId]) {
        throw new Error('Scène introuvable');
    }
    delete display.scenes[sceneId];
    // Purge tout ce qui était rattaché à cette page (éléments, positions, textes) — sinon des
    // données orphelines s'accumulent dans le profil à chaque scène supprimée.
    if (display.customTexts) delete display.customTexts[sceneId];
    if (display.layout) delete display.layout[sceneId];
    if (display.texts) delete display.texts[sceneId];
    if (display.themes) delete display.themes[sceneId];

    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        recomputeDisplay();
    }
}

const AUDIO_EXT_BY_MIME = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'weba',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac'
};

function extFor(originalName, mimeType, mimeMap = AUDIO_EXT_BY_MIME) {
    const fromMime = mimeMap[mimeType];
    if (fromMime) return fromMime;
    const fromName = path.extname(originalName || '').replace('.', '').toLowerCase();
    return fromName || 'bin';
}

const MEDIA_EXT_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

/**
 * Enregistre (ou remplace) le son d'un type d'alerte pour un profil. `id` peut être n'importe
 * quel profil, actif ou non (utilisé aussi bien par l'upload direct que par l'import de profil).
 */
function setProfileAudio(id, alertType, { filename, mimeType, buffer }) {
    if (!ALERT_TYPES.includes(alertType)) {
        throw new Error('Type d\'alerte inconnu');
    }
    const profile = getProfileFull(id);
    const dir = profileAudioDir(id);
    fs.mkdirSync(dir, { recursive: true });

    // Un remplacement peut changer d'extension (ex: .mp3 -> .wav) : supprimer l'ancien fichier
    // pour ne pas laisser de résidu orphelin sur disque.
    const previous = profile.audio && profile.audio[alertType];
    if (previous && previous.ext) {
        fs.rmSync(path.join(dir, `${alertType}.${previous.ext}`), { force: true });
    }

    const ext = extFor(filename, mimeType);
    fs.writeFileSync(path.join(dir, `${alertType}.${ext}`), buffer);

    profile.audio = profile.audio || {};
    profile.audio[alertType] = {
        filename: filename || `${alertType}.${ext}`,
        mimeType: mimeType || 'application/octet-stream',
        ext,
        updatedAt: new Date().toISOString()
    };
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        activeProfile = profile;
        recomputeDisplay();
    }
}

function deleteProfileAudio(id, alertType) {
    const profile = getProfileFull(id);
    const entry = profile.audio && profile.audio[alertType];
    if (!entry) return;

    fs.rmSync(path.join(profileAudioDir(id), `${alertType}.${entry.ext}`), { force: true });
    delete profile.audio[alertType];
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        activeProfile = profile;
        recomputeDisplay();
    }
}

/**
 * Chemin + métadonnées du fichier son d'un type d'alerte pour un profil, ou null si aucun son
 * n'est configuré. Utilisé par la route qui sert le fichier binaire et par l'export de profil.
 */
function getProfileAudioFilePath(id, alertType) {
    let profile;
    try {
        profile = getProfileFull(id);
    } catch (error) {
        return null;
    }
    const entry = profile.audio && profile.audio[alertType];
    if (!entry) return null;
    return {
        path: path.join(profileAudioDir(id), `${alertType}.${entry.ext}`),
        mimeType: entry.mimeType,
        filename: entry.filename,
        updatedAt: entry.updatedAt
    };
}

function readProfileAudioBuffer(id, alertType) {
    const info = getProfileAudioFilePath(id, alertType);
    if (!info) return null;
    return { buffer: fs.readFileSync(info.path), mimeType: info.mimeType, filename: info.filename };
}

/**
 * Média "hero" (image/GIF) affiché en grand dans le cadre d'alerte pour un type donné — même
 * principe que setProfileAudio, dossier séparé (profileMediaDir) pour ne pas mélanger les deux
 * types de fichiers binaires par profil.
 */
function setProfileMedia(id, alertType, { filename, mimeType, buffer }) {
    if (!ALERT_TYPES.includes(alertType)) {
        throw new Error('Type d\'alerte inconnu');
    }
    const profile = getProfileFull(id);
    const dir = profileMediaDir(id);
    fs.mkdirSync(dir, { recursive: true });

    const previous = profile.media && profile.media[alertType];
    if (previous && previous.ext) {
        fs.rmSync(path.join(dir, `${alertType}.${previous.ext}`), { force: true });
    }

    const ext = extFor(filename, mimeType, MEDIA_EXT_BY_MIME);
    fs.writeFileSync(path.join(dir, `${alertType}.${ext}`), buffer);

    profile.media = profile.media || {};
    profile.media[alertType] = {
        filename: filename || `${alertType}.${ext}`,
        mimeType: mimeType || 'application/octet-stream',
        ext,
        updatedAt: new Date().toISOString()
    };
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        activeProfile = profile;
        recomputeDisplay();
    }
}

function deleteProfileMedia(id, alertType) {
    const profile = getProfileFull(id);
    const entry = profile.media && profile.media[alertType];
    if (!entry) return;

    fs.rmSync(path.join(profileMediaDir(id), `${alertType}.${entry.ext}`), { force: true });
    delete profile.media[alertType];
    profile.updatedAt = new Date().toISOString();
    writeProfileFile(profile);
    if (id === getActiveProfileId()) {
        activeProfile = profile;
        recomputeDisplay();
    }
}

function getProfileMediaFilePath(id, alertType) {
    let profile;
    try {
        profile = getProfileFull(id);
    } catch (error) {
        return null;
    }
    const entry = profile.media && profile.media[alertType];
    if (!entry) return null;
    return {
        path: path.join(profileMediaDir(id), `${alertType}.${entry.ext}`),
        mimeType: entry.mimeType,
        filename: entry.filename,
        updatedAt: entry.updatedAt
    };
}

function readProfileMediaBuffer(id, alertType) {
    const info = getProfileMediaFilePath(id, alertType);
    if (!info) return null;
    return { buffer: fs.readFileSync(info.path), mimeType: info.mimeType, filename: info.filename };
}

/**
 * Crée un nouveau profil à partir d'un export précédent (voir routes/profiles.js). Génère
 * toujours un nouvel id (jamais celui de l'export) pour ne jamais entrer en collision avec un
 * profil existant sur la machine qui importe.
 */
function importProfile({ name, display, audio, media }) {
    const now = new Date().toISOString();
    const profile = {
        id: crypto.randomUUID(),
        name: String(name || '').trim() || 'Profil importé',
        createdAt: now,
        updatedAt: now,
        display: isPlainObject(display) ? display : {},
        audio: {},
        media: {}
    };
    writeProfileFile(profile);

    for (const [type, entry] of Object.entries(audio || {})) {
        if (!ALERT_TYPES.includes(type) || !entry || !entry.dataBase64) continue;
        setProfileAudio(profile.id, type, {
            filename: entry.filename,
            mimeType: entry.mimeType,
            buffer: Buffer.from(entry.dataBase64, 'base64')
        });
    }

    for (const [type, entry] of Object.entries(media || {})) {
        if (!ALERT_TYPES.includes(type) || !entry || !entry.dataBase64) continue;
        setProfileMedia(profile.id, type, {
            filename: entry.filename,
            mimeType: entry.mimeType,
            buffer: Buffer.from(entry.dataBase64, 'base64')
        });
    }

    return { id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

/**
 * Construit l'objet OVERLAY_CONFIG exposé au frontend (route /js/config.js et diffusion
 * WebSocket 'config-updated') — un seul endroit pour définir cette forme.
 */
function toFrontendConfig() {
    const display = JSON.parse(JSON.stringify(config.display));
    const activeId = getActiveProfileId();

    if (display.alerts && display.alerts.types && activeId) {
        for (const type of Object.keys(display.alerts.types)) {
            const audioMeta = activeProfile.audio && activeProfile.audio[type];
            const mediaMeta = activeProfile.media && activeProfile.media[type];
            display.alerts.types[type] = {
                ...display.alerts.types[type],
                sound: audioMeta ? `/api/profiles/${activeId}/audio/${type}?v=${encodeURIComponent(audioMeta.updatedAt)}` : null,
                media: mediaMeta ? `/api/profiles/${activeId}/media/${type}?v=${encodeURIComponent(mediaMeta.updatedAt)}` : null
            };
        }
    }

    return {
        server: {
            host: config.server.HOST,
            port: config.server.PORT,
            wsPort: config.server.WS_PORT
        },
        twitch: {
            broadcasterId: config.twitch.BROADCASTER_ID
        },
        ...display
    };
}

const config = deepMerge(DEFAULTS, loadOverrides());
loadActiveProfile();

module.exports = config;
module.exports.saveConfig = saveConfig;
module.exports.isConfigured = () => isConfigured(config);
module.exports.getConfigPath = () => CONFIG_PATH;
module.exports.appRoot = appRoot;
module.exports.toFrontendConfig = toFrontendConfig;

module.exports.ALERT_TYPES = ALERT_TYPES;
module.exports.listProfiles = listProfiles;
module.exports.getActiveProfileId = getActiveProfileId;
module.exports.getProfileFull = getProfileFull;
module.exports.createProfile = createProfile;
module.exports.renameProfile = renameProfile;
module.exports.deleteProfile = deleteProfile;
module.exports.setActiveProfile = setActiveProfile;
module.exports.ensureThemePresetProfiles = ensureThemePresetProfiles;
module.exports.getEffectiveDisplay = getEffectiveDisplay;
module.exports.saveProfileDisplay = saveProfileDisplay;
module.exports.updateProfileElementLayout = updateProfileElementLayout;
module.exports.resetProfileElementLayout = resetProfileElementLayout;
module.exports.setProfileText = setProfileText;
module.exports.resetProfileText = resetProfileText;
module.exports.addProfileCustomText = addProfileCustomText;
module.exports.updateProfileCustomText = updateProfileCustomText;
module.exports.removeProfileCustomText = removeProfileCustomText;
module.exports.CUSTOM_ELEMENT_TYPES = CUSTOM_ELEMENT_TYPES;
module.exports.BUILTIN_PAGE_KEYS = BUILTIN_PAGE_KEYS;
module.exports.addProfileScene = addProfileScene;
module.exports.updateProfileScene = updateProfileScene;
module.exports.removeProfileScene = removeProfileScene;
module.exports.setProfileAudio = setProfileAudio;
module.exports.deleteProfileAudio = deleteProfileAudio;
module.exports.getProfileAudioFilePath = getProfileAudioFilePath;
module.exports.readProfileAudioBuffer = readProfileAudioBuffer;
module.exports.setProfileMedia = setProfileMedia;
module.exports.deleteProfileMedia = deleteProfileMedia;
module.exports.getProfileMediaFilePath = getProfileMediaFilePath;
module.exports.readProfileMediaBuffer = readProfileMediaBuffer;
module.exports.importProfile = importProfile;
module.exports.COMMAND_PERMISSIONS = COMMAND_PERMISSIONS;
module.exports.listCommands = listCommands;
module.exports.createCommand = createCommand;
module.exports.updateCommand = updateCommand;
module.exports.deleteCommand = deleteCommand;
