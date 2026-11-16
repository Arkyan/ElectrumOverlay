// Extrait le HTML des pages de l'app depuis les routes Node (gabarits JS `...${expr}...`) vers
// templates/pages/<nom>.html, où chaque expression serveur est remplacée par `{{expr:N}}`.
// La version Rust remplit ces repères (src/pages/*.rs) ; le test tests/pages_parity.rs vérifie
// que le HTML produit est identique octet pour octet à celui de la version Node.
//
// À relancer après toute modification d'une page côté Node :
//   node crates/electrum-server/templates/extract.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(__dirname, 'pages');

// nom → [fichier source, texte qui précède le gabarit (la 1re backtick qui suit est l'ouvrante)]
const PAGES = {
    'scene-editor': ['src/routes/sceneEditor.js', 'const SCENE_EDITOR_HTML'],
    'settings': ['src/routes/settings.js', 'const SETTINGS_PAGE_HTML'],
    'settings-tabgroup': ['src/routes/settings.js', 'function renderTabGroup'],
    'settings-theme-tab': ['src/routes/settings.js', 'const t = display.themes?.[key] || {};'],
    'settings-alert-tab': ['src/routes/settings.js', 'const currentAnim = ANIMATION_STYLE_KEYS'],
    'settings-particle': ['src/routes/settings.js', 'const duration = a.duration || [5, 8];'],
    'tests': ['src/routes/testtools.js', 'const TESTS_PAGE_HTML'],
    'logs': ['src/routes/logs.js', 'const LOGS_PAGE_HTML'],
    'commands': ['src/routes/commands.js', 'const COMMANDS_PAGE_HTML'],
    'command-card': ['src/routes/commands.js', 'function commandCardHTML'],
    'integrations': ['src/routes/integrations.js', 'const INTEGRATIONS_PAGE_HTML'],
    'setup': ['src/routes/setup.js', 'const SETUP_PAGE_HTML'],
    'app': ['server.js', "this.app.get('/app'"],
    'auth-url': ['src/routes/api.js', "router.get('/auth-url'"],
    'auth-callback': ['src/routes/api.js', "router.get('/auth-callback'"],
    'stream-stats': ['src/services/StreamStatsManager.js', 'generateHTMLStats() {']
};

const ESC = { n: '\n', t: '\t', r: '\r', '\\': '\\', '`': '`', $: '$', "'": "'", '"': '"', 0: '\0', b: '\b', f: '\f', v: '\v' };

function skipString(src, i, q) {
    i++;
    while (src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    return i + 1;
}
function skipTemplate(src, i) {
    i++;
    for (;;) {
        const c = src[i];
        if (c === '\\') i += 2;
        else if (c === '`') return i + 1;
        else if (c === '$' && src[i + 1] === '{') i = skipExpr(src, i + 2);
        else i++;
    }
}
function skipExpr(src, i) {
    let depth = 0;
    for (;;) {
        const c = src[i];
        if (c === '"' || c === "'") i = skipString(src, i, c);
        else if (c === '`') i = skipTemplate(src, i);
        else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i);
        else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i) + 2;
        else if (c === '{') { depth++; i++; }
        else if (c === '}') { if (depth === 0) return i + 1; depth--; i++; }
        else i++;
    }
}
/** Segments du gabarit qui commence à la backtick `start` : texte « cuit » et expressions. */
function parse(src, start) {
    const segs = [];
    let buf = '';
    let i = start + 1;
    for (;;) {
        const c = src[i];
        if (c === '\\') {
            const n = src[i + 1];
            if (n === 'u' && src[i + 2] === '{') { const j = src.indexOf('}', i); buf += String.fromCodePoint(parseInt(src.slice(i + 3, j), 16)); i = j + 1; }
            else if (n === 'u') { buf += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; }
            else if (n === 'x') { buf += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 4; }
            else if (n === '\n') i += 2;
            else { buf += n in ESC ? ESC[n] : n; i += 2; }
        } else if (c === '`') {
            segs.push({ text: buf });
            return segs;
        } else if (c === '$' && src[i + 1] === '{') {
            segs.push({ text: buf });
            buf = '';
            const j = skipExpr(src, i + 2);
            segs.push({ expr: src.slice(i + 2, j - 1).trim() });
            i = j;
        } else { buf += c; i++; }
    }
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = {};
for (const [name, [file, marker]] of Object.entries(PAGES)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    const at = src.indexOf(marker);
    if (at < 0) throw new Error(`${name} : « ${marker} » introuvable dans ${file}`);
    const segs = parse(src, src.indexOf('`', at));
    let html = '';
    const expressions = [];
    for (const seg of segs) {
        if ('text' in seg) {
            if (seg.text.includes('{{expr:')) throw new Error(`${name} : le texte contient déjà « {{expr: »`);
            html += seg.text;
        } else {
            html += `{{expr:${expressions.length}}}`;
            expressions.push(seg.expr);
        }
    }
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
    manifest[name] = { source: file, expressions };
    console.log(`${name.padEnd(14)} ${String(expressions.length).padStart(3)} expressions  ← ${file}`);
}
fs.writeFileSync(path.join(__dirname, 'pages.json'), JSON.stringify(manifest, null, 2) + '\n');
