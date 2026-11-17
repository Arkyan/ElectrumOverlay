#!/usr/bin/env node
/**
 * Release de la version Rust (Tauri) — voir docs/RELEASE-RUST.md avant la première utilisation.
 *
 *   node scripts/release-rust.js              build signé + release GitHub en BROUILLON
 *   node scripts/release-rust.js --skip-build réutilise l'installateur déjà compilé dans target/
 *                                             (le plugin Stream Deck est toujours reconstruit)
 *
 * La release contient :
 * - l'installateur NSIS (ElectrumOverlay_<version>_x64-setup.exe) ;
 * - latest.json : lu par les mises à jour automatiques de la version Rust (signature incluse) ;
 * - latest.yml : lu par electron-updater, pour que l'app ELECTRON installée chez les utilisateurs
 *   télécharge et lance cet installateur (bascule automatique vers la version Rust) ;
 * - le plugin Stream Deck et ConfigOBS.json, comme les releases actuelles.
 *
 * Une version avec un suffixe (3.0.0-beta.1) est publiée en « pré-version » : ni l'app Electron
 * ni l'app Rust ne la proposent en mise à jour automatique (pratique pour tester).
 * Rien n'est rendu public : la release est créée en brouillon, à publier à la main sur GitHub.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = 'Arkyan/ElectrumOverlay';

function workspaceVersion() {
    const cargo = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf-8');
    const section = cargo.split('[workspace.package]')[1] || '';
    const match = section.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (!match) throw new Error('Version introuvable dans [workspace.package] de Cargo.toml');
    return match[1];
}

/** Manifeste des mises à jour Tauri (format « static JSON » du plugin updater). */
function tauriManifest({ version, installerName, signature, notes = '', date = new Date() }) {
    return {
        version,
        notes,
        pub_date: date.toISOString(),
        platforms: {
            'windows-x86_64': {
                signature: signature.trim(),
                url: `https://github.com/${REPO}/releases/download/v${version}/${installerName}`
            }
        }
    };
}

/** Manifeste electron-updater (latest.yml) pointant vers l'installateur Tauri. */
function electronManifest({ version, installerName, bytes, date = new Date() }) {
    const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
    return [
        `version: ${version}`,
        'files:',
        `  - url: ${installerName}`,
        `    sha512: ${sha512}`,
        `    size: ${bytes.length}`,
        `path: ${installerName}`,
        `sha512: ${sha512}`,
        `releaseDate: '${date.toISOString()}'`,
        ''
    ].join('\n');
}

function run(command, args, options = {}) {
    console.log(`\n▶ ${command} ${args.join(' ')}`);
    // Sous Windows, npm est un script .cmd : il faut passer par l'interpréteur de commandes. Mais
    // celui-ci supprime les arguments vides et coupe ceux qui contiennent des espaces : on ne
    // l'utilise donc QUE pour npm (cargo et gh sont de vrais exécutables).
    const shell = process.platform === 'win32' && command === 'npm';
    execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, shell, ...options });
}

function main() {
    const skipBuild = process.argv.includes('--skip-build');
    const version = workspaceVersion();
    const prerelease = version.includes('-');
    console.log(`📦 Version ${version}${prerelease ? ' (pré-version : pas de mise à jour automatique)' : ''}`);

    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf-8'));
    if (!conf.plugins?.updater?.pubkey || conf.plugins.updater.pubkey.startsWith('À_REMPLACER')) {
        throw new Error('Clé publique absente de src-tauri/tauri.conf.json (plugins.updater.pubkey) — voir docs/RELEASE-RUST.md');
    }
    if (!skipBuild) {
        if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
            throw new Error('TAURI_SIGNING_PRIVATE_KEY non défini — voir docs/RELEASE-RUST.md');
        }
        run('cargo', ['tauri', 'build']);
    }
    // Plugin Stream Deck : ses dépendances (rollup...) ne sont pas installées par défaut sur un
    // nouveau PC — on les installe si besoin.
    if (!fs.existsSync(path.join(ROOT, 'streamdeck-plugin', 'node_modules'))) {
        run('npm', ['install'], { cwd: path.join(ROOT, 'streamdeck-plugin') });
    }
    run('npm', ['run', 'package:streamdeck']);

    const installerName = `ElectrumOverlay_${version}_x64-setup.exe`;
    const installer = path.join(ROOT, 'target', 'release', 'bundle', 'nsis', installerName);
    if (!fs.existsSync(installer) || !fs.existsSync(`${installer}.sig`)) {
        throw new Error(`Installateur ou signature introuvable : ${installer}(.sig)`);
    }
    const out = path.join(ROOT, 'dist-rust');
    fs.mkdirSync(out, { recursive: true });
    const bytes = fs.readFileSync(installer);
    const signature = fs.readFileSync(`${installer}.sig`, 'utf-8');
    const latestJson = path.join(out, 'latest.json');
    const latestYml = path.join(out, 'latest.yml');
    fs.writeFileSync(latestJson, JSON.stringify(tauriManifest({ version, installerName, signature }), null, 2) + '\n');
    fs.writeFileSync(latestYml, electronManifest({ version, installerName, bytes }));

    const distDir = path.join(ROOT, 'dist');
    const plugin = fs.existsSync(distDir) ? fs.readdirSync(distDir).find((f) => f.endsWith('.streamDeckPlugin')) : null;
    const assets = [installer, latestJson, latestYml, path.join(ROOT, 'ConfigOBS.json')];
    if (plugin) assets.push(path.join(distDir, plugin));
    else console.warn('⚠️  Plugin Stream Deck introuvable dans dist/ : non joint à la release');

    const notes = prerelease
        ? 'Pré-version de test de la version Rust (Tauri). Non proposée en mise à jour automatique.'
        : 'Version Rust (Tauri) : voir docs/RELEASE-RUST.md.';
    const args = ['release', 'create', `v${version}`, '--repo', REPO, '--draft', '--title', version, '--notes', notes];
    if (prerelease) args.push('--prerelease');
    try {
        execFileSync('gh', ['--version'], { stdio: 'ignore' });
    } catch {
        throw new Error('Le CLI GitHub (gh) est introuvable : winget install --id GitHub.cli, puis gh auth login (voir docs/RELEASE-RUST.md)');
    }
    run('gh', [...args, ...assets]);
    console.log(`\n✅ Release v${version} créée en BROUILLON : vérifie-la sur GitHub puis publie-la.`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exit(1);
    }
}

module.exports = { workspaceVersion, tauriManifest, electronManifest };
