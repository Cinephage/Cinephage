/**
 * One mapping from a scored release to the payload the grab service takes.
 *
 * Movie, series, season and episode each spelled these eleven fields out, so a
 * new identity field had to be added in four places. The grab side is the same
 * request for every kind; only the target differs.
 */

import type { EnhancedReleaseResult } from '#lib/server/indexers/types/index.js';
import type { ReleaseInfo } from '#lib/server/downloads/grab-types.js';

export function toGrabRelease(release: EnhancedReleaseResult): ReleaseInfo {
	return {
		title: release.title,
		infoHash: release.infoHash,
		magnetUrl: release.magnetUrl,
		downloadUrl: release.downloadUrl,
		indexerId: release.indexerId,
		indexerName: release.indexerName,
		size: release.size,
		protocol: release.protocol as 'torrent' | 'usenet' | 'streaming' | undefined,
		tmdbId: release.tmdbId,
		imdbId: release.imdbId,
		tvdbId: release.tvdbId
	};
}
