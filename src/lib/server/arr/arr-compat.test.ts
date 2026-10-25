import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb, type TestDatabase } from '../../../test/db-helper.js';
import { rootFolders, scoringProfiles } from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { buildRootFolders } = await import('./rootFolders.js');
const { buildQualityProfiles } = await import('./qualityProfiles.js');
const { buildTags } = await import('./tags.js');
const { buildSystemStatus } = await import('./systemStatus.js');
const { resetRootFolderService } = await import('#lib/server/downloadClients/RootFolderService.js');

beforeEach(() => {
	testDb.db.delete(rootFolders).run();
	testDb.db.delete(scoringProfiles).run();
	resetRootFolderService();
});

describe('buildRootFolders', () => {
	it('only returns folders matching the requested media type, with a stable surrogate ID', async () => {
		testDb.db
			.insert(rootFolders)
			.values([
				{ id: 'movie-folder', name: 'Movies', path: '/movies', mediaType: 'movie' },
				{ id: 'tv-folder', name: 'TV', path: '/tv', mediaType: 'tv' }
			])
			.run();

		const movieFolders = await buildRootFolders('movie');
		expect(movieFolders).toHaveLength(1);
		expect(movieFolders[0].path).toBe('/movies');
		expect(Number.isInteger(movieFolders[0].id)).toBe(true);

		const tvFolders = await buildRootFolders('tv');
		expect(tvFolders).toHaveLength(1);
		expect(tvFolders[0].path).toBe('/tv');

		// Same UUID, same surrogate ID across calls
		const movieFoldersAgain = await buildRootFolders('movie');
		expect(movieFoldersAgain[0].id).toBe(movieFolders[0].id);
	});
});

describe('buildQualityProfiles', () => {
	it("returns the same profile list to both trees, differing only by the language field Radarr's schema has and Sonarr's does not", async () => {
		testDb.db
			.insert(scoringProfiles)
			.values([{ id: 'profile-1', name: 'HD-1080p' }])
			.run();

		const commonFields = {
			id: expect.any(Number),
			name: 'HD-1080p',
			upgradeAllowed: true,
			cutoff: expect.any(Number),
			items: [],
			minFormatScore: 0,
			cutoffFormatScore: 0,
			minUpgradeFormatScore: 0,
			formatItems: []
		};

		const radarrProfiles = await buildQualityProfiles('Radarr');
		expect(radarrProfiles).toEqual([{ ...commonFields, language: { id: 1, name: 'English' } }]);

		const sonarrProfiles = await buildQualityProfiles('Sonarr');
		expect(sonarrProfiles).toEqual([commonFields]);
		expect(sonarrProfiles[0]).not.toHaveProperty('language');
	});
});

describe('buildTags', () => {
	it('returns an empty list', () => {
		expect(buildTags()).toEqual([]);
	});
});

describe('buildSystemStatus', () => {
	it('differs only in appName between the two arr personas', () => {
		const radarr = buildSystemStatus('Radarr');
		const sonarr = buildSystemStatus('Sonarr');
		expect(radarr.appName).toBe('Radarr');
		expect(sonarr.appName).toBe('Sonarr');
		expect({ ...radarr, appName: undefined }).toEqual({ ...sonarr, appName: undefined });
	});
});
