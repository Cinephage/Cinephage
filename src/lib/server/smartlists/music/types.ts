import type { SmartListRecord } from '#lib/server/db/schema.js';

/**
 * Music smart-list vocabulary.
 *
 * A music list is still one row in `smart_lists`: the list-level controls
 * (profile, root folder, monitor, auto-add, exclusions, provenance) are the
 * same ones movie/TV lists use. What differs is the source — a playlist URL or
 * the new releases of the artists already monitored — and the item identity,
 * which is a MusicBrainz release group rather than a TMDB id.
 */

export type MusicListSource = 'playlist' | 'musicbrainz-new-releases';

export interface MusicListConfig {
	source: MusicListSource;
	url: string | null;
	/** Playlist tracks resolved per refresh. MusicBrainz allows ~1 request/s. */
	trackLimit: number;
	releaseTypes: string[];
	lookbackDays: number;
	artistLimit: number;
}

export interface MusicListCandidate {
	/** MusicBrainz release-group id — the album identity. */
	mbid: string;
	title: string;
	artistName: string;
	artistMbid: string | null;
	year: number | null;
	primaryType: string | null;
	trackCount: number | null;
	coverUrl: string | null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.round(parsed), min), max);
}

export function musicListConfig(list: SmartListRecord): MusicListConfig {
	const config = (list.externalSourceConfig ?? {}) as {
		url?: string;
		trackLimit?: number;
		releaseTypes?: string[];
		lookbackDays?: number;
		artistLimit?: number;
	};

	return {
		source:
			list.listSourceType === 'musicbrainz-new-releases' ? 'musicbrainz-new-releases' : 'playlist',
		url: config.url?.trim() || null,
		// 50 tracks is roughly one minute of gated MusicBrainz lookups on a cold
		// cache; the lookup cache makes later refreshes much cheaper.
		trackLimit: clampInt(config.trackLimit, 1, 200, 50),
		releaseTypes:
			Array.isArray(config.releaseTypes) && config.releaseTypes.length > 0
				? config.releaseTypes.filter((type): type is string => typeof type === 'string')
				: ['Album', 'EP'],
		lookbackDays: clampInt(config.lookbackDays, 1, 365, 30),
		artistLimit: clampInt(config.artistLimit, 1, 100, 30)
	};
}

/** Why a music list cannot refresh, or null when it is configured. */
export function musicListConfigError(list: SmartListRecord): string | null {
	return musicSourceConfigError({
		mediaType: list.mediaType,
		listSourceType: list.listSourceType,
		externalSourceConfig: list.externalSourceConfig
	});
}

/**
 * The same check for a create/update payload, before a row exists. A music list
 * must name a source; the playlist source must carry the URL that identifies it.
 */
export function musicSourceConfigError(input: {
	mediaType: string;
	listSourceType?: string | null;
	externalSourceConfig?: unknown;
}): string | null {
	if (input.mediaType !== 'music') return null;
	if (input.listSourceType !== 'playlist' && input.listSourceType !== 'musicbrainz-new-releases') {
		return 'A music list needs a playlist or a new-releases source';
	}
	if (input.listSourceType === 'playlist') {
		const config = (input.externalSourceConfig ?? {}) as { url?: string };
		if (!config.url?.trim()) return 'A playlist list needs a playlist URL';
	}
	return null;
}

/** The Cover Art Archive thumbnail a not-yet-imported album renders. */
export { coverArtUrl } from '../../music/cover-art.js';
