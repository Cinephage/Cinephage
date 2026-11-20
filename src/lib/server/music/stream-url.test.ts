import { describe, it, expect } from 'vitest';
import { buildMusicStreamUrl, parseMusicStreamUrl } from './stream-url.js';

const ALBUM_ID = '0f0e6b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

describe('music stream URL', () => {
	it('round-trips an album id', () => {
		const url = buildMusicStreamUrl(ALBUM_ID);

		expect(url).toBe(`stream://music/album/${ALBUM_ID}`);
		expect(parseMusicStreamUrl(url)).toEqual({ albumId: ALBUM_ID });
	});

	it('rejects video URLs and ordinary HTTP URLs', () => {
		expect(parseMusicStreamUrl('stream://movie/27205')).toBeNull();
		expect(parseMusicStreamUrl('stream://tv/1399/1/1')).toBeNull();
		expect(parseMusicStreamUrl('https://example.com/track.mp3')).toBeNull();
	});

	it('rejects a track-shaped, empty or multi-segment music URL', () => {
		expect(parseMusicStreamUrl('stream://music/album/')).toBeNull();
		expect(parseMusicStreamUrl('stream://music/track/abc')).toBeNull();
		expect(parseMusicStreamUrl('stream://music/album/a/b')).toBeNull();
	});
});
