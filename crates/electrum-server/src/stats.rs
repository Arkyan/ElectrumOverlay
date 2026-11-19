//! Statistiques du stream en cours : port de `src/services/StreamStatsManager.js`.

use serde_json::{json, Value};

#[derive(Debug, Clone, Default)]
pub struct StreamStats {
    pub is_live: bool,
    pub start_time: Option<String>,
    pub follows: u64,
    pub subscribers: u64,
    pub chat_messages: u64,
    pub title: String,
    pub game: String,
    pub viewer_count: u64,
    /// Fin du dernier live (ms) : la durée reste affichée sur l'écran de fin.
    pub end_ms: Option<i64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp_millis())
}

impl StreamStats {
    pub fn reset(&mut self) {
        *self = StreamStats::default();
    }

    /// `stream.online` : remet les compteurs à zéro et démarre le chrono.
    pub fn start_stream(&mut self, started_at: Option<&str>, title: Option<&str>, game: Option<&str>) {
        self.reset();
        self.is_live = true;
        self.start_time = Some(
            started_at
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(electrum_core::time::now_iso),
        );
        self.title = title.unwrap_or_default().to_string();
        self.game = game.unwrap_or_default().to_string();
    }

    /// Live déjà en cours à l'ouverture de l'app : passe en direct sans effacer les compteurs.
    pub fn resume_stream(&mut self, started_at: Option<&str>, title: Option<&str>, game: Option<&str>) {
        let counters = (self.follows, self.subscribers, self.chat_messages);
        self.start_stream(started_at, title, game);
        (self.follows, self.subscribers, self.chat_messages) = counters;
    }

    /// `stream.offline` : les compteurs et la durée restent consultables (écran de fin).
    pub fn end_stream(&mut self) {
        if self.is_live {
            self.end_ms = Some(now_ms());
        }
        self.is_live = false;
    }

    pub fn update_stream_info(&mut self, title: Option<&str>, game: Option<&str>) {
        if self.is_live {
            if let Some(t) = title.filter(|t| !t.is_empty()) {
                self.title = t.to_string();
            }
            if let Some(g) = game.filter(|g| !g.is_empty()) {
                self.game = g.to_string();
            }
        }
    }

    pub fn add_follow(&mut self) {
        self.follows += 1;
    }

    pub fn add_subscriber(&mut self, count: u64) {
        self.subscribers += count;
    }

    pub fn add_chat_message(&mut self) {
        self.chat_messages += 1;
    }

    pub fn update_viewer_count(&mut self, count: u64) {
        self.viewer_count = count;
    }

    fn duration_ms(&self) -> Option<i64> {
        let start = parse_ms(self.start_time.as_deref()?)?;
        let end = if self.is_live { now_ms() } else { self.end_ms? };
        Some(end - start)
    }

    /// `HH:MM:SS`, ou « Stream hors ligne ».
    pub fn stream_duration(&self) -> String {
        match self.duration_ms() {
            None => "Stream hors ligne".to_string(),
            Some(ms) => {
                let ms = ms.max(0);
                let (h, m, s) = (ms / 3_600_000, (ms % 3_600_000) / 60_000, (ms % 60_000) / 1000);
                format!("{h:02}:{m:02}:{s:02}")
            }
        }
    }

    /// Réponse de `GET /api/stream-stats` (mêmes clés, même ordre que `getStats()`).
    pub fn to_json(&self) -> Value {
        json!({
            "isLive": self.is_live,
            "startTime": self.start_time,
            "follows": self.follows,
            "subscribers": self.subscribers,
            "chatMessages": self.chat_messages,
            "title": self.title,
            "game": self.game,
            "viewerCount": self.viewer_count,
            "streamDuration": self.stream_duration(),
            "streamDurationMs": self.duration_ms().unwrap_or(0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycle_de_stream() {
        let mut stats = StreamStats::default();
        assert_eq!(stats.to_json()["streamDuration"], "Stream hors ligne");
        stats.add_follow();
        stats.start_stream(Some("2020-01-01T00:00:00Z"), Some("Titre"), None);
        assert_eq!(stats.follows, 0, "un nouveau stream remet les compteurs à zéro");
        stats.add_subscriber(5);
        stats.update_stream_info(Some(""), Some("Jeu"));
        assert_eq!((stats.title.as_str(), stats.game.as_str()), ("Titre", "Jeu"));
        assert!(stats.stream_duration().len() >= 8);
        stats.end_stream();
        let json = stats.to_json();
        assert_eq!(json["subscribers"], 5);
        assert!(json["streamDurationMs"].as_i64().unwrap() > 0, "la durée reste affichée après la fin du live");
        assert_ne!(json["streamDuration"], "Stream hors ligne");
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        let ended = json["streamDurationMs"].clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(stats.to_json()["streamDurationMs"], ended, "la durée ne bouge plus une fois le live fini");

        // App ouverte en plein live : on passe en direct sans perdre les compteurs.
        let mut stats = StreamStats::default();
        stats.add_follow();
        stats.resume_stream(Some("2020-01-01T00:00:00Z"), Some("Titre"), Some("Jeu"));
        assert!(stats.is_live && stats.follows == 1);
        assert_eq!(keys, ["isLive", "startTime", "follows", "subscribers", "chatMessages", "title", "game", "viewerCount", "streamDuration", "streamDurationMs"]);
    }
}
