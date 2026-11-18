/** The music row shape the Discover surfaces hand to MusicRowCard. */
export type MusicRowItem = {
	id: string;
	title?: string;
	subtitle?: string | null;
	image_url?: string | null;
	media_type: 'music';
	/** MusicBrainz id when the row came from search; Deezer chart rows resolve on click. */
	mbid?: string | null;
	/** Albums link to the album page, artists to the artist page. */
	musicKind?: 'album' | 'artist';
};
