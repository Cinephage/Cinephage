/**
 * Tests for torrent recovery path resolution when a download disappears
 * from the client (e.g., qBittorrent auto-removes after completion).
 *
 * When a torrent is auto-removed by the client before the next poll,
 * the outputPath still points to the temp/incomplete path, but the
 * actual files exist at {downloadPathLocal}/{category}/{lastComponent}.
 *
 * These tests verify the recovery logic that should be added to
 * handleMissingDownload() in DownloadMonitorService.
 *
 * The fix should extract a buildTorrentRecoveryPath() helper from
 * handleMissingDownload and export it. Until that export exists,
 * the test "is exported from DownloadMonitorService" will FAIL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Specification: buildTorrentRecoveryPath
//
// This function computes where the completed files should be found when a
// torrent download disappears from the client (e.g. qBittorrent auto-removes
// after moving files from .incomplete → completed directory).
//
// Params:
//   outputPath        – the stored outputPath (points to temp/incomplete dir)
//   downloadPathLocal – the client's downloadPathLocal (base completed dir)
//   category          – the client's tvCategory or movieCategory
//
// Returns the completed path: {downloadPathLocal}/{category}/{lastComponent}
// ---------------------------------------------------------------------------

interface RecoveryPathParams {
	outputPath: string;
	downloadPathLocal: string;
	category: string;
}

function buildTorrentRecoveryPath_spec(params: RecoveryPathParams): string {
	const { outputPath, downloadPathLocal, category } = params;

	// Normalize backslashes → forward slashes (consistent with PathMapping)
	const normalizedOutput = outputPath.replace(/\\/g, '/');
	const normalizedLocal = downloadPathLocal.replace(/\\/g, '/').replace(/\/+$/, '');
	const normalizedCategory = category.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

	// Extract the last path component from the output path
	const segments = normalizedOutput.split('/').filter(Boolean);
	const lastComponent = segments[segments.length - 1] || '';

	if (!lastComponent) {
		// Fallback: if no last component, return base + category
		return `${normalizedLocal}/${normalizedCategory}`;
	}

	return `${normalizedLocal}/${normalizedCategory}/${lastComponent}`;
}

// ---------------------------------------------------------------------------
// Unit tests: path construction
// These test the spec inline - they always pass and document expected behaviour.
// ---------------------------------------------------------------------------

describe('buildTorrentRecoveryPath (specification)', () => {
	it('computes the completed path from a .incomplete temp outputPath (TV)', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/data/downloads/.incomplete/Show.S01E01.1080p',
			downloadPathLocal: '/data/downloads',
			category: 'tv'
		});
		expect(result).toBe('/data/downloads/tv/Show.S01E01.1080p');
	});

	it('computes the completed path from a temp outputPath (movies)', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/data/downloads/.incomplete/Movie.2024.1080p',
			downloadPathLocal: '/data/downloads',
			category: 'movies'
		});
		expect(result).toBe('/data/downloads/movies/Movie.2024.1080p');
	});

	it('handles trailing slash on downloadPathLocal', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/mnt/storage/.incomplete/Episode.Title',
			downloadPathLocal: '/mnt/storage/',
			category: 'tv'
		});
		expect(result).toBe('/mnt/storage/tv/Episode.Title');
	});

	it('handles trailing slash on outputPath', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/downloads/incomplete/My.Show.S02E03/',
			downloadPathLocal: '/downloads',
			category: 'tv'
		});
		expect(result).toBe('/downloads/tv/My.Show.S02E03');
	});

	it('handles Windows-style backslash paths', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: 'D:\\Torrent\\.incomplete\\Show.Name.S01E01',
			downloadPathLocal: 'D:\\Completed',
			category: 'tv-sonarr'
		});
		expect(result).toBe('D:/Completed/tv-sonarr/Show.Name.S01E01');
	});

	it('handles category with leading/trailing slashes', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/downloads/incomplete/Show.S01E01',
			downloadPathLocal: '/downloads',
			category: '/tv/'
		});
		expect(result).toBe('/downloads/tv/Show.S01E01');
	});

	it('handles deeply nested output paths - only the last component matters', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/data/torrents/incomplete/subdir/Another.Show.S03E05',
			downloadPathLocal: '/data/torrents',
			category: 'tv'
		});
		expect(result).toBe('/data/torrents/tv/Another.Show.S03E05');
	});

	it('handles single-component outputPath (no directory separators)', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: 'JustAShow.S01E01',
			downloadPathLocal: '/downloads',
			category: 'tv'
		});
		expect(result).toBe('/downloads/tv/JustAShow.S01E01');
	});

	it('handles empty outputPath gracefully', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '',
			downloadPathLocal: '/downloads',
			category: 'tv'
		});
		expect(result).toBe('/downloads/tv');
	});

	it('handles outputPath with only slashes', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '///',
			downloadPathLocal: '/downloads',
			category: 'tv'
		});
		expect(result).toBe('/downloads/tv');
	});
});

// ---------------------------------------------------------------------------
// Filesystem integration: simulate qBittorrent auto-remove scenario
//
// Creates a real temp directory structure:
//   incompletePath = {base}/.incomplete/ShowName  (does NOT exist)
//   completedPath  = {base}/tv/ShowName           (DOES exist, has files)
//
// This replicates what happens when qBittorrent:
//   1. Downloads to .incomplete/
//   2. Moves files to tv/ on completion
//   3. Auto-removes the torrent before the next poll
//
// The old code in handleMissingDownload() checks the stored outputPath
// (which points to .incomplete/ - gone) and marks the download as failed.
// After the fix, buildTorrentRecoveryPath computes the completed path,
// stat() confirms files exist, and the download is marked completed.
// ---------------------------------------------------------------------------

describe('handleMissingDownload torrent recovery - filesystem integration', () => {
	const testRunId = randomUUID().slice(0, 8);
	let baseDir: string;
	let incompletePath: string;
	let completedPath: string;
	let testFileName: string;

	beforeAll(async () => {
		baseDir = join(tmpdir(), `cinephage-recovery-test-${testRunId}`);
		const tvCategory = 'tv';
		const showName = `Test.Show.S01E01.1080p.${testRunId}`;

		incompletePath = join(baseDir, '.incomplete', showName);
		completedPath = join(baseDir, tvCategory, showName);
		testFileName = 'test.show.s01e01.1080p.mkv';

		// Create the completed path with a file - qBittorrent moved it here
		await mkdir(completedPath, { recursive: true });
		await writeFile(join(completedPath, testFileName), 'fake video content');

		// Intentionally do NOT create the incomplete path
	});

	afterAll(async () => {
		try {
			await rm(baseDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('the incomplete path does NOT exist (simulating torrent auto-remove)', async () => {
		await expect(stat(incompletePath)).rejects.toThrow();
	});

	it('the completed path exists with actual files', async () => {
		const dirStats = await stat(completedPath);
		expect(dirStats.isDirectory()).toBe(true);

		const fileStats = await stat(join(completedPath, testFileName));
		expect(fileStats.isFile()).toBe(true);
	});

	it('buildTorrentRecoveryPath resolves to the correct completed path', () => {
		const recoveryPath = buildTorrentRecoveryPath_spec({
			outputPath: incompletePath,
			downloadPathLocal: baseDir,
			category: 'tv'
		});

		expect(recoveryPath).toBe(completedPath);
	});

	it('the recovery path exists on disk (files are reachable via recovery)', async () => {
		const recoveryPath = buildTorrentRecoveryPath_spec({
			outputPath: incompletePath,
			downloadPathLocal: baseDir,
			category: 'tv'
		});

		// This is the critical check: handleMissingDownload should stat()
		// the recovery path and find the files qBittorrent moved to completed.
		const recoveryStats = await stat(recoveryPath);
		expect(recoveryStats.isDirectory()).toBe(true);

		const fileStats = await stat(join(recoveryPath, testFileName));
		expect(fileStats.isFile()).toBe(true);
	});

	it('recovery path differs from the stored (now-missing) outputPath', () => {
		const recoveryPath = buildTorrentRecoveryPath_spec({
			outputPath: incompletePath,
			downloadPathLocal: baseDir,
			category: 'tv'
		});

		expect(recoveryPath).not.toBe(incompletePath);
		expect(recoveryPath).toContain('tv');
		expect(incompletePath).toContain('.incomplete');
	});

	it('the stored outputPath alone would fail stat (current buggy behavior)', async () => {
		// This demonstrates the bug: the stored outputPath points to
		// a non-existent directory, so handleMissingDownload marks it as failed.
		await expect(stat(incompletePath)).rejects.toThrow();
	});

	it('the recovery path succeeds stat (expected behavior after fix)', async () => {
		const recoveryPath = buildTorrentRecoveryPath_spec({
			outputPath: incompletePath,
			downloadPathLocal: baseDir,
			category: 'tv'
		});

		// The recovery path DOES exist - the fix should use this instead.
		const recoveryStats = await stat(recoveryPath);
		expect(recoveryStats.isDirectory()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Edge cases for recovery path
// ---------------------------------------------------------------------------

describe('buildTorrentRecoveryPath - edge cases', () => {
	it('works when downloadPathLocal contains spaces', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/My Downloads/.incomplete/Show.Name',
			downloadPathLocal: '/My Downloads',
			category: 'tv'
		});
		expect(result).toBe('/My Downloads/tv/Show.Name');
	});

	it('works with Unix hidden directories in the path', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/data/.hidden/.incomplete/Show.Name',
			downloadPathLocal: '/data/.hidden',
			category: 'movies'
		});
		expect(result).toBe('/data/.hidden/movies/Show.Name');
	});

	it('preserves the exact last component (case-sensitive)', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/downloads/incomplete/MixedCase.Show.S01',
			downloadPathLocal: '/downloads',
			category: 'TV'
		});
		expect(result).toBe('/downloads/TV/MixedCase.Show.S01');
	});

	it('handles outputPath that already points to a completed path', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/downloads/tv/Already.Complete.Show',
			downloadPathLocal: '/downloads',
			category: 'tv'
		});
		expect(result).toBe('/downloads/tv/Already.Complete.Show');
	});

	it('handles movieCategory path', () => {
		const result = buildTorrentRecoveryPath_spec({
			outputPath: '/data/incomplete/Movie.Name.2024.2160p',
			downloadPathLocal: '/data',
			category: 'movies-radarr'
		});
		expect(result).toBe('/data/movies-radarr/Movie.Name.2024.2160p');
	});
});

// ---------------------------------------------------------------------------
// FAILING TEST - FIX REQUIRED
//
// This dynamic import checks that buildTorrentRecoveryPath is exported from
// DownloadMonitorService. It will FAIL until the fix extracts this function
// from handleMissingDownload() and exports it.
//
// Once the export exists, the next step is to update handleMissingDownload()
// to call this function for torrent downloads with seriesId/movieId, and
// stat() the recovery path before falling through to the "mark as failed" path.
// ---------------------------------------------------------------------------

describe('buildTorrentRecoveryPath - export check (currently FAILING)', () => {
	it('is exported from DownloadMonitorService', async () => {
		const mod = await import('./DownloadMonitorService');
		expect(mod).toHaveProperty('buildTorrentRecoveryPath');
		expect(typeof (mod as Record<string, unknown>).buildTorrentRecoveryPath).toBe('function');
	});

	it('matches the specification for a standard .incomplete → completed mapping', async () => {
		const mod = await import('./DownloadMonitorService');
		const fn = (mod as Record<string, unknown>).buildTorrentRecoveryPath as
			| ((outputPath: string, downloadPathLocal: string, category: string) => string | null)
			| undefined;

		expect(fn).toBeDefined();
		if (!fn) return; // Type guard

		const result = fn('/data/downloads/.incomplete/Show.S01E01.1080p', '/data/downloads', 'tv');
		expect(result).toBe('/data/downloads/tv/Show.S01E01.1080p');
	});
});
