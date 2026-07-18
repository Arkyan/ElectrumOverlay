/**
 * Petit client HTTP vers l'API d'ElectrumOverlay (voir src/routes/*.js côté serveur principal),
 * partagé par les actions du plugin. Hôte/port sont configurables par action (réglages de
 * l'inspecteur de propriétés) car rien n'empêche de faire tourner le serveur sur un autre port ;
 * par défaut localhost:8080, celui du serveur Express standard.
 */

export type ApiConfig = {
	host?: string;
	port?: string;
};

function baseUrl(config: ApiConfig): string {
	const host = config.host?.trim() || "localhost";
	const port = config.port?.trim() || "8080";
	return `http://${host}:${port}`;
}

async function assertOk(res: Response): Promise<void> {
	if (!res.ok) {
		throw new Error(`ElectrumOverlay a répondu ${res.status}`);
	}
}

/**
 * Déclenche un événement de test simulé (voir TEST_ACTIONS dans src/routes/testtools.js).
 */
export async function triggerTestAlert(alertType: string, config: ApiConfig = {}): Promise<void> {
	const res = await fetch(`${baseUrl(config)}/api/tests/trigger`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: alertType })
	});
	await assertOk(res);
}

export type ProfileSummary = {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
};

export type ProfilesResponse = {
	activeId: string | null;
	profiles: ProfileSummary[];
};

export async function listProfiles(config: ApiConfig = {}): Promise<ProfilesResponse> {
	const res = await fetch(`${baseUrl(config)}/api/profiles`);
	await assertOk(res);
	return (await res.json()) as ProfilesResponse;
}

export async function activateProfile(profileId: string, config: ApiConfig = {}): Promise<void> {
	const res = await fetch(`${baseUrl(config)}/api/profiles/${encodeURIComponent(profileId)}/activate`, {
		method: "POST"
	});
	await assertOk(res);
}

export type StreamStats = {
	isLive: boolean;
	startTime: string | null;
	follows: number;
	subscribers: number;
	chatMessages: number;
	title: string;
	game: string;
	viewerCount: number;
	streamDuration: string;
	streamDurationMs: number;
};

export async function getStreamStats(config: ApiConfig = {}): Promise<StreamStats> {
	const res = await fetch(`${baseUrl(config)}/api/stream-stats`);
	await assertOk(res);
	return (await res.json()) as StreamStats;
}

export type PanelName = "left" | "bottom";

/**
 * Affiche le panneau gauche ou le bandeau bas immédiatement (voir POST /api/panels/:panel/show
 * côté serveur), sans attendre leur cycle automatique.
 */
export async function showPanel(panel: PanelName, config: ApiConfig = {}): Promise<void> {
	const res = await fetch(`${baseUrl(config)}/api/panels/${panel}/show`, { method: "POST" });
	await assertOk(res);
}
