/**
 * HLS Playlist Validation Tests
 *
 * Tests the playlist validation/sanitization logic.
 * These tests use sample playlists - no network calls required.
 */

import { describe, it, expect } from 'vitest';
import { validatePlaylist, sanitizePlaylist, isHLSPlaylist } from './hls';

// Sample master playlist (realistic format)
const SAMPLE_MASTER_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.42c01e,mp4a.40.2"
480p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/playlist.m3u8
`;

const SAMPLE_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
segment0.ts
#EXTINF:10.0,
segment1.ts
#EXT-X-ENDLIST
`;

describe('HLS Playlist Validation', () => {
	describe('validatePlaylist', () => {
		it('should validate a valid master playlist', () => {
			const result = validatePlaylist(SAMPLE_MASTER_PLAYLIST);
			expect(result.valid).toBe(true);
			expect(result.type).toBe('master');
			expect(result.errors).toHaveLength(0);
		});

		it('should validate a valid media playlist', () => {
			const result = validatePlaylist(SAMPLE_MEDIA_PLAYLIST);
			expect(result.valid).toBe(true);
			expect(result.type).toBe('media');
			expect(result.errors).toHaveLength(0);
		});

		it('should reject empty content', () => {
			const result = validatePlaylist('');
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Empty content');
		});

		it('should reject content without #EXTM3U header', () => {
			const result = validatePlaylist('This is not HLS content');
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Missing #EXTM3U header');
		});

		it('should reject playlist with no recognizable tags', () => {
			const result = validatePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n');
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Playlist has no recognizable HLS tags');
		});

		it('should warn about missing ENDLIST in media playlist', () => {
			const playlistWithoutEndlist = `#EXTM3U
#EXTINF:10.0,
segment0.ts
`;
			const result = validatePlaylist(playlistWithoutEndlist);
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes('ENDLIST'))).toBe(true);
		});
	});

	describe('sanitizePlaylist', () => {
		it('should remove garbage before #EXTM3U', () => {
			const corrupted = 'garbage content here\n#EXTM3U\n#EXTINF:10.0,\nsegment.ts\n#EXT-X-ENDLIST';
			const sanitized = sanitizePlaylist(corrupted);
			expect(sanitized.startsWith('#EXTM3U')).toBe(true);
		});

		it('should remove content after #EXT-X-ENDLIST', () => {
			const corrupted = '#EXTM3U\n#EXTINF:10.0,\nsegment.ts\n#EXT-X-ENDLIST\ngarbage\nmore garbage';
			const sanitized = sanitizePlaylist(corrupted);
			expect(sanitized.includes('garbage')).toBe(false);
			expect(sanitized.endsWith('#EXT-X-ENDLIST')).toBe(true);
		});

		it('should preserve valid HLS content', () => {
			const valid = SAMPLE_MEDIA_PLAYLIST;
			const sanitized = sanitizePlaylist(valid);
			// Should be essentially the same (minus any trailing newlines)
			expect(sanitized.includes('#EXTM3U')).toBe(true);
			expect(sanitized.includes('#EXTINF:')).toBe(true);
			expect(sanitized.includes('segment0.ts')).toBe(true);
		});

		it('should return content as-is if no #EXTM3U found', () => {
			const notHLS = 'This is not HLS content';
			const result = sanitizePlaylist(notHLS);
			expect(result).toBe(notHLS);
		});
	});

	describe('isHLSPlaylist', () => {
		it('should return true for valid HLS content', () => {
			expect(isHLSPlaylist(SAMPLE_MASTER_PLAYLIST)).toBe(true);
			expect(isHLSPlaylist(SAMPLE_MEDIA_PLAYLIST)).toBe(true);
		});

		it('should return true even with leading whitespace', () => {
			expect(isHLSPlaylist('  \n#EXTM3U\n')).toBe(true);
		});

		it('should return false for non-HLS content', () => {
			expect(isHLSPlaylist('This is not HLS')).toBe(false);
			expect(isHLSPlaylist('<html>')).toBe(false);
		});

		it('should return false for empty/null content', () => {
			expect(isHLSPlaylist('')).toBe(false);
			expect(isHLSPlaylist(null as unknown as string)).toBe(false);
		});
	});
});
