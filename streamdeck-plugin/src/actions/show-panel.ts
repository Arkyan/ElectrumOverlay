import { action, KeyDownEvent, SingletonAction } from "@elgato/streamdeck";

import { PanelName, showPanel } from "../api-client";

type ShowPanelSettings = {
	panel?: PanelName;
	host?: string;
	port?: string;
};

/**
 * Affiche le panneau gauche ou le bandeau bas d'ElectrumOverlay immédiatement (POST
 * /api/panels/:panel/show) — n'a d'effet que si la source OBS ouverte est bien l'overlay
 * principal (index.html), les autres pages n'ont pas ces panneaux.
 */
@action({ UUID: "com.electrumvtc.overlay.streamdeck.show-panel" })
export class ShowPanel extends SingletonAction<ShowPanelSettings> {
	override async onKeyDown(ev: KeyDownEvent<ShowPanelSettings>): Promise<void> {
		const { panel, host, port } = ev.payload.settings;

		if (panel !== "left" && panel !== "bottom") {
			await ev.action.showAlert();
			return;
		}

		try {
			await showPanel(panel, { host, port });
			await ev.action.showOk();
		} catch (error) {
			await ev.action.showAlert();
		}
	}
}
