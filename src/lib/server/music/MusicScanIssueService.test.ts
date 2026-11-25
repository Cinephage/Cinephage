import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
	createTestDb,
	destroyTestDb,
	clearTestDb,
	type TestDatabase
} from '../../../test/db-helper.js';
import { musicScanIssueService } from './MusicScanIssueService.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	}
}));

beforeEach(() => {
	clearTestDb(testDb);
});

afterAll(() => {
	destroyTestDb(testDb);
});

function scanResult(folder: string, status: 'imported' | 'skipped' | 'unmatched' | 'failed') {
	return { folder, album: 'Discovery', artist: 'Daft Punk', status, reason: 'no release group' };
}

describe('MusicScanIssueService', () => {
	it('queues only the folders the scan refused, once per folder', () => {
		musicScanIssueService.record(null, [
			scanResult('/music/Daft Punk/Discovery', 'imported'),
			scanResult('/music/Unknown/Untitled', 'unmatched'),
			scanResult('/music/Broken/Album', 'failed')
		]);
		musicScanIssueService.record(null, [scanResult('/music/Unknown/Untitled', 'unmatched')]);

		const issues = musicScanIssueService.listPending();
		expect(issues.map((issue) => issue.folder).sort()).toEqual([
			'/music/Broken/Album',
			'/music/Unknown/Untitled'
		]);
		expect(musicScanIssueService.countPending()).toBe(2);
	});

	it('keeps a dismissed folder dismissed when a later scan refuses it again', () => {
		musicScanIssueService.record(null, [scanResult('/music/Unknown/Untitled', 'unmatched')]);
		const [issue] = musicScanIssueService.listPending();

		expect(musicScanIssueService.ignore(issue.id)).toBe(true);
		expect(musicScanIssueService.listPending()).toHaveLength(0);

		musicScanIssueService.record(null, [scanResult('/music/Unknown/Untitled', 'unmatched')]);
		expect(musicScanIssueService.listPending()).toHaveLength(0);
	});

	it('resolves the issue when the folder is imported by hand', () => {
		musicScanIssueService.record(null, [scanResult('/music/Unknown/Untitled', 'unmatched')]);
		musicScanIssueService.resolveFolder('/music/Unknown/Untitled');

		expect(musicScanIssueService.countPending()).toBe(0);
	});

	it('reports an unknown id rather than pretending to ignore it', () => {
		expect(musicScanIssueService.ignore('missing')).toBe(false);
	});
});
