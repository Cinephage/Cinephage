import { describe, expect, it } from 'vitest';
import { trackAvailability } from './music-card.js';

describe('trackAvailability', () => {
	it('reads a local file as downloaded', () => {
		expect(trackAvailability({ hasFile: true })).toBe('downloaded');
	});

	it('reads an album shortcut as streaming, not missing', () => {
		// The regression: a stream-backed album has no local audio, so hasFile is
		// false for every track while the .strm shortcut plays fine.
		expect(trackAvailability({ hasFile: false, streamSource: 'Cinephage Library' })).toBe(
			'streaming'
		);
	});

	it('reads a monitored album with nothing on disk as missing', () => {
		expect(trackAvailability({ hasFile: false, streamSource: null })).toBe('missing');
		expect(trackAvailability({ hasFile: false })).toBe('missing');
	});

	it('prefers the file when both are present', () => {
		// An imported album clears streamSource; if a row ever carries both, the
		// file is the more specific artefact.
		expect(trackAvailability({ hasFile: true, streamSource: 'Cinephage Library' })).toBe(
			'downloaded'
		);
	});
});
