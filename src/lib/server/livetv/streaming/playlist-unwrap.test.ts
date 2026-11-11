import { describe, expect, it } from 'vitest';

import {
	mergePlaylistUnwrapHeaders,
	playlistUnwrapHeaders,
	unwrapHeadersForScheme
} from './playlist-unwrap';

describe('playlist unwrap hints', () => {
	it('reads the zlive Referer from the playlist tag', () => {
		const playlist = '#EXTM3U\n#EXT-X-CINEPHAGE-UNWRAP:zlive-referer-1\n#EXTINF:6,\nsegment.ts\n';
		expect(playlistUnwrapHeaders(playlist)).toEqual({ Referer: 'https://zlive.st/' });
	});

	it('returns undefined for absent or unknown schemes', () => {
		expect(playlistUnwrapHeaders('#EXTM3U\n#EXTINF:6,\nsegment.ts\n')).toBeUndefined();
		expect(playlistUnwrapHeaders('#EXT-X-CINEPHAGE-UNWRAP:something-new')).toBeUndefined();
	});

	it('maps schemes case-insensitively', () => {
		expect(unwrapHeadersForScheme(' ZLIVE-REFERER-1 ')).toEqual({
			Referer: 'https://zlive.st/'
		});
		expect(unwrapHeadersForScheme('daddylive-camo-1')).toBeUndefined();
	});

	it('overlays playlist headers on the detail-time provider headers', () => {
		expect(
			mergePlaylistUnwrapHeaders(
				{ 'User-Agent': 'stb', Accept: '*/*' },
				'#EXT-X-CINEPHAGE-UNWRAP:zlive-referer-1'
			)
		).toEqual({
			'User-Agent': 'stb',
			Accept: '*/*',
			Referer: 'https://zlive.st/'
		});
	});

	it('keeps the provider headers when the playlist carries no hint', () => {
		expect(mergePlaylistUnwrapHeaders({ Cookie: 'a=b' }, '#EXTM3U')).toEqual({ Cookie: 'a=b' });
	});
});
