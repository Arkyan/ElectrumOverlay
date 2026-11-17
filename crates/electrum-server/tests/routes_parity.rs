//! Parité des routes avec la version Node : `tests/node/calls.json` est joué sur les VRAIS
//! handlers de `src/routes/profiles.js` et `settings.js` (via `tests/node/routes_scenario.js`),
//! puis sur electrum-server. Réponses (code + corps), diffusions `config-updated` et config
//! obtenue doivent être identiques, aux UUID et horodatages près.

use axum::body::Body;
use axum::http::Request;
use electrum_core::Store;
use electrum_server::{http_router, AppState, Assets};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tower::ServiceExt;

fn here() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn calls() -> Vec<Value> {
    let text = std::fs::read_to_string(here().join("tests").join("node").join("calls.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn node_available() -> bool {
    Command::new("node").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn fill(text: &str, vars: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (key, value) in vars {
        out = out.replace(&format!("{{{key}}}"), value);
    }
    out
}

fn fill_value(value: &Value, vars: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => Value::String(fill(s, vars)),
        Value::Array(items) => Value::Array(items.iter().map(|v| fill_value(v, vars)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill_value(v, vars))).collect()),
        other => other.clone(),
    }
}

async fn run_rust(dir: &Path) -> Value {
    let mut store = Store::open(dir).unwrap();
    // Config Twitch complète : sinon toutes les pages redirigent vers /setup (comme côté Node).
    store.save_config(&serde_json::json!({ "twitch": { "CLIENT_ID": "test", "CLIENT_SECRET": "s", "BROADCASTER_ID": "1", "USER_ACCESS_TOKEN": "t" } })).unwrap();
    let repo = here().join("..").join("..");
    let state = AppState::new(store, Assets { public_dir: repo.join("public"), templates_dir: repo.join("src").join("templates") });
    let mut events = state.subscribe();
    let mut vars = HashMap::from([("active".to_string(), state.store().active_profile_id().unwrap().to_string())]);

    let mut responses = Vec::new();
    for call in calls() {
        let mut uri = call["route"].as_str().unwrap().to_string();
        if let Some(params) = call["params"].as_object() {
            for (key, value) in params {
                uri = uri.replace(&format!(":{key}"), &fill(value.as_str().unwrap(), &vars));
            }
        }
        let body = call.get("body").map(|b| fill_value(b, &vars)).unwrap_or(Value::Null);
        let request = Request::builder()
            .method(call["method"].as_str().unwrap())
            .uri(&uri)
            .header("content-type", "application/json")
            .body(if body.is_null() { Body::empty() } else { Body::from(body.to_string()) })
            .unwrap();
        let response = http_router(state.clone()).oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        for (field, var) in [("elementId", "element"), ("sceneId", "scene")] {
            if let Some(v) = payload.get(field).and_then(Value::as_str) {
                vars.insert(var.into(), v.into());
            }
        }
        if let Some(v) = payload.get("profile").and_then(|p| p.get("id")).and_then(Value::as_str) {
            vars.insert("profile".into(), v.into());
        }
        let mut broadcasts = Vec::new();
        while let Ok(event) = events.try_recv() {
            broadcasts.push(serde_json::from_str::<Value>(&event).unwrap()["type"].clone());
        }
        responses.push(json!({ "status": status, "body": payload, "broadcasts": broadcasts }));
    }

    let store = state.store();
    json!({
        "responses": responses,
        "display": store.effective_display(store.active_profile_id().unwrap()).unwrap(),
        "profiles": store.list_profiles().unwrap()
    })
}

/// Remplace UUID et horodatages par des jetons numérotés dans l'ordre d'apparition.
fn normalize(value: &Value) -> String {
    let text = serde_json::to_string_pretty(value).unwrap();
    let ts = regex::Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}(:|%3A)\d{2}(:|%3A)\d{2}\.\d{3}Z").unwrap();
    let uuid = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").unwrap();
    let text = ts.replace_all(&text, "<horodatage>").to_string();
    let mut ids: HashMap<String, usize> = HashMap::new();
    uuid.replace_all(&text, |m: &regex::Captures| {
        let next = ids.len() + 1;
        format!("<id-{}>", ids.entry(m[0].to_string()).or_insert(next))
    })
    .to_string()
}

#[tokio::test]
async fn memes_reponses_que_les_routes_node() {
    if !node_available() {
        eprintln!("⚠️  node introuvable : test de parité des routes ignoré");
        return;
    }
    let node_dir = tempfile::tempdir().unwrap();
    let rust_dir = tempfile::tempdir().unwrap();

    let output = Command::new("node")
        .arg(here().join("tests").join("node").join("routes_scenario.js"))
        .arg(here().join("tests").join("node").join("calls.json"))
        .env("ELECTRUM_CONFIG_DIR", node_dir.path())
        .output()
        .expect("lancement de node");
    assert!(output.status.success(), "routes_scenario.js a échoué :\n{}", String::from_utf8_lossy(&output.stderr));
    let node: Value = serde_json::from_slice(&output.stdout).unwrap();
    let rust = run_rust(rust_dir.path()).await;

    let (node_responses, rust_responses) = (node["responses"].as_array().unwrap(), rust["responses"].as_array().unwrap());
    let calls = calls();
    for (i, (n, r)) in node_responses.iter().zip(rust_responses).enumerate() {
        assert_eq!(normalize(r), normalize(n), "appel n°{i} : {} {}", calls[i]["method"], calls[i]["route"]);
    }
    assert_eq!(normalize(&rust["display"]), normalize(&node["display"]), "display effectif différent");
    assert_eq!(normalize(&rust["profiles"]), normalize(&node["profiles"]), "liste des profils différente");
}
