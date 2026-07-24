const { uIOhook, UiohookKey } = require('uiohook-napi');

// Whitelist volontairement restreinte à un set "gaming" (WASD/flèches, modificateurs, F1-F12,
// chiffres, touches de contrôle courantes) — jamais les lettres/ponctuation générales, pour ne
// jamais afficher de texte tapé ailleurs (chat, mots de passe) pendant que la capture tourne en
// tâche de fond. Sert à la fois de filtre ET de source des libellés affichés : toute touche hors
// de cette table est purement ignorée, jamais transmise au broadcast. Plusieurs keycodes peuvent
// pointer vers le même libellé (Shift/ShiftRight...) : le plateau affiché côté overlay n'a qu'une
// seule touche "Shift" — voir labelHoldCount ci-dessous pour gérer ce many-to-one proprement.
//
// W/A et Z/Q sont TOUS LES DEUX écoutés en permanence, peu importe la disposition sélectionnée
// côté overlay : Windows traduit déjà le scancode physique en vkCode selon le layout clavier actif
// (WH_KEYBOARD_LL, sur lequel repose uiohook), donc la touche physiquement "avancer" d'un clavier
// AZERTY remonte le vkCode de Z (jamais W) et la touche physiquement "gauche" remonte celui de Q
// (jamais A) — capturer les deux jeux ici évite toute synchronisation avec le réglage `layout` du
// widget, qui ne fait que choisir lesquels AFFICHER (voir buildKeysBlocks dans overlay-common.js).
const ALLOWED_KEYS = {
    [UiohookKey.W]: 'W',
    [UiohookKey.A]: 'A',
    [UiohookKey.Z]: 'Z',
    [UiohookKey.Q]: 'Q',
    [UiohookKey.E]: 'E',
    [UiohookKey.S]: 'S',
    [UiohookKey.D]: 'D',
    [UiohookKey.ArrowUp]: '↑',
    [UiohookKey.ArrowDown]: '↓',
    [UiohookKey.ArrowLeft]: '←',
    [UiohookKey.ArrowRight]: '→',
    [UiohookKey.Space]: 'Espace',
    [UiohookKey.Shift]: 'Shift',
    [UiohookKey.ShiftRight]: 'Shift',
    [UiohookKey.Ctrl]: 'Ctrl',
    [UiohookKey.CtrlRight]: 'Ctrl',
    [UiohookKey.Alt]: 'Alt',
    [UiohookKey.AltRight]: 'Alt',
    [UiohookKey.Tab]: 'Tab',
    [UiohookKey.Escape]: 'Échap',
    [UiohookKey.Enter]: 'Entrée',
    [UiohookKey.F1]: 'F1',
    [UiohookKey.F2]: 'F2',
    [UiohookKey.F3]: 'F3',
    [UiohookKey.F4]: 'F4',
    [UiohookKey.F5]: 'F5',
    [UiohookKey.F6]: 'F6',
    [UiohookKey.F7]: 'F7',
    [UiohookKey.F8]: 'F8',
    [UiohookKey.F9]: 'F9',
    [UiohookKey.F10]: 'F10',
    [UiohookKey.F11]: 'F11',
    [UiohookKey.F12]: 'F12',
    [UiohookKey[0]]: '0',
    [UiohookKey[1]]: '1',
    [UiohookKey[2]]: '2',
    [UiohookKey[3]]: '3',
    [UiohookKey[4]]: '4',
    [UiohookKey[5]]: '5',
    [UiohookKey[6]]: '6',
    [UiohookKey[7]]: '7',
    [UiohookKey[8]]: '8',
    [UiohookKey[9]]: '9'
};

// Convention uiohook-napi (héritée de libuiohook) pour le champ `button` des événements souris —
// 4/5 = boutons latéraux ("pouce"), confirmés côté Windows (libuiohook/src/windows/input_hook.c) :
// XBUTTON1 (arrière) → MOUSE_BUTTON4, XBUTTON2 (avant) → MOUSE_BUTTON5.
const MOUSE_BUTTON_LABELS = {
    1: 'Clic gauche',
    2: 'Clic droit',
    3: 'Clic molette',
    4: 'Bouton arrière',
    5: 'Bouton avant'
};

// Keycodes/boutons actuellement enfoncés au niveau matériel : le hook renvoie un `keydown` à
// chaque répétition tant que la touche reste appuyée (auto-repeat clavier), pas un seul événement
// par appui — ce filtre ignore les répétitions.
const heldKeycodes = new Set();
const heldButtons = new Set();

// Nombre de keycodes actuellement enfoncés contribuant à un même libellé affiché (ex: Shift ET
// ShiftRight tous les deux vers "Shift") — le plateau overlay ne doit passer en "relâché" que
// quand le DERNIER des deux est relâché, pas au premier keyup reçu.
const labelHoldCount = new Map();

let running = false;
let onEventRef = null;
let keydownHandler = null;
let keyupHandler = null;
let mousedownHandler = null;
let mouseupHandler = null;

function setLabelHeld(label, onEvent, kind) {
    const count = (labelHoldCount.get(label) || 0) + 1;
    labelHoldCount.set(label, count);
    if (count === 1) onEvent({ label, kind, state: 'down' });
}

function setLabelReleased(label, onEvent, kind) {
    const count = Math.max(0, (labelHoldCount.get(label) || 0) - 1);
    if (count === 0) {
        labelHoldCount.delete(label);
        onEvent({ label, kind, state: 'up' });
    } else {
        labelHoldCount.set(label, count);
    }
}

/**
 * Démarre la capture globale clavier/souris et transmet chaque appui/relâchement autorisé à
 * `onEvent({label, kind, state})` (state: 'down'|'up') — le plateau overlay façon NohBoard reste
 * allumé tant que la touche est réellement maintenue, pas un simple flash chronométré. No-op si
 * déjà démarrée. Doit uniquement être appelé depuis electron/main.js — jamais depuis server.js,
 * qui doit rester utilisable sans Electron (voir CLAUDE.md).
 */
function start(onEvent) {
    if (running) return;
    onEventRef = onEvent;

    keydownHandler = (e) => {
        if (heldKeycodes.has(e.keycode)) return;
        heldKeycodes.add(e.keycode);
        const label = ALLOWED_KEYS[e.keycode];
        if (label) setLabelHeld(label, onEvent, 'keyboard');
    };
    keyupHandler = (e) => {
        heldKeycodes.delete(e.keycode);
        const label = ALLOWED_KEYS[e.keycode];
        if (label) setLabelReleased(label, onEvent, 'keyboard');
    };
    mousedownHandler = (e) => {
        if (heldButtons.has(e.button)) return;
        heldButtons.add(e.button);
        const label = MOUSE_BUTTON_LABELS[e.button];
        if (label) setLabelHeld(label, onEvent, 'mouse');
    };
    mouseupHandler = (e) => {
        heldButtons.delete(e.button);
        const label = MOUSE_BUTTON_LABELS[e.button];
        if (label) setLabelReleased(label, onEvent, 'mouse');
    };

    uIOhook.on('keydown', keydownHandler);
    uIOhook.on('keyup', keyupHandler);
    uIOhook.on('mousedown', mousedownHandler);
    uIOhook.on('mouseup', mouseupHandler);

    try {
        uIOhook.start();
        running = true;
    } catch (error) {
        // best-effort : un souci de hook natif (permissions, plateforme...) ne doit jamais
        // empêcher le reste de l'app de fonctionner, le widget restera simplement inactif.
        console.error('❌ Impossible de démarrer la capture clavier/souris:', error.message);
        uIOhook.off('keydown', keydownHandler);
        uIOhook.off('keyup', keyupHandler);
        uIOhook.off('mousedown', mousedownHandler);
        uIOhook.off('mouseup', mouseupHandler);
    }
}

function stop() {
    if (!running) return;
    try {
        uIOhook.stop();
    } catch (error) {
        // best-effort, cf. start()
    }
    uIOhook.off('keydown', keydownHandler);
    uIOhook.off('keyup', keyupHandler);
    uIOhook.off('mousedown', mousedownHandler);
    uIOhook.off('mouseup', mouseupHandler);

    // Relâche visuellement tout ce qui restait allumé (ex: capture coupée depuis /integrations
    // pendant qu'une touche est maintenue) — sans ça, le plateau resterait figé en "pressé"
    // jusqu'au prochain appui de la même touche, potentiellement bien après la désactivation.
    if (onEventRef) {
        for (const label of labelHoldCount.keys()) {
            onEventRef({ label, kind: 'keyboard', state: 'up' });
        }
    }

    heldKeycodes.clear();
    heldButtons.clear();
    labelHoldCount.clear();
    onEventRef = null;
    running = false;
}

function isRunning() {
    return running;
}

module.exports = { start, stop, isRunning };
