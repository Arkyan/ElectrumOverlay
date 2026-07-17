/**
 * JavaScript spécifique à index.html
 * Fonctionnalités personnalisées pour la page principale du stream
 */

let timerInterval;
let progress = 0;
const interval = 500;
let totalSteps = 0;

// getOverlayConfig is defined globally in overlay-common.js and reused here.
// Système de popup toutes les 5 minutes
async function showInfoPanel() {
    const cfg = getOverlayConfig();
    const panelCfg = cfg.panels?.left;
    if (panelCfg?.enabled === false) return;

    if (timerInterval) {
        clearInterval(timerInterval);
    }
    const data = await fetch('/api/info-panel')
        .then(response => response.json())
        .catch(error => {
            console.error('❌ Erreur lors de la récupération des données du panneau d\'information:', error);
            return null;
        });
    if (!data) {
        console.error('❌ Aucune donnée disponible pour le panneau d\'information.');
        return;
    }
    const panel = document.getElementById('leftPanel');
    if (!panel) return;
    const timer = panel.querySelector('.timer-progress');
    if (!timer) return;

    updateLeftPanel('leftPanelDestination', `${data.lastJob.source_city_name} → ${data.lastJob.destination_city_name}`);
    updateLeftPanel('leftPanelDistance', `${data.lastJob.planned_distance_km} km`);
    updateLeftPanel('leftPanelCargo', `${data.lastJob.cargo_name} ( ${data.lastJob.cargo_mass_t}t )`);
    updateLeftPanel('leftPanelRank', `${data.userData.role.name || 'Inconnu'}`);
    updateLeftPanel('leftPanelDistanceVTC', `${seperateThousands(data.companyStats.distance_driven_on_job_km)} km`);
    updateLeftPanel('leftPanelCompletedTrips', `${seperateThousands(data.companyStats.jobs_delivered)}`);
    updateLeftPanel('leftPanelDrivers', `${seperateThousands(data.companyDetails.members_count)}`);
    updateLeftPanel('leftPanelRecruitments', `${data.companyDetails.recruitment === 'open' ? '🟢 Ouverts' : '🔴 Fermés'}`);

    progress = 0;
    timer.style.background = `conic-gradient(#ef4444 0%, transparent 0%)`;

    const duration = panelCfg?.duration ?? 15000;
    totalSteps = duration / interval;
    timerInterval = setInterval(() => updateTimer(timer), interval);
    panel.classList.add('show');

    setTimeout(() => {
        panel.classList.remove('show');
        clearInterval(timerInterval);
    }, duration);
}

function updateTimer(timer) {
    if (!totalSteps || totalSteps <= 0) return;
    progress += (100 / totalSteps);
    timer.style.background = `conic-gradient(var(--timer-color, #ef4444) ${progress}%, transparent ${progress}%)`;

    if (progress >= 100) {
        clearInterval(timerInterval);
    }
}

function showBottomBar() {
    const cfg = getOverlayConfig();
    const panelCfg = cfg.panels?.bottom;
    if (panelCfg?.enabled === false) return;

    const bottomBar = document.getElementById('bottomBar');
    if (!bottomBar) return;
    bottomBar.style.display = 'flex';
    bottomBar.style.animation = 'slide-in-up 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';

    const duration = panelCfg?.duration ?? 20000;
    setTimeout(() => {
        bottomBar.style.animation = 'slide-out-down 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards';
        setTimeout(() => {
            bottomBar.style.display = 'none';
        }, 600);
    }, duration);
}

function updateLeftPanel(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    } else {
        console.warn(`Élément avec l'ID ${id} non trouvé dans le panneau gauche.`);
    }
}

function seperateThousands(value) {
    const rounded = Math.round(Number(value));
    return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Initialisation automatique quand le DOM est prêt
document.addEventListener('DOMContentLoaded', function () {

    const cfg = getOverlayConfig();
    const leftCfg = cfg.panels?.left;
    const bottomCfg = cfg.panels?.bottom;

    if (leftCfg?.enabled !== false) {
        setTimeout(showInfoPanel, leftCfg?.firstDelay ?? 30000);
        setInterval(showInfoPanel, leftCfg?.interval ?? 300000);
    }

    if (bottomCfg?.enabled !== false) {
        setTimeout(showBottomBar, bottomCfg?.firstDelay ?? 10000);
        setInterval(showBottomBar, bottomCfg?.interval ?? 180000);
    }
});
