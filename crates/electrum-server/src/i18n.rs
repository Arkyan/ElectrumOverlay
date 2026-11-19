//! Interface en anglais. Le texte de référence est le français (pages, messages) ; en anglais,
//! un dictionnaire français → anglais (`i18n/en.json`) est appliqué au rendu :
//! - pages de l'app : tout le HTML produit par `pages::shell::wrap` (textes, attributs, et
//!   chaînes des scripts) ;
//! - messages d'erreur de l'API ;
//! - overlays : dictionnaire à part (`i18n/en-overlay.json`), servi par `/js/i18n.js` et
//!   appliqué par les overlays eux-mêmes.
//!
//! Un texte absent du dictionnaire reste en français. Un remplacement n'a lieu que sur des mots
//! entiers (« Fin » ne touche pas « Final »).

use aho_corasick::{AhoCorasick, Input, MatchKind};
use serde_json::{Map, Value};
use std::sync::OnceLock;

const EN_JSON: &str = include_str!("../i18n/en.json");
const EN_OVERLAY_JSON: &str = include_str!("../i18n/en-overlay.json");

/// Langues proposées : code, nom affiché.
pub const LANGUAGES: [(&str, &str); 2] = [("fr", "Français"), ("en", "English")];

/// Langue enregistrée dans une config (`app.language`), `None` si pas encore choisie.
pub fn configured_language(config: &Value) -> Option<&'static str> {
    match config["app"]["language"].as_str() {
        Some("en") => Some("en"),
        Some("fr") => Some("fr"),
        _ => None,
    }
}

/// Langue de l'interface pour une config (français si rien n'est choisi).
pub fn language_of(config: &Value) -> &'static str {
    configured_language(config).unwrap_or("fr")
}

struct Dictionary {
    matcher: AhoCorasick,
    values: Vec<String>,
}

fn load(json: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .expect("dictionnaire de traduction invalide")
}

/// Traduction prête à insérer n'importe où (HTML, attribut, chaîne JS entre ' ou ") :
/// apostrophes et guillemets typographiques.
fn safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut open = true;
    for c in text.chars() {
        match c {
            '\'' => out.push('’'),
            '"' => {
                out.push(if open { '“' } else { '”' });
                open = !open;
            }
            other => out.push(other),
        }
    }
    out
}

fn dictionary() -> &'static Dictionary {
    static DICT: OnceLock<Dictionary> = OnceLock::new();
    DICT.get_or_init(|| {
        let mut keys = Vec::new();
        let mut values = Vec::new();
        for (fr, en) in load(EN_JSON) {
            let Some(en) = en.as_str() else { continue };
            let en = safe(en);
            // Dans une chaîne JS entre apostrophes, le français apparaît échappé (`l\'app`).
            if fr.contains('\'') {
                keys.push(fr.replace('\'', "\\'"));
                values.push(en.clone());
                keys.push(fr.replace('\'', "&#39;"));
                values.push(en.clone());
            }
            keys.push(fr);
            values.push(en);
        }
        let matcher = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(&keys)
            .expect("dictionnaire de traduction");
        Dictionary { matcher, values }
    })
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(char::is_alphanumeric)
}

/// Applique le dictionnaire anglais à un texte, quelle que soit la langue courante.
pub fn to_english(text: &str) -> String {
    translate(text, &[])
}

/// Balises (commentaires JS) autour des données de l'utilisateur insérées dans un script.
pub const USER_DATA_START: &str = "/*user-data*/";
pub const USER_DATA_END: &str = "/*end-user-data*/";

/// Zones d'une page à ne jamais traduire : les valeurs (`value="…"`, `data-value="…"`), le
/// contenu des `<textarea>` et les données balisées des scripts, qui sont des réglages de l'utilisateur ou des clés renvoyées au
/// serveur. Les traduire les modifierait à l'enregistrement.
fn protected_ranges(html: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(found) = html[from..].find(USER_DATA_START) {
        let start = from + found;
        let end = html[start..].find(USER_DATA_END).map_or(html.len(), |i| start + i);
        ranges.push((start, end));
        from = end;
    }
    let mut from = 0;
    while let Some(found) = html[from..].find("value=\"") {
        let start = from + found + "value=\"".len();
        let Some(len) = html[start..].find('"') else { break };
        ranges.push((start, start + len));
        from = start + len + 1;
    }
    from = 0;
    while let Some(found) = html[from..].find("<textarea") {
        let open = from + found;
        let Some(body) = html[open..].find('>').map(|i| open + i + 1) else { break };
        let end = html[body..].find("</textarea>").map_or(html.len(), |i| body + i);
        ranges.push((body, end));
        from = end;
    }
    ranges
}

fn translate(text: &str, protected: &[(usize, usize)]) -> String {
    let dict = dictionary();
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut copied = 0;
    let mut at = 0;
    while at < text.len() {
        let Some(m) = dict.matcher.find(Input::new(text).range(at..)) else { break };
        let before = text[..m.start()].chars().next_back();
        let after = text[m.end()..].chars().next();
        let key = &text[m.start()..m.end()];
        let starts_word = key.chars().next().is_some_and(char::is_alphanumeric);
        let ends_word = key.chars().next_back().is_some_and(char::is_alphanumeric);
        let in_value = protected.iter().any(|&(start, end)| m.start() < end && m.end() > start);
        if in_value || (starts_word && is_word(before)) || (ends_word && is_word(after)) {
            // Pas un mot entier : on avance d'un caractère et on recherche plus loin.
            at = m.start() + key.chars().next().map_or(1, char::len_utf8);
            continue;
        }
        out.push_str(&text[copied..m.start()]);
        out.push_str(&dict.values[m.pattern().as_usize()]);
        copied = m.end();
        at = m.end();
    }
    out.push_str(&text[copied..]);
    out
}

/// Page HTML complète traduite en anglais.
pub fn page_to_english(html: &str) -> String {
    translate(html, &protected_ranges(html)).replacen("<html lang=\"fr\">", "<html lang=\"en\">", 1)
}

/// `/js/i18n.js` : dictionnaire des overlays (vide en français).
pub fn overlay_script(language: &str) -> String {
    let dict = if language == "en" {
        let mut map = Map::new();
        for (fr, en) in load(EN_OVERLAY_JSON) {
            if let Some(en) = en.as_str() {
                map.insert(fr, Value::String(en.to_string()));
            }
        }
        Value::Object(map)
    } else {
        Value::Object(Map::new())
    };
    format!(
        "globalThis.OVERLAY_I18N = {{ lang: \"{}\", dict: {} }};\n",
        if language == "en" { "en" } else { "fr" },
        electrum_core::json::to_js_string(&dict).replace('<', "\\u003c")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valeurs_de_l_utilisateur_non_traduites() {
        let html = r#"<label>Pause</label><input value="Pause"><button data-value="Bleu Cyber">Bleu Cyber</button><textarea>Pause</textarea>"#;
        let en = page_to_english(html);
        assert!(en.contains(r#"value="Pause""#) && en.contains(r#"data-value="Bleu Cyber""#) && en.contains("<textarea>Pause</textarea>"), "{en}");
        assert!(!en.contains(">Bleu Cyber</button>"), "le texte affiché reste traduit : {en}");
        let script = format!("<script>const PAUSE = {USER_DATA_START}[\"Fin\"]{USER_DATA_END}; say('Fin');</script>");
        let en = page_to_english(&script);
        assert!(en.contains("[\"Fin\"]") && !en.contains("say('Fin')"), "{en}");
    }

    #[test]
    fn mots_entiers_et_echappements() {
        assert_eq!(to_english("<h1>Tableau de bord</h1>"), "<h1>Dashboard</h1>");
        // « Fin » est traduit seul, pas au milieu d'un autre mot.
        assert_eq!(to_english("Fin · Finale"), "Ending · Finale");
        // Version échappée dans une chaîne JS : la traduction ne casse pas la chaîne.
        let js = to_english("msg.textContent = 'Impossible de contacter le serveur.';");
        assert_eq!(js, "msg.textContent = 'Could not reach the server.';");
        // Le plus long gagne.
        assert_eq!(to_english("Supprimer la scène"), "Delete scene");
        // Aucune entrée du dictionnaire ne doit être vide ni identique au français.
        for (fr, en) in load(EN_JSON).iter().chain(load(EN_OVERLAY_JSON).iter()) {
            let en = en.as_str().unwrap_or_default();
            assert!(!en.trim().is_empty(), "traduction vide : {fr}");
        }
    }
}
