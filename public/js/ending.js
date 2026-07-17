/**
 * JavaScript spécifique à ending.html
 * Fonctionnalités personnalisées pour la page de fin de stream
 */

// Code spécifique à ending.html

function renderStreamStats(data) {
    const streamTimeMs = data.streamDurationMs || 0;
    const streamTimeSec = Math.floor(streamTimeMs / 1000);
    const streamTimeMin = Math.floor(streamTimeSec / 60);
    const streamTimeHours = Math.floor(streamTimeMin / 60);
    const streamTimeText = `${streamTimeHours}h ${streamTimeMin % 60}m ${streamTimeSec % 60}s`;
    const streamDurationEl = document.getElementById('streamDurationText');
    const totalMessagesEl = document.getElementById('totalMessages');
    const newFollowersEl = document.getElementById('newFollowers');
    const newSubsEl = document.getElementById('newSubs');
    if (streamDurationEl) streamDurationEl.innerText = streamTimeText;
    if (totalMessagesEl) totalMessagesEl.innerText = data.chatMessages ?? 0;
    if (newFollowersEl) newFollowersEl.innerText = data.follows ?? 0;
    if (newSubsEl) newSubsEl.innerText = data.subscribers ?? 0;
}

async function fetchStreamStats() {
    const cfg = getOverlayConfig();
    try {
        const response = await fetch('/stream-stats');
        const data = await response.json();
        renderStreamStats(data);
    } catch (error) {
        console.error('❌ Erreur lors de la récupération des statistiques du stream:', error);
        if (cfg.stats?.simulateData) {
            renderStreamStats({
                streamDurationMs: Math.floor(Math.random() * 3 * 60 * 60 * 1000),
                chatMessages: Math.floor(Math.random() * 500),
                follows: Math.floor(Math.random() * 50),
                subscribers: Math.floor(Math.random() * 25)
            });
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const cfg = getOverlayConfig();
    const interval = cfg.stats?.updateInterval ?? 30000;
    fetchStreamStats();
    setInterval(fetchStreamStats, interval);
});
