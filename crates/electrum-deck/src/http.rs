//! Client HTTP minimal vers l'API locale d'ElectrumOverlay (HTTP/1.1 en clair sur le réseau
//! local) : assez pour quelques requêtes JSON, sans bibliothèque en plus.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

pub struct Server {
    host: String,
    port: u16,
}

/// Encodage d'un segment d'URL (identifiant de profil).
pub fn encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

impl Server {
    pub fn new(host: &str, port: &str) -> Self {
        let host = host.trim();
        Server {
            host: if host.is_empty() { "localhost".into() } else { host.into() },
            port: port.trim().parse().unwrap_or(8080),
        }
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        self.request("GET", path, None)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.request("POST", path, Some(body))
    }

    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        // « localhost » donne souvent ::1 puis 127.0.0.1 : on essaie chaque adresse, pas seulement
        // la première.
        let mut last_error = "adresse introuvable".to_string();
        let mut connected = None;
        for address in (self.host.as_str(), self.port).to_socket_addrs().map_err(|e| e.to_string())? {
            match TcpStream::connect_timeout(&address, TIMEOUT) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        let mut stream = connected.ok_or(last_error)?;
        stream.set_read_timeout(Some(TIMEOUT)).ok();
        stream.set_write_timeout(Some(TIMEOUT)).ok();
        let body = body.map(Value::to_string).unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            self.host,
            self.port,
            body.len()
        );
        stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        parse_response(&raw)
    }
}

/// Statut + corps JSON d'une réponse HTTP/1.1 (`Content-Length` ou `chunked`).
fn parse_response(raw: &[u8]) -> Result<Value, String> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("réponse incomplète")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut body = raw[split + 4..].to_vec();
    let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("statut illisible")?;
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    if !(200..300).contains(&status) {
        return Err(format!("ElectrumOverlay a répondu {status}"));
    }
    Ok(serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") {
        let size = usize::from_str_radix(String::from_utf8_lossy(&data[..line_end]).trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = line_end + 2;
        let end = (start + size).min(data.len());
        out.extend_from_slice(&data[start..end]);
        data = &data[(end + 2).min(data.len())..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reponses() {
        let ok = parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!(ok["ok"], true);
        let chunked = parse_response(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n6\r\n{\"a\":1\r\n1\r\n}\r\n0\r\n\r\n").unwrap();
        assert_eq!(chunked["a"], 1);
        assert!(parse_response(b"HTTP/1.1 404 Not Found\r\n\r\n").is_err());
        assert_eq!(encode("a b/é"), "a%20b%2F%C3%A9");
    }
}
