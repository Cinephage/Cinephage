import { describe, expect, it } from 'vitest';
import { buildShortcutUrl } from './MusicStrmService.js';

const BASE = 'http://192.168.1.10:3000';

describe('buildShortcutUrl', () => {
	it('carries the duration/container/codec hints the Jellyfin plugin reads', () => {
		expect(buildShortcutUrl(BASE, 'track-1', 'key with space', 224)).toBe(
			`${BASE}/api/streaming/music/track/track-1/stream?api_key=key%20with%20space&cp_duration=224&cp_container=m4a&cp_codec=aac`
		);
	});

	it('omits hints when the track has no duration', () => {
		expect(buildShortcutUrl(BASE, 'track-1', 'key', null)).toBe(
			`${BASE}/api/streaming/music/track/track-1/stream?api_key=key`
		);
	});
});
