/**
 * Attache ConfigOBS.json (scènes/sources OBS prêtes à importer, à la racine du repo) à la
 * release GitHub que `electron-builder --publish always` vient de créer pour cette version —
 * appelé en chaîne depuis `npm run publish:win`, comme upload-streamdeck-asset.js. Nécessite le
 * CLI `gh` installé et authentifié (mêmes prérequis que GH_TOKEN pour electron-builder).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const configPath = path.join(__dirname, '..', 'ConfigOBS.json');
const tag = `v${pkg.version}`;

if (!fs.existsSync(configPath)) {
    console.error('❌ ConfigOBS.json introuvable à la racine du repo.');
    process.exit(1);
}

try {
    execFileSync('gh', ['release', 'upload', tag, configPath, '--clobber'], { stdio: 'inherit' });
    console.log(`✅ ConfigOBS.json attaché à la release ${tag}`);
} catch (error) {
    console.error(`❌ Échec de l'upload vers la release ${tag}. Vérifie que le CLI "gh" est installé et authentifié, et que la release ${tag} existe bien (créée par electron-builder juste avant).`);
    process.exit(1);
}
