//! Configuration automatique d'OBS par son serveur WebSocket (obs-websocket 5, intégré à OBS 28+) :
//! crée les scènes de l'app et y ajoute la source navigateur de chaque overlay.
//! Protocole : https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const TIMEOUT: Duration = Duration::from_secs(8);

/// Scène à préparer dans OBS : nom de la scène, URL de l'overlay.
#[derive(Debug, Clone)]
pub struct SceneSetup {
    pub name: String,
    pub url: String,
}

/// Réponse d'authentification obs-websocket : base64(sha256(base64(sha256(mdp + sel)) + défi)).
pub fn auth_response(password: &str, salt: &str, challenge: &str) -> String {
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let secret = b64(&Sha256::digest(format!("{password}{salt}").as_bytes()));
    b64(&Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

struct Obs {
    socket: Socket,
    next_id: u64,
}

impl Obs {
    async fn receive(&mut self) -> Result<Value, String> {
        loop {
            let message = tokio::time::timeout(TIMEOUT, self.socket.next())
                .await
                .map_err(|_| "OBS ne répond pas".to_string())?
                .ok_or("connexion fermée par OBS")?;
            match message {
                Ok(Message::Text(text)) => return serde_json::from_str(&text).map_err(|e| e.to_string()),
                Ok(Message::Close(frame)) => {
                    let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(0);
                    return Err(match code {
                        4009 => "Mot de passe OBS incorrect".to_string(),
                        _ => format!("connexion fermée par OBS ({code})"),
                    });
                }
                Ok(_) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    async fn connect(host: &str, port: u16, password: &str) -> Result<Obs, String> {
        let url = format!("ws://{host}:{port}");
        let (socket, _) = tokio::time::timeout(TIMEOUT, tokio_tungstenite::connect_async(url.as_str()))
            .await
            .map_err(|_| "OBS ne répond pas".to_string())?
            .map_err(|_| {
                "OBS injoignable : lance OBS et active son serveur WebSocket (Outils › Paramètres du serveur WebSocket)".to_string()
            })?;
        let mut obs = Obs { socket, next_id: 0 };
        let hello = obs.receive().await?;
        if hello["op"] != 0 {
            return Err("réponse inattendue d'OBS".into());
        }
        let mut identify = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
        let auth = &hello["d"]["authentication"];
        if auth.is_object() {
            if password.is_empty() {
                return Err("OBS demande un mot de passe : copie-le depuis Outils › Paramètres du serveur WebSocket › Afficher les infos de connexion".into());
            }
            identify["authentication"] =
                json!(auth_response(password, auth["salt"].as_str().unwrap_or_default(), auth["challenge"].as_str().unwrap_or_default()));
        }
        obs.socket.send(Message::text(json!({ "op": 1, "d": identify }).to_string())).await.map_err(|e| e.to_string())?;
        let identified = obs.receive().await?;
        if identified["op"] != 2 {
            return Err("OBS a refusé la connexion".into());
        }
        Ok(obs)
    }

    /// Requête OBS ; `Err((code, message))` si OBS la refuse.
    async fn request(&mut self, kind: &str, data: Value) -> Result<Value, (i64, String)> {
        self.next_id += 1;
        let id = self.next_id.to_string();
        let message = json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } });
        self.socket.send(Message::text(message.to_string())).await.map_err(|e| (0, e.to_string()))?;
        loop {
            let reply = self.receive().await.map_err(|e| (0, e))?;
            if reply["op"] != 7 || reply["d"]["requestId"] != id.as_str() {
                continue; // événements ou autres réponses
            }
            let status = &reply["d"]["requestStatus"];
            if status["result"].as_bool() == Some(true) {
                return Ok(reply["d"]["responseData"].clone());
            }
            return Err((status["code"].as_i64().unwrap_or(0), status["comment"].as_str().unwrap_or(kind).to_string()));
        }
    }
}

/// Nom de la source navigateur d'une scène.
pub fn source_name(scene: &str) -> String {
    format!("ElectrumOverlay - {scene}")
}

/// Crée (ou met à jour) dans OBS chaque scène et sa source navigateur 1920×1080. Renvoie le
/// compte rendu, une ligne par action.
pub async fn configure(host: &str, port: u16, password: &str, scenes: &[SceneSetup], obs_audio: bool) -> Result<Vec<String>, String> {
    let mut obs = Obs::connect(host, port, password).await?;
    let fail = |(_, message): (i64, String)| format!("OBS : {message}");
    let existing_scenes: Vec<String> = obs
        .request("GetSceneList", json!({}))
        .await
        .map_err(fail)?["scenes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["sceneName"].as_str().map(str::to_string))
        .collect();
    let existing_inputs: Vec<String> = obs
        .request("GetInputList", json!({}))
        .await
        .map_err(fail)?["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| i["inputName"].as_str().map(str::to_string))
        .collect();

    let mut report = Vec::new();
    for scene in scenes {
        let settings = json!({ "url": scene.url, "width": 1920, "height": 1080, "reroute_audio": obs_audio, "restart_when_active": false });
        if !existing_scenes.contains(&scene.name) {
            obs.request("CreateScene", json!({ "sceneName": scene.name })).await.map_err(fail)?;
            report.push(format!("Scène « {} » créée", scene.name));
        }
        let source = source_name(&scene.name);
        if existing_inputs.contains(&source) {
            obs.request("SetInputSettings", json!({ "inputName": source, "inputSettings": settings, "overlay": true })).await.map_err(fail)?;
            // La source existe : on s'assure qu'elle est bien dans la scène.
            match obs.request("GetSceneItemId", json!({ "sceneName": scene.name, "sourceName": source })).await {
                Ok(_) => report.push(format!("« {} » : source mise à jour", scene.name)),
                Err(_) => {
                    obs.request("CreateSceneItem", json!({ "sceneName": scene.name, "sourceName": source, "sceneItemEnabled": true }))
                        .await
                        .map_err(fail)?;
                    report.push(format!("« {} » : source ajoutée", scene.name));
                }
            }
        } else {
            obs.request(
                "CreateInput",
                json!({ "sceneName": scene.name, "inputName": source, "inputKind": "browser_source", "inputSettings": settings, "sceneItemEnabled": true }),
            )
            .await
            .map_err(fail)?;
            report.push(format!("« {} » : source navigateur ajoutée", scene.name));
        }
    }
    let _ = obs.socket.close(None).await;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentification() {
        // Exemple calculé avec la formule de la documentation obs-websocket.
        let secret = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"supersecretpasswordlrbE0iUUFxyBz4ldJDkHHQ=="));
        let expected = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(format!("{secret}+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=").as_bytes()));
        assert_eq!(auth_response("supersecretpassword", "lrbE0iUUFxyBz4ldJDkHHQ==", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="), expected);
    }
}
