/** The music row shape the Discover surfaces hand to MusicRowCard. */
export type MusicRowItem = {
	id: string;
	title?: string;
	subtitle?: string | null;
	image_url?: string | null;
	media_type: 'music';
	/** MusicBrainz id, when the row came from MusicBrainz. */
	mbid?: string | null;
	/** Albums link to the album page, artists to the artist page, songs to their album. */
	musicKind?: 'album' | 'artist' | 'song';
	/** For a song row, the album whose page it opens. */
	album_title?: string | null;
	/** Deezer's own ids: a browse row has no MBID and links by these. */
	deezerId?: number | null;
	/** For a song row, the Deezer album id its page opens. */
	deezerAlbumId?: number | null;
};
