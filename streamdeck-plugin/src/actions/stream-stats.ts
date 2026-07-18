import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { getStreamStats } from "../api-client";

type StatKey = "follows" | "subscribers" | "chatMessages" | "viewerCount";

type StreamStatsSettings = {
	stat?: StatKey;
	host?: string;
	port?: string;
};

const STAT_LABELS: Record<StatKey, string> = {
	follows: "Follows",
	subscribers: "Abonnés",
	chatMessages: "Messages",
	viewerCount: "Viewers"
};

// "follows"/"subscribers" sont des compteurs depuis le début du stream (remis à zéro à chaque
// stream.online — voir StreamStatsManager.js), pas le total de la chaîne. "viewerCount" vient
// d'un polling périodique de l'API Twitch côté serveur (rien à voir avec EventSub).
const POLL_INTERVAL_MS = 10000;

/**
 * Affiche une statistique de stream en direct (follows/abonnés/viewers/messages de chat) sur la
 * touche, rafraîchie automatiquement tant qu'elle est visible. Un appui force un rafraîchissement
 * immédiat plutôt que d'attendre le prochain cycle.
 */
@action({ UUID: "com.electrumvtc.overlay.streamdeck.stream-stats" })
export class StreamStatsAction extends SingletonAction<StreamStatsSettings> {
	private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

	override onWillAppear(ev: WillAppearEvent<StreamStatsSettings>): void {
		if (!ev.action.isKey()) return;
		const keyAction = ev.action;

		void this.refreshState(keyAction);
		const timer = setInterval(() => void this.refreshState(keyAction), POLL_INTERVAL_MS);
		this.timers.set(keyAction.id, timer);
	}

	override onWillDisappear(ev: WillDisappearEvent<StreamStatsSettings>): void {
		const timer = this.timers.get(ev.action.id);
		if (timer) {
			clearInterval(timer);
			this.timers.delete(ev.action.id);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<StreamStatsSettings>): Promise<void> {
		if (!ev.payload.settings.stat) {
			await ev.action.showAlert();
			return;
		}
		await this.refreshState(ev.action);
		await ev.action.showOk();
	}

	private async refreshState(keyAction: KeyAction<StreamStatsSettings>): Promise<void> {
		const { stat, host, port } = await keyAction.getSettings();
		if (!stat) return;

		try {
			const stats = await getStreamStats({ host, port });
			await keyAction.setTitle(`${STAT_LABELS[stat]}\n${stats[stat] ?? 0}`);
		} catch (error) {
			// Serveur injoignable — on laisse le dernier titre affiché plutôt que de l'effacer
			// à chaque coupure passagère.
		}
	}
}
