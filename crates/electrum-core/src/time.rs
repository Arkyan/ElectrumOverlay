/// Horodatage au format `new Date().toISOString()` : `2026-11-16T18:13:09.123Z`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    #[test]
    fn format_iso_js() {
        let s = super::now_iso();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z') && s.as_bytes()[19] == b'.', "{s}");
    }
}
