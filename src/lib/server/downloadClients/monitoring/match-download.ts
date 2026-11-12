/**
 * Queue-row ↔ client-download matching.
 *
 * The monitor works from a *list* of client downloads, and a list is not the
 * client: SABnzbd pages history (100 rows) and splits it into two disjoint sets,
 * the queue is capped, and history is filtered by category on the server while
 * the queue is filtered locally. Matching rules therefore live here, apart from
 * the poll loop, so "which client item is this row?" has exactly one answer and
 * can be tested without a database.
 */
import type { DownloadInfo } from '../core/interfaces';
import { resolveInfoHash } from '../utils/hashUtils';

export type MatchStrategy = 'downloadId' | 'infoHash' | 'magnetUrl' | 'title';

/** The identity a queue row carries into a poll. */
export interface QueueIdentity {
	downloadId: string;
	infoHash: string | null;
	magnetUrl: string | null;
	title: string;
}

export interface DownloadMatch {
	download: DownloadInfo;
	matchedBy: MatchStrategy;
}

export interface MatchOptions {
	/**
	 * Title matching exists for clients that mint a new id when a job is
	 * re-added (SABnzbd's nzo_id); torrent hashes are stable and never need it.
	 */
	allowTitleFallback: boolean;
	/** Client hashes already held by a different row in this same poll. */
	claimed?: ReadonlySet<string>;
}

export function indexDownloadsByHash(
	downloads: readonly DownloadInfo[]
): Map<string, DownloadInfo> {
	const byHash = new Map<string, DownloadInfo>();
	for (const download of downloads) {
		byHash.set(download.hash.toLowerCase(), download);
	}
	return byHash;
}

/**
 * Resolve one queue row against the downloads fetched in this poll.
 *
 * Order is deliberate: the stored client id, then the stored infoHash, then the
 * hash inside the magnet, and only then a title match — cheapest and most exact
 * first, guesswork last.
 */
export function matchQueueItem(
	item: QueueIdentity,
	byHash: ReadonlyMap<string, DownloadInfo>,
	downloads: readonly DownloadInfo[],
	options: MatchOptions
): DownloadMatch | null {
	const direct = byHash.get(item.downloadId.toLowerCase());
	if (direct) return { download: direct, matchedBy: 'downloadId' };

	if (item.infoHash) {
		const byInfoHash = byHash.get(item.infoHash.toLowerCase());
		if (byInfoHash) return { download: byInfoHash, matchedBy: 'infoHash' };
	}

	if (item.magnetUrl) {
		const extracted = resolveInfoHash(item.magnetUrl);
		if (extracted) {
			const byMagnet = byHash.get(extracted.toLowerCase());
			if (byMagnet) return { download: byMagnet, matchedBy: 'magnetUrl' };
		}
	}

	if (options.allowTitleFallback) {
		const title = item.title.toLowerCase();
		const candidates = downloads.filter(
			(download) =>
				download.name.toLowerCase() === title && !options.claimed?.has(download.hash.toLowerCase())
		);
		// Two rows' worth of candidates for one name is a data problem, not a coin
		// flip. Binding an arbitrary one is how two queue rows ended up on a single
		// client job, both then entering recovery for it (#664).
		if (candidates.length === 1) return { download: candidates[0], matchedBy: 'title' };
	}

	return null;
}

/**
 * What a row's stored identity becomes after a non-exact match.
 *
 * A client id is not an infoHash. Usenet rows used to have `info_hash` filled
 * with the nzo_id, a value that outlives the job and then disarms the
 * adoption guard for an unrelated download; usenet carries no infoHash at all,
 * so a usenet row is cleared rather than filled. A torrent's hash *is* its
 * infoHash, so that side keeps the value.
 */
export function identityUpdateFor(
	match: DownloadMatch,
	protocol: 'usenet' | 'torrent'
): { downloadId: string; infoHash: string | null } | null {
	if (match.matchedBy === 'downloadId') return null;
	return {
		downloadId: match.download.hash,
		infoHash: protocol === 'torrent' ? match.download.hash : null
	};
}
