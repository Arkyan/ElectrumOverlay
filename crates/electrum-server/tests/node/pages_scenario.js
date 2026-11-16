// Prépare une config réaliste avec la VRAIE version Node, puis génère les pages de l'app avec les
// vrais handlers (express remplacé par une doublure). Le test Rust tests/pages_parity.rs ouvre
// ensuite le même dossier et doit produire exactement le même HTML.
// Usage : ELECTRUM_CONFIG_DIR=<dossier vide> node pages_scenario.js
const Module = require('module');
const path = require('path');

const getHandlers = new Map();
function fakeRouter() {
    const router = { post() {}, put() {}, patch() {}, delete() {} };
    router.get = (route, ...fns) => getHandlers.set(route, fns[fns.length - 1]);
    return router;
}
const fakeExpress = Object.assign(() => ({}), { Router: fakeRouter, json: () => null, raw: () => null });
const fakeMulter = Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'express') return fakeExpress;
    if (request === 'multer') return fakeMulter;
    return originalLoad.call(this, request, parent, isMain);
};

const root = path.join(__dirname, '..', '..', '..', '..');
const config = require(path.join(root, 'src', 'config', 'store'));
const StreamStatsManager = require(path.join(root, 'src', 'services', 'StreamStatsManager'));

// --- Une config qui exerce un maximum de branches des pages ---
const active = config.getActiveProfileId();
config.saveProfileDisplay(active, {
    themes: { index: { primary: '#123456' }, pause: { text: '<b>"x"</b>' } },
    alerts: { soundVolume: 0.35, duration: 4500, types: { raid: { title: 'RAID <3', animationStyle: 'slide', border: '#ff0000' } } },
    panels: { left: { enabled: true, timerColor: '' }, bottom: { content: { infoTexts: ['twitch.tv/moi', "l'autre"], scrollingText: 'Défile & "cite"' } } },
    animations: { meteors: { enabled: true, count: 3, duration: [1.5, 2] }, dvdLogo: { enabled: false } },
    chat: { enabled: { starting: false }, maxMessages: 25 },
    stats: { simulateData: false },
    pause: { messages: ['</script><b>', 'Pause'], progressMessages: [] }
});
config.setProfileAudio(active, 'follow', { filename: 'ding "1".mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('a') });
config.setProfileMedia(active, 'raid', { filename: 'raid.gif', mimeType: 'image/gif', buffer: Buffer.from('b') });
const scene = config.addProfileScene(active, 'Ma <scène>');
config.updateProfileScene(active, scene, { background: { mode: 'gradient' }, effects: { stars: true } });
config.updateProfileScene(active, 'pause', { effects: { particles: false } });
const other = config.createProfile("Profil d'été", null).id;
config.createCommand({ trigger: '!discord', chatReply: { enabled: true, message: 'Merci {user} <3' }, cooldownSeconds: 12, permission: 'vip' });
config.createCommand({ trigger: '!info', enabled: false, overlayAction: { enabled: true, panel: 'bottom' } });

require(path.join(root, 'src', 'routes', 'sceneEditor.js'))();
require(path.join(root, 'src', 'routes', 'settings.js'))(() => {});
require(path.join(root, 'src', 'routes', 'testtools.js'))({});
require(path.join(root, 'src', 'routes', 'logs.js'))();
require(path.join(root, 'src', 'routes', 'commands.js'))({});

function render(route, query = {}) {
    let html = null;
    getHandlers.get(route)({ params: {}, query }, { send(body) { html = body; } });
    return html;
}

const pages = {
    'scene-editor': render('/scene-editor'),
    'settings': render('/settings'),
    'settings?profile=other': render('/settings', { profile: other }),
    'settings?profile=inconnu': render('/settings', { profile: 'inconnu' }),
    'tests': render('/tests'),
    'logs': render('/logs'),
    'commands': render('/commands'),
    'stream-stats-html': new StreamStatsManager().generateHTMLStats()
};
process.stdout.write(JSON.stringify({ other, pages }));
