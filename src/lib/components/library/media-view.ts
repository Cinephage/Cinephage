/**
 * One presentation shape for every kind a library grid shows.
 *
 * The library list, its cards and its table are shared by movies, TV and music.
 * Each kind adapts its own row into these views, so the components render one
 * grammar and never grow another branch per kind.
 */

import type { LibraryMovie, LibrarySeries } from '#lib/types/library.js';
import { displayTitle, getBestQualityFromFiles } from '#lib/types/library.js';
import type { AlbumCardData, ArtistCardData } from '#lib/components/music/music-card.js';
import * as m from '#lib/paraglide/messages.js';
import { formatBytes } from '#lib/utils/format.js';

export type LibraryKind = 'movie' | 'tv' | 'album' | 'artist';

/** Where a tile's art comes from: a TMDB path, or a servable URL (music covers). */
export type MediaArt = { source: 'tmdb'; path: string } | { source: 'url'; url: string };

export interface MediaCardView {
	id: string;
	kind: LibraryKind;
	href: string;
	title: string;
	year: number | null;
	art: MediaArt | null;
	/** Album and artist art is square; posters are 2:3. */
	square: boolean;
	typeLabel: string;
	typeTone: 'primary' | 'secondary' | 'accent';
	monitored: boolean;
	partiallyMonitored: boolean;
	/** Top-left state badge: a file tick/cross, or a child-count "n/n". */
	state: { icon: 'file' | 'cross' | 'count'; label: string; tone: 'success' | 'error' | 'neutral' } | null;
	/** Muted badge under the state (a movie's quality, an album's format). */
	detail: string | null;
	/** 0–100 when the kind has partial progress. */
	progress: number | null;
	/** Second line in the hover overlay (artist name, percent complete). */
	subtitle: string | null;
	/** Chip in the hover overlay (a collection name). */
	tag: string | null;
}

export function movieCardView(
	movie: LibraryMovie,
	preferOriginalTitleDefault: boolean | null = false
): MediaCardView {
	const quality = getBestQualityFromFiles(movie.files);
	const qualityLabel = movie.scoringProfileId === 'streamer'
		? m.library_mediaCard_auto()
		: [quality.quality, quality.hdr].filter(Boolean).join(' ') || null;

	return {
		id: movie.id,
		kind: 'movie',
		href: `/library/movie/${movie.id}`,
		title: displayTitle(movie, preferOriginalTitleDefault),
		year: movie.year,
		art: movie.posterPath ? { source: 'tmdb', path: movie.posterPath } : null,
		square: false,
		typeLabel: m.common_movie(),
		typeTone: 'primary',
		monitored: Boolean(movie.monitored),
		partiallyMonitored: false,
		state: movie.hasFile
			? { icon: 'file', label: m.library_mediaCard_fileAvailable(), tone: 'success' }
			: { icon: 'cross', label: m.library_mediaCard_missingFile(), tone: 'error' },
		detail: movie.hasFile ? qualityLabel : null,
		progress: null,
		subtitle: null,
		tag: movie.collectionName ?? null
	};
}

export function seriesCardView(
	series: LibrarySeries,
	preferOriginalTitleDefault: boolean | null = false
): MediaCardView {
	const percent = series.percentComplete ?? 0;
	return {
		id: series.id,
		kind: 'tv',
		href: `/library/tv/${series.id}`,
		title: displayTitle(series, preferOriginalTitleDefault),
		year: series.year,
		art: series.posterPath ? { source: 'tmdb', path: series.posterPath } : null,
		square: false,
		typeLabel: m.common_tvShow(),
		typeTone: 'secondary',
		monitored: Boolean(series.monitored),
		partiallyMonitored: series.partiallyMonitored === true,
		state: {
			icon: 'count',
			label: m.library_episodeProgress({
				episodeFileCount: series.episodeFileCount ?? 0,
				episodeCount: series.episodeCount ?? 0
			}),
			tone: 'neutral'
		},
		detail: null,
		progress: percent,
		subtitle: `${percent}%`,
		tag: null
	};
}

export function albumCardView(
album: AlbumCardData,
options: { artUrl?: string | null; href?: string } = {}
): MediaCardView {
const art: MediaArt | null =
options.artUrl === undefined
? album.hasCover
? { source: 'url', url: `/api/music/albums/${album.id}/cover` }
: null
: options.artUrl
? { source: 'url', url: options.artUrl }
: null;
return {
		id: album.id,
		kind: 'album',
		href: options.href ?? `/library/music/${album.id}`,
		title: album.title,
		year: album.year ?? null,
		art,
		square: true,
		typeLabel: album.primaryType ?? m.music_tabAlbum(),
		typeTone: 'accent',
		monitored: Boolean(album.monitored),
		partiallyMonitored: false,
		state: album.hasFile
			? { icon: 'file', label: m.library_mediaCard_fileAvailable(), tone: 'success' }
			: { icon: 'cross', label: m.library_mediaCard_missingFile(), tone: 'error' },
		detail: album.trackCount ? m.music_tracksShort({ count: album.trackCount }) : null,
		progress: null,
		subtitle: album.artistName,
		tag: null
	};
}

export function artistCardView(artist: ArtistCardData): MediaCardView {
	return {
		id: artist.id,
		kind: 'artist',
		href: `/library/music/artist/${artist.id}`,
		title: artist.name,
		year: null,
		art: artist.coverAlbumId
			? { source: 'url', url: `/api/music/albums/${artist.coverAlbumId}/cover` }
			: null,
		square: true,
		typeLabel: m.music_tabArtist(),
		typeTone: 'accent',
		monitored: Boolean(artist.monitored),
		partiallyMonitored: false,
		state: {
			icon: 'count',
			label: `${artist.inLibraryCount}/${artist.albumCount}`,
			tone: 'neutral'
		},
		detail: null,
		progress: artist.albumCount > 0 ? Math.round((artist.inLibraryCount / artist.albumCount) * 100) : 0,
		subtitle: m.music_albumsCount({ count: artist.albumCount }),
		tag: null
	};
}

/** The row columns a table needs on top of the card's identity. */
export interface MediaRowView extends MediaCardView {
	qualityBadges: Array<{ label: string; type: string }>;
	profileLabel: string | null;
	/** Pre-formatted sixth column: a byte size, a track count, an album count. */
	sizeLabel: string | null;
	progressLabel: string | null;
	added: string | null;
}

export function movieRowView(
	movie: LibraryMovie,
	preferOriginalTitleDefault: boolean | null = false
): MediaRowView {
	const file = getBestQualityFromFiles(movie.files);
	const badges: Array<{ label: string; type: string }> = [];
	if (file.quality) badges.push({ label: file.quality, type: 'resolution' });
	if (file.hdr) badges.push({ label: file.hdr, type: 'hdr' });
	return {
		...movieCardView(movie, preferOriginalTitleDefault),
		qualityBadges: movie.scoringProfileId === 'streamer'
			? [{ label: m.library_mediaCard_auto(), type: 'resolution' }]
			: badges,
		profileLabel: null,
		sizeLabel: formatBytesOrNull(movie.files.reduce((sum, entry) => sum + (entry.size ?? 0), 0)),
		progressLabel: null,
		added: movie.added ?? null
	};
}

export function seriesRowView(
	series: LibrarySeries,
	preferOriginalTitleDefault: boolean | null = false,
	profileName: string | null = null
): MediaRowView {
	return {
		...seriesCardView(series, preferOriginalTitleDefault),
		qualityBadges: [],
		profileLabel: profileName,
		sizeLabel: formatBytesOrNull(series.totalSize ?? 0),
		progressLabel: `${series.episodeFileCount ?? 0}/${series.episodeCount ?? 0}`,
		added: series.added ?? null
	};
}

export function albumRowView(album: AlbumCardData): MediaRowView {
	return {
		...albumCardView(album),
		qualityBadges: album.primaryType ? [{ label: album.primaryType, type: 'type' }] : [],
		profileLabel: null,
		sizeLabel: album.trackCount ? m.music_tracksShort({ count: album.trackCount }) : null,
		progressLabel: null,
		added: null
	};
}

export function artistRowView(artist: ArtistCardData): MediaRowView {
	return {
		...artistCardView(artist),
		qualityBadges: artist.type ? [{ label: artist.type, type: 'type' }] : [],
		profileLabel: null,
		sizeLabel: m.music_albumsCount({ count: artist.albumCount }),
		progressLabel: `${artist.inLibraryCount}/${artist.albumCount}`,
		added: null
	};
}

/** A byte size for the table, or nothing when the kind has no size of its own. */
function formatBytesOrNull(bytes: number): string | null {
	return bytes > 0 ? formatBytes(bytes) : null;
}
