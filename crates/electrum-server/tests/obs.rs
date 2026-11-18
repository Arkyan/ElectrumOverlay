//! Configuration automatique d'OBS contre un faux serveur obs-websocket 5 (même protocole).

use electrum_server::obs::{auth_response, configure, SceneSetup};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct FakeObs {
    scenes: Vec<String>,
    /// (nom de la source, scène, réglages)
    inputs: Vec<(String, String, Value)>,
    calls: Vec<String>,
}

async fn start(password: &'static str, obs: Arc<Mutex<FakeObs>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let obs = obs.clone();
            tokio::spawn(async move {
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let (salt, challenge) = ("c2VsLWRlLXRlc3Q=", "ZGVmaS1kZS10ZXN0");
                ws.send(Message::text(json!({ "op": 0, "d": { "rpcVersion": 1, "authentication": { "salt": salt, "challenge": challenge } } }).to_string())).await.unwrap();
                let identify: Value = match ws.next().await { Some(Ok(Message::Text(t))) => serde_json::from_str(&t).unwrap(), _ => return };
                if identify["d"]["authentication"] != auth_response(password, salt, challenge).as_str() {
                    let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(4009), reason: "Authentication failed.".into() }))).await;
                    return;
                }
                ws.send(Message::text(json!({ "op": 2, "d": { "negotiatedRpcVersion": 1 } }).to_string())).await.unwrap();
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    let (kind, data) = (request["d"]["requestType"].as_str().unwrap().to_string(), request["d"]["requestData"].clone());
                    let (ok, response) = {
                    let mut state = obs.lock().unwrap();
                    state.calls.push(kind.clone());
                    match kind.as_str() {
                        "GetSceneList" => (true, json!({ "scenes": state.scenes.iter().map(|s| json!({ "sceneName": s })).collect::<Vec<_>>() })),
                        "GetInputList" => (true, json!({ "inputs": state.inputs.iter().map(|i| json!({ "inputName": i.0 })).collect::<Vec<_>>() })),
                        "CreateScene" => { state.scenes.push(data["sceneName"].as_str().unwrap().into()); (true, json!({})) }
                        "CreateInput" => {
                            assert_eq!(data["inputKind"], "browser_source");
                            state.inputs.push((data["inputName"].as_str().unwrap().into(), data["sceneName"].as_str().unwrap().into(), data["inputSettings"].clone()));
                            (true, json!({ "sceneItemId": 1 }))
                        }
                        "SetInputSettings" => {
                            let input = state.inputs.iter_mut().find(|i| i.0 == data["inputName"]).unwrap();
                            input.2 = data["inputSettings"].clone();
                            (true, json!({}))
                        }
                        "GetSceneItemId" => (state.inputs.iter().any(|i| i.0 == data["sourceName"] && i.1 == data["sceneName"]), json!({ "sceneItemId": 1 })),
                        "CreateSceneItem" => (true, json!({ "sceneItemId": 2 })),
                        _ => (false, json!({})),
                    }
                    };
                    let status = if ok { json!({ "result": true, "code": 100 }) } else { json!({ "result": false, "code": 600, "comment": "introuvable" }) };
                    let reply = json!({ "op": 7, "d": { "requestType": kind, "requestId": request["d"]["requestId"], "requestStatus": status, "responseData": response } });
                    ws.send(Message::text(reply.to_string())).await.unwrap();
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn configuration_automatique_d_obs() {
    let obs = Arc::new(Mutex::new(FakeObs { scenes: vec!["En direct".into(), "Ma scène à moi".into()], ..Default::default() }));
    let port = start("secret", obs.clone()).await;
    let scenes = vec![
        SceneSetup { name: "Démarrage".into(), url: "http://localhost:8080/starting.html".into() },
        SceneSetup { name: "En direct".into(), url: "http://localhost:8080/".into() },
    ];

    let report = configure("127.0.0.1", port, "secret", &scenes, true).await.unwrap();
    assert_eq!(report, ["Scène « Démarrage » créée", "« Démarrage » : source navigateur ajoutée", "« En direct » : source navigateur ajoutée"]);
    {
        let state = obs.lock().unwrap();
        assert_eq!(state.scenes, ["En direct", "Ma scène à moi", "Démarrage"], "scène existante gardée, pas recréée");
        let live = state.inputs.iter().find(|i| i.0 == "ElectrumOverlay - En direct").unwrap();
        assert_eq!(live.2, json!({ "url": "http://localhost:8080/", "width": 1920, "height": 1080, "reroute_audio": true, "restart_when_active": false }));
    }

    // Deuxième passage : rien n'est dupliqué, les sources sont mises à jour.
    let report = configure("127.0.0.1", port, "secret", &scenes, false).await.unwrap();
    assert_eq!(report, ["« Démarrage » : source mise à jour", "« En direct » : source mise à jour"]);
    assert_eq!(obs.lock().unwrap().inputs.len(), 2);
    assert_eq!(obs.lock().unwrap().inputs[0].2["reroute_audio"], false);

    // Mauvais mot de passe, mot de passe manquant, OBS fermé.
    assert_eq!(configure("127.0.0.1", port, "faux", &scenes, true).await.unwrap_err(), "Mot de passe OBS incorrect");
    assert!(configure("127.0.0.1", port, "", &scenes, true).await.unwrap_err().contains("OBS demande un mot de passe"));
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    assert!(configure("127.0.0.1", closed, "", &scenes, true).await.unwrap_err().contains("OBS injoignable"));
}
