//! Différences VOLONTAIRES entre les pages Rust et les pages Node.
//!
//! La version Rust reçoit les événements Twitch par EventSub WebSocket : ngrok et les webhooks
//! disparaissent, ainsi que tout ce qui les mentionne. Chaque changement remplace un passage
//! exact du gabarit extrait de Node ; `tests/pages_parity.rs` vérifie que chaque passage existe
//! toujours une et une seule fois (sinon, la page Node a changé et la liste est à revoir).

/// (page, texte du gabarit Node, remplacement Rust)
pub const CHANGES: &[(&str, &str, &str)] = &[
    // Accueil : l'avertissement « ngrok pas connecté » devient « connexion Twitch coupée ».
    (
        "app",
        "ngrok est activé mais pas connecté — vérifiez votre authtoken dans <a href=\"/setup\">Configuration</a>. Sans ça, aucun événement Twitch (chat, follows, alertes...) ne peut arriver.",
        "La connexion à Twitch est coupée — vérifiez l'autorisation dans <a href=\"/setup\">Configuration</a>. Sans elle, aucun événement Twitch (chat, follows, alertes...) ne peut arriver.",
    ),
    (
        "app",
        "(data.ngrok?.enabled && !data.ngrok?.connected)",
        "(data.twitchAuthenticated && !data.eventsub?.connected)",
    ),
    ("app", "Identifiants Twitch, ngrok, image de marque", "Identifiants Twitch, image de marque"),
    // Assistant de configuration : plus de section ngrok, plus de redémarrage.
    ("setup", "<h2 class=\"card-title\">Branding et ngrok</h2>", "<h2 class=\"card-title\">Image de marque</h2>"),
    (
        "setup",
        r#"            <div class="sub-block">
                <label class="checkbox-row"><input type="checkbox" id="ngrokEnabled" {{expr:9}}> Utiliser ngrok (tunnel automatique pour les webhooks Twitch)</label>
                <div class="hint">Requiert un compte gratuit : <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank">dashboard.ngrok.com/get-started/your-authtoken</a></div>
                <div class="field" style="margin-top:var(--space-3);margin-bottom:0;">
                    <label for="ngrokAuthtoken">Authtoken ngrok</label>
                    <input type="password" id="ngrokAuthtoken" autocomplete="off" placeholder="{{expr:10}}">
                </div>
            </div>

"#,
        "",
    ),
    (
        "setup",
        "Le serveur redémarre après cette sauvegarde (ngrok ne se reconfigure qu'au lancement). Spotify",
        "La connexion à Twitch est relancée après cette sauvegarde, sans redémarrage. Spotify",
    ),
    (
        "setup",
        ",\n                ngrokEnabled: document.getElementById('ngrokEnabled').checked,\n                ngrokAuthtoken: document.getElementById('ngrokAuthtoken').value.trim()\n",
        "\n",
    ),
    ("setup", "'Configuration enregistrée, redémarrage en cours...'", "'Configuration enregistrée, connexion à Twitch...'"),
    ("setup", "setTimeout(() => { window.location.href = '/app'; }, 4000);", "setTimeout(() => { window.location.href = '/app'; }, 1500);"),
];

/// Renommages appliqués à TOUTES les occurrences (identifiants internes du JavaScript).
pub const RENAMES: &[(&str, &str, &str)] = &[
    ("app", "ngrokWarning", "twitchWarning"),
    ("app", "checkNgrokStatus", "checkTwitchStatus"),
];

/// Gabarit Node avec les changements Rust de `page` appliqués.
pub fn apply(page: &str, template: &str) -> String {
    let mut out = template.to_string();
    // Un passage introuvable est simplement ignoré : la page reste utilisable. Le test
    // `chaque_changement_vise_un_passage_unique_du_gabarit_node` est là pour le signaler.
    for (_, from, to) in CHANGES.iter().filter(|(p, ..)| *p == page) {
        out = out.replacen(from, to, 1);
    }
    for (_, from, to) in RENAMES.iter().filter(|(p, ..)| *p == page) {
        out = out.replace(from, to);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn template(page: &str) -> String {
        let raw = match page {
            "app" => include_str!("../../templates/pages/app.html"),
            "setup" => include_str!("../../templates/pages/setup.html"),
            other => panic!("page inconnue : {other}"),
        };
        super::super::normalize_newlines(raw).into_owned()
    }

    #[test]
    fn fonctionne_aussi_avec_des_fins_de_ligne_windows() {
        // Ce que git produit sous Windows (core.autocrlf) : la page doit rester correcte.
        let windows = template("setup").replace('\n', "\r\n");
        let page = apply("setup", &super::super::normalize_newlines(&windows));
        assert!(!page.to_lowercase().contains("ngrok"));
    }

    #[test]
    fn chaque_changement_vise_un_passage_unique_du_gabarit_node() {
        for (page, from, _) in CHANGES {
            let count = template(page).matches(from).count();
            assert_eq!(count, 1, "{page} : passage trouvé {count} fois (la page Node a changé ?) :\n{from}");
        }
        for (page, from, _) in RENAMES {
            assert!(template(page).contains(from), "{page} : « {from} » n'existe plus dans la page Node");
        }
    }

    #[test]
    fn plus_aucune_mention_de_ngrok() {
        let config = json!({
            "server": { "PORT": 8080 },
            "twitch": { "CLIENT_ID": "abc", "CLIENT_SECRET": "s", "BROADCASTER_ID": "42", "BROADCASTER_LOGIN": "moi" },
            "display": { "themes": { "index": { "primary": "#123456" } },
                         "panels": { "bottom": { "content": { "infoTexts": ["a", "<b>"], "scrollingText": "x" } } } }
        });
        let setup = super::super::setup(&config);
        let app = super::super::app_home();
        for (name, html) in [("setup", &setup), ("app", &app)] {
            assert!(!html.to_lowercase().contains("ngrok"), "{name} mentionne encore ngrok");
            assert!(!html.contains("{{expr:"), "{name} : repère non rempli");
        }
        assert!(setup.contains("http://localhost:8080/auth-callback"));
        assert!(setup.contains("value=\"@moi — ID 42\""));
        assert!(setup.contains("value=\"&lt;b&gt;\""));
        assert!(setup.contains("placeholder=\"Déjà enregistré — laisser vide pour ne pas changer\""));
    }
}
