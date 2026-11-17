// Joue une liste d'appels d'API sur les VRAIS handlers Node (src/routes/profiles.js et
// settings.js), sans Express : `express` et `multer` sont remplacés par des doublures qui se
// contentent d'enregistrer les handlers. Le test Rust `tests/routes_parity.rs` joue les mêmes
// appels sur electrum-server et compare réponses + config obtenue.
// Usage : ELECTRUM_CONFIG_DIR=<dossier> node routes_scenario.js <calls.json>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const handlers = new Map();
function fakeRouter() {
    const router = {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        router[method] = (route, ...fns) => { handlers.set(`${method.toUpperCase()} ${route}`, fns[fns.length - 1]); };
    }
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
const broadcasts = [];
const broadcast = (event) => broadcasts.push(event.type);
require(path.join(root, 'src', 'routes', 'profiles.js'))(broadcast);
require(path.join(root, 'src', 'routes', 'settings.js'))(broadcast);

const calls = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const vars = { active: config.getActiveProfileId() };
const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const fillValue = (v) => typeof v === 'string' ? fill(v)
    : Array.isArray(v) ? v.map(fillValue)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillValue(x)]))
    : v;

const responses = [];
for (const call of calls) {
    const handler = handlers.get(`${call.method} ${call.route}`);
    if (!handler) throw new Error(`Route Node inconnue : ${call.method} ${call.route}`);
    const params = Object.fromEntries(Object.entries(call.params || {}).map(([k, v]) => [k, fill(v)]));
    const res = {
        statusCode: 200, payload: undefined,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.payload = value; return this; },
        sendStatus(code) { this.statusCode = code; return this; }
    };
    broadcasts.length = 0;
    handler({ params, body: fillValue(call.body), query: {} }, res);
    const payload = JSON.parse(JSON.stringify(res.payload ?? null));
    if (payload && payload.elementId) vars.element = payload.elementId;
    if (payload && payload.sceneId) vars.scene = payload.sceneId;
    if (payload && payload.profile && payload.profile.id) vars.profile = payload.profile.id;
    responses.push({ status: res.statusCode, body: payload, broadcasts: [...broadcasts] });
}

process.stdout.write(JSON.stringify({
    responses,
    display: config.getEffectiveDisplay(config.getActiveProfileId()),
    profiles: config.listProfiles()
}));
