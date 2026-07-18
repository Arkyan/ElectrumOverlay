import { action, KeyDownEvent, SingletonAction } from "@elgato/streamdeck";

import { triggerTestAlert } from "../api-client";

export const ALERT_TYPES = [
	"follow",
	"sub",
	"subgift",
	"raid",
	"bits",
	"chat",
	"info",
	"streamOnline",
	"streamOffline"
] as const;

type TriggerTestAlertSettings = {
	alertType?: string;
	host?: string;
	port?: string;
};

/**
 * Déclenche un événement de test ElectrumOverlay (POST /api/tests/trigger) — le même chemin que
 * la page /tests de l'app, donc les alertes/animations/panneaux réagissent exactement pareil.
 */
@action({ UUID: "com.electrumvtc.overlay.streamdeck.trigger-test-alert" })
export class TriggerTestAlert extends SingletonAction<TriggerTestAlertSettings> {
	override async onKeyDown(ev: KeyDownEvent<TriggerTestAlertSettings>): Promise<void> {
		const { alertType, host, port } = ev.payload.settings;

		if (!alertType || !(ALERT_TYPES as readonly string[]).includes(alertType)) {
			await ev.action.showAlert();
			return;
		}

		try {
			await triggerTestAlert(alertType, { host, port });
			await ev.action.showOk();
		} catch (error) {
			await ev.action.showAlert();
		}
	}
}
