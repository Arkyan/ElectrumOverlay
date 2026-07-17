const MAX_LINES = 500;

const buffer = [];
let broadcastEvent = null;
let patched = false;

function formatArgs(args) {
    return args
        .map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.stack || a.message : JSON.stringify(a))))
        .join(' ');
}

function push(level, args) {
    const entry = { level, text: formatArgs(args), time: new Date().toISOString() };
    buffer.push(entry);
    if (buffer.length > MAX_LINES) buffer.shift();
    if (broadcastEvent) {
        try {
            broadcastEvent({ type: 'log', ...entry });
        } catch (error) {
            // best-effort : un souci de diffusion ne doit jamais faire planter un simple log
        }
    }
}

/**
 * Intercepte console.log/warn/error pour garder un historique consultable depuis /logs et le
 * diffuser en direct via WebSocket — utile une fois l'app packagée, où il n'y a plus de terminal
 * visible pour voir ce que fait le serveur (ngrok, EventSub, erreurs...).
 */
function init(broadcastEventFn) {
    broadcastEvent = broadcastEventFn;
    if (patched) return;
    patched = true;

    const original = { log: console.log, error: console.error, warn: console.warn };

    console.log = (...args) => {
        original.log(...args);
        push('info', args);
    };
    console.error = (...args) => {
        original.error(...args);
        push('error', args);
    };
    console.warn = (...args) => {
        original.warn(...args);
        push('warn', args);
    };
}

function getBuffer() {
    return buffer;
}

module.exports = { init, getBuffer };
