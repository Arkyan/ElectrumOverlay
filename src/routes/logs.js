const express = require('express');
const LogBuffer = require('../services/LogBuffer');
const config = require('../config/store');

/**
 * Fenêtre de logs en direct — utile une fois l'app packagée (plus de terminal visible).
 * L'historique vient de /api/logs, le direct arrive via le WebSocket déjà utilisé pour les
 * événements Twitch et les mises à jour de /settings (voir public/js/overlay-common.js pour
 * le pendant côté overlays — ici c'est une page admin séparée, avec son propre petit script).
 */
function createLogsRoutes() {
    const router = express.Router();

    router.get('/logs', (req, res) => {
        res.send(LOGS_PAGE_HTML(config.server.WS_PORT));
    });

    router.get('/api/logs', (req, res) => {
        res.json({ lines: LogBuffer.getBuffer() });
    });

    return router;
}

const LOGS_PAGE_HTML = (wsPort) => `
<html>
<head>
    <title>Logs - ElectrumOverlay</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/css/app-ui.css">
    <style>
        .page { max-width: none; padding-left: var(--space-5); padding-right: var(--space-5); }
        #log {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: var(--space-4);
            font-family: 'Cascadia Code', 'Consolas', monospace;
            font-size: 12.5px;
            line-height: 1.6;
            height: calc(100vh - var(--titlebar-height) - 160px);
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .log-line { display: flex; gap: var(--space-2); }
        .log-time { color: var(--text-faint); flex-shrink: 0; }
        .log-error { color: var(--error); }
        .log-warn { color: #fbbf24; }
        .top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-3); }
    </style>
</head>
<body>
    <script src="/js/app-titlebar.js"></script>
    <div class="page in-app">
        <a class="back-link" href="/app">← Retour</a>
        <div class="top-row">
            <h1 style="margin:0;">Logs</h1>
            <label class="checkbox-row"><input type="checkbox" id="autoscroll" checked> Défilement automatique</label>
        </div>
        <div id="log"></div>
    </div>

    <script>
        const logEl = document.getElementById('log');
        const autoscroll = document.getElementById('autoscroll');

        function appendLine(entry) {
            const div = document.createElement('div');
            div.className = 'log-line' + (entry.level === 'error' ? ' log-error' : entry.level === 'warn' ? ' log-warn' : '');
            const time = new Date(entry.time).toLocaleTimeString();
            div.innerHTML = '<span class="log-time">' + time + '</span><span></span>';
            div.lastElementChild.textContent = entry.text;
            logEl.appendChild(div);
            if (autoscroll.checked) {
                logEl.scrollTop = logEl.scrollHeight;
            }
        }

        fetch('/api/logs')
            .then(r => r.json())
            .then(data => {
                (data.lines || []).forEach(appendLine);
                logEl.scrollTop = logEl.scrollHeight;
            });

        const ws = new WebSocket('ws://localhost:${wsPort}');
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'log') {
                appendLine(data);
            }
        };
    </script>
</body>
</html>
`;

module.exports = createLogsRoutes;
