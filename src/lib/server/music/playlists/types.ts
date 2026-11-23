/**
 * Playlist import types.
 *
 * A playlist lists *songs*; the library stores *albums* (MusicBrainz release
 * groups). Every provider adapter hands back the same track shape, and the
 * resolver is the one place that knows how a song becomes an album.
 */

export type PlaylistProviderId = 'youtube' | 'deezer' | 'spotify';

/** A playlist as the provider describes it, before any MusicBrainz lookup. */
export interface PlaylistRef {
	provider: PlaylistProviderId;
	/** Provider-native id: the YouTube `list` value, the Deezer playlist id, the Spotify id. */
	id: string;
	url: string;
	title: string;
	description: string | null;
	owner: string | null;
	coverUrl: string | null;
	/** What the provider says the playlist holds. May exceed `tracks.length` when truncated. */
	trackCount: number;
}

/**
 * One entry of a playlist. Album and year are only present when the provider
 * knows them (Deezer); a YouTube entry is a video title, so it arrives without
 * them and the resolver falls back to a recording lookup.
 */
export interface PlaylistTrack {
	title: string;
	/** Primary artist first; empty when the source could not be parsed. */
	artists: string[];
	album: string | null;
	year: number | null;
	durationMs: number | null;
	isrc: string | null;
}

export interface PlaylistPage {
	playlist: PlaylistRef;
	tracks: PlaylistTrack[];
	/** True when the provider holds more entries than we asked for. */
	truncated: boolean;
}

/**
 * One playlist provider. `parseUrl` is what makes the paste box work without
 * a provider picker: the URL decides, and an unknown host is a clear error
 * rather than a guessed request to the wrong API.
 */
export interface PlaylistSource {
	id: PlaylistProviderId;
	label: string;
	/** The provider's playlist id when the URL belongs to it, otherwise null. */
	parseUrl(url: URL): string | null;
	fetchPlaylist(url: URL, options: { limit: number }): Promise<PlaylistPage>;
}

/** How a track was attached to an album, which is also how much to trust it. */
export type MatchBasis = 'album' | 'track';

export type MatchConfidence = 'high' | 'low';

/**
 * One album the resolver found. `tracks` keeps the playlist entries that hit
 * it so the preview can show "3 songs from this playlist" instead of a bare
 * album title the user cannot relate to what they pasted.
 */
export interface AlbumCandidate {
	/** Row id for the preview; the release group mbid, stable across re-resolves. */
	id: string;
	releaseGroupMbid: string;
	title: string;
	artistName: string;
	artistMbid: string;
	year: number | null;
	primaryType: string | null;
	matchedBy: MatchBasis;
	confidence: MatchConfidence;
	tracks: Array<{ title: string; artist: string }>;
	/** Already in the music library. Add remains idempotent; the UI hides these by default. */
	inLibrary: boolean;
	albumId: string | null;
}

export type UnmatchedReason = 'no-artist' | 'no-match' | 'lookup-failed';

export interface UnmatchedTrack {
	title: string;
	artist: string | null;
	reason: UnmatchedReason;
}

export interface ResolveResult {
	candidates: AlbumCandidate[];
	unmatched: UnmatchedTrack[];
	/** Playlist entries that resolved to some album. */
	resolvedTracks: number;
}
