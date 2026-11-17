/**
 * Rendu des cartes Twitch « interactives » : objectif, sondage, prédiction, hype train.
 * Partagé par les overlays autonomes (goal.html, interactions.html) et par les éléments de scène
 * du même nom (overlay-common.js). Tout est en `em` (css/twitch-widgets.css) : la taille se règle
 * par la police de l'élément.
 *
 * Données : format simplifié diffusé par le serveur (`{ type: "interaction", kind, phase, data }`,
 * voir crates/electrum-server/src/interactions.rs) et renvoyé par GET /api/interactions.
 */
(function () {
    // Traduction (interface en anglais) : même dictionnaire que les overlays (/js/i18n.js).
    function tr(text, vars) {
        const dict = globalThis.OVERLAY_I18N?.dict || {};
        let out = dict[text] !== undefined ? dict[text] : text;
        if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v));
        return out;
    }

    function esc(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function number(n) {
        return Number(n || 0).toLocaleString(globalThis.OVERLAY_I18N?.lang === 'en' ? 'en-US' : 'fr-FR');
    }

    function secondsUntil(iso) {
        if (!iso) return 0;
        return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
    }

    function countdown(seconds) {
        return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }

    function head(label, right, endsAt) {
        return `<div class="tw-head"><span class="tw-label">${label}</span>`
            + `<span class="tw-timer"${endsAt ? ` data-tw-ends="${esc(endsAt)}"` : ''}>${right}</span></div>`;
    }

    function bar(label, value, percent, extraClass = '') {
        return `<div class="tw-bar ${extraClass}"><div class="tw-bar-fill" style="width:${percent}%"></div>`
            + `<div class="tw-bar-text"><span>${esc(label)}</span><span>${value}</span></div></div>`;
    }

    function goal(g, phase) {
        const percent = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
        const done = g.achieved || (g.target > 0 && g.current >= g.target);
        const unit = g.unit ? tr(g.unit) : '';
        const title = g.description || (unit ? unit.charAt(0).toUpperCase() + unit.slice(1) : tr('Objectif'));
        return head(done ? tr('Objectif atteint !') : tr('Objectif'), `${percent} %`)
            + bar(title, `${number(g.current)} / ${number(g.target)}`, percent, done ? 'tw-gold' : '');
    }

    function poll(p, phase) {
        const ended = phase === 'end';
        const total = p.choices.reduce((sum, c) => sum + c.votes, 0);
        const max = Math.max(0, ...p.choices.map((c) => c.votes));
        const rows = p.choices.map((c) => {
            const percent = total ? Math.round((c.votes / total) * 100) : 0;
            const cls = ended && total ? (c.votes === max ? 'tw-winner' : 'tw-loser') : '';
            return bar(c.title, `${percent} %`, percent, cls);
        }).join('');
        return head(tr('Sondage'), ended ? tr('Terminé') : countdown(secondsUntil(p.endsAt)), ended ? '' : p.endsAt)
            + `<div class="tw-title">${esc(p.title)}</div>${rows}`
            + `<div class="tw-foot">${tr(total > 1 ? '{n} votes' : '{n} vote', { n: number(total) })}</div>`;
    }

    function prediction(p, phase) {
        const total = p.outcomes.reduce((sum, o) => sum + o.points, 0);
        const resolved = phase === 'end' && p.status === 'resolved';
        const rows = p.outcomes.map((o) => {
            const percent = total ? Math.round((o.points / total) * 100) : 0;
            const ratio = o.points ? (total / o.points).toFixed(2).replace('.', ',') : '–';
            const cls = [o.color === 'pink' ? 'tw-pink' : 'tw-blue', resolved ? (o.id === p.winningOutcomeId ? 'tw-winner' : 'tw-loser') : ''].join(' ');
            return bar(o.title, `${percent} % · 1:${ratio}`, percent, cls);
        }).join('');
        const live = phase === 'begin' || phase === 'progress';
        let status = countdown(secondsUntil(p.locksAt));
        if (phase === 'end') status = p.status === 'canceled' ? tr('Annulée') : tr('Résultat');
        else if (phase === 'lock') status = tr('Verrouillée');
        return head(tr('Prédiction'), status, live ? p.locksAt : '')
            + `<div class="tw-title">${esc(p.title)}</div>${rows}`
            + `<div class="tw-foot">${tr('{n} points de chaîne en jeu', { n: number(total) })}</div>`;
    }

    function hypetrain(h, phase) {
        const ended = phase === 'end';
        const percent = h.goal ? Math.min(100, Math.round((h.progress / h.goal) * 100)) : 100;
        const top = (h.topContributions || []).slice(0, 2)
            .map((c) => `<span>${c.type === 'bits' ? 'Bits' : 'Subs'}${tr(' : ')}<strong>${esc(c.user)}</strong></span>`).join('');
        return `<div class="tw-hype-head"><span class="tw-level${h.golden ? ' tw-golden' : ''}">${h.level}</span><div class="tw-grow">`
            + head(h.golden ? 'Golden Kappa Train' : 'Hype train', ended ? tr('Terminé') : countdown(secondsUntil(h.expiresAt)), ended ? '' : h.expiresAt)
            + `<div class="tw-title tw-title-tight">${tr(ended ? 'Niveau {n} atteint !' : 'Niveau {n}', { n: h.level })}</div></div></div>`
            + (ended ? '' : bar(tr('Vers le niveau {n}', { n: h.level + 1 }), `${percent} %`, percent))
            + (top ? `<div class="tw-foot tw-top">${top}</div>` : '');
    }

    const RENDER = { goal, poll, prediction, hypetrain };

    /** Exemples pour l'aperçu de l'éditeur de scène. */
    function sample(kind) {
        const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();
        return {
            goal: { phase: 'progress', data: { description: tr('Objectif followers'), unit: 'followers', current: 842, target: 1000 } },
            poll: { phase: 'progress', data: { title: tr('On joue à quoi ensuite ?'), endsAt: inSeconds(95), choices: [
                { title: 'Euro Truck Simulator 2', votes: 21 }, { title: 'Minecraft', votes: 14 }, { title: 'Just Chatting', votes: 6 }] } },
            prediction: { phase: 'progress', data: { title: tr('La prochaine livraison ?'), locksAt: inSeconds(95), outcomes: [
                { id: 'a', title: tr('Sans dégâts'), color: 'blue', points: 4200 }, { id: 'b', title: tr('Au moins une rayure'), color: 'pink', points: 2100 }] } },
            hypetrain: { phase: 'progress', data: { level: 2, progress: 700, goal: 2100, expiresAt: inSeconds(240),
                topContributions: [{ user: 'Viewer1', type: 'bits' }, { user: 'Viewer2', type: 'subscription' }] } },
        }[kind];
    }

    // Comptes à rebours de toutes les cartes de la page.
    setInterval(() => {
        document.querySelectorAll('[data-tw-ends]').forEach((el) => {
            el.textContent = countdown(secondsUntil(el.dataset.twEnds));
        });
    }, 1000);

    globalThis.TwitchWidgets = {
        KINDS: Object.keys(RENDER),
        /** Durée d'affichage du résultat après la fin (ms). */
        LINGER: { goal: 15000, poll: 15000, prediction: 20000, hypetrain: 12000 },
        html(kind, data, phase) {
            return RENDER[kind] ? RENDER[kind](data, phase) : '';
        },
        sample,
        /** Couleur d'accent (+ triplet RVB) posée sur un élément ou sur :root. */
        setAccent(el, hex) {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
            if (!m) return;
            const n = parseInt(m[1], 16);
            el.style.setProperty('--tw-accent', '#' + m[1]);
            el.style.setProperty('--tw-accent-rgb', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
        },
    };
})();
