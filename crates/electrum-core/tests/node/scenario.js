// Scénario de référence joué sur la VRAIE version Node (src/config/store.js).
// Le test Rust `tests/node_parity.rs` joue exactement les mêmes étapes avec electrum-core et
// compare les résultats ET les fichiers écrits sur disque (ids et horodatages normalisés).
// Usage : ELECTRUM_CONFIG_DIR=<dossier contenant overlay-config.json> node scenario.js
const path = require('path');
const config = require(path.join(__dirname, '..', '..', '..', '..', 'src', 'config', 'store'));

const errors = [];
function attempt(label, fn) {
    try { return fn(); } catch (error) { errors.push(`${label}: ${error.message}`); return null; }
}

// Commandes
const discord = config.createCommand({ trigger: '  !Discord ', chatReply: { enabled: true, message: ' rejoins ' }, cooldownSeconds: '10' });
config.updateCommand(discord.id, { enabled: false, overlayAction: { enabled: true, panel: 'bottom' } });
const tmp = config.createCommand({ trigger: '!tmp', enabled: false, permission: 'vip' });
attempt('doublon', () => config.createCommand({ trigger: '!discord' }));
attempt('trigger', () => config.createCommand({ trigger: 'sans-point' }));
config.deleteCommand(tmp.id);

// Profils
const defaultId = config.getActiveProfileId();
const p = config.createProfile('Mon profil', null).id;
config.setActiveProfile(p);

config.updateProfileElementLayout(p, 'index', 'chatContainer', { top: 10, left: 20, hidden: true });
config.updateProfileElementLayout(p, 'index', 'chatContainer', { left: 30 });
config.updateProfileElementLayout(p, 'index', 'gone', { top: 1 });
config.resetProfileElementLayout(p, 'index', 'gone');

config.setProfileText(p, 'index', 'title', 'Salut');
config.setProfileText(p, 'index', 'vide', '');
config.setProfileTextStyle(p, 'index', 'title', { size: 3, font: 'baron' });
config.setProfileTextStyle(p, 'index', 'title', { size: undefined });

config.addProfileCustomText(p, 'index', {});
const keys = config.addProfileCustomText(p, 'index', { type: 'keys', top: 5 });
config.addProfileCustomText(p, 'index', { type: 'statBadge', color: '#123456' });
config.addProfileCustomText(p, 'index', { type: 'chat' });
attempt('singleton', () => config.addProfileCustomText(p, 'index', { type: 'chat' }));
config.addProfileCustomText(p, 'index', { type: 'inconnu', text: 'Bonjour' });
config.updateProfileCustomText(p, 'index', keys, { layout: 'qwerty', scale: 150 });
attempt('element', () => config.updateProfileCustomText(p, 'index', 'nope', { text: 'x' }));

const scene = config.addProfileScene(p, 'Ma scène');
config.updateProfileScene(p, scene, { name: ' Renommée ', background: { mode: 'color' }, effects: { stars: true } });
config.updateProfileScene(p, 'pause', { effects: { particles: false } });
attempt('scene', () => config.updateProfileScene(p, 'nope', { name: 'x' }));
const doomed = config.addProfileScene(p, '');
config.addProfileCustomText(p, doomed, { type: 'clock' });
config.removeProfileScene(p, doomed);
attempt('builtin', () => config.removeProfileScene(p, 'index'));

config.saveProfileDisplay(p, { pause: { messages: ['a', 'b'] }, themes: { index: { primary: '#00ff00' } } });

config.setProfileAudio(p, 'follow', { filename: 'Son.MP3', mimeType: 'audio/mpeg', buffer: Buffer.from('abc') });
config.setProfileAudio(p, 'follow', { filename: 'son.wav', mimeType: 'audio/wav', buffer: Buffer.from('wave') });
config.setProfileAudio(p, 'sub', { filename: '', mimeType: '', buffer: Buffer.from('x') });
config.setProfileMedia(p, 'raid', { filename: 'raid.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
config.deleteProfileAudio(p, 'sub');
attempt('alerte', () => config.setProfileAudio(p, 'nope', { filename: 'a', mimeType: '', buffer: Buffer.from('a') }));

// Export : même logique que GET /api/profiles/:id/export (src/routes/profiles.js)
function exportProfile(id) {
    const profile = config.getProfileFull(id);
    const audio = {};
    for (const type of config.ALERT_TYPES) {
        const entry = profile.audio && profile.audio[type];
        if (!entry) continue;
        const data = config.readProfileAudioBuffer(id, type);
        if (!data) continue;
        audio[type] = { filename: entry.filename, mimeType: entry.mimeType, dataBase64: data.buffer.toString('base64') };
    }
    const media = {};
    for (const type of config.ALERT_TYPES) {
        const entry = profile.media && profile.media[type];
        if (!entry) continue;
        const data = config.readProfileMediaBuffer(id, type);
        if (!data) continue;
        media[type] = { filename: entry.filename, mimeType: entry.mimeType, dataBase64: data.buffer.toString('base64') };
    }
    return { exportedFrom: 'ElectrumOverlay', exportVersion: 1, name: profile.name, display: profile.display, audio, media };
}
const exported = exportProfile(p);
config.importProfile({ ...exported, name: 'Copie' });

config.renameProfile(defaultId, '  Base  ');
const createdPresets = config.ensureThemePresetProfiles();
const rouge = config.listProfiles().find((x) => x.name === 'Rouge Braise');
config.deleteProfile(rouge.id);
attempt('actif', () => config.deleteProfile(p));

process.stdout.write(JSON.stringify({
    frontend: config.toFrontendConfig(),
    profiles: config.listProfiles(),
    commands: config.listCommands(),
    effective: config.getEffectiveDisplay(defaultId),
    configured: config.isConfigured(),
    createdPresets,
    exported,
    errors
}));
