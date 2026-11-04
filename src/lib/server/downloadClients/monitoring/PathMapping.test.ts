import { describe, it, expect } from 'vitest';
import {
	mapClientPathToLocal,
	mapClientPathToLocalWithResult,
	needsPathMapping
} from './PathMapping';

describe('PathMapping windows separator handling', () => {
	it('maps Windows client paths with backslashes to Linux local paths', () => {
		const mapped = mapClientPathToLocal(
			'D:\\Torrent\\www.UIndex.org - The Simpsons S37E01',
			'/downloads',
			'D:\\Torrent'
		);

		expect(mapped).toBe('/downloads/www.UIndex.org - The Simpsons S37E01');
	});

	it('strips a leading backslash in the relative path after prefix removal', () => {
		const mapped = mapClientPathToLocal('D:\\Torrent\\filename.mkv', '/downloads', 'D:\\Torrent');
		expect(mapped).toBe('/downloads/filename.mkv');
	});

	it('maps Windows-style paths in detailed mapping mode', () => {
		const result = mapClientPathToLocalWithResult('D:\\Torrent\\Show\\Episode.mkv', {
			completeLocalPath: '/downloads',
			completeRemotePath: 'D:\\Torrent'
		});

		expect(result).toEqual({
			path: '/downloads/Show/Episode.mkv',
			exact: true
		});
	});

	it('treats slash style differences as already local in needsPathMapping', () => {
		expect(needsPathMapping('\\downloads\\Show\\Episode.mkv', '/downloads')).toBe(false);
	});
});

describe('PathMapping segment-boundary prefix matching', () => {
	// Regression: a raw string startsWith let a configured remote base of
	// '/downloads/complete' capture Transmission's '/downloads/completed/...'
	// output and slice mid-segment, mapping imports to a bogus 'd/<name>'
	// path ("No video files found in download" on every retry).
	it('does not slice mid-segment when the client folder extends the configured remote base name', () => {
		const mapped = mapClientPathToLocal(
			'/downloads/completed/Show.S01E01.1080p-GROUP/Show.S01E01.mkv',
			'/media/downloads/complete',
			'/downloads/complete'
		);

		expect(mapped).not.toContain('/d/');
		expect(mapped).toBe(
			'/media/downloads/complete/completed/Show.S01E01.1080p-GROUP/Show.S01E01.mkv'
		);
	});

	it('still maps exact matches and direct children of the remote base', () => {
		expect(
			mapClientPathToLocal('/downloads/complete', '/media/complete', '/downloads/complete')
		).toBe('/media/complete');
		expect(
			mapClientPathToLocal(
				'/downloads/complete/Torrent/file.mkv',
				'/media/complete',
				'/downloads/complete'
			)
		).toBe('/media/complete/Torrent/file.mkv');
	});

	it('does not capture sibling folders sharing only a name prefix', () => {
		const mapped = mapClientPathToLocal(
			'/downloads/complete-season2/Torrent/file.mkv',
			'/media/complete',
			'/downloads/complete'
		);

		expect(mapped).not.toContain('/-season2');
		expect(mapped).toBe('/media/complete/complete-season2/Torrent/file.mkv');
	});

	it('requires segment boundaries for heuristic prefix matches without a remote base', () => {
		// '/complete' must not match inside '/srv/completed'
		const mapped = mapClientPathToLocal('/srv/completed/Torrent', '/data/complete');

		expect(mapped).not.toContain('completed/Torrent');
		expect(mapped).toBe('/data/complete/Torrent');
	});

	it('applies the same boundary rule in detailed mapping mode', () => {
		const result = mapClientPathToLocalWithResult('/downloads/completed/Torrent/file.mkv', {
			completeLocalPath: '/media/complete',
			completeRemotePath: '/downloads/complete'
		});

		expect(result.path).not.toContain('/d/');
		expect(result.path).toBe('/media/complete/completed/Torrent/file.mkv');
	});
});

describe('PathMapping mapping-quality reporting', () => {
	it('reports a configured completed-folder match as exact', () => {
		const result = mapClientPathToLocalWithResult('/downloads/complete/Torrent/file.mkv', {
			completeLocalPath: '/media/complete',
			completeRemotePath: '/downloads/complete'
		});

		expect(result).toEqual({
			path: '/media/complete/Torrent/file.mkv',
			exact: true
		});
	});

	it('reports a client path already under the local base as exact pass-through', () => {
		const result = mapClientPathToLocalWithResult('/downloads/Torrent/file.mkv', {
			completeLocalPath: '/downloads'
		});

		expect(result).toEqual({
			path: '/downloads/Torrent/file.mkv',
			exact: true
		});
	});

	it('reports a configured temp-folder match as exact and segment-aware', () => {
		const matched = mapClientPathToLocalWithResult('/downloads/incomplete/Torrent/file.mkv', {
			completeLocalPath: '/media/complete',
			completeRemotePath: '/downloads/complete',
			tempLocalPath: '/media/incomplete',
			tempRemotePath: '/downloads/incomplete'
		});
		expect(matched).toEqual({
			path: '/media/incomplete/Torrent/file.mkv',
			exact: true
		});

		// '/downloads/incomplete' must not capture '/downloads/incomplete2'
		const nearMiss = mapClientPathToLocalWithResult('/downloads/incomplete2/Torrent/file.mkv', {
			completeLocalPath: '/media/complete',
			completeRemotePath: '/downloads/complete',
			tempLocalPath: '/media/incomplete',
			tempRemotePath: '/downloads/incomplete'
		});
		expect(nearMiss.exact).toBe(false);
		expect(nearMiss.path).not.toBe('/media/incomplete/2/Torrent/file.mkv');
		expect(nearMiss.path).toBe('/media/complete/incomplete2/Torrent/file.mkv');
	});

	it('marks heuristic resolutions as non-exact with a warning naming both paths', () => {
		const result = mapClientPathToLocalWithResult('/downloads/completed/Torrent/file.mkv', {
			completeLocalPath: '/media/complete',
			completeRemotePath: '/downloads/complete'
		});

		expect(result.exact).toBe(false);
		expect(result.warning).toContain('/downloads/completed/Torrent/file.mkv');
		expect(result.warning).toContain('/downloads/complete');
	});

	it('passes through unchanged and non-exact when no local path is configured', () => {
		const result = mapClientPathToLocalWithResult('/downloads/Torrent/file.mkv', {
			completeLocalPath: null
		});

		expect(result).toEqual({
			path: '/downloads/Torrent/file.mkv',
			exact: false,
			warning: 'No local path configured'
		});
	});
});
