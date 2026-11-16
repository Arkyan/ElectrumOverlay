//! Structure commune des pages de l'app : barre de titre (déplaçable, boutons de fenêtre),
//! barre latérale de navigation, état du serveur et de Twitch. Chaque page contient
//! `{{shell:open}}` juste après `<body>` et `{{shell:close}}` juste avant `</body>`.
//!
//! Les boutons de fenêtre et le bouton serveur passent par `window.electronAPI` (pont Tauri) :
//! ouverts dans un navigateur ordinaire, ils sont simplement masqués.

/// Icônes (24×24, trait de 1,75) : `<svg class="icon"><use href="#i-home"/></svg>`.
const ICONS: &str = r##"<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-home" viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/></symbol>
<symbol id="i-scene" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/><rect x="6.5" y="7.5" width="6" height="4" rx="0.5"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24"><path d="M4 5h16v11H10l-4 4v-4H4z"/><path d="M8 9h8M8 12h5"/></symbol>
<symbol id="i-plug" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/></symbol>
<symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></symbol>
<symbol id="i-chart" viewBox="0 0 24 24"><path d="M3 20h18"/><path d="M6 16v-5M11 16V6M16 16v-8M21 16v-3"/></symbol>
<symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/></symbol>
<symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/></symbol>
<symbol id="i-power" viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></symbol>
<symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
<symbol id="i-min" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
<symbol id="i-max" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
</svg>"##;

/// Entrée de navigation : (chemin, libellé, icône).
type NavItem = (&'static str, &'static str, &'static str);

/// Groupes de navigation : (titre du groupe, entrées).
const NAV: &[(&str, &[NavItem])] = &[
    ("", &[
        ("/app", "Tableau de bord", "home"),
        ("/scene-editor", "Éditeur de scène", "scene"),
        ("/settings", "Paramètres", "sliders"),
    ]),
    ("Contenu", &[
        ("/commands", "Commandes de chat", "chat"),
        ("/integrations", "Intégrations", "plug"),
    ]),
    ("Live", &[
        ("/tests", "Tests", "zap"),
        ("/stream-stats-html", "Statistiques", "chart"),
        ("/logs", "Logs", "terminal"),
    ]),
    ("Compte", &[
        ("/setup", "Configuration", "key"),
    ]),
];

pub fn icon(name: &str) -> String {
    format!("<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-{name}\"/></svg>")
}

fn open(active: &str) -> String {
    let mut nav = String::new();
    for (label, items) in NAV {
        nav.push_str("<div class=\"nav-group\">");
        if !label.is_empty() {
            nav.push_str(&format!("<div class=\"nav-label\">{label}</div>"));
        }
        for (path, text, name) in *items {
            let class = if *path == active { "nav-item active" } else { "nav-item" };
            nav.push_str(&format!("<a class=\"{class}\" href=\"{path}\" title=\"{text}\">{}<span>{text}</span></a>", icon(name)));
        }
        nav.push_str("</div>");
    }
    format!(
        r#"{ICONS}
<header class="chrome" data-tauri-drag-region>
    <div class="chrome-brand" data-tauri-drag-region><img src="/logo.png" alt="" data-tauri-drag-region>ElectrumOverlay <span class="chrome-version" id="chromeVersion" data-tauri-drag-region></span></div>
    <div class="chrome-controls">
        <button type="button" id="winMin" title="Réduire">{min}</button>
        <button type="button" id="winMax" title="Agrandir">{max}</button>
        <button type="button" id="winClose" class="close" title="Fermer (l'app reste dans la zone de notification)">{close}</button>
    </div>
</header>
<div class="{shell_class}">
<nav class="sidebar">
    {nav}
    <div class="sidebar-status">
        <div class="status-line" title="Serveur des overlays"><span class="dot ok" id="shellServerDot"></span><span class="status-text" id="shellServerText">Serveur actif</span></div>
        <div class="status-line" title="Connexion à Twitch (EventSub)"><span class="dot" id="shellTwitchDot"></span><span class="status-text" id="shellTwitchText">Twitch…</span></div>
        <button type="button" class="btn btn-sm" id="shellServerToggle" hidden>{power}<span>Arrêter le serveur</span></button>
    </div>
</nav>
<main class="main">"#,
        min = icon("min"),
        max = icon("max"),
        close = icon("close"),
        power = icon("power"),
        shell_class = if active == "/scene-editor" { "shell nav-compact" } else { "shell" },
    )
}

const CLOSE: &str = r#"</main>
</div>
<script>
(function () {
    const api = window.electronAPI;
    const $ = (id) => document.getElementById(id);
    if (api) {
        document.documentElement.classList.add('in-app');
        api.getAppVersion().then((v) => { if (v) $('chromeVersion').textContent = 'v' + v; });
        $('winMin').onclick = () => api.minimize();
        $('winMax').onclick = () => api.maximize();
        $('winClose').onclick = () => api.close();
    }

    // État du serveur (bouton Arrêter/Démarrer : seulement dans l'app) et de Twitch.
    const toggle = $('shellServerToggle');
    function renderServer(running) {
        $('shellServerDot').className = 'dot ' + (running ? 'ok' : 'bad');
        $('shellServerText').textContent = running ? 'Serveur actif' : 'Serveur arrêté';
        toggle.querySelector('span').textContent = running ? 'Arrêter le serveur' : 'Démarrer le serveur';
        toggle.dataset.running = running ? '1' : '';
    }
    if (api) {
        toggle.hidden = false;
        api.getServerStatus().then(renderServer);
        api.onServerStatusChange(renderServer);
        toggle.onclick = async () => {
            toggle.disabled = true;
            await (toggle.dataset.running ? api.stopServer() : api.startServer());
            renderServer(await api.getServerStatus());
            toggle.disabled = false;
        };
    }
    function refreshTwitch() {
        fetch('/status').then((r) => r.ok ? r.json() : null).then((s) => {
            if (!s) return;
            const e = s.eventsub || {};
            const [cls, text] = !s.twitchAuthenticated ? ['bad', 'Twitch non autorisé']
                : e.connected ? ['ok', 'Twitch connecté']
                : e.needsAuthorization ? ['bad', 'Twitch : à ré-autoriser']
                : ['warn', 'Twitch : connexion…'];
            $('shellTwitchDot').className = 'dot ' + cls;
            $('shellTwitchText').textContent = text;
            $('shellTwitchDot').parentElement.title = e.lastError || 'Connexion à Twitch (EventSub)';
        }).catch(() => {});
    }
    refreshTwitch();
    setInterval(refreshTwitch, 10000);
})();
</script>"#;

/// Remplace les repères de structure. `active` = chemin de l'entrée de navigation en surbrillance.
pub fn wrap(html: &str, active: &str) -> String {
    html.replacen("{{shell:open}}", &open(active), 1)
        .replacen("{{shell:close}}", CLOSE, 1)
        .replacen("{{shell:standalone}}", "<div class=\"standalone\">", 1)
        .replacen("{{shell:standalone-close}}", "</div>", 1)
}
