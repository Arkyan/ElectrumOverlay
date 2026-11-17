# Releases (et bascule depuis l'ancienne version Electron)

## 1. Une seule fois : la clé de signature des mises à jour

Les mises à jour automatiques de la version Rust ne s'installent que si l'installateur est signé
avec **ta** clé privée (la clé publique est intégrée à l'app). Même avec un accès à ton compte
GitHub, personne ne peut donc pousser de fausse mise à jour.

```bash
cargo tauri signer generate -w "$env:USERPROFILE\.tauri\electrumoverlay.key"
```

La commande demande un mot de passe et crée deux fichiers :

- `electrumoverlay.key` : la **clé privée**. À garder précieusement (gestionnaire de mots de
  passe + sauvegarde), **jamais dans le dépôt**. Perdue = les apps installées refuseront toutes
  les futures mises à jour (réinstallation manuelle obligatoire pour tout le monde).
- `electrumoverlay.key.pub` : la clé publique, intégrée dans `src-tauri/tauri.conf.json`
  (`plugins.updater.pubkey`). ✅ Fait : clé `51D4E211347E8157`. Si un jour tu changes de clé,
  remplace cette valeur (les apps déjà installées n'accepteront alors plus les mises à jour).

Ce n'est **pas** un certificat de signature de code Windows (celui qui évite l'avertissement
SmartScreen) : celui-là est payant et optionnel, et rien ne change de ce côté.

## 2. Faire une release

Prérequis sur le PC (une seule fois) : le CLI GitHub, connecté à ton compte.

```bash
winget install --id GitHub.cli
```

```bash
gh auth login
```

Version : `version` de `[workspace.package]` dans `Cargo.toml` (ex. `3.0.0`, ou `3.0.0-beta.1`).
Notes affichées sur GitHub : `docs/notes/<version>.md` s'il existe.

```bash
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\electrumoverlay.key"
```

```bash
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "ton mot de passe"
```

```bash
cargo xtask release
```

Le script compile l'installateur signé et le plugin Stream Deck, prépare les fichiers de mise à
jour, puis crée la release en **brouillon** sur GitHub (rien n'est public tant que tu ne cliques
pas sur « Publish »). Contenu de la release :

| Fichier | Rôle |
|---|---|
| `ElectrumOverlay_<version>_x64-setup.exe` | Installateur |
| `latest.json` | Mises à jour automatiques de la version Rust (avec la signature) |
| `latest.yml` | Lu par l'app **Electron** : elle télécharge et lance l'installateur Rust |
| `*.streamDeckPlugin`, `ConfigOBS.json` | Comme les releases actuelles |

Une version avec suffixe (`3.0.0-beta.1`) est publiée en **pré-version** : ni l'app Electron ni
l'app Rust ne la proposent en mise à jour automatique.

## 3. Plan de bascule des utilisateurs Electron

### Ce qui se passe chez un utilisateur

1. Son app Electron trouve la release `3.0.0` (via `latest.yml`), la télécharge et affiche
   « Mise à jour v3.0.0 prête à installer ».
2. Il clique sur « Installer et redémarrer » : l'app Electron se ferme et lance l'installateur Rust.
3. L'installateur désinstalle silencieusement l'ancienne app Electron
   (`src-tauri/windows/hooks.nsh`), puis installe la version Rust.
4. La version Rust démarre avec **la même config** (`%APPDATA%\ElectrumOverlay\config` :
   identifiants Twitch, profils, sons, scènes, commandes) et les mêmes URLs pour OBS.

Ensuite, les mises à jour passent par `latest.json` et la signature.

### Étapes recommandées

1. **Pré-version de test** (`3.0.0-beta.1`, publiée en pré-version) : installe-la toi-même par
   dessus ta version Electron, sur ton PC de stream, et fais un vrai live. Puis demande à ton pote
   d'en faire autant. Aucun autre utilisateur n'est concerné.
2. Vérifie pendant le test :
   - l'ancienne app a bien disparu (menu Démarrer, « Applications installées ») ;
   - config, profils, sons et scènes sont là ;
   - les sources OBS fonctionnent sans les modifier ;
   - chat, follows, subs, raids (et Spotify / Trucky / touches si tu les utilises).
3. **Release `3.0.0`** (publication normale) : tous les utilisateurs Electron basculent au fil
   de leurs mises à jour.

### Retour en arrière

- Pendant les tests : réinstaller la 2.5.2 depuis sa release GitHub. La config est commune aux
  deux versions et la version Rust conserve les anciennes clés (ngrok, webhooks), donc Electron
  la relit sans problème.
- Après la 3.0.0 : les utilisateurs passés en Rust ne peuvent pas revenir automatiquement à
  Electron ; on corrige en publiant une 3.0.x.

## Ce qui a été vérifié

- `latest.yml` : lu avec la vraie bibliothèque `electron-updater` (version, lien de
  téléchargement, empreinte SHA-512, version 3.0.0 bien proposée à une app en 2.5.2).
- `hooks.nsh` : compilé avec NSIS et exécuté sous Wine avec une fausse installation Electron
  dans le registre (avec et sans commande de désinstallation silencieuse, et sans version
  Electron) ; l'entrée de la version Tauri et les autres applications ne sont jamais touchées.
- Pas encore vérifié : un vrai passage 2.5.2 → 3.0.0 sur Windows. C'est l'objet de la pré-version.
