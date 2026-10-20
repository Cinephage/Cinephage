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
});
