/**
 * Radarr/Sonarr-compatible `health` response - real health checks backed by
 * Cinephage's own download-client health tracking (`download_clients.health`
 * /`consecutiveFailures`, already updated by real connectivity checks), not
 * a reproduction of Radarr's much larger health-check catalog (indexer RSS
 * failures, update checks, etc. have no Cinephage equivalent).
 *
 * Field set confirmed against HealthResource in Radarr/Sonarr's actual
 * openapi.json.
 */

import { db } from '#lib/server/db/index.js';
import { downloadClients } from '#lib/server/db/schema.js';

export async function buildHealth(): Promise<Record<string, unknown>[]> {
	const clients = await db
		.select({
			id: downloadClients.id,
			name: downloadClients.name,
			health: downloadClients.health,
			enabled: downloadClients.enabled,
			lastFailureMessage: downloadClients.lastFailureMessage
		})
		.from(downloadClients);

	const issues: Record<string, unknown>[] = [];
	let nextId = 1;

	for (const client of clients) {
		if (!client.enabled) continue;
		if (client.health === 'failing') {
			issues.push({
				id: nextId++,
				source: 'DownloadClientCheck',
				type: 'error',
				message: client.lastFailureMessage ?? `${client.name} is failing`,
				wikiUrl: null
			});
		} else if (client.health === 'warning') {
			issues.push({
				id: nextId++,
				source: 'DownloadClientCheck',
				type: 'warning',
				message: client.lastFailureMessage ?? `${client.name} has connection issues`,
				wikiUrl: null
			});
		}
	}

	return issues;
}
