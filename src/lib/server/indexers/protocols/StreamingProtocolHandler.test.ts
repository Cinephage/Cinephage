import { describe, it, expect } from 'vitest';
import { StreamingProtocolHandler } from './StreamingProtocolHandler.js';
import type { ReleaseResult } from '../types/release.js';

function release(downloadUrl: string): ReleaseResult {
	return {
		guid: 'stream-test',
		title: 'Test [Streaming]',
		downloadUrl,
		publishDate: new Date('2026-01-01T00:00:00Z'),
		size: 1,
		indexerId: 'cinephage-stream',
		indexerName: 'Cinephage Library',
		protocol: 'streaming',
		categories: []
	};
}

describe('StreamingProtocolHandler.validateResult', () => {
	const handler = new StreamingProtocolHandler();

	it('accepts an album stream URL', () => {
		expect(handler.validateResult(release('stream://music/album/abc-123'))).toBe(true);
	});

	it('rejects a music URL with no album id', () => {
		expect(handler.validateResult(release('stream://music/album/'))).toBe(false);
	});

	it('rejects a track-shaped music URL', () => {
		expect(handler.validateResult(release('stream://music/track/abc'))).toBe(false);
	});

	it('still accepts the existing video grammar', () => {
		expect(handler.validateResult(release('stream://movie/27205'))).toBe(true);
		expect(handler.validateResult(release('stream://tv/1399/1/1'))).toBe(true);
	});
});
