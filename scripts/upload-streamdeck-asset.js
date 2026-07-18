/**
 * Attache le .streamDeckPlugin (déjà généré par `npm run package:streamdeck`) à la release
 * GitHub que `electron-builder --publish always` vient de créer pour cette version — appelé en
 * chaîne depuis `npm run publish:win`. Nécessite le CLI `gh` installé et authentifié (mêmes
 * prérequis que GH_TOKEN pour electron-builder).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const distDir = path.join(__dirname, '..', 'dist');
const tag = `v${pkg.version}`;

const pluginFile = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).find((f) => f.endsWith('.streamDeckPlugin'))
    : null;

if (!pluginFile) {
    console.error('❌ Aucun fichier .streamDeckPlugin trouvé dans dist/ — "npm run package:streamdeck" a-t-il été exécuté avant ?');
    process.exit(1);
}

const pluginPath = path.join(distDir, pluginFile);

try {
    execFileSync('gh', ['release', 'upload', tag, pluginPath, '--clobber'], { stdio: 'inherit' });
    console.log(`✅ ${pluginFile} attaché à la release ${tag}`);
} catch (error) {
    console.error(`❌ Échec de l'upload vers la release ${tag}. Vérifie que le CLI "gh" est installé et authentifié, et que la release ${tag} existe bien (créée par electron-builder juste avant).`);
    process.exit(1);
}
