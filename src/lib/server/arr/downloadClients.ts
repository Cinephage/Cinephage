/**
 * Radarr/Sonarr-compatible `downloadclient` response.
 *
 * Field set confirmed against DownloadClientResource in Radarr/Sonarr's
 * actual openapi.json, backed by Cinephage's real `download_clients`
 * table. This isn't just Radarr/Sonarr-web-UI config surface: arr clients
 * (Seerr's download tracker) use `protocol` and `removeCompletedDownloads`
 * to interpret an item disappearing from `/queue` - without this endpoint
 * they can't tell "completed and removed by the client" from anything
 * else, which is what broke completion status tracking.
 */

import { db } from '#lib/server/db/index.js';
import { downloadClients } from '#lib/server/db/schema.js';
import { getOrAssignArrId } from './ArrIdMappingService.js';

// -> DownloadProtocol enum (unknown | usenet | torrent). Same convention as
// queue.ts/blocklist.ts/history.ts: debrid is torrent-sourced content
// fetched via a debrid provider rather than a local client, so it maps to
// 'torrent'.
const PROTOCOL_MAP: Record<string, string> = {
	qbittorrent: 'torrent',
	transmission: 'torrent',
	deluge: 'torrent',
	rtorrent: 'torrent',
	realdebrid: 'torrent',
	torbox: 'torrent',
	sabnzbd: 'usenet',
	nzbget: 'usenet'
};

const IMPLEMENTATION_NAME_MAP: Record<string, string> = {
	qbittorrent: 'qBittorrent',
	transmission: 'Transmission',
	deluge: 'Deluge',
	rtorrent: 'rTorrent',
	sabnzbd: 'Sabnzbd',
	nzbget: 'NZBGet',
	realdebrid: 'Real-Debrid',
	torbox: 'TorBox'
};

export async function buildDownloadClients(): Promise<Record<string, unknown>[]> {
	const rows = await db.select().from(downloadClients);

	return Promise.all(
		rows.map(async (row) => ({
			id: await getOrAssignArrId('downloadClient', row.id),
			name: row.name,
			fields: [],
			implementationName: IMPLEMENTATION_NAME_MAP[row.implementation] ?? row.implementation,
			implementation: row.implementation,
			configContract: `${row.implementation}Settings`,
			infoLink: null,
			message: { message: null, type: 'info' },
			tags: [],
			enable: row.enabled ?? true,
			protocol: PROTOCOL_MAP[row.implementation] ?? 'unknown',
			// Real Radarr/Sonarr use this to order multiple clients of the same
			// protocol - Cinephage has no equivalent ranking concept, so every
			// client reports the same neutral priority.
			priority: 1,
			// Standard torrent/usenet clients (qBittorrent, SABnzbd, ...) leave
			// completed items visible until the user removes them - Cinephage
			// doesn't track a "remove after completion" setting for those, so
			// false is the accurate default. Debrid clients do have a real
			// equivalent (removeAfterImport), which we use when present.
			removeCompletedDownloads: row.removeAfterImport ?? false,
			removeFailedDownloads: false
		}))
	);
}
