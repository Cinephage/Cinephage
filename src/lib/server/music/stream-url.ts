/**
 * The `stream://` grammar for music.
 *
 * Video names one file — a movie by TMDB id, an episode by season and number.
 * Music names the album: the album is the unit that searches, grabs and gets
 * monitored, exactly like a movie. Tracks are resolved lazily at playback, so
 * they never appear as their own "download".
 */
const MUSIC_STREAM_PREFIX = 'stream://music/album/';

/** Album ids are generated UUIDs; the looser shape keeps fixtures usable. */
const ALBUM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function buildMusicStreamUrl(albumId: string): string {
	return `${MUSIC_STREAM_PREFIX}${albumId}`;
}

export function parseMusicStreamUrl(url: string): { albumId: string } | null {
	if (!url.startsWith(MUSIC_STREAM_PREFIX)) return null;

	const albumId = url.slice(MUSIC_STREAM_PREFIX.length);
	if (!ALBUM_ID_PATTERN.test(albumId)) return null;

	return { albumId };
}
