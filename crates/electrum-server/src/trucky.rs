//! Trucky (panneau d'infos : trajet en cours, stats, société) : port de `src/services/TruckyApi.js`
//! et de la route `/api/info-panel`.
//!
//! L'API Trucky est derrière Cloudflare, qui peut refuser les clients « non navigateurs ». La
//! version Node lançait systématiquement un Chrome invisible (puppeteer) pour chaque appel. Ici :
//! 1. un appel HTTP direct d'abord (rapide, sans navigateur) ;
//! 2. si la réponse n'est pas du JSON (page de vérification Cloudflare), le Chrome ou l'Edge déjà
//!    installé est lancé en mode invisible, UNE seule fois pour toute la requête du panneau.

use crate::state::AppState;
use chromiumoxide::browser::{Browser, BrowserConfig, HeadlessMode};
use chromiumoxide::detection::{default_executable, DetectionOptions};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

/// Même User-Agent que la version Node (un navigateur ordinaire).
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

/// Récupère des URLs JSON de Trucky, en ne lançant le navigateur qu'en cas de besoin.
pub struct Fetcher {
    http: reqwest::Client,
    browser: Option<(Browser, tokio::task::JoinHandle<()>)>,
}

impl Fetcher {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(15))
            .build()
            .expect("client HTTP");
        Fetcher { http, browser: None }
    }

    pub async fn get_json(&mut self, url: &str) -> Result<Value, String> {
        if let Ok(response) = self.http.get(url).header("Accept", "application/json").send().await {
            if response.status().is_success() {
                if let Ok(text) = response.text().await {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        return Ok(value);
                    }
                }
            }
        }
        self.get_json_with_browser(url).await
    }

    async fn browser(&mut self) -> Result<&Browser, String> {
        if self.browser.is_none() {
            let executable = default_executable(DetectionOptions::default()).map_err(|_| {
                "Aucun navigateur Chrome ou Edge détecté sur cette machine. Installez Google Chrome ou Microsoft Edge pour utiliser l'intégration Trucky.".to_string()
            })?;
            let config = BrowserConfig::builder()
                .chrome_executable(executable)
                .headless_mode(HeadlessMode::New)
                .no_sandbox()
                .args(["--disable-gpu", "--disable-dev-shm-usage"])
                .launch_timeout(Duration::from_secs(20))
                .build()?;
            let (browser, mut handler) = Browser::launch(config).await.map_err(|e| format!("lancement du navigateur impossible : {e}"))?;
            let task = tokio::spawn(async move { while handler.next().await.is_some() {} });
            self.browser = Some((browser, task));
        }
        Ok(&self.browser.as_ref().expect("navigateur lancé juste au-dessus").0)
    }

    async fn get_json_with_browser(&mut self, url: &str) -> Result<Value, String> {
        let browser = self.browser().await?;
        let page = browser.new_page("about:blank").await.map_err(|e| e.to_string())?;
        page.set_user_agent(USER_AGENT).await.map_err(|e| e.to_string())?;
        page.goto(url).await.map_err(|e| e.to_string())?;
        // Laisser à Cloudflare le temps de valider sa vérification et de recharger la page.
        let mut text = String::new();
        for _ in 0..20 {
            text = page
                .evaluate("document.body ? document.body.textContent : ''")
                .await
                .ok()
                .and_then(|r| r.into_value::<String>().ok())
                .unwrap_or_default();
            if serde_json::from_str::<Value>(&text).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let _ = page.close().await;
        serde_json::from_str(&text).map_err(|_| "réponse Trucky illisible (vérification Cloudflare non passée ?)".to_string())
    }

    /// Ferme le navigateur s'il a été lancé.
    pub async fn close(mut self) {
        if let Some((mut browser, task)) = self.browser.take() {
            let _ = browser.close().await;
            let _ = browser.wait().await;
            task.abort();
        }
    }
}

impl Default for Fetcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Erreur de `/api/info-panel` : code HTTP + message (mêmes messages que la version Node).
pub type PanelError = (u16, String);

/// Données du panneau d'infos (`{ userData, lastJob, companyStats, companyDetails? }`).
pub async fn info_panel(state: &AppState) -> Result<Value, PanelError> {
    let (enabled, user_id) = {
        let store = state.store();
        let trucky = &store.config()["trucky"];
        (electrum_core::json::is_truthy(trucky.get("enable")), electrum_core::json::js_string_or_empty(trucky.get("USER_ID")))
    };
    if !enabled {
        return Err((404, "Intégration Trucky désactivée".into()));
    }
    // L'ID est inséré dans l'adresse de l'API : seulement des chiffres.
    let user_id = user_id.trim().to_string();
    if user_id.is_empty() || !user_id.chars().all(|c| c.is_ascii_digit()) {
        return Err((400, "ID utilisateur Trucky invalide (un nombre, visible dans l'adresse de ton profil Trucky)".into()));
    }
    let base = state.trucky_base.clone();
    let mut fetcher = Fetcher::new();
    let result = collect(&mut fetcher, state, &base, &user_id).await;
    fetcher.close().await;
    result
}

async fn collect(fetcher: &mut Fetcher, state: &AppState, base: &str, user_id: &str) -> Result<Value, PanelError> {
    let failed = |error: String| {
        state.log("error", format!("❌ Erreur lors de la récupération des données Trucky: {error}"));
        (500, "Erreur lors de la récupération des données".to_string())
    };
    let user = fetcher.get_json(&format!("{base}v1/user/{user_id}")).await.map_err(failed)?;
    if !electrum_core::json::is_truthy(Some(&user)) {
        return Err((404, "Aucun utilisateur trouvé pour l'API Trucky".into()));
    }
    let jobs = fetcher.get_json(&format!("{base}v1/user/{user_id}/jobs")).await.map_err(failed)?;
    let last_job = jobs["data"][0].clone();
    if !electrum_core::json::is_truthy(Some(&last_job)) {
        return Err((404, "Aucun job trouvé pour l'utilisateur Trucky".into()));
    }
    let mut panel = json!({ "userData": user, "lastJob": last_job, "companyStats": null });
    let company_id = panel["userData"]["company_id"].clone();
    if electrum_core::json::is_truthy(Some(&company_id)) {
        let id = electrum_core::json::js_string_or_empty(Some(&company_id));
        panel["companyStats"] = fetcher.get_json(&format!("{base}v1/company/{id}/stats/aggregated")).await.map_err(failed)?;
        panel["companyDetails"] = fetcher.get_json(&format!("{base}v1/company/{id}")).await.map_err(failed)?;
    }
    Ok(panel)
}
