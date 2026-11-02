import type { LibraryMovie, LibrarySeries } from '#lib/types/library.js';
import { pickBestMovieFile } from '#lib/shared/best-file.js';

export function isMovie(item: LibraryMovie | LibrarySeries): item is LibraryMovie {
	return 'hasFile' in item;
}

export function isSeries(item: LibraryMovie | LibrarySeries): item is LibrarySeries {
	return 'episodeCount' in item;
}

export function getItemSize(item: LibraryMovie | LibrarySeries): number {
	if (isMovie(item)) {
		return item.files.reduce((sum, f) => sum + (f.size ?? 0), 0);
	}
	if (isSeries(item)) {
		return item.totalSize ?? 0;
	}
	return 0;
}

export function getQualityBadges(
	item: LibraryMovie | LibrarySeries,
	hasStreamerProfileFn: (item: LibraryMovie | LibrarySeries) => boolean
): Array<{ label: string; type: string }> {
	const badges: Array<{ label: string; type: string }> = [];

	if (isMovie(item) && item.files.length > 0) {
		const file = pickBestMovieFile(item.files);
		if (!file) return badges;
		const useAutoResolution = hasStreamerProfileFn(item);

		if (file.quality?.resolution) {
			badges.push({
				label: useAutoResolution ? 'Auto' : file.quality.resolution,
				type: 'resolution'
			});
		} else if (useAutoResolution) {
			badges.push({ label: 'Auto', type: 'resolution' });
		}
		if (file.quality?.source) {
			badges.push({
				label: useAutoResolution ? 'Streaming' : file.quality.source,
				type: 'source'
			});
		} else if (useAutoResolution) {
			badges.push({ label: 'Streaming', type: 'source' });
		}
		if (file.mediaInfo?.videoCodec) {
			badges.push({ label: file.mediaInfo.videoCodec, type: 'codec' });
		}
		if (file.mediaInfo?.hdrFormat) {
			badges.push({ label: file.mediaInfo.hdrFormat, type: 'hdr' });
		}
	}

	return badges;
}

export function isItemMissing(item: LibraryMovie | LibrarySeries): boolean {
	if (isMovie(item)) return !item.hasFile;
	if (isSeries(item)) return (item.percentComplete ?? 0) === 0;
	return false;
}
