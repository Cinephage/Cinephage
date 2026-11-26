/**
 * Installs and reports the Cinephage Jellyfin plugin on a configured Jellyfin
 * server.
 *
 * Cinephage owns the plugin package (served from /api/jellyfin-plugin/) and
 * Jellyfin owns plugin installation. This module is the bridge: it registers
 * Cinephage as a plugin repository on the server, asks Jellyfin to install the
 * package, and reports the result. It never writes into Jellyfin's plugin
 * directory itself.
 */
import { MediaBrowserClient } from './MediaBrowserClient.js';
import type { MediaBrowserServerRecord } from './types.js';
import {
	CINEPHAGE_PLUGIN_GUID,
	CINEPHAGE_PLUGIN_NAME,
	pickCompatibleVersion,
	readPluginBuild,
	readPluginPackage,
	type CinephagePluginVersion
} from '#lib/server/jellyfinPlugin/manifest.js';

const REPOSITORY_NAME = 'Cinephage';

export class CinephagePluginError extends Error {
	constructor(
		message: string,
		readonly status: number = 400
	) {
		super(message);
		this.name = 'CinephagePluginError';
	}
}

export interface CinephagePluginStatus {
	/** A plugin package is present in this Cinephage build. */
	bundled: boolean;
	latestVersion: string | null;
	installed: boolean;
	installedVersion: string | null;
	updateAvailable: boolean;
	/** Jellyfin's plugin status: Active, Restart, Disabled, ... */
	status: string | null;
}

function isInstalledPlugin(id: string): boolean {
	return id.replace(/-/g, '').toLowerCase() === CINEPHAGE_PLUGIN_GUID.replace(/-/g, '');
}

async function latestForServer(
	serverVersion: string | null
): Promise<CinephagePluginVersion | null> {
	const build = await readPluginBuild();
	if (!build) return null;
	return pickCompatibleVersion(build.pkg.versions, serverVersion);
}

function toStatus(
	latest: CinephagePluginVersion | null,
	plugins: Awaited<ReturnType<MediaBrowserClient['getPlugins']>>
): CinephagePluginStatus {
	const installed = plugins.find((plugin) => isInstalledPlugin(plugin.Id)) ?? null;

	return {
		bundled: latest !== null,
		latestVersion: latest?.version ?? null,
		installed: installed !== null,
		installedVersion: installed?.Version ?? null,
		updateAvailable: installed !== null && latest !== null && installed.Version !== latest.version,
		status: installed?.Status ?? null
	};
}

/**
 * Reads the plugin state from Jellyfin. Uses the live server version because
 * the stored one is only refreshed by a connection test.
 */
export async function getCinephagePluginStatus(
	client: MediaBrowserClient,
	serverVersion?: string | null
): Promise<CinephagePluginStatus> {
	const version = serverVersion ?? (await client.getSystemInfo()).version;
	const [latest, plugins] = await Promise.all([latestForServer(version), client.getPlugins()]);
	return toStatus(latest, plugins);
}

export async function installCinephagePlugin(
	client: MediaBrowserClient,
	repositoryUrl: string,
	serverVersion?: string | null
): Promise<CinephagePluginStatus> {
	const build = await readPluginBuild();
	if (!build) {
		throw new CinephagePluginError(
			'This Cinephage build does not include the Jellyfin plugin package.',
			503
		);
	}

	const version = serverVersion ?? (await client.getSystemInfo()).version;
	const latest = pickCompatibleVersion(build.pkg.versions, version);
	if (!latest || !build.files.has(latest.file)) {
		throw new CinephagePluginError(
			`The bundled Cinephage plugin does not support Jellyfin ${version}.`,
			409
		);
	}

	// Keep the package file reachable before touching the server: a Jellyfin
	// that cannot download the zip would otherwise sit at "Restart" forever.
	const packageFile = await readPluginPackage(latest.file);
	if (!packageFile) {
		throw new CinephagePluginError('The bundled Cinephage plugin package is unreadable.', 503);
	}

	const repositories = await client.getRepositories();
	const withoutCinephage = repositories.filter((repository) => repository.Url !== repositoryUrl);
	await client.setRepositories([
		...withoutCinephage,
		{ Name: REPOSITORY_NAME, Url: repositoryUrl, Enabled: true }
	]);

	await client.installPlugin(
		CINEPHAGE_PLUGIN_NAME,
		CINEPHAGE_PLUGIN_GUID,
		latest.version,
		repositoryUrl
	);

	return toStatus(latest, await client.getPlugins());
}

export async function restartMediaServer(client: MediaBrowserClient): Promise<void> {
	await client.restart();
}

export function createJellyfinClient(record: MediaBrowserServerRecord): MediaBrowserClient {
	if (record.serverType !== 'jellyfin') {
		throw new CinephagePluginError('The Cinephage plugin requires a Jellyfin server.', 400);
	}

	return new MediaBrowserClient({
		host: record.host,
		apiKey: record.apiKey,
		serverType: 'jellyfin'
	});
}
