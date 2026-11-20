/**
 * Card view models for the music surfaces.
 *
 * Kept in a plain module (not the components) so the library list, the artist
 * page and the discover pages all build the same shape from their own queries,
 * and a prop rename cannot silently drift between them.
 */

/** Everything a music card needs — a subset of AlbumSummary, plus display text. */
export interface AlbumCardData {
	id: string;
	title: string;
	artistName: string;
	/** Library artist id, when the album has a library row behind it. */
	artistId?: string | null;
	/** MusicBrainz artist id, for the discover artist page. */
	artistMbid?: string | null;
	year?: number | null;
	primaryType?: string | null;
	trackCount?: number | null;
	duration?: number | null;
	monitored?: boolean | null;
	hasFile?: boolean | null;
	hasCover?: boolean;
	/** Release-group MBID — the key the discover album route takes. */
	mbid?: string | null;
}

export interface ArtistCardData {
	id: string;
	name: string;
	/** Album that supplies the tile art (the artist has no portrait cache yet). */
	coverAlbumId?: string | null;
	albumCount: number;
	inLibraryCount: number;
	monitored?: boolean | null;
	/** MusicBrainz artist id; present on both library and discover tiles. */
	mbid?: string | null;
	type?: string | null;
	country?: string | null;
}

/** Everything the album hero renders: the album row plus its edition facts. */
export interface AlbumHeroAlbum {
	id: string;
	title: string;
	artistName: string;
	artistMbid?: string | null;
	year?: number | null;
	primaryType?: string | null;
	secondaryTypes?: string[] | null;
	status?: string | null;
	labelName?: string | null;
	catalogNumber?: string | null;
	barcode?: string | null;
	country?: string | null;
	mediaCount?: number | null;
	trackCount?: number | null;
	duration?: number | null;
	hasFile?: boolean | null;
	/** Non-null when the album is served by a streaming source, not files. */
	streamSource?: string | null;
	monitored?: boolean | null;
	path?: string | null;
	releaseMbid?: string | null;
	mbid?: string | null;
}

/** One track row, as every tracklist surface renders it. */
export interface TrackListTrack {
	id: string;
	title: string;
	artistCredit: string | null;
	discNumber: number | null;
	trackNumber: number | null;
	duration: number | null;
	hasFile: boolean | null;
}

/** "2h 14m" / "47m" — the same shape the movie runtime line uses. */
export function formatRuntime(seconds: number | null | undefined): string | null {
	if (!seconds || seconds <= 0) return null;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

/** Album plus its tracklist — the shape the artist page's accordion needs. */
export type AlbumWithTracks = AlbumCardData & { tracks: TrackListTrack[] };

/** One row of the songs table, across the whole library. */
export interface TrackTableRow {
	id: string;
	albumId: string;
	albumTitle: string;
	artistId: string;
	artistName: string;
	title: string;
	artistCredit: string | null;
	discNumber: number | null;
	trackNumber: number | null;
	duration: number | null;
	hasFile: boolean | null;
}

/**
 * Collaborators across a discography, most-credited first.
 *
 * Track credits are free text ("Chris Webby, Knowledge"), so this is a
 * deliberate heuristic: split on the separators MusicBrainz actually emits,
 * drop the artist themselves, and rank by how often a name appears. It feeds a
 * cast-style row of bubbles, not a data model.
 */
export function deriveFeaturedArtists(
	credits: Array<string | null>,
	artistName: string,
	limit = 8
): string[] {
	const self = artistName.trim().toLowerCase();
	const counts = new Map<string, number>();
	for (const credit of credits) {
		if (!credit) continue;
		for (const part of credit.split(/\s*(?:,|&|\bfeat\.|\bft\.|\sx\s)\s*/i)) {
			const name = part.trim();
			if (!name || name.toLowerCase() === self) continue;
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([name]) => name);
}

/** The editable release facts, shared by the album page and its edit modal. */
export interface AlbumEditData {
	title: string;
	year: number | null;
	primaryType: string | null;
	labelName: string | null;
	catalogNumber: string | null;
	barcode: string | null;
	country: string | null;
}
