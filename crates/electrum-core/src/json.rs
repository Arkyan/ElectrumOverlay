//! Utilitaires JSON qui reproduisent à l'identique le comportement de la version Node
//! (`src/config/store.js`). La config et les profils sont manipulés comme du JSON générique
//! (`serde_json::Value`, ordre des clés préservé) et jamais via des structures rigides : une clé
//! inconnue de cette version doit survivre à une réécriture du fichier (voir docs/FORMATS.md §10).

use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter};
use serde_json::{json, Map, Value};
use std::io;

/// Équivalent de `isPlainObject` : un objet JSON, pas un tableau ni `null`.
pub fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

/// Équivalent exact de `deepMerge(base, override)` :
/// - deux objets → fusion récursive clé par clé ;
/// - sinon → `override` remplace `base` (les tableaux ne sont jamais fusionnés).
///
/// `None` joue le rôle de `undefined` côté JS (clé absente).
pub fn deep_merge(base: Option<&Value>, over: Option<&Value>) -> Value {
    match (base, over) {
        (Some(Value::Object(b)), Some(Value::Object(o))) => {
            let mut result = b.clone();
            for (key, value) in o {
                let merged = deep_merge(b.get(key), Some(value));
                result.insert(key.clone(), merged);
            }
            Value::Object(result)
        }
        (_, Some(o)) => o.clone(),
        (Some(b), None) => b.clone(),
        (None, None) => Value::Null,
    }
}

/// Raccourci pour le cas courant où les deux valeurs existent.
pub fn merge(base: &Value, over: &Value) -> Value {
    deep_merge(Some(base), Some(over))
}

/// Accès en écriture à `obj[key]` en créant un objet vide si la clé est absente ou n'est pas un
/// objet (équivalent de `obj[key] = obj[key] || {}`).
pub fn ensure_object<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let entry = obj.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().expect("objet garanti juste au-dessus")
}

/// Équivalent de `String(value)` pour les valeurs qu'on peut raisonnablement rencontrer
/// (`undefined`/`null` → chaîne vide, comme le fait `String(x || '')` dans store.js).
pub fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(Value::Number(n)) => js_number_to_string(n.as_f64().unwrap_or(0.0)),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                other => js_string_or_empty(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// Équivalent de `Number(x)` pour les valeurs JSON (`undefined` → NaN, `null` → 0, `""` → 0...).
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() { 0.0 } else { s.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Some(Value::Array(_)) | Some(Value::Object(_)) => f64::NAN,
    }
}

/// Nombre JSON écrit comme en JS (5 et non 5.0).
pub fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// Valeur JS « truthy » (utile pour reproduire les `entry && entry.dataBase64`).
pub fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Équivalent de `encodeURIComponent`.
pub fn encode_uri_component(input: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || KEEP.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Nombre formaté comme le fait JavaScript : un flottant entier s'écrit sans `.0`.
pub fn js_number_to_string(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        if value == 0.0 {
            "0".to_string()
        } else {
            format!("{value:.0}")
        }
    } else {
        let mut buf = Vec::new();
        let _ = serde_json::to_writer(&mut buf, &value);
        String::from_utf8(buf).unwrap_or_default()
    }
}

/// Formatter « JSON.stringify(x, null, 2) » : indentation 2 espaces (comme PrettyFormatter),
/// mais un flottant entier (ex. 2.0) est écrit `2`, comme en JS.
struct JsPrettyFormatter<'a> {
    inner: PrettyFormatter<'a>,
}

impl Formatter for JsPrettyFormatter<'_> {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(js_number_to_string(value).as_bytes())
    }
    fn begin_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.begin_array(w)
    }
    fn end_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_array(w)
    }
    fn begin_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.inner.begin_array_value(w, first)
    }
    fn end_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_array_value(w)
    }
    fn begin_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.begin_object(w)
    }
    fn end_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_object(w)
    }
    fn begin_object_key<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.inner.begin_object_key(w, first)
    }
    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.begin_object_value(w)
    }
    fn end_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.inner.end_object_value(w)
    }
}

/// Équivalent de `JSON.stringify(value)` (compact), pour les messages WebSocket.
pub fn to_js_string(value: &Value) -> String {
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, JsCompactFormatter);
    value.serialize(&mut ser).expect("sérialiser une Value en mémoire ne peut pas échouer");
    String::from_utf8(buf).expect("serde_json produit toujours de l'UTF-8")
}

struct JsCompactFormatter;

impl Formatter for JsCompactFormatter {
    fn write_f64<W: ?Sized + io::Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(js_number_to_string(value).as_bytes())
    }
}

/// Équivalent de `JSON.stringify(value, null, 2)`.
pub fn to_js_pretty_string(value: &Value) -> String {
    let mut buf = Vec::new();
    let formatter = JsPrettyFormatter { inner: PrettyFormatter::with_indent(b"  ") };
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    value.serialize(&mut ser).expect("sérialiser une Value en mémoire ne peut pas échouer");
    String::from_utf8(buf).expect("serde_json produit toujours de l'UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_objets_recursif_et_tableaux_remplaces() {
        let base = json!({ "a": { "x": 1, "y": 2 }, "list": [1, 2, 3], "keep": true });
        let over = json!({ "a": { "y": 20, "z": 30 }, "list": [9] });
        assert_eq!(
            merge(&base, &over),
            json!({ "a": { "x": 1, "y": 20, "z": 30 }, "list": [9], "keep": true })
        );
    }

    #[test]
    fn merge_null_et_types_differents_remplacent() {
        assert_eq!(merge(&json!({ "a": { "x": 1 } }), &json!({ "a": null })), json!({ "a": null }));
        assert_eq!(merge(&json!({ "a": [1] }), &json!({ "a": { "x": 1 } })), json!({ "a": { "x": 1 } }));
        assert_eq!(merge(&json!({ "a": 1 }), &json!("texte")), json!("texte"));
    }

    #[test]
    fn merge_garde_l_ordre_des_cles() {
        let merged = merge(&json!({ "b": 1, "a": 2 }), &json!({ "c": 3, "b": 4 }));
        let keys: Vec<_> = merged.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["b", "a", "c"]);
    }

    #[test]
    fn stringify_comme_js() {
        let value = json!({ "entier": 2.0, "flottant": 0.8, "vide": {}, "liste": [], "é": "🎮" });
        assert_eq!(
            to_js_pretty_string(&value),
            "{\n  \"entier\": 2,\n  \"flottant\": 0.8,\n  \"vide\": {},\n  \"liste\": [],\n  \"é\": \"🎮\"\n}"
        );
    }

    #[test]
    fn stringify_compact_comme_js() {
        assert_eq!(to_js_string(&json!({ "a": [1.0, 0.5], "b": "x" })), r#"{"a":[1,0.5],"b":"x"}"#);
    }

    #[test]
    fn encode_uri_component_comme_js() {
        assert_eq!(
            encode_uri_component("2026-11-16T18:13:09.123Z"),
            "2026-11-16T18%3A13%3A09.123Z"
        );
        assert_eq!(encode_uri_component("a b/é"), "a%20b%2F%C3%A9");
    }
}
