/**
 * Script pour pause.html
 * Gestion des animations et interactions de la page de pause
 */

let pauseMessageIndex = 0;
let pauseStartTime = null;
let clockInterval = null;
let messageRotationInterval = null;
let progressInterval = null;

// Messages de pause rotatifs
const pauseMessages = [
    "🎮 Pause technique - On revient tout de suite !",
    "☕ Petite pause café - Restez connectés !",
    "💬 N'hésitez pas à discuter en attendant !",
    "🔧 Quelques ajustements - Merci de patienter !",
    "⏱️ Pause rapide - On est de retour bientôt !",
    "🎵 Pause musicale - Profitez du son !",
    "🍕 Pause déjeuner - À tout de suite !",
    "🛠️ Mise à jour en cours - Patience !",
    "🎯 Préparation du prochain segment !"
];

// Initialisation au chargement de la page
document.addEventListener('DOMContentLoaded', function () {
    console.log('🟡 Page de pause chargée');

    // Démarrer l'horloge
    startRealTimeClock();

    // Rotation des messages
    startMessageRotation();

    // Animation de la barre de progression
    startProgressAnimation();

    // Enregistrer l'heure de début de pause
    pauseStartTime = new Date();

    // Connexion WebSocket pour les stats
    connectApi();

    // Animations d'éléments
    startElementAnimations();

    // Effets de particules
    initializeParticleEffects();
});

// Horloge en temps réel
function startRealTimeClock() {
    const timeElement = document.getElementById('currentTime');

    function updateClock() {
        const now = new Date();
        const timeString = now.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        if (timeElement) {
            timeElement.textContent = timeString;
        }
    }

    // Mise à jour immédiate
    updateClock();

    // Mise à jour chaque seconde
    clockInterval = setInterval(updateClock, 1000);
}

// Rotation des messages de pause
function startMessageRotation() {
    const messageElements = document.querySelectorAll('.pause-message');

    if (messageElements.length === 0) return;

    // Mettre à jour les textes avec notre tableau
    messageElements.forEach((element, index) => {
        if (pauseMessages[index]) {
            element.textContent = pauseMessages[index];
        }
    });

    function rotateMessage() {
        // Cacher le message actuel
        messageElements.forEach(el => el.classList.remove('active'));

        // Passer au message suivant
        pauseMessageIndex = (pauseMessageIndex + 1) % messageElements.length;

        // Afficher le nouveau message
        setTimeout(() => {
            messageElements[pauseMessageIndex].classList.add('active');
        }, 400);
    }

    // Rotation toutes les 4 secondes
    messageRotationInterval = setInterval(rotateMessage, 4000);
}

// Animation de la barre de progression
function startProgressAnimation() {
    const progressFill = document.querySelector('.pause-progress-fill');
    const progressText = document.querySelector('.pause-progress-text');

    if (!progressFill || !progressText) return;

    let progress = 0;
    const messages = [
        "Reprise imminente...",
        "Préparation en cours...",
        "Presque prêt...",
        "Derniers réglages...",
        "De retour dans un instant..."
    ];

    function updateProgress() {
        // Changer le texte aléatoirement
        const randomMessage = messages[Math.floor(Math.random() * messages.length)];
        progressText.textContent = randomMessage;

        // Animation de la barre
        progressFill.style.animation = 'none';
        setTimeout(() => {
            progressFill.style.animation = 'pauseProgressAnimation 3s ease-in-out infinite';
        }, 100);
    }

    // Mise à jour toutes les 6 secondes
    progressInterval = setInterval(updateProgress, 6000);
}

// Connexion WebSocket pour les statistiques
function connectApi() {
    fetch('/stream-stats')
        .then(response => response.json())
        .then(data => {
            document.getElementById('viewersCount').innerText = data.viewerCount || 0;
        })
        .catch(error => {
            console.error('❌ Erreur lors de la récupération des statistiques du stream:', error);
        });
}

// Mettre à jour le compteur de spectateurs
function updateViewersCount(count) {
    const viewersElement = document.getElementById('viewersCount');
    if (viewersElement) {
        viewersElement.textContent = count;

        // Animation de mise à jour
        viewersElement.style.transform = 'scale(1.2)';
        setTimeout(() => {
            viewersElement.style.transform = 'scale(1)';
        }, 200);
    }
}

// Animations d'éléments
function startElementAnimations() {
    const cfg = getOverlayConfig();
    // Effet de confettis occasionnel
    if (typeof confetti !== 'undefined' && cfg.alerts?.confettiEnabled !== false) {
        setInterval(() => {
            if (Math.random() < 0.1) { // 10% de chance toutes les 5 secondes
                confetti({
                    particleCount: 50,
                    startVelocity: 20,
                    spread: 60,
                    origin: { y: 0.8 },
                    colors: ['#0B36F5FF', '#086AEAFF', '#0196FAFF']
                });
            }
        }, 5000);
    }
}

// Initialiser les effets de particules
function initializeParticleEffects() {
    const cfg = getOverlayConfig();
    if (cfg.animations?.enabled === false) return;

    if (typeof globalThis !== 'undefined') {
        // If common overlay animations have already been initialized elsewhere, do nothing.
        if (globalThis.__OVERLAY_COMMON_ANIMATIONS_DONE) {
            return;
        }
        // Mark animations as initialized to prevent duplicate initialization in other scripts.
        globalThis.__OVERLAY_COMMON_ANIMATIONS_DONE = true;
    }

    if (typeof createStars === 'function') {
        createStars(cfg.animations?.stars?.count ?? 30, cfg.animations?.stars?.duration ?? [1.5, 2.5]);
    }

    // if (typeof createMeteors === 'function') {
    //     createMeteors(3); // Moins de météores
    // }

    // if (typeof createCircuitLines === 'function') {
    //     createCircuitLines(8); // Lignes de circuit réduites
    // }

    if (typeof createParticles === 'function') {
        createParticles(cfg.animations?.particles?.count ?? 20, cfg.animations?.particles?.duration ?? [5, 8]);
    }
}

// Nettoyage lors de la fermeture
window.addEventListener('beforeunload', function () {
    if (clockInterval) clearInterval(clockInterval);
    if (messageRotationInterval) clearInterval(messageRotationInterval);
    if (progressInterval) clearInterval(progressInterval);
});

// Fonctions utilitaires pour les interactions
function showPauseStats() {
    if (pauseStartTime) {
        const now = new Date();
        const pauseDuration = Math.floor((now - pauseStartTime) / 1000);

        console.log(`⏸️ Pause depuis ${pauseDuration} secondes`);

        // Affichage optionnel de la durée
        const progressText = document.querySelector('.pause-progress-text');
        if (progressText && pauseDuration > 60) {
            const minutes = Math.floor(pauseDuration / 60);
            progressText.textContent = `En pause depuis ${minutes} minute${minutes > 1 ? 's' : ''}...`;
        }
    }
}

// Affichage des stats toutes les 30 secondes
setInterval(showPauseStats, 30000);

// Log de démarrage
console.log('🟡 Script pause.js chargé - Page de pause active');
