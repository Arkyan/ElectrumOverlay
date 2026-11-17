//! Petits équivalents des opérateurs JavaScript utilisés par les gabarits des pages Node
//! (`?.`, `??`, `||`, `String()`, `esc()`, `JSON.stringify`), pour produire exactement le même HTML.

use electrum_core::json::{is_truthy, js_number_to_string, to_js_string};
use serde_json::Value;

/// `v?.a?.b?.[0]` : `None` dès qu'un maillon manque ou n'est pas indexable.
pub fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = match current {
            Value::Object(map) => map.get(*key)?,
            Value::Array(items) => items.get(key.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// `String(v)` (avec `undefined`/`null` → chaîne vide, comme `String(v ?? '')`).
pub fn string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number_to_string(n.as_f64().unwrap_or(0.0)),
        Some(Value::Array(items)) => items.iter().map(|v| string(Some(v))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `esc()` des routes Node : `& < > " '` échappés.
pub fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// `esc(v)`.
pub fn esc_v(value: Option<&Value>) -> String {
    esc(&string(value))
}

/// `esc(v ?? fallback)`.
pub fn esc_nn(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => esc(fallback),
        some => esc_v(some),
    }
}

/// `esc(v || fallback)`.
pub fn esc_or(value: Option<&Value>, fallback: &str) -> String {
    if is_truthy(value) { esc_v(value) } else { esc(fallback) }
}

/// `v || fallback` sans échappement.
pub fn or<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    if is_truthy(value) { value } else { fallback }
}

/// `v !== false ? word : ''`.
pub fn unless_false(value: Option<&Value>, word: &str) -> String {
    if value == Some(&Value::Bool(false)) { String::new() } else { word.to_string() }
}

/// `v ? word : ''`.
pub fn if_truthy(value: Option<&Value>, word: &str) -> String {
    if is_truthy(value) { word.to_string() } else { String::new() }
}

/// `JSON.stringify(v)`.
pub fn stringify(value: &Value) -> String {
    to_js_string(value)
}

/// `JSON.stringify(v).replace(/</g, '\\u003c')` : sûr dans un bloc `<script>`.
pub fn js(value: &Value) -> String {
    to_js_string(value).replace('<', "\\u003c")
}

/// Remplit les repères `{{expr:N}}` d'un gabarit de page.
/// Une valeur sans repère est permise : un changement volontaire (`changes.rs`) peut avoir retiré
/// le passage qui la contenait.
pub fn fill(template: &str, values: &[String]) -> String {
    let mut out = String::with_capacity(template.len() + values.iter().map(String::len).sum::<usize>());
    let mut rest = template;
    while let Some(start) = rest.find("{{expr:") {
        out.push_str(&rest[..start]);
        let end = start + rest[start..].find("}}").expect("repère {{expr:N}} non fermé");
        let index: usize = rest[start + 7..end].parse().expect("numéro de repère invalide");
        out.push_str(values.get(index).unwrap_or_else(|| panic!("valeur manquante pour {{{{expr:{index}}}}}")));
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn semantique_js() {
        let v = json!({ "a": { "n": 0, "f": false, "s": "", "list": ["x", "y"], "nul": null } });
        assert_eq!(esc_nn(at(&v, &["a", "n"]), "9"), "0", "?? garde 0");
        assert_eq!(esc_or(at(&v, &["a", "n"]), "9"), "9", "|| remplace 0");
        assert_eq!(esc_nn(at(&v, &["a", "nul"]), "9"), "9");
        assert_eq!(esc_v(at(&v, &["a", "list", "1"])), "y");
        assert_eq!(at(&v, &["a", "s", "x"]), None);
        assert_eq!(unless_false(at(&v, &["a", "f"]), "checked"), "");
        assert_eq!(unless_false(at(&v, &["a", "absent"]), "checked"), "checked");
        assert_eq!(js(&json!("</script>")), "\"\\u003c/script>\"");
        assert_eq!(fill("a{{expr:1}}b{{expr:0}}", &["0".into(), "1".into()]), "a1b0");
    }
}
