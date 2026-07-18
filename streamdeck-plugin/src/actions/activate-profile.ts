import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { activateProfile, listProfiles } from "../api-client";

type ActivateProfileSettings = {
	profileId?: string;
	host?: string;
	port?: string;
};

// Le nom affiché sur la touche n'est jamais stocké dans les settings — il est retrouvé à chaque
// rafraîchissement via /api/profiles, pour rester juste même si le profil est renommé ailleurs.
const POLL_INTERVAL_MS = 5000;

/**
 * Active un profil ElectrumOverlay (POST /api/profiles/:id/activate) et reflète en direct, tant
 * que la touche est visible, si ce profil est bien celui actuellement actif (icône + titre),
 * via un polling léger de /api/profiles — pas de connexion WebSocket permanente pour rester simple.
 */
@action({ UUID: "com.electrumvtc.overlay.streamdeck.activate-profile" })
export class ActivateProfile extends SingletonAction<ActivateProfileSettings> {
	private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

	override onWillAppear(ev: WillAppearEvent<ActivateProfileSettings>): void {
		if (!ev.action.isKey()) return;
		const keyAction = ev.action;

		void this.refreshState(keyAction);
		const timer = setInterval(() => void this.refreshState(keyAction), POLL_INTERVAL_MS);
		this.timers.set(keyAction.id, timer);
	}

	override onWillDisappear(ev: WillDisappearEvent<ActivateProfileSettings>): void {
		const timer = this.timers.get(ev.action.id);
		if (timer) {
			clearInterval(timer);
			this.timers.delete(ev.action.id);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<ActivateProfileSettings>): Promise<void> {
		const { profileId, host, port } = ev.payload.settings;
		if (!profileId) {
			await ev.action.showAlert();
			return;
		}

		try {
			await activateProfile(profileId, { host, port });
			await ev.action.showOk();
			await this.refreshState(ev.action);
		} catch (error) {
			await ev.action.showAlert();
		}
	}

	private async refreshState(keyAction: KeyAction<ActivateProfileSettings>): Promise<void> {
		const { profileId, host, port } = await keyAction.getSettings();
		if (!profileId) return;

		try {
			const { activeId, profiles } = await listProfiles({ host, port });
			const profile = profiles.find((p) => p.id === profileId);
			const isActive = activeId === profileId;

			await keyAction.setState(isActive ? 1 : 0);
			await keyAction.setTitle(`${isActive ? "✓ " : ""}${profile?.name ?? "?"}`);
		} catch (error) {
			// Serveur injoignable (pas démarré, etc.) — on laisse le dernier état affiché plutôt
			// que d'effacer le titre à chaque coupure passagère.
		}
	}
}
