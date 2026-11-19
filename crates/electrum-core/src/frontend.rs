//! Configuration envoyée aux overlays : `GET /js/config.js` et message WebSocket
//! `config-updated` (port de `toFrontendConfig()`, voir docs/FORMATS.md §7).

use crate::assets::AssetKind;
use crate::json::encode_uri_component;
use crate::store::Store;
use serde_json::{json, Map, Value};

impl Store {
    /// Objet `OVERLAY_CONFIG` : `server`, `twitch.broadcasterId`, puis toutes les clés du display
    /// effectif. Chaque type d'alerte reçoit `sound` et `media` (URL versionnée ou `null`).
    pub fn to_frontend_config(&self) -> Value {
        let mut display = self.config.get("display").cloned().unwrap_or_else(|| json!({}));

        if let (Some(active_id), Some(types)) = (
            self.active_profile_id(),
            display.get_mut("alerts").and_then(|a| a.get_mut("types")).and_then(Value::as_object_mut),
        ) {
            let active = self.active_profile.as_ref();
            for (alert_type, settings) in types.iter_mut() {
                let url_for = |kind: AssetKind| -> Value {
                    active
                        .and_then(|p| p.get(kind.key()))
                        .and_then(|m| m.get(alert_type))
                        .filter(|meta| crate::json::is_truthy(Some(meta)))
                        .map(|meta| {
                            let version = crate::json::js_string_or_empty(meta.get("updatedAt"));
                            json!(format!(
                                "/api/profiles/{active_id}/{}/{alert_type}?v={}",
                                kind.key(),
                                encode_uri_component(&version)
                            ))
                        })
                        .unwrap_or(Value::Null)
                };
                let sound = url_for(AssetKind::Audio);
                let media = url_for(AssetKind::Media);
                let mut entry = settings.as_object().cloned().unwrap_or_default();
                entry.insert("sound".into(), sound);
                entry.insert("media".into(), media);
                *settings = Value::Object(entry);
            }
        }

        let server = &self.config["server"];
        let mut out = Map::new();
        out.insert(
            "server".into(),
            json!({ "host": server["HOST"], "port": server["PORT"], "wsPort": server["WS_PORT"] }),
        );
        let mut twitch = Map::new();
        if let Some(id) = self.config["twitch"].get("BROADCASTER_ID") {
            twitch.insert("broadcasterId".into(), id.clone());
        }
        out.insert("twitch".into(), Value::Object(twitch));
        if let Value::Object(display) = display {
            for (key, value) in display {
                // Ces clés viennent de la config de l'app : un profil (importé) ne les remplace pas.
                if key == "server" || key == "twitch" {
                    continue;
                }
                out.insert(key, value);
            }
        }
        Value::Object(out)
    }

    /// Contenu de `/js/config.js`.
    pub fn frontend_config_script(&self) -> String {
        format!(
            "globalThis.OVERLAY_CONFIG = {};",
            serde_json::to_string(&self.to_frontend_config()).expect("Value toujours sérialisable")
        )
    }
}
