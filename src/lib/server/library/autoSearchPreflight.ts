import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import type { AutoSearchIssue } from '#lib/server/library/autoSearchIssues.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import {
	CINEPHAGE_STREAM_DEFINITION_ID,
	indexerHasCategoriesForSearchType,
	type IndexerCapabilities,
	type SearchType
} from '#lib/server/indexers/types/index.js';

function supportsSearchType(
	capabilities: IndexerCapabilities | undefined,
	searchType: SearchType
): boolean {
	if (!capabilities) return false;

	switch (searchType) {
		case 'movie':
			return (
				(capabilities.movieSearch?.available ?? false) &&
				indexerHasCategoriesForSearchType(capabilities.categories, 'movie')
			);
		case 'tv':
			return (
				(capabilities.tvSearch?.available ?? false) &&
				indexerHasCategoriesForSearchType(capabilities.categories, 'tv')
			);
		case 'music':
			return (
				(capabilities.musicSearch?.available ?? false) &&
				indexerHasCategoriesForSearchType(capabilities.categories, 'music')
			);
		case 'book':
			return (
				(capabilities.bookSearch?.available ?? false) &&
				indexerHasCategoriesForSearchType(capabilities.categories, 'book')
			);
		case 'basic':
			return capabilities.search?.available ?? true;
		default:
			return false;
	}
}

/**
 * Auto-search preflight for workflows that are expected to grab downloads.
 * Returns an actionable issue when eligible indexer protocols have no enabled client.
 *
 * Streamer profile is excluded because it can complete via streaming releases
 * without download clients.
 */
export async function getAutoSearchPreflightIssue(
	scoringProfileId: string | null | undefined,
	searchType: SearchType
): Promise<AutoSearchIssue | null> {
	if (scoringProfileId === 'streamer') {
		return null;
	}

	const indexerManager = await getIndexerManager();
	const indexers = await indexerManager.getIndexers();
	const profileScoped =
		scoringProfileId === 'streamer'
			? indexers.filter((indexer) => indexer.definitionId === CINEPHAGE_STREAM_DEFINITION_ID)
			: indexers;
	const eligibleIndexers = profileScoped.filter((indexer) => {
		if (!indexer.enabled) return false;
		if (indexer.enableInteractiveSearch === false) return false;
		const capabilities = indexerManager.getDefinitionCapabilities(indexer.definitionId);
		return supportsSearchType(capabilities, searchType);
	});

	const needsTorrent = eligibleIndexers.some((indexer) => indexer.protocol === 'torrent');
	const needsUsenet = eligibleIndexers.some((indexer) => indexer.protocol === 'usenet');

	if (!needsTorrent && !needsUsenet) {
		return null;
	}

	const manager = getDownloadClientManager();
	const [torrentClients, usenetClients, debridClient] = await Promise.all([
		manager.getEnabledClientsForProtocol('torrent'),
		manager.getEnabledClientsForProtocol('usenet'),
		manager.getDebridClientForAcquisition()
	]);

	const hasTorrent = torrentClients.length > 0;
	const hasUsenet = usenetClients.length > 0;
	const hasDebrid = !!debridClient;

	if (needsTorrent && !(hasTorrent || hasDebrid) && !needsUsenet) {
		return {
			code: 'NO_DOWNLOAD_CLIENT',
			message: 'No torrent or debrid download client is enabled',
			suggestion: 'Enable a torrent or debrid client in Settings > Integrations > Download Clients.'
		};
	}

	if (needsUsenet && !hasUsenet && !needsTorrent) {
		return {
			code: 'NO_DOWNLOAD_CLIENT',
			message: 'No usenet download client is enabled',
			suggestion: 'Enable a usenet client in Settings > Integrations > Download Clients.'
		};
	}

	if ((needsTorrent && !(hasTorrent || hasDebrid)) || (needsUsenet && !hasUsenet)) {
		// Mixed protocol indexers: allow search if at least one required protocol has a client.
		if ((needsTorrent && (hasTorrent || hasDebrid)) || (needsUsenet && hasUsenet)) {
			return null;
		}
	}

	if (hasTorrent || hasDebrid || hasUsenet) {
		return null;
	}

	return {
		code: 'NO_DOWNLOAD_CLIENT',
		message: 'No download client is enabled',
		suggestion:
			'Enable a torrent, debrid, or usenet client in Settings > Integrations > Download Clients.'
	};
}
