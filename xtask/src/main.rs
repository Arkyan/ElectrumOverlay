//! Tâches du projet, sans Node ni npm (voir docs/RELEASE-RUST.md) :
//!
//!   cargo xtask release              build signé + release GitHub en BROUILLON
//!   cargo xtask release --skip-build réutilise l'installateur déjà compilé dans target/
//!   cargo xtask plugin               construit seulement le plugin Stream Deck (dist-rust/)
//!
//! La release contient :
//! - l'installateur NSIS (`ElectrumOverlay_<version>_x64-setup.exe`) ;
//! - `latest.json` : mises à jour automatiques de l'app (avec la signature) ;
//! - `latest.yml` : lu par l'ancienne app Electron (2.x), qui télécharge et lance l'installateur ;
//! - le plugin Stream Deck (`.streamDeckPlugin`) et `ConfigOBS.json`.
//!
//! Une version avec suffixe (`3.1.0-beta.1`) est publiée en pré-version : aucune app ne la propose
//! en mise à jour automatique. Rien n'est rendu public : la release est un brouillon.

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const REPO: &str = "Arkyan/ElectrumOverlay";
const PLUGIN_DIR: &str = "com.electrumvtc.overlay.streamdeck.sdPlugin";
const PLUGIN_FILE: &str = "com.electrumvtc.overlay.streamdeck.streamDeckPlugin";
const PLUGIN_EXE: &str = "electrum-deck.exe";

type Result<T> = std::result::Result<T, String>;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("racine du dépôt").to_path_buf()
}

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| format!("{} : {e}", path.display()))
}

/// `version` de `[workspace.package]` dans Cargo.toml.
fn workspace_version(cargo_toml: &str) -> Result<String> {
    let section = cargo_toml.split("[workspace.package]").nth(1).ok_or("[workspace.package] absent de Cargo.toml")?;
    section
        .lines()
        .take_while(|line| !line.trim_start().starts_with('['))
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "version").then(|| value.trim().trim_matches('"').to_string())
        })
        .ok_or_else(|| "version introuvable dans [workspace.package]".to_string())
}

/// Manifeste des mises à jour Tauri (format « static JSON » du plugin updater).
fn tauri_manifest(version: &str, installer: &str, signature: &str, notes: &str, date: &str) -> Value {
    json!({
        "version": version,
        "notes": notes,
        "pub_date": date,
        "platforms": {
            "windows-x86_64": {
                "signature": signature.trim(),
                "url": format!("https://github.com/{REPO}/releases/download/v{version}/{installer}")
            }
        }
    })
}

/// Manifeste electron-updater (`latest.yml`) pointant vers l'installateur Tauri.
fn electron_manifest(version: &str, installer: &str, bytes: &[u8], date: &str) -> String {
    let sha512 = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes));
    [
        format!("version: {version}"),
        "files:".into(),
        format!("  - url: {installer}"),
        format!("    sha512: {sha512}"),
        format!("    size: {}", bytes.len()),
        format!("path: {installer}"),
        format!("sha512: {sha512}"),
        format!("releaseDate: '{date}'"),
        String::new(),
    ]
    .join("\n")
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    println!("\n▶ {program} {}", args.join(" "));
    let status = Command::new(program)
        .args(args)
        .current_dir(root())
        .status()
        .map_err(|e| format!("{program} introuvable ou impossible à lancer ({e})"))?;
    if status.success() { Ok(()) } else { Err(format!("échec de : {program} {}", args.join(" "))) }
}

/// Compile le plugin Stream Deck (exécutable Windows) et l'empaquette en `.streamDeckPlugin`
/// (un zip du dossier `.sdPlugin`, comme le fait l'outil d'Elgato).
fn build_plugin(out: &Path) -> Result<PathBuf> {
    let mut args = vec!["build", "--release", "--package", "electrum-deck"];
    // Hors Windows (CI, tests) : compilation croisée.
    if !cfg!(windows) {
        args.extend(["--target", "x86_64-pc-windows-gnu"]);
    }
    run("cargo", &args)?;
    let target = if cfg!(windows) { root().join("target/release") } else { root().join("target/x86_64-pc-windows-gnu/release") };
    let exe = std::fs::read(target.join(PLUGIN_EXE)).map_err(|e| format!("{PLUGIN_EXE} introuvable : {e}"))?;
    let package = out.join(PLUGIN_FILE);
    package_plugin(&root().join("streamdeck-plugin").join(PLUGIN_DIR), &exe, &package)?;
    println!("✅ Plugin Stream Deck : {}", package.display());
    Ok(package)
}

fn package_plugin(source: &Path, exe: &[u8], destination: &Path) -> Result<()> {
    use zip::write::SimpleFileOptions;
    let file = std::fs::File::create(destination).map_err(|e| format!("{} : {e}", destination.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let error = |e: &dyn std::fmt::Display| format!("plugin Stream Deck : {e}");
    fn walk(dir: &Path, base: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let relative = path.strip_prefix(base).unwrap_or(&path);
            // bin/ : produit de compilation ; logs/ : écrit par Stream Deck.
            if relative.starts_with("bin") || relative.starts_with("logs") {
                continue;
            }
            if path.is_dir() { walk(&path, base, files)? } else { files.push(path) }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(source, source, &mut files).map_err(|e| error(&e))?;
    for path in files {
        let relative = path.strip_prefix(source).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        zip.start_file(format!("{PLUGIN_DIR}/{relative}"), SimpleFileOptions::default()).map_err(|e| error(&e))?;
        zip.write_all(&std::fs::read(&path).map_err(|e| error(&e))?).map_err(|e| error(&e))?;
    }
    zip.start_file(format!("{PLUGIN_DIR}/bin/{PLUGIN_EXE}"), SimpleFileOptions::default()).map_err(|e| error(&e))?;
    zip.write_all(exe).map_err(|e| error(&e))?;
    zip.finish().map_err(|e| error(&e))?;
    Ok(())
}

fn release(skip_build: bool) -> Result<()> {
    let root = root();
    let version = workspace_version(&read(&root.join("Cargo.toml"))?)?;
    let prerelease = version.contains('-');
    println!("📦 Version {version}{}", if prerelease { " (pré-version : pas de mise à jour automatique)" } else { "" });

    let conf: Value = serde_json::from_str(&read(&root.join("src-tauri/tauri.conf.json"))?).map_err(|e| e.to_string())?;
    let pubkey = conf["plugins"]["updater"]["pubkey"].as_str().unwrap_or_default();
    if pubkey.is_empty() || pubkey.starts_with("À_REMPLACER") {
        return Err("Clé publique absente de src-tauri/tauri.conf.json (plugins.updater.pubkey) — voir docs/RELEASE-RUST.md".into());
    }
    if !skip_build {
        if std::env::var_os("TAURI_SIGNING_PRIVATE_KEY").is_none() {
            return Err("TAURI_SIGNING_PRIVATE_KEY non défini — voir docs/RELEASE-RUST.md".into());
        }
        run("cargo", &["tauri", "build"])?;
    }

    let out = root.join("dist-rust");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let plugin = build_plugin(&out)?;

    let installer_name = format!("ElectrumOverlay_{version}_x64-setup.exe");
    let installer = root.join("target/release/bundle/nsis").join(&installer_name);
    let signature_path = PathBuf::from(format!("{}.sig", installer.display()));
    if !installer.exists() || !signature_path.exists() {
        return Err(format!("Installateur ou signature introuvable : {}(.sig)", installer.display()));
    }
    let bytes = std::fs::read(&installer).map_err(|e| e.to_string())?;
    let signature = read(&signature_path)?;
    let date = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let latest_json = out.join("latest.json");
    let latest_yml = out.join("latest.yml");
    let manifest = serde_json::to_string_pretty(&tauri_manifest(&version, &installer_name, &signature, "", &date)).unwrap_or_default();
    std::fs::write(&latest_json, manifest + "\n").map_err(|e| e.to_string())?;
    std::fs::write(&latest_yml, electron_manifest(&version, &installer_name, &bytes, &date)).map_err(|e| e.to_string())?;

    // Notes affichées sur GitHub : docs/notes/<version>.md s'il existe.
    let notes = read(&root.join("docs/notes").join(format!("{version}.md"))).unwrap_or_else(|_| {
        if prerelease {
            "Pré-version de test. Non proposée en mise à jour automatique.".into()
        } else {
            format!("ElectrumOverlay {version}")
        }
    });
    let notes_file = out.join("notes.md");
    std::fs::write(&notes_file, &notes).map_err(|e| e.to_string())?;

    if Command::new("gh").arg("--version").output().is_err() {
        return Err("Le CLI GitHub (gh) est introuvable : winget install --id GitHub.cli, puis gh auth login (voir docs/RELEASE-RUST.md)".into());
    }
    let tag = format!("v{version}");
    let paths: Vec<String> = [installer, latest_json, latest_yml, root.join("ConfigOBS.json"), plugin]
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    let notes_path = notes_file.display().to_string();
    let mut args = vec!["release", "create", &tag, "--repo", REPO, "--draft", "--title", &version, "--notes-file", &notes_path];
    if prerelease {
        args.push("--prerelease");
    }
    args.extend(paths.iter().map(String::as_str));
    run("gh", &args)?;
    println!("\n✅ Release {tag} créée en BROUILLON : vérifie-la sur GitHub puis publie-la.");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("release") => release(args.iter().any(|a| a == "--skip-build")),
        Some("plugin") => {
            let out = root().join("dist-rust");
            std::fs::create_dir_all(&out).map_err(|e| e.to_string()).and_then(|_| build_plugin(&out).map(|_| ()))
        }
        _ => Err("Usage : cargo xtask release [--skip-build] | cargo xtask plugin".into()),
    };
    if let Err(error) = result {
        eprintln!("❌ {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_et_manifestes() {
        let cargo = "[workspace]\nmembers = []\n\n[workspace.package]\nversion = \"3.0.0\"\nedition = \"2021\"\n\n[other]\nversion = \"9\"\n";
        assert_eq!(workspace_version(cargo).unwrap(), "3.0.0");

        let manifest = tauri_manifest("3.0.0", "Setup.exe", "sig\n", "", "2026-11-17T00:00:00.000Z");
        assert_eq!(manifest["platforms"]["windows-x86_64"]["signature"], "sig");
        assert_eq!(manifest["platforms"]["windows-x86_64"]["url"], "https://github.com/Arkyan/ElectrumOverlay/releases/download/v3.0.0/Setup.exe");

        // Même contenu que l'ancien script Node (vérifié à l'époque avec electron-updater).
        let yml = electron_manifest("3.0.0", "Setup.exe", b"abc", "2026-11-17T00:00:00.000Z");
        let sha = "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";
        assert_eq!(yml, format!("version: 3.0.0\nfiles:\n  - url: Setup.exe\n    sha512: {sha}\n    size: 3\npath: Setup.exe\nsha512: {sha}\nreleaseDate: '2026-11-17T00:00:00.000Z'\n"));
    }

    #[test]
    fn paquet_du_plugin() {
        let dir = std::env::temp_dir().join(format!("xtask-plugin-{}", std::process::id()));
        let destination = dir.join("plugin.streamDeckPlugin");
        std::fs::create_dir_all(&dir).unwrap();
        package_plugin(&root().join("streamdeck-plugin").join(PLUGIN_DIR), b"MZ", &destination).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&destination).unwrap()).unwrap();
        let names: Vec<String> = archive.file_names().map(|n| n.unwrap().to_string()).collect();
        assert!(names.contains(&format!("{PLUGIN_DIR}/manifest.json")));
        assert!(names.contains(&format!("{PLUGIN_DIR}/bin/{PLUGIN_EXE}")));
        assert!(names.iter().any(|n| n.starts_with(&format!("{PLUGIN_DIR}/ui/"))));
        assert!(!names.iter().any(|n| n.ends_with(".js") && n.contains("/bin/")));
        assert_eq!(archive.by_name(&format!("{PLUGIN_DIR}/bin/{PLUGIN_EXE}")).unwrap().size(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }
}
