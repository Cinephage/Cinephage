import { describe, expect, it } from 'vitest';
import { findUnmatchedOrigin, type UnmatchedOrigin } from './unmatched-origins.js';

const ORIGIN: UnmatchedOrigin = { hash: 'a'.repeat(40), progress: 1 };

function group(overrides: { sourcePath: string; selectedFilePath: string }) {
	return { sourcePath: overrides.sourcePath, selectedFilePath: overrides.selectedFilePath };
}

describe('findUnmatchedOrigin', () => {
	it('matches on sourcePath', () => {
		const byPath = new Map([['/downloads/a.mkv', ORIGIN]]);
		expect(
			findUnmatchedOrigin(group({ sourcePath: '/downloads/a.mkv', selectedFilePath: '/x' }), byPath)
		).toBe(ORIGIN);
	});

	it('falls back to selectedFilePath when detection normalized the source', () => {
		const byPath = new Map([['/downloads/a.mkv', ORIGIN]]);
		expect(
			findUnmatchedOrigin(
				group({ sourcePath: '/downloads', selectedFilePath: '/downloads/a.mkv' }),
				byPath
			)
		).toBe(ORIGIN);
	});

	it('returns null when neither path resolves', () => {
		const byPath = new Map([['/downloads/a.mkv', ORIGIN]]);
		expect(
			findUnmatchedOrigin(group({ sourcePath: '/other', selectedFilePath: '/elsewhere' }), byPath)
		).toBeNull();
	});

	it('matches a detected file inside a folder-based item (issue #629)', () => {
		const byPath = new Map([['/downloads/Example.Movie.2024.1080p.WEB-DL-GROUP', ORIGIN]]);
		expect(
			findUnmatchedOrigin(
				group({
					sourcePath: '/downloads/Example.Movie.2024.1080p.WEB-DL-GROUP/movie.mkv',
					selectedFilePath: '/downloads/Example.Movie.2024.1080p.WEB-DL-GROUP/movie.mkv'
				}),
				byPath
			)
		).toBe(ORIGIN);
	});

	it('does not match a sibling path with a shared prefix', () => {
		const byPath = new Map([['/data/incoming/a', ORIGIN]]);
		expect(
			findUnmatchedOrigin(
				group({
					sourcePath: '/data/incoming/ab/file.mkv',
					selectedFilePath: '/data/incoming/ab/file.mkv'
				}),
				byPath
			)
		).toBeNull();
	});
});
