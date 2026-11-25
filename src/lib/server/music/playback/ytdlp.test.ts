import { describe, it, expect } from 'vitest';
import { parseResolvedAudio } from './ytdlp.js';

describe('parseResolvedAudio', () => {
	it('reads the URL, the container and the expiry', () => {
		const parsed = parseResolvedAudio(
			'https://rr5---sn-vgqsknzr.googlevideo.com/videoplayback?expire=1795165657&mime=audio%2Fmp4|m4a'
		);

		expect(parsed).toMatchObject({
			contentType: 'audio/mp4',
			expiresAt: 1795165657 * 1000
		});
	});

	it('maps a webm result to audio/webm', () => {
		const parsed = parseResolvedAudio(
			'https://example.googlevideo.com/videoplayback?expire=1|webm'
		);

		expect(parsed?.contentType).toBe('audio/webm');
	});

	it('rejects a line without a container or a non-https URL', () => {
		expect(parseResolvedAudio('https://example.googlevideo.com/x')).toBeNull();
		expect(parseResolvedAudio('/tmp/file.m4a|m4a')).toBeNull();
	});
});
